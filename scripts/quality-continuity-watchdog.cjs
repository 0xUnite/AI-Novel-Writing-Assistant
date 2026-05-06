#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const BASE_URL = process.env.NOVEL_BASE_URL ?? "http://localhost:3000/api";
const NOVEL_ID = process.env.NOVEL_ID ?? "cmniz64mp0001an3v59x2sfal";
const THRESHOLD = Number(process.env.NOVEL_THRESHOLD ?? "75");
const POLL_INTERVAL_MS = Number(process.env.NOVEL_WATCHDOG_POLL_MS ?? "30000");
const PROVIDER = process.env.NOVEL_PROVIDER ?? "minimax";
const MODEL = process.env.NOVEL_MODEL ?? "MiniMax-M2.7";
const TEMPERATURE = Number(process.env.NOVEL_TEMPERATURE ?? "0.7");
const QUALITY_REPAIR_MAX_ATTEMPTS = Number(process.env.NOVEL_QUALITY_REPAIR_MAX_ATTEMPTS ?? "60");
const CONTINUITY_REPAIR_MAX_ATTEMPTS = Number(process.env.NOVEL_CONTINUITY_REPAIR_MAX_ATTEMPTS ?? "12");
const MAX_FAILURE_RESTARTS = Number(process.env.NOVEL_WATCHDOG_MAX_FAILURE_RESTARTS ?? "2");
const ACTIVE_JOB_STALE_MS = Number(process.env.NOVEL_WATCHDOG_STALE_MS ?? "240000");
const ACTIVE_JOB_PROGRESS_STALL_MS = Number(process.env.NOVEL_WATCHDOG_PROGRESS_STALL_MS ?? "900000");

const REPO_ROOT = path.resolve(__dirname, "..");
const RUN_DIR = path.join(REPO_ROOT, ".run");
const LOG_PATH = path.join(RUN_DIR, "quality-continuity-watchdog.log");
const STATE_PATH = path.join(RUN_DIR, "quality-continuity-watchdog-state.json");

const ACTIVE_STATUSES = new Set(["queued", "running"]);
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled"]);

fs.mkdirSync(RUN_DIR, { recursive: true });

const state = {
  startedAt: new Date().toISOString(),
  status: "booting",
  phase: "init",
  lastAction: null,
  managedJobId: null,
  managedJobType: null,
  failureCounts: {
    quality_review_all: 0,
    quality_repair_until_pass: 0,
    continuity_audit: 0,
  },
  quality: null,
  continuity: null,
  activeJobProgressSignature: null,
  activeJobProgressAt: null,
  lastUpdatedAt: null,
};

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
    const error = new Error(message);
    error.statusCode = response.status;
    error.payload = parsed;
    throw error;
  }
  return parsed;
}

function buildRunConfig(overrides = {}) {
  return {
    provider: PROVIDER,
    model: MODEL,
    temperature: TEMPERATURE,
    threshold: THRESHOLD,
    ...overrides,
  };
}

async function getQualityReport() {
  const response = await requestJson(`${BASE_URL}/novels/${NOVEL_ID}/quality-report`);
  return response.data;
}

async function getContinuityProgress() {
  const response = await requestJson(`${BASE_URL}/novels/${NOVEL_ID}/continuity-progress?threshold=${THRESHOLD}`);
  return response.data;
}

async function listReviewBatchJobs() {
  const response = await requestJson(`${BASE_URL}/novels/${NOVEL_ID}/review-batch-jobs?limit=10`);
  return response.data ?? [];
}

async function startReviewBatchJob(type, overrides = {}) {
  const endpoint = type === "quality_review_all"
    ? "quality-review"
    : type === "quality_repair_until_pass"
      ? "quality-repair"
      : "continuity-audit";
  const payload = type === "continuity_audit"
    ? buildRunConfig({
      autoRepairBlocked: true,
      maxRepairAttempts: CONTINUITY_REPAIR_MAX_ATTEMPTS,
    })
    : type === "quality_repair_until_pass"
      ? buildRunConfig({
        maxRepairAttempts: QUALITY_REPAIR_MAX_ATTEMPTS,
      })
      : buildRunConfig();
  const finalPayload = {
    ...payload,
    ...overrides,
  };
  const response = await requestJson(`${BASE_URL}/novels/${NOVEL_ID}/review-batch-jobs/${endpoint}`, {
    method: "POST",
    body: JSON.stringify(finalPayload),
  });
  return response.data;
}

async function cancelReviewBatchJob(jobId) {
  const response = await requestJson(`${BASE_URL}/novels/${NOVEL_ID}/review-batch-jobs/${jobId}/cancel`, {
    method: "POST",
  });
  return response.data;
}

function summarizeQuality(report) {
  const actionable = report.chapterReports
    .filter((item) => item.chapterStatus === "needs_repair" || (!(item.isMissing || item.isStale) && item.overall < THRESHOLD))
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

function getActiveJob(jobs) {
  return jobs.find((job) => ACTIVE_STATUSES.has(job.status)) ?? null;
}

function getManagedJobStatus(jobs) {
  if (!state.managedJobId) {
    return null;
  }
  return jobs.find((job) => job.id === state.managedJobId) ?? null;
}

function toTimestamp(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isJobStale(job) {
  if (!job || !ACTIVE_STATUSES.has(job.status)) {
    return false;
  }
  const now = Date.now();
  const heartbeatAt = toTimestamp(job.heartbeatAt);
  if (heartbeatAt !== null) {
    return now - heartbeatAt > ACTIVE_JOB_STALE_MS;
  }
  const updatedAt = toTimestamp(job.updatedAt);
  return updatedAt !== null && now - updatedAt > ACTIVE_JOB_STALE_MS;
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

function recordJobProgress(job) {
  const signature = getJobProgressSignature(job);
  if (state.activeJobProgressSignature !== signature) {
    state.activeJobProgressSignature = signature;
    state.activeJobProgressAt = timestamp();
  }
}

function clearJobProgress() {
  state.activeJobProgressSignature = null;
  state.activeJobProgressAt = null;
}

function isJobProgressStalled(job) {
  if (!job || !ACTIVE_STATUSES.has(job.status) || !state.activeJobProgressAt) {
    return false;
  }
  if (state.activeJobProgressSignature !== getJobProgressSignature(job)) {
    return false;
  }
  const lastProgressAt = toTimestamp(state.activeJobProgressAt);
  return lastProgressAt !== null && (Date.now() - lastProgressAt > ACTIVE_JOB_PROGRESS_STALL_MS);
}

function updateSnapshots(qualitySummary, continuityProgress) {
  state.quality = {
    actionableCount: qualitySummary.actionable.length,
    actionableChapters: qualitySummary.actionable.slice(0, 12),
    reviewableRecheckCount: qualitySummary.reviewableRecheck.length,
    reviewableRecheckPreview: qualitySummary.reviewableRecheck.slice(0, 12),
    finalizedRecheckCount: qualitySummary.finalizedRecheck.length,
    finalizedRecheckPreview: qualitySummary.finalizedRecheck.slice(0, 12),
  };
  state.continuity = {
    status: continuityProgress.status,
    lastPassedOrder: continuityProgress.lastPassedOrder,
    resumeOrder: continuityProgress.resumeOrder,
    nextBatchStartOrder: continuityProgress.nextBatchStartOrder,
    nextBatchEndOrder: continuityProgress.nextBatchEndOrder,
    blockedCount: continuityProgress.blockedChapters.length,
  };
}

async function maybeStartNextJob(qualitySummary, continuityProgress) {
  if (qualitySummary.reviewableRecheck.length > 0) {
    state.phase = "quality_review";
    state.lastAction = "start_quality_review_all";
    const job = await startReviewBatchJob("quality_review_all");
    state.managedJobId = job.id;
    state.managedJobType = job.jobType;
    log("Started quality review batch job.", {
      jobId: job.id,
      actionableCount: qualitySummary.actionable.length,
      reviewableRecheckCount: qualitySummary.reviewableRecheck.length,
    });
    return true;
  }

  if (qualitySummary.actionable.length > 0) {
    state.phase = "quality_repair";
    state.lastAction = "start_quality_repair_until_pass";
    const job = await startReviewBatchJob("quality_repair_until_pass");
    state.managedJobId = job.id;
    state.managedJobType = job.jobType;
    log("Started quality repair batch job.", {
      jobId: job.id,
      actionableCount: qualitySummary.actionable.length,
      actionablePreview: qualitySummary.actionable.slice(0, 8),
    });
    return true;
  }

  if (continuityProgress.status !== "completed") {
    state.phase = "continuity_audit";
    state.lastAction = "start_continuity_audit";
    const job = await startReviewBatchJob("continuity_audit");
    state.managedJobId = job.id;
    state.managedJobType = job.jobType;
    log("Started continuity audit batch job.", {
      jobId: job.id,
      resumeOrder: continuityProgress.resumeOrder,
      nextBatchStartOrder: continuityProgress.nextBatchStartOrder,
      nextBatchEndOrder: continuityProgress.nextBatchEndOrder,
    });
    return true;
  }

  if (qualitySummary.finalizedRecheck.length > 0) {
    state.phase = "quality_review_finalized";
    state.lastAction = "start_quality_review_finalized";
    const job = await startReviewBatchJob("quality_review_all", {
      includeFinalizedRecheck: true,
    });
    state.managedJobId = job.id;
    state.managedJobType = job.jobType;
    log("Started finalized chapter quality recheck batch job.", {
      jobId: job.id,
      finalizedRecheckCount: qualitySummary.finalizedRecheck.length,
      finalizedPreview: qualitySummary.finalizedRecheck.slice(0, 8),
    });
    return true;
  }

  state.status = "completed";
  state.phase = "done";
  state.lastAction = "completed";
  log("Overnight watchdog finished: quality is clear and continuity audit is complete.", {
    continuityLastPassedOrder: continuityProgress.lastPassedOrder,
  });
  return false;
}

async function main() {
  log("Quality/continuity watchdog booted.", {
    novelId: NOVEL_ID,
    threshold: THRESHOLD,
    provider: PROVIDER,
    model: MODEL,
  });

  while (state.status !== "completed" && state.status !== "failed") {
    try {
      const [jobs, qualityReport, continuityProgress] = await Promise.all([
        listReviewBatchJobs(),
        getQualityReport(),
        getContinuityProgress(),
      ]);
      const qualitySummary = summarizeQuality(qualityReport);
      updateSnapshots(qualitySummary, continuityProgress);

      const activeJob = getActiveJob(jobs);
      const managedJob = getManagedJobStatus(jobs);

      if (managedJob && TERMINAL_STATUSES.has(managedJob.status)) {
        if (managedJob.status === "failed") {
          state.failureCounts[managedJob.jobType] = (state.failureCounts[managedJob.jobType] ?? 0) + 1;
          log("Managed job failed.", {
            jobId: managedJob.id,
            jobType: managedJob.jobType,
            error: managedJob.error ?? null,
            failureCount: state.failureCounts[managedJob.jobType],
          });
          if (state.failureCounts[managedJob.jobType] > MAX_FAILURE_RESTARTS) {
            state.status = "failed";
            state.phase = "attention_required";
            state.lastAction = "stop_after_repeated_failures";
            log("Stopping watchdog after repeated failures.", {
              jobType: managedJob.jobType,
              failureCount: state.failureCounts[managedJob.jobType],
            });
            break;
          }
        } else if (managedJob.status === "cancelled") {
          log("Managed job was cancelled.", {
            jobId: managedJob.id,
            jobType: managedJob.jobType,
          });
        } else {
          state.failureCounts[managedJob.jobType] = 0;
          log("Managed job completed.", {
            jobId: managedJob.id,
            jobType: managedJob.jobType,
          });
        }
        state.managedJobId = null;
        state.managedJobType = null;
        clearJobProgress();
      }

      if (activeJob && isJobStale(activeJob)) {
        await cancelReviewBatchJob(activeJob.id);
        log("Cancelled stale active review job.", {
          jobId: activeJob.id,
          jobType: activeJob.jobType,
          heartbeatAt: activeJob.heartbeatAt ?? null,
          updatedAt: activeJob.updatedAt ?? null,
        });
        if (state.managedJobId === activeJob.id) {
          state.managedJobId = null;
          state.managedJobType = null;
        }
        clearJobProgress();
      } else if (activeJob) {
        recordJobProgress(activeJob);
        if (isJobProgressStalled(activeJob)) {
          await cancelReviewBatchJob(activeJob.id);
          log("Cancelled stalled active review job.", {
            jobId: activeJob.id,
            jobType: activeJob.jobType,
            completedCount: activeJob.completedCount,
            currentItemLabel: activeJob.currentItemLabel ?? null,
            progress: activeJob.progress ?? null,
            lastProgressAt: state.activeJobProgressAt,
          });
          if (state.managedJobId === activeJob.id) {
            state.managedJobId = null;
            state.managedJobType = null;
          }
          clearJobProgress();
        } else if (!state.managedJobId) {
          state.managedJobId = activeJob.id;
          state.managedJobType = activeJob.jobType;
          state.phase = activeJob.jobType;
          state.status = "running";
          state.lastAction = "adopt_active_job";
          log("Adopted existing active review job.", {
            jobId: activeJob.id,
            jobType: activeJob.jobType,
            currentStage: activeJob.currentStage,
            currentItemLabel: activeJob.currentItemLabel,
          });
        } else {
          state.phase = activeJob.jobType;
          state.status = "running";
        }
      } else if (!state.managedJobId) {
        clearJobProgress();
        await maybeStartNextJob(qualitySummary, continuityProgress);
      }

      persistState();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log("Watchdog loop error.", { error: message });
    }

    if (state.status === "completed" || state.status === "failed") {
      break;
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

void main().catch((error) => {
  state.status = "failed";
  state.phase = "crashed";
  state.lastAction = "crash";
  log("Quality/continuity watchdog crashed.", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
