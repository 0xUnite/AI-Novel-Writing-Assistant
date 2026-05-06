#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");

const { prisma } = require("../server/dist/db/prisma.js");
const {
  sanitizeGeneratedChapterContent,
  hasGeneratedReasoningLeak,
} = require("../server/dist/services/novel/chapterContentSanitizer.js");
const {
  briefSummary,
  extractCharacterEventLines,
  extractFacts,
} = require("../server/dist/services/novel/novelCoreShared.js");

const ROOT = path.resolve(__dirname, "..");
const RUN_DIR = path.join(ROOT, ".run");
const STATE_PATH = path.join(RUN_DIR, "pipeline-watchdog-state.json");
const SERVER_LOG = path.join(RUN_DIR, "server.log");
const SERVER_SCREEN = "ai-novel-server";
const SERVER_PORT = 3000;
const SERVER_CMD = "/opt/homebrew/bin/node dist/app.js";
const DEFAULT_BASE_URL = "http://localhost:3000";
const DEFAULT_POLL_MS = 15000;
const DEFAULT_STALE_MS = 4 * 60 * 1000;
const DEFAULT_MAX_AUTO_RETRIES = 12;

fs.mkdirSync(RUN_DIR, { recursive: true });

function parseArgs(argv) {
  const output = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      continue;
    }
    const raw = arg.slice(2);
    const eqIndex = raw.indexOf("=");
    if (eqIndex >= 0) {
      output[raw.slice(0, eqIndex)] = raw.slice(eqIndex + 1);
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      output[raw] = next;
      index += 1;
      continue;
    }
    output[raw] = true;
  }
  return output;
}

function asInt(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatError(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function log(message, extra) {
  const suffix = extra && Object.keys(extra).length > 0 ? ` ${JSON.stringify(extra)}` : "";
  console.log(`[${new Date().toISOString()}] ${message}${suffix}`);
}

function writeState(state) {
  fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Invalid JSON from ${url}: ${text.slice(0, 240)}`);
  }
  if (!response.ok || (payload && payload.success === false)) {
    throw new Error(payload?.error ?? payload?.message ?? `${response.status} ${response.statusText}`);
  }
  return payload?.data ?? payload;
}

function parseCurrentOrder(label) {
  if (typeof label !== "string") {
    return null;
  }
  const match = label.match(/第\s*\d+\s*\/\s*\d+\s*章\s*·\s*第\s*(\d+)\s*章/u);
  if (!match) {
    return null;
  }
  return Number.parseInt(match[1], 10);
}

function listListeningPids(port) {
  try {
    const output = execFileSync("lsof", ["-tiTCP:" + String(port), "-sTCP:LISTEN"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!output) {
      return [];
    }
    return output
      .split(/\s+/u)
      .map((item) => Number.parseInt(item, 10))
      .filter((item) => Number.isFinite(item));
  } catch {
    return [];
  }
}

function pidCommand(pid) {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function isProjectOwnedCommand(command) {
  return command.includes(ROOT)
    || command.includes("dist/app.js")
    || command.includes("ts-node-dev")
    || command.includes("src/app.ts")
    || command.includes("node_modules/vite/bin/vite.js");
}

async function waitForHealth(baseUrl, attempts = 30, intervalMs = 1000) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await fetchJson(`${baseUrl}/api/health`);
      return true;
    } catch {
      await delay(intervalMs);
    }
  }
  return false;
}

async function restartServer(baseUrl) {
  log("Backend health check failed twice, restarting backend process.");
  try {
    execFileSync("screen", ["-S", SERVER_SCREEN, "-X", "quit"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    // Ignore missing session.
  }

  for (const pid of listListeningPids(SERVER_PORT)) {
    const command = pidCommand(pid);
    if (!isProjectOwnedCommand(command)) {
      throw new Error(`Port ${SERVER_PORT} is occupied by a non-project process: ${command}`);
    }
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Ignore already-exited processes.
    }
  }

  await delay(1000);

  for (const pid of listListeningPids(SERVER_PORT)) {
    const command = pidCommand(pid);
    if (!isProjectOwnedCommand(command)) {
      throw new Error(`Port ${SERVER_PORT} is still occupied by a non-project process: ${command}`);
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Ignore already-exited processes.
    }
  }

  const launchCommand = `cd "${path.join(ROOT, "server")}" && exec ${SERVER_CMD} >> "${SERVER_LOG}" 2>&1`;
  execFileSync("screen", ["-dmS", SERVER_SCREEN, "bash", "-lc", launchCommand], {
    stdio: ["ignore", "ignore", "ignore"],
  });

  const healthy = await waitForHealth(baseUrl, 40, 1000);
  if (!healthy) {
    throw new Error("Backend restart did not become healthy in time.");
  }
  log("Backend restarted successfully.");
}

async function resolveCurrentOrder(job) {
  const fromLabel = parseCurrentOrder(job.currentItemLabel);
  if (Number.isFinite(fromLabel)) {
    return fromLabel;
  }
  if (typeof job.currentItemKey !== "string" || !job.currentItemKey.trim()) {
    return null;
  }
  const chapter = await prisma.chapter.findUnique({
    where: { id: job.currentItemKey },
    select: { order: true },
  });
  return chapter?.order ?? null;
}

async function rollbackStrayChapter(chapter) {
  await prisma.$transaction(async (tx) => {
    await tx.chapterSummary.deleteMany({ where: { chapterId: chapter.id } });
    await tx.consistencyFact.deleteMany({ where: { chapterId: chapter.id } });
    await tx.characterTimeline.deleteMany({ where: { chapterId: chapter.id } });
    await tx.qualityReport.deleteMany({ where: { chapterId: chapter.id } });
    await tx.storyStateSnapshot.deleteMany({ where: { sourceChapterId: chapter.id } });
    await tx.openConflict.deleteMany({ where: { chapterId: chapter.id } });
    await tx.storyPlan.deleteMany({ where: { chapterId: chapter.id } });
    await tx.replanRun.deleteMany({ where: { chapterId: chapter.id } });
    await tx.auditReport.deleteMany({ where: { chapterId: chapter.id } });
    await tx.creativeDecision.deleteMany({ where: { chapterId: chapter.id } });
    await tx.foreshadowState.deleteMany({
      where: {
        OR: [
          { setupChapterId: chapter.id },
          { payoffChapterId: chapter.id },
        ],
      },
    });
    await tx.chapter.update({
      where: { id: chapter.id },
      data: {
        content: "",
        generationState: "planned",
        qualityScore: null,
        continuityScore: null,
        characterScore: null,
        pacingScore: null,
        riskFlags: null,
        repairHistory: null,
        hook: null,
      },
    });
  });
}

async function repairStrayDrafts(novelId, job, currentOrder) {
  const startedAtMs = Date.parse(job.startedAt ?? job.createdAt ?? "");
  if (!Number.isFinite(startedAtMs)) {
    return 0;
  }

  const allChapters = await prisma.chapter.findMany({
    where: { novelId },
    orderBy: { order: "asc" },
    select: {
      id: true,
      order: true,
      title: true,
      content: true,
      generationState: true,
      updatedAt: true,
    },
  });
  const written = allChapters.filter((chapter) => (chapter.content ?? "").trim().length > 0);
  if (written.length === 0) {
    return 0;
  }

  let frontier = 0;
  let gapDetected = false;
  const stray = [];
  for (const chapter of written) {
    if (!gapDetected && chapter.order === frontier + 1) {
      frontier = chapter.order;
      continue;
    }
    gapDetected = true;
    stray.push(chapter);
  }

  const candidates = stray.filter((chapter) => (
    chapter.updatedAt.getTime() >= startedAtMs
    && (currentOrder === null || chapter.order > currentOrder)
  ));

  let repaired = 0;
  for (const chapter of candidates) {
    await rollbackStrayChapter(chapter);
    repaired += 1;
    log("Rolled back stray future chapter draft.", {
      order: chapter.order,
      title: chapter.title,
      frontier,
      currentOrder,
    });
  }
  return repaired;
}

async function repairReasoningLeaks(novelId) {
  const leaked = await prisma.chapter.findMany({
    where: {
      novelId,
      content: { contains: "<think>" },
    },
    orderBy: { order: "asc" },
    select: {
      id: true,
      order: true,
      title: true,
      content: true,
    },
  });
  if (leaked.length === 0) {
    return 0;
  }

  const characters = await prisma.character.findMany({
    where: { novelId },
    select: { id: true, name: true },
  });

  let repaired = 0;
  for (const chapter of leaked) {
    const content = chapter.content ?? "";
    if (!hasGeneratedReasoningLeak(content)) {
      continue;
    }
    const sanitized = sanitizeGeneratedChapterContent(content);
    if (sanitized === content) {
      continue;
    }

    const facts = extractFacts(sanitized);
    const summary = briefSummary(sanitized, facts);
    const timelineRows = [];
    for (const character of characters) {
      const lines = extractCharacterEventLines(sanitized, character.name, 3);
      for (const line of lines) {
        timelineRows.push({
          novelId,
          characterId: character.id,
          chapterId: chapter.id,
          chapterOrder: chapter.order,
          title: `${chapter.order} · ${chapter.title}`,
          content: line,
          source: "chapter_extract",
        });
      }
    }

    await prisma.$transaction(async (tx) => {
      await tx.chapter.update({
        where: { id: chapter.id },
        data: { content: sanitized },
      });
      await tx.chapterSummary.upsert({
        where: { chapterId: chapter.id },
        update: {
          summary,
          keyEvents: facts.map((item) => item.content).slice(0, 3).join(""),
          characterStates: facts
            .filter((item) => item.category === "character")
            .map((item) => item.content)
            .slice(0, 3)
            .join(""),
        },
        create: {
          novelId,
          chapterId: chapter.id,
          summary,
          keyEvents: facts.map((item) => item.content).slice(0, 3).join(""),
          characterStates: facts
            .filter((item) => item.category === "character")
            .map((item) => item.content)
            .slice(0, 3)
            .join(""),
        },
      });
      await tx.consistencyFact.deleteMany({
        where: { novelId, chapterId: chapter.id },
      });
      if (facts.length > 0) {
        await tx.consistencyFact.createMany({
          data: facts.map((item) => ({
            novelId,
            chapterId: chapter.id,
            category: item.category,
            content: item.content,
            source: "chapter_auto_extract",
          })),
        });
      }
      await tx.characterTimeline.deleteMany({
        where: {
          novelId,
          chapterId: chapter.id,
          source: "chapter_extract",
        },
      });
      if (timelineRows.length > 0) {
        await tx.characterTimeline.createMany({ data: timelineRows });
      }
    });

    repaired += 1;
    log("Sanitized leaked reasoning block from chapter.", {
      order: chapter.order,
      title: chapter.title,
    });
  }

  return repaired;
}

async function retryFailedJob(baseUrl, jobId) {
  return fetchJson(`${baseUrl}/api/tasks/novel_pipeline/${jobId}/retry`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const novelId = String(args["novel-id"] ?? "").trim();
  let currentJobId = String(args["job-id"] ?? "").trim();
  const baseUrl = String(args["base-url"] ?? DEFAULT_BASE_URL).replace(/\/+$/u, "");
  const pollMs = Math.max(5000, asInt(args["poll-ms"], DEFAULT_POLL_MS));
  const staleMs = Math.max(60000, asInt(args["stale-ms"], DEFAULT_STALE_MS));
  const maxAutoRetries = Math.max(1, asInt(args["max-auto-retries"], DEFAULT_MAX_AUTO_RETRIES));
  const once = Boolean(args.once);

  if (!novelId) {
    throw new Error("Missing --novel-id");
  }
  if (!currentJobId) {
    throw new Error("Missing --job-id");
  }

  let consecutiveHealthFailures = 0;
  let autoRetryCount = 0;
  let lastProgressKey = "";
  let shouldExit = false;

  const writeRuntimeState = (extra = {}) => {
    writeState({
      novelId,
      jobId: currentJobId,
      updatedAt: new Date().toISOString(),
      autoRetryCount,
      ...extra,
    });
  };

  while (!shouldExit) {
    let healthOk = false;
    try {
      await fetchJson(`${baseUrl}/api/health`);
      healthOk = true;
      consecutiveHealthFailures = 0;
    } catch (error) {
      consecutiveHealthFailures += 1;
      log("Backend health check failed.", {
        failures: consecutiveHealthFailures,
        error: formatError(error),
      });
      writeRuntimeState({
        health: "down",
        lastError: formatError(error),
      });
      if (consecutiveHealthFailures >= 2) {
        await restartServer(baseUrl);
        consecutiveHealthFailures = 0;
      }
    }

    if (healthOk) {
      const job = await fetchJson(`${baseUrl}/api/novels/${novelId}/pipeline/jobs/${currentJobId}`);
      const currentOrder = await resolveCurrentOrder(job);
      const heartbeatAgeMs = typeof job.heartbeatAt === "string"
        ? Math.max(0, Date.now() - Date.parse(job.heartbeatAt))
        : null;

      const repairedStrays = await repairStrayDrafts(novelId, job, currentOrder);
      const repairedLeaks = await repairReasoningLeaks(novelId);

      const progressKey = [
        job.status ?? "",
        job.currentStage ?? "",
        job.currentItemLabel ?? "",
        job.completedCount ?? "",
        job.totalCount ?? "",
      ].join("|");
      if (progressKey !== lastProgressKey || repairedStrays > 0 || repairedLeaks > 0) {
        lastProgressKey = progressKey;
        log("Pipeline heartbeat snapshot.", {
          jobId: currentJobId,
          status: job.status,
          stage: job.currentStage,
          item: job.currentItemLabel,
          completed: job.completedCount,
          total: job.totalCount,
          heartbeatAgeMs,
          repairedStrays,
          repairedLeaks,
        });
      }

      writeRuntimeState({
        health: "ok",
        status: job.status,
        stage: job.currentStage,
        item: job.currentItemLabel,
        completedCount: job.completedCount,
        totalCount: job.totalCount,
        heartbeatAt: job.heartbeatAt ?? null,
        heartbeatAgeMs,
        currentOrder,
        repairedStrays,
        repairedLeaks,
      });

      if ((job.status === "running" || job.status === "queued") && heartbeatAgeMs !== null && heartbeatAgeMs > staleMs) {
        log("Pipeline heartbeat is stale. Waiting for in-process watchdog recovery.", {
          jobId: currentJobId,
          heartbeatAgeMs,
          staleMs,
        });
      }

      if (job.status === "failed") {
        if (autoRetryCount >= maxAutoRetries) {
          log("Auto-retry budget exhausted. Leaving the failed job in place.", {
            jobId: currentJobId,
            maxAutoRetries,
          });
          shouldExit = true;
        } else {
          const retried = await retryFailedJob(baseUrl, currentJobId);
          const nextJobId = typeof retried?.id === "string" ? retried.id.trim() : "";
          if (!nextJobId) {
            throw new Error("Retry succeeded but no replacement job id was returned.");
          }
          autoRetryCount += 1;
          currentJobId = nextJobId;
          lastProgressKey = "";
          log("Auto-retried failed pipeline job.", {
            previousJobId: job.id,
            nextJobId,
            autoRetryCount,
          });
        }
      } else if (job.status === "succeeded") {
        log("Pipeline finished successfully. Watchdog will exit.", {
          jobId: currentJobId,
        });
        shouldExit = true;
      } else if (job.status === "cancelled") {
        log("Pipeline was cancelled. Watchdog will exit without restarting it.", {
          jobId: currentJobId,
        });
        shouldExit = true;
      }
    }

    if (once || shouldExit) {
      break;
    }
    await delay(pollMs);
  }
}

main()
  .catch((error) => {
    log("Pipeline watchdog crashed.", { error: formatError(error) });
    writeState({
      updatedAt: new Date().toISOString(),
      status: "watchdog_failed",
      error: formatError(error),
    });
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => null);
  });
