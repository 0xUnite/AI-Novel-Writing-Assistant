#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const BASE_URL = process.env.NOVEL_BASE_URL ?? "http://127.0.0.1:3000/api";
const POLL_INTERVAL_MS = Number(process.env.DUAL_NOVEL_WATCHDOG_POLL_MS ?? "30000");
const DEFAULT_STALE_MS = Number(process.env.DUAL_NOVEL_WATCHDOG_STALE_MS ?? "240000");
const DEFAULT_PROGRESS_STALL_MS = Number(process.env.DUAL_NOVEL_WATCHDOG_PROGRESS_STALL_MS ?? "900000");
const DEFAULT_BLOCKED_REPEAT_THRESHOLD = Number(process.env.DUAL_NOVEL_WATCHDOG_BLOCKED_REPEAT_THRESHOLD ?? "3");
const DEFAULT_BLOCKED_ALERT_THRESHOLD = Number(process.env.DUAL_NOVEL_WATCHDOG_BLOCKED_ALERT_THRESHOLD ?? "10");
const ALERTS_ENABLED = (process.env.DUAL_NOVEL_WATCHDOG_ALERTS_ENABLED ?? "1") !== "0";
const ALERT_CHANNEL = process.env.DUAL_NOVEL_WATCHDOG_ALERT_CHANNEL ?? "telegram";
const ALERT_TARGET = process.env.DUAL_NOVEL_WATCHDOG_ALERT_TARGET ?? "6297570217";
const ALERT_ACCOUNT = process.env.DUAL_NOVEL_WATCHDOG_ALERT_ACCOUNT ?? "default";
const ALERT_COOLDOWN_MS = Number(process.env.DUAL_NOVEL_WATCHDOG_ALERT_COOLDOWN_MS ?? "1800000");
const ALERT_TIMEOUT_MS = Number(process.env.DUAL_NOVEL_WATCHDOG_ALERT_TIMEOUT_MS ?? "30000");
const RUN_ONCE = process.argv.includes("--once");

const REPO_ROOT = path.resolve(__dirname, "..");
const RUN_DIR = path.join(REPO_ROOT, ".run");
const LOG_PATH = path.join(RUN_DIR, "dual-novel-progress-watchdog.log");
const STATE_PATH = path.join(RUN_DIR, "dual-novel-progress-watchdog-state.json");
const LOCK_PATH = path.join(RUN_DIR, "dual-novel-progress-watchdog.lock");

const ACTIVE_STATUSES = new Set(["queued", "running"]);
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled"]);

const NOVELS = [
  {
    key: "rebirth2005",
    label: "重生2005",
    novelId: "cmnvhbpjb004zt4jui6ac85tn",
    strategy: "continuity_only",
    threshold: 75,
    provider: "minimax",
    model: "MiniMax-M2.7",
    temperature: 0.7,
    continuityRepairMaxAttempts: 12,
    activeJobStaleMs: DEFAULT_STALE_MS,
    activeJobProgressStallMs: DEFAULT_PROGRESS_STALL_MS,
    blockedRepeatThreshold: DEFAULT_BLOCKED_REPEAT_THRESHOLD,
  },
  {
    key: "cyber_asylum",
    label: "赛博精神病院",
    novelId: "cmniz64mp0001an3v59x2sfal",
    strategy: "quality_then_continuity",
    threshold: 75,
    provider: "minimax",
    model: "MiniMax-M2.7",
    temperature: 0.7,
    qualityRepairMaxAttempts: 60,
    continuityRepairMaxAttempts: 12,
    activeJobStaleMs: DEFAULT_STALE_MS,
    activeJobProgressStallMs: DEFAULT_PROGRESS_STALL_MS,
    blockedRepeatThreshold: DEFAULT_BLOCKED_REPEAT_THRESHOLD,
  },
];

fs.mkdirSync(RUN_DIR, { recursive: true });

const state = {
  startedAt: new Date().toISOString(),
  status: "booting",
  novels: Object.fromEntries(NOVELS.map((config) => [config.key, createNovelState(config)])),
  lastUpdatedAt: null,
};

function createNovelState(config) {
  return {
    key: config.key,
    label: config.label,
    novelId: config.novelId,
    strategy: config.strategy,
    status: "idle",
    phase: "init",
    lastAction: null,
    managedJobId: null,
    managedJobType: null,
    activeJobProgressSignature: null,
    activeJobProgressAt: null,
    blockedTracker: {
      chapterId: null,
      chapterOrder: null,
      lastPassedOrder: null,
      count: 0,
      updatedAt: null,
    },
    preferContinuityRepairNext: false,
    preferQualityReviewNext: false,
    quality: null,
    continuity: null,
    failureCounts: {
      quality_review_all: 0,
      quality_repair_until_pass: 0,
      continuity_audit: 0,
      continuity_repair_blocked: 0,
    },
    loopErrorCount: 0,
    lastAlertKey: null,
    lastAlertAt: null,
    lastAlertStatus: null,
    lastUpdatedAt: null,
  };
}

let lockAcquired = false;

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return false;
  }
}

function readLockFile() {
  if (!fs.existsSync(LOCK_PATH)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(LOCK_PATH, "utf8");
    return raw.trim().length > 0 ? JSON.parse(raw) : null;
  } catch (error) {
    return null;
  }
}

function releaseLock() {
  if (!lockAcquired) {
    return;
  }

  const existing = readLockFile();
  if (existing?.pid === process.pid && fs.existsSync(LOCK_PATH)) {
    fs.unlinkSync(LOCK_PATH);
  }
  lockAcquired = false;
}

function acquireLock() {
  const existing = readLockFile();
  if (existing?.pid && existing.pid !== process.pid && isProcessAlive(existing.pid)) {
    console.error(`[${timestamp()}] Another dual novel progress watchdog is already running. ${JSON.stringify(existing)}`);
    return false;
  }

  if (fs.existsSync(LOCK_PATH)) {
    fs.unlinkSync(LOCK_PATH);
  }

  fs.writeFileSync(LOCK_PATH, `${JSON.stringify({
    pid: process.pid,
    startedAt: state.startedAt,
  }, null, 2)}\n`);
  lockAcquired = true;
  return true;
}

function timestamp() {
  return new Date().toISOString();
}

function persistState() {
  state.lastUpdatedAt = timestamp();
  fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

function log(message, extra) {
  const line = `[${timestamp()}] ${message}${extra ? ` ${JSON.stringify(extra)}` : ""}`;
  fs.appendFileSync(LOG_PATH, `${line}\n`);
  console.log(line);
  persistState();
}

function formatKstTimestamp(value = new Date()) {
  const formatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  return `${formatter.format(value).replace(/\//g, "-")} KST`;
}

function listBlockedOrders(continuityProgress) {
  return (continuityProgress.blockedChapters ?? [])
    .slice(0, 8)
    .map((item) => item.chapterOrder)
    .filter((value) => value !== null && value !== undefined)
    .join(" / ");
}

function maybeSendTelegramAlert(config, novelState, alertKey, lines) {
  if (!ALERTS_ENABLED || !ALERT_TARGET) {
    return;
  }

  const now = Date.now();
  const lastAlertAt = toTimestamp(novelState.lastAlertAt);
  if (novelState.lastAlertKey === alertKey
    && lastAlertAt !== null
    && now - lastAlertAt < ALERT_COOLDOWN_MS) {
    return;
  }

  const message = [
    `【小说监工告警】${formatKstTimestamp()}`,
    ...lines,
  ].join("\n");
  const command = [
    "message",
    "send",
    "--channel",
    ALERT_CHANNEL,
    "--target",
    ALERT_TARGET,
    "--message",
    message,
    "--json",
  ];
  if (ALERT_ACCOUNT) {
    command.push("--account", ALERT_ACCOUNT);
  }

  const result = spawnSync("openclaw", command, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: ALERT_TIMEOUT_MS,
  });

  novelState.lastAlertKey = alertKey;
  novelState.lastAlertAt = timestamp();

  if (result.status !== 0) {
    novelState.lastAlertStatus = "failed";
    log("Failed to send Telegram watchdog alert.", {
      novel: config.label,
      alertKey,
      status: result.status ?? null,
      error: result.error?.message ?? null,
      stderr: result.stderr?.trim() || null,
    });
    return;
  }

  novelState.lastAlertStatus = "sent";
  log("Sent Telegram watchdog alert.", {
    novel: config.label,
    alertKey,
    channel: ALERT_CHANNEL,
    target: ALERT_TARGET,
  });
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestJson(url, init) {
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch (error) {
    throw new Error(`Failed to parse JSON from ${url}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok || parsed?.success === false) {
    const message = parsed?.error ?? parsed?.message ?? `${response.status} ${response.statusText}`;
    const wrapped = new Error(message);
    wrapped.statusCode = response.status;
    wrapped.payload = parsed;
    throw wrapped;
  }
  return parsed;
}

function buildRunConfig(config, overrides = {}) {
  return {
    provider: config.provider,
    model: config.model,
    temperature: config.temperature,
    threshold: config.threshold,
    ...overrides,
  };
}

async function listReviewBatchJobs(config) {
  const response = await requestJson(`${BASE_URL}/novels/${config.novelId}/review-batch-jobs?limit=10`);
  return response.data ?? [];
}

async function getContinuityProgress(config) {
  const response = await requestJson(`${BASE_URL}/novels/${config.novelId}/continuity-progress?threshold=${config.threshold}`);
  return response.data;
}

async function getQualityReport(config) {
  const response = await requestJson(`${BASE_URL}/novels/${config.novelId}/quality-report`);
  return response.data;
}

async function startReviewBatchJob(config, type, overrides = {}) {
  const endpoint = type === "quality_review_all"
    ? "quality-review"
    : type === "quality_repair_until_pass"
      ? "quality-repair"
      : type === "continuity_repair_blocked"
        ? "continuity-repair"
        : "continuity-audit";
  const payload = type === "continuity_audit" || type === "continuity_repair_blocked"
    ? buildRunConfig(config, {
      autoRepairBlocked: true,
      maxRepairAttempts: config.continuityRepairMaxAttempts ?? 12,
    })
    : type === "quality_repair_until_pass"
      ? buildRunConfig(config, {
        maxRepairAttempts: config.qualityRepairMaxAttempts ?? 60,
      })
      : buildRunConfig(config);
  const response = await requestJson(`${BASE_URL}/novels/${config.novelId}/review-batch-jobs/${endpoint}`, {
    method: "POST",
    body: JSON.stringify({
      ...payload,
      ...overrides,
    }),
  });
  return response.data;
}

async function cancelReviewBatchJob(config, jobId) {
  try {
    const response = await requestJson(`${BASE_URL}/novels/${config.novelId}/review-batch-jobs/${jobId}/cancel`, {
      method: "POST",
    });
    return {
      status: "cancelled",
      data: response.data,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("仅排队中或运行中的后台审校任务可取消")) {
      log("Skip cancelling review job that already left active state.", {
        novel: config.label,
        jobId,
        error: message,
      });
      return {
        status: "already_terminal",
        data: null,
      };
    }
    throw error;
  }
}

function summarizeQuality(report, threshold) {
  const actionable = report.chapterReports
    .filter((item) => item.chapterStatus === "needs_repair" || (!(item.isMissing || item.isStale) && item.overall < threshold))
    .sort((left, right) => left.overall - right.overall || left.chapterOrder - right.chapterOrder)
    .map((item) => ({
      chapterId: item.chapterId,
      chapterOrder: item.chapterOrder,
      overall: item.overall,
      chapterStatus: item.chapterStatus ?? null,
    }));

  const reviewableRecheck = report.chapterReports
    .filter((item) => (item.isMissing || item.isStale) && item.generationState !== "approved" && item.generationState !== "published")
    .sort((left, right) => (left.chapterOrder ?? 0) - (right.chapterOrder ?? 0))
    .map((item) => ({
      chapterId: item.chapterId,
      chapterOrder: item.chapterOrder,
      generationState: item.generationState ?? null,
    }));

  const finalizedRecheck = report.chapterReports
    .filter((item) => (item.isMissing || item.isStale) && (item.generationState === "approved" || item.generationState === "published"))
    .sort((left, right) => (left.chapterOrder ?? 0) - (right.chapterOrder ?? 0))
    .map((item) => ({
      chapterId: item.chapterId,
      chapterOrder: item.chapterOrder,
      generationState: item.generationState ?? null,
    }));

  return {
    actionable,
    reviewableRecheck,
    finalizedRecheck,
  };
}

function getJobUpdatedAt(job) {
  const updatedAt = toTimestamp(job.updatedAt);
  if (updatedAt !== null) {
    return updatedAt;
  }
  const createdAt = toTimestamp(job.createdAt);
  return createdAt ?? 0;
}

function getActiveJobStatusPriority(status) {
  if (status === "running") {
    return 0;
  }
  if (status === "queued") {
    return 1;
  }
  return 2;
}

function getActiveJob(jobs) {
  return [...(jobs ?? [])]
    .filter((job) => ACTIVE_STATUSES.has(job.status ?? ""))
    .sort((left, right) => {
      const statusDiff = getActiveJobStatusPriority(left.status) - getActiveJobStatusPriority(right.status);
      if (statusDiff !== 0) {
        return statusDiff;
      }
      return getJobUpdatedAt(right) - getJobUpdatedAt(left);
    })[0] ?? null;
}

function getManagedJobStatus(novelState, jobs) {
  if (!novelState.managedJobId) {
    return null;
  }
  return jobs.find((job) => job.id === novelState.managedJobId) ?? null;
}

function toTimestamp(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isJobStale(config, job) {
  if (!job || !ACTIVE_STATUSES.has(job.status)) {
    return false;
  }
  const now = Date.now();
  const heartbeatAt = toTimestamp(job.heartbeatAt);
  if (heartbeatAt !== null) {
    return now - heartbeatAt > config.activeJobStaleMs;
  }
  const updatedAt = toTimestamp(job.updatedAt);
  return updatedAt !== null && now - updatedAt > config.activeJobStaleMs;
}

function getJobProgressSignature(job) {
  return JSON.stringify([
    job.id,
    job.status,
    job.completedCount ?? 0,
    job.currentItemKey ?? null,
    job.currentStage ?? null,
    job.progress ?? 0,
  ]);
}

function recordJobProgress(novelState, job) {
  const signature = getJobProgressSignature(job);
  if (novelState.activeJobProgressSignature !== signature) {
    novelState.activeJobProgressSignature = signature;
    novelState.activeJobProgressAt = timestamp();
  }
}

function clearJobProgress(novelState) {
  novelState.activeJobProgressSignature = null;
  novelState.activeJobProgressAt = null;
}

function isJobProgressStalled(config, novelState, job) {
  if (!job || !ACTIVE_STATUSES.has(job.status) || !novelState.activeJobProgressAt) {
    return false;
  }
  if (novelState.activeJobProgressSignature !== getJobProgressSignature(job)) {
    return false;
  }
  const lastProgressAt = toTimestamp(novelState.activeJobProgressAt);
  return lastProgressAt !== null && (Date.now() - lastProgressAt > config.activeJobProgressStallMs);
}

function isActiveContinuityJob(job) {
  return Boolean(
    job
    && ACTIVE_STATUSES.has(job.status ?? "")
    && (job.jobType === "continuity_audit" || job.jobType === "continuity_repair_blocked"),
  );
}

function updateBlockedTracker(config, novelState, continuityProgress, activeJob) {
  const leader = continuityProgress.blockedChapters?.[0] ?? null;
  if (!leader) {
    novelState.blockedTracker = {
      chapterId: null,
      chapterOrder: null,
      lastPassedOrder: continuityProgress.lastPassedOrder ?? null,
      count: 0,
      updatedAt: timestamp(),
    };
    novelState.preferContinuityRepairNext = false;
    return;
  }

  const tracker = novelState.blockedTracker;
  const sameLeader = tracker.chapterId === leader.chapterId
    && tracker.lastPassedOrder === (continuityProgress.lastPassedOrder ?? null);

  if (sameLeader) {
    if (!isActiveContinuityJob(activeJob)) {
      tracker.count += 1;
    }
  } else {
    tracker.chapterId = leader.chapterId;
    tracker.chapterOrder = leader.chapterOrder ?? null;
    tracker.lastPassedOrder = continuityProgress.lastPassedOrder ?? null;
    tracker.count = 1;
  }
  tracker.updatedAt = timestamp();

  if (isActiveContinuityJob(activeJob)) {
    return;
  }

  if (tracker.count >= (config.blockedRepeatThreshold ?? DEFAULT_BLOCKED_REPEAT_THRESHOLD)) {
    novelState.preferContinuityRepairNext = true;
  }
}

function shouldUseContinuityRepair(config, novelState, continuityProgress) {
  return Boolean(
    continuityProgress.blockedChapters?.length
    && (novelState.preferContinuityRepairNext || novelState.blockedTracker.count >= (config.blockedRepeatThreshold ?? DEFAULT_BLOCKED_REPEAT_THRESHOLD)),
  );
}

function updateSnapshots(novelState, qualitySummary, continuityProgress) {
  if (qualitySummary) {
    novelState.quality = {
      actionableCount: qualitySummary.actionable.length,
      actionablePreview: qualitySummary.actionable.slice(0, 8),
      reviewableRecheckCount: qualitySummary.reviewableRecheck.length,
      reviewableRecheckPreview: qualitySummary.reviewableRecheck.slice(0, 8),
      finalizedRecheckCount: qualitySummary.finalizedRecheck.length,
      finalizedRecheckPreview: qualitySummary.finalizedRecheck.slice(0, 8),
    };
  }

  novelState.continuity = {
    status: continuityProgress.status ?? "unknown",
    lastPassedOrder: continuityProgress.lastPassedOrder ?? null,
    resumeOrder: continuityProgress.resumeOrder ?? null,
    nextBatchStartOrder: continuityProgress.nextBatchStartOrder ?? null,
    nextBatchEndOrder: continuityProgress.nextBatchEndOrder ?? null,
    blockedCount: continuityProgress.blockedChapters?.length ?? 0,
    blockedPreview: (continuityProgress.blockedChapters ?? []).slice(0, 8).map((item) => ({
      chapterOrder: item.chapterOrder,
      chapterLabel: item.chapterLabel,
      coherence: item.coherence,
    })),
  };
  novelState.lastUpdatedAt = timestamp();
}

function shouldAlertBlockedRepeat(config, novelState) {
  return novelState.blockedTracker.count >= Math.max(
    config.blockedRepeatThreshold ?? DEFAULT_BLOCKED_REPEAT_THRESHOLD,
    DEFAULT_BLOCKED_ALERT_THRESHOLD,
  );
}

function isContinuityJobActivelyAdvancing(config, novelState, activeJob, continuityProgress) {
  if (!activeJob || !ACTIVE_STATUSES.has(activeJob.status ?? "")) {
    return false;
  }
  if (activeJob.jobType !== "continuity_audit" && activeJob.jobType !== "continuity_repair_blocked") {
    return false;
  }
  if ((continuityProgress.blockedChapters?.length ?? 0) === 0) {
    return false;
  }
  const lastProgressAt = toTimestamp(novelState.activeJobProgressAt);
  const hasRecentProgress = lastProgressAt !== null
    && (Date.now() - lastProgressAt) <= Math.max(60_000, Math.floor(config.activeJobProgressStallMs / 2));
  if (hasRecentProgress) {
    return true;
  }
  const heartbeatAt = toTimestamp(activeJob.heartbeatAt);
  const hasRecentHeartbeat = heartbeatAt !== null
    && (Date.now() - heartbeatAt) <= Math.max(90_000, Math.floor(config.activeJobStaleMs / 2));
  return hasRecentHeartbeat && activeJob.currentStage === "repairing";
}

async function startAndTrackJob(config, novelState, type, reason, overrides = {}) {
  const job = await startReviewBatchJob(config, type, overrides);
  novelState.managedJobId = job.id;
  novelState.managedJobType = job.jobType;
  novelState.phase = job.jobType;
  novelState.status = "running";
  novelState.lastAction = reason;
  clearJobProgress(novelState);
  if (type === "continuity_repair_blocked") {
    novelState.preferContinuityRepairNext = false;
  }
  if (type === "quality_review_all") {
    novelState.preferQualityReviewNext = false;
  }
  log("Started review watchdog job.", {
    novel: config.label,
    novelId: config.novelId,
    reason,
    jobId: job.id,
    jobType: job.jobType,
    currentBatchStartOrder: job.currentBatchStartOrder ?? null,
    currentBatchEndOrder: job.currentBatchEndOrder ?? null,
  });
  return job;
}

async function maybeStartNextJob(config, novelState, qualitySummary, continuityProgress) {
  if (config.strategy === "quality_then_continuity") {
    if (qualitySummary.reviewableRecheck.length > 0 || novelState.preferQualityReviewNext) {
      await startAndTrackJob(config, novelState, "quality_review_all", "quality_review_recheck");
      return;
    }

    if (qualitySummary.actionable.length > 0) {
      await startAndTrackJob(config, novelState, "quality_repair_until_pass", "quality_repair_actionable");
      return;
    }

    if (continuityProgress.status !== "completed") {
      if (shouldUseContinuityRepair(config, novelState, continuityProgress)) {
        await startAndTrackJob(config, novelState, "continuity_repair_blocked", "continuity_repair_blocked");
      } else {
        await startAndTrackJob(config, novelState, "continuity_audit", "continuity_audit");
      }
      return;
    }

    if (qualitySummary.finalizedRecheck.length > 0) {
      await startAndTrackJob(config, novelState, "quality_review_all", "quality_review_finalized", {
        includeFinalizedRecheck: true,
      });
      return;
    }

    novelState.status = "idle";
    novelState.phase = "waiting";
    novelState.lastAction = "idle_no_work";
    return;
  }

  if (continuityProgress.status !== "completed") {
    if (shouldUseContinuityRepair(config, novelState, continuityProgress)) {
      await startAndTrackJob(config, novelState, "continuity_repair_blocked", "continuity_repair_blocked");
    } else {
      await startAndTrackJob(config, novelState, "continuity_audit", "continuity_audit");
    }
    return;
  }

  novelState.status = "idle";
  novelState.phase = "waiting";
  novelState.lastAction = "continuity_completed_waiting";
}

function noteManagedJobFinished(config, novelState, managedJob, continuityProgress) {
  if (managedJob.status === "failed") {
    novelState.failureCounts[managedJob.jobType] = (novelState.failureCounts[managedJob.jobType] ?? 0) + 1;
    if ((managedJob.jobType === "continuity_audit" || managedJob.jobType === "continuity_repair_blocked")
      && (continuityProgress.blockedChapters?.length ?? 0) > 0) {
      novelState.preferContinuityRepairNext = true;
    }
    if (managedJob.jobType === "quality_repair_until_pass") {
      novelState.preferQualityReviewNext = true;
    }
    log("Managed job failed; watchdog will continue with intervention.", {
      novel: config.label,
      jobId: managedJob.id,
      jobType: managedJob.jobType,
      error: managedJob.error ?? null,
      failureCount: novelState.failureCounts[managedJob.jobType],
    });
    maybeSendTelegramAlert(
      config,
      novelState,
      `managed_failed:${managedJob.jobType}:${continuityProgress.lastPassedOrder ?? "none"}:${listBlockedOrders(continuityProgress) || "none"}`,
      [
        `${config.label} 任务失败，watchdog 已准备接管。`,
        `- 失败任务: ${managedJob.jobType} (${managedJob.id})`,
        `- 失败次数: ${novelState.failureCounts[managedJob.jobType]}`,
        `- 最近通过章节: ${continuityProgress.lastPassedOrder ?? "未知"}`,
        `- 当前阻塞章: ${listBlockedOrders(continuityProgress) || "无"}`,
        `- 错误: ${managedJob.error ?? "未返回具体错误"}`,
      ],
    );
  } else if (managedJob.status === "cancelled") {
    log("Managed job was cancelled.", {
      novel: config.label,
      jobId: managedJob.id,
      jobType: managedJob.jobType,
    });
  } else {
    novelState.failureCounts[managedJob.jobType] = 0;
    if (managedJob.jobType === "continuity_repair_blocked") {
      novelState.preferContinuityRepairNext = false;
    }
    if (managedJob.jobType === "quality_review_all") {
      novelState.preferQualityReviewNext = false;
    }
    log("Managed job completed.", {
      novel: config.label,
      jobId: managedJob.id,
      jobType: managedJob.jobType,
    });
  }

  novelState.managedJobId = null;
  novelState.managedJobType = null;
  clearJobProgress(novelState);
}

async function tickNovel(config, novelState) {
  const jobs = await listReviewBatchJobs(config);
  const activeJob = getActiveJob(jobs);
  const continuityProgress = await getContinuityProgress(config);
  const qualitySummary = config.strategy === "quality_then_continuity"
    ? summarizeQuality(await getQualityReport(config), config.threshold)
    : null;

  updateBlockedTracker(config, novelState, continuityProgress, activeJob);
  updateSnapshots(novelState, qualitySummary, continuityProgress);

  const managedJob = getManagedJobStatus(novelState, jobs);
  const suppressBlockedRepeatAlert = config.strategy === "quality_then_continuity"
    && (activeJob?.jobType === "quality_review_all" || activeJob?.jobType === "quality_repair_until_pass");

  if (!suppressBlockedRepeatAlert
    && !isActiveContinuityJob(activeJob)
    && (continuityProgress.blockedChapters?.length ?? 0) > 0
    && shouldAlertBlockedRepeat(config, novelState)
    && !isContinuityJobActivelyAdvancing(config, novelState, activeJob, continuityProgress)) {
    const leader = continuityProgress.blockedChapters?.[0] ?? null;
    maybeSendTelegramAlert(
      config,
      novelState,
      `blocked_repeat:${leader?.chapterId ?? "none"}:${continuityProgress.lastPassedOrder ?? "none"}`,
      [
        `${config.label} 出现重复阻塞，watchdog 将升级修复策略。`,
        `- 连续阻塞章节: 第${leader?.chapterOrder ?? "?"}章 ${leader?.chapterLabel ?? ""}`.trim(),
        `- 连续命中轮次: ${novelState.blockedTracker.count}`,
        `- 最近通过章节: ${continuityProgress.lastPassedOrder ?? "未知"}`,
        `- 当前阻塞章: ${listBlockedOrders(continuityProgress) || "无"}`,
        `- 下一步: 优先执行 continuity repair`,
      ],
    );
  }

  if (managedJob && TERMINAL_STATUSES.has(managedJob.status)) {
    noteManagedJobFinished(config, novelState, managedJob, continuityProgress);
  }

  if (activeJob && isJobStale(config, activeJob)) {
    const cancelResult = await cancelReviewBatchJob(config, activeJob.id);
    if (cancelResult.status !== "cancelled") {
      if (novelState.managedJobId === activeJob.id) {
        novelState.managedJobId = null;
        novelState.managedJobType = null;
      }
      clearJobProgress(novelState);
      return;
    }
    if ((activeJob.jobType === "continuity_audit" || activeJob.jobType === "continuity_repair_blocked")
      && (continuityProgress.blockedChapters?.length ?? 0) > 0) {
      novelState.preferContinuityRepairNext = true;
    }
    log("Cancelled stale active review job.", {
      novel: config.label,
      jobId: activeJob.id,
      jobType: activeJob.jobType,
      heartbeatAt: activeJob.heartbeatAt ?? null,
      updatedAt: activeJob.updatedAt ?? null,
      currentItemLabel: activeJob.currentItemLabel ?? null,
    });
    maybeSendTelegramAlert(
      config,
      novelState,
      `stale:${activeJob.id}:${activeJob.currentItemKey ?? "none"}`,
      [
        `${config.label} 检测到任务假死，watchdog 已取消旧任务。`,
        `- 旧任务: ${activeJob.jobType} (${activeJob.id})`,
        `- 当前处理: ${activeJob.currentItemLabel ?? "未知"}`,
        `- 最近心跳: ${activeJob.heartbeatAt ? formatKstTimestamp(new Date(activeJob.heartbeatAt)) : "缺失"}`,
        `- 当前阻塞章: ${listBlockedOrders(continuityProgress) || "无"}`,
        `- 下一步: 下一轮自动重启更合适的修复流程`,
      ],
    );
    if (novelState.managedJobId === activeJob.id) {
      novelState.managedJobId = null;
      novelState.managedJobType = null;
    }
    clearJobProgress(novelState);
    return;
  }

  if (activeJob) {
    recordJobProgress(novelState, activeJob);
    if (isJobProgressStalled(config, novelState, activeJob)) {
      const cancelResult = await cancelReviewBatchJob(config, activeJob.id);
      if (cancelResult.status !== "cancelled") {
        if (novelState.managedJobId === activeJob.id) {
          novelState.managedJobId = null;
          novelState.managedJobType = null;
        }
        clearJobProgress(novelState);
        return;
      }
      if ((activeJob.jobType === "continuity_audit" || activeJob.jobType === "continuity_repair_blocked")
        && (continuityProgress.blockedChapters?.length ?? 0) > 0) {
        novelState.preferContinuityRepairNext = true;
      }
      log("Cancelled stalled active review job.", {
        novel: config.label,
        jobId: activeJob.id,
        jobType: activeJob.jobType,
        completedCount: activeJob.completedCount ?? null,
        progress: activeJob.progress ?? null,
        currentItemLabel: activeJob.currentItemLabel ?? null,
        lastProgressAt: novelState.activeJobProgressAt,
      });
      maybeSendTelegramAlert(
        config,
        novelState,
        `stall:${activeJob.id}:${activeJob.currentItemKey ?? "none"}:${activeJob.completedCount ?? 0}`,
        [
          `${config.label} 长时间不推进，watchdog 已执行干预。`,
          `- 旧任务: ${activeJob.jobType} (${activeJob.id})`,
          `- 停滞章节: ${activeJob.currentItemLabel ?? "未知"}`,
          `- 进度: ${activeJob.progress ?? "未知"}%`,
          `- 最近有效推进: ${novelState.activeJobProgressAt ? formatKstTimestamp(new Date(novelState.activeJobProgressAt)) : "未知"}`,
          `- 当前阻塞章: ${listBlockedOrders(continuityProgress) || "无"}`,
        ],
      );
      if (novelState.managedJobId === activeJob.id) {
        novelState.managedJobId = null;
        novelState.managedJobType = null;
      }
      clearJobProgress(novelState);
      return;
    }

    if (!novelState.managedJobId) {
      novelState.managedJobId = activeJob.id;
      novelState.managedJobType = activeJob.jobType;
      novelState.phase = activeJob.jobType;
      novelState.status = "running";
      novelState.lastAction = "adopt_active_job";
      log("Adopted existing active review job.", {
        novel: config.label,
        jobId: activeJob.id,
        jobType: activeJob.jobType,
        currentStage: activeJob.currentStage ?? null,
        currentItemLabel: activeJob.currentItemLabel ?? null,
      });
    } else {
      novelState.phase = activeJob.jobType;
      novelState.status = "running";
    }
    return;
  }

  clearJobProgress(novelState);
  await maybeStartNextJob(config, novelState, qualitySummary, continuityProgress);
}

async function main() {
  if (!acquireLock()) {
    state.status = "skipped";
    return;
  }
  state.status = "running";
  log("Dual novel progress watchdog booted.", {
    baseUrl: BASE_URL,
    novels: NOVELS.map((item) => ({
      key: item.key,
      label: item.label,
      novelId: item.novelId,
      strategy: item.strategy,
    })),
    pollIntervalMs: POLL_INTERVAL_MS,
    alertsEnabled: ALERTS_ENABLED,
    alertChannel: ALERT_CHANNEL,
    alertTarget: ALERT_TARGET || null,
  });

  do {
    for (const config of NOVELS) {
      const novelState = state.novels[config.key];
      try {
        await tickNovel(config, novelState);
        novelState.loopErrorCount = 0;
      } catch (error) {
        novelState.status = "error";
        novelState.phase = "loop_error";
        novelState.lastAction = "loop_error";
        novelState.loopErrorCount = (novelState.loopErrorCount ?? 0) + 1;
        log("Novel watchdog loop error.", {
          novel: config.label,
          error: error instanceof Error ? error.message : String(error),
        });
        if (novelState.loopErrorCount >= 2) {
          maybeSendTelegramAlert(
            config,
            novelState,
            `loop_error:${error instanceof Error ? error.message : String(error)}`,
            [
              `${config.label} 的 watchdog 轮询连续异常，需要关注。`,
              `- 连续异常次数: ${novelState.loopErrorCount}`,
              `- 错误: ${error instanceof Error ? error.message : String(error)}`,
              `- 当前阶段: ${novelState.phase}`,
              `- 最近动作: ${novelState.lastAction ?? "未知"}`,
            ],
          );
        }
      }
    }

    persistState();
    if (!RUN_ONCE) {
      await sleep(POLL_INTERVAL_MS);
    }
  } while (!RUN_ONCE);
}

process.on("exit", releaseLock);
process.on("SIGINT", () => {
  releaseLock();
  process.exit(130);
});
process.on("SIGTERM", () => {
  releaseLock();
  process.exit(143);
});

void main().catch((error) => {
  state.status = "failed";
  log("Dual novel progress watchdog crashed.", {
    error: error instanceof Error ? error.message : String(error),
  });
  releaseLock();
  process.exitCode = 1;
});
