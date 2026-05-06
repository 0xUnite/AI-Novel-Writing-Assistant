import type { NovelReviewBatchJob as PrismaNovelReviewBatchJob } from "@prisma/client";
import type { ContinuityBlockedChapterSummary, NovelReviewBatchJob } from "@ai-novel/shared/types/novel";
import type { LLMProvider } from "@ai-novel/shared/types/llm";
import type { RepairOptions } from "./novelCoreShared";
import { prisma } from "../../db/prisma";
import { isTransientLlmTransportError } from "../../llm/transientErrors";
import { collectStream } from "./novelProductionHelpers";
import { NovelCoreReviewService } from "./novelCoreReviewService";
import { buildApprovedChapterProgress, buildReviewedChapterProgress } from "./chapterProgressState";

interface ReviewBatchRunOptions {
  provider?: LLMProvider;
  model?: string;
  temperature?: number;
  threshold?: number;
  maxRepairAttempts?: number;
  autoRepairBlocked?: boolean;
  includeFinalizedRecheck?: boolean;
}

interface ReviewBatchPayload {
  provider?: LLMProvider;
  model?: string;
  temperature?: number;
  threshold?: number;
  autoRepairBlocked?: boolean;
  includeFinalizedRecheck?: boolean;
  chapterIds: string[];
  qualifiedCount?: number;
  repairedCount?: number;
  passedCount?: number;
  currentBatchStartOrder?: number | null;
  currentBatchEndOrder?: number | null;
  lastPassedOrder?: number | null;
  blockedChapters?: ContinuityBlockedChapterSummary[];
  issueIdsByChapter?: Record<string, string[]>;
  message?: string | null;
}

interface ChapterCandidate {
  id: string;
  title: string;
  order: number;
  content: string | null;
  generationState: string;
  chapterStatus: string | null;
  updatedAt: Date;
}

const DEFAULT_THRESHOLD = 75;
const DEFAULT_QUALITY_REPAIR_ATTEMPTS = 30;
const DEFAULT_CONTINUITY_REPAIR_ATTEMPTS = 8;
const CONTINUITY_AUDIT_BATCH_SIZE = 20;
const CONTINUITY_AUDIT_CONCURRENCY = 4;
const REVIEW_BATCH_HEARTBEAT_INTERVAL_MS = 15_000;
const CONTINUITY_REPORT_SKEW_TOLERANCE_MS = 10_000;
const QUALITY_REVIEW_STEP_TIMEOUT_MS = 300_000;
const CONTINUITY_AUDIT_STEP_TIMEOUT_MS = 180_000;
const CONTINUITY_REPAIR_STEP_TIMEOUT_MS = 480_000;
const CONTINUITY_REAUDIT_STEP_TIMEOUT_MS = 300_000;

function isActiveStatus(status: string | null | undefined): boolean {
  return status === "queued" || status === "running";
}

function isQualityQualified(
  score:
    | {
      coherence?: number | null;
      repetition?: number | null;
      pacing?: number | null;
      voice?: number | null;
      engagement?: number | null;
      overall?: number | null;
    }
    | null
    | undefined,
  threshold: number,
): boolean {
  if (!score) {
    return false;
  }
  return (score.coherence ?? 0) >= 60
    && (score.repetition ?? 100) <= 40
    && (score.pacing ?? 0) >= 60
    && (score.voice ?? 0) >= 60
    && (score.engagement ?? 0) >= 60
    && (score.overall ?? 0) >= threshold;
}

function formatChapterLabel(order: number, title: string | null | undefined): string {
  return `第${order}章 - ${title?.trim() || "未命名章节"}`;
}

function hasChapterContent(chapter: Pick<ChapterCandidate, "content">): boolean {
  return Boolean(chapter.content?.trim());
}

function isFinalizedChapter(chapter: Pick<ChapterCandidate, "generationState">): boolean {
  return chapter.generationState === "approved" || chapter.generationState === "published";
}

function resolveEffectiveChapterStatus(
  chapter: Pick<ChapterCandidate, "chapterStatus" | "generationState" | "content">,
): NonNullable<ChapterCandidate["chapterStatus"]> {
  const hasContent = hasChapterContent(chapter);
  if (isFinalizedChapter(chapter)) {
    return "completed";
  }
  if (chapter.chapterStatus === "needs_repair") {
    return "needs_repair";
  }
  if (
    (chapter.generationState === "drafted" || chapter.generationState === "reviewed" || chapter.generationState === "repaired")
    && hasContent
  ) {
    return "pending_review";
  }
  if (chapter.chapterStatus === "generating" && !hasContent) {
    return "generating";
  }
  if (chapter.chapterStatus) {
    return chapter.chapterStatus;
  }
  return hasContent ? "pending_review" : "pending_generation";
}

function isReportPendingRecheck(report: { isMissing?: boolean; isStale?: boolean } | undefined): boolean {
  return Boolean(report?.isMissing || report?.isStale);
}

function isFreshLowScoreReport(
  report: { overall?: number | null; isMissing?: boolean; isStale?: boolean } | undefined,
  threshold: number,
): boolean {
  return !isReportPendingRecheck(report) && typeof report?.overall === "number" && report.overall < threshold;
}

function isFreshQualifiedQualityReport(
  report:
    | {
      coherence?: number | null;
      repetition?: number | null;
      pacing?: number | null;
      voice?: number | null;
      engagement?: number | null;
      overall?: number | null;
      isMissing?: boolean;
      isStale?: boolean;
    }
    | undefined,
  threshold: number,
): boolean {
  return !isReportPendingRecheck(report)
    && isQualityQualified(report, threshold);
}

function isChapterMarkedForRepair(
  chapter: Pick<ChapterCandidate, "chapterStatus" | "generationState" | "content">,
): boolean {
  return resolveEffectiveChapterStatus(chapter) === "needs_repair";
}

function getQualityReviewPriority(
  chapter: Pick<ChapterCandidate, "chapterStatus" | "generationState" | "content">,
  report: { overall?: number | null; isMissing?: boolean; isStale?: boolean } | undefined,
  threshold: number,
): number {
  if (isChapterMarkedForRepair(chapter) || isFreshLowScoreReport(report, threshold)) {
    return 0;
  }
  if (resolveEffectiveChapterStatus(chapter) === "pending_review") {
    return 1;
  }
  if (isReportPendingRecheck(report) && !isFinalizedChapter(chapter)) {
    return 2;
  }
  return 3;
}

function hasBlockingContinuityIssue(
  audit:
    | {
      auditReports?: Array<{
        issues: Array<{ status: string; severity: string; id: string }>;
      }> | null;
    }
    | null
    | undefined,
): boolean {
  return (audit?.auditReports ?? [])
    .flatMap((report) => report.issues)
    .some((issue) => issue.status === "open" && (issue.severity === "high" || issue.severity === "critical"));
}

function isContinuityQualified(
  audit:
    | {
      score?: { coherence?: number | null } | null;
      auditReports?: Array<{
        issues: Array<{ status: string; severity: string; id: string }>;
      }> | null;
    }
    | null
    | undefined,
  threshold: number,
): boolean {
  return (audit?.score?.coherence ?? 0) >= threshold && !hasBlockingContinuityIssue(audit);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms: ${label}`)), timeoutMs);
    timeout.unref?.();
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) {
      clearTimeout(timeout);
    }
  });
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "未知错误");
}

function isRecoverableBatchStepError(error: unknown): boolean {
  return isTransientLlmTransportError(error)
    || /^Timeout after \d+ms:/i.test(getErrorMessage(error));
}

function buildContinuityBlockedChapter(
  chapter: Pick<ChapterCandidate, "id" | "order" | "title">,
  audit:
    | {
      score?: { coherence?: number | null } | null;
      auditReports?: Array<{
        issues: Array<{ status: string; severity: string; id: string }>;
      }> | null;
    }
    | null
    | undefined,
  threshold: number,
): ContinuityBlockedChapterSummary | null {
  if (!audit) {
    return {
      chapterId: chapter.id,
      chapterOrder: chapter.order,
      chapterLabel: formatChapterLabel(chapter.order, chapter.title),
      coherence: 0,
      issueIds: [],
    };
  }
  if (isContinuityQualified(audit, threshold)) {
    return null;
  }
  const issueIds = Array.from(new Set(
    (audit.auditReports ?? [])
      .flatMap((report) => report.issues)
      .filter((issue) => issue.status === "open")
      .map((issue) => issue.id),
  ));
  return {
    chapterId: chapter.id,
    chapterOrder: chapter.order,
    chapterLabel: formatChapterLabel(chapter.order, chapter.title),
    coherence: audit.score?.coherence ?? 0,
    issueIds,
  };
}

function isFreshContinuityAuditReport(
  chapterUpdatedAt: Date,
  reportCreatedAt?: Date | null,
): boolean {
  if (!reportCreatedAt) {
    return false;
  }
  return reportCreatedAt.getTime() >= chapterUpdatedAt.getTime() - CONTINUITY_REPORT_SKEW_TOLERANCE_MS;
}

function parsePayload(payload: string | null | undefined): ReviewBatchPayload {
  if (!payload?.trim()) {
    return { chapterIds: [] };
  }
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    const issueIdsByChapter = parsed.issueIdsByChapter && typeof parsed.issueIdsByChapter === "object"
      ? Object.fromEntries(
        Object.entries(parsed.issueIdsByChapter as Record<string, unknown>).map(([chapterId, issueIds]) => [
          chapterId,
          Array.isArray(issueIds)
            ? issueIds.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
            : [],
        ]),
      )
      : undefined;
    return {
      provider: typeof parsed.provider === "string" ? parsed.provider as LLMProvider : undefined,
      model: typeof parsed.model === "string" ? parsed.model : undefined,
      temperature: typeof parsed.temperature === "number" ? parsed.temperature : undefined,
      threshold: typeof parsed.threshold === "number" ? parsed.threshold : undefined,
      autoRepairBlocked: typeof parsed.autoRepairBlocked === "boolean" ? parsed.autoRepairBlocked : undefined,
      includeFinalizedRecheck: typeof parsed.includeFinalizedRecheck === "boolean" ? parsed.includeFinalizedRecheck : undefined,
      chapterIds: Array.isArray(parsed.chapterIds)
        ? parsed.chapterIds.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        : [],
      qualifiedCount: typeof parsed.qualifiedCount === "number" ? parsed.qualifiedCount : undefined,
      repairedCount: typeof parsed.repairedCount === "number" ? parsed.repairedCount : undefined,
      passedCount: typeof parsed.passedCount === "number" ? parsed.passedCount : undefined,
      currentBatchStartOrder: typeof parsed.currentBatchStartOrder === "number" ? parsed.currentBatchStartOrder : null,
      currentBatchEndOrder: typeof parsed.currentBatchEndOrder === "number" ? parsed.currentBatchEndOrder : null,
      lastPassedOrder: typeof parsed.lastPassedOrder === "number" ? parsed.lastPassedOrder : null,
      blockedChapters: Array.isArray(parsed.blockedChapters)
        ? parsed.blockedChapters
          .map((item) => {
            if (!item || typeof item !== "object" || Array.isArray(item)) {
              return null;
            }
            const record = item as Record<string, unknown>;
            if (
              typeof record.chapterId !== "string"
              || typeof record.chapterOrder !== "number"
              || typeof record.chapterLabel !== "string"
            ) {
              return null;
            }
            return {
              chapterId: record.chapterId,
              chapterOrder: record.chapterOrder,
              chapterLabel: record.chapterLabel,
              coherence: typeof record.coherence === "number" ? record.coherence : 0,
              issueIds: Array.isArray(record.issueIds)
                ? record.issueIds.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
                : [],
            } satisfies ContinuityBlockedChapterSummary;
          })
          .filter((item): item is ContinuityBlockedChapterSummary => Boolean(item))
        : [],
      issueIdsByChapter,
      message: typeof parsed.message === "string" ? parsed.message : null,
    };
  } catch {
    return { chapterIds: [] };
  }
}

function stringifyPayload(payload: ReviewBatchPayload): string {
  return JSON.stringify({
    ...(payload.provider ? { provider: payload.provider } : {}),
    ...(payload.model ? { model: payload.model } : {}),
    ...(typeof payload.temperature === "number" ? { temperature: payload.temperature } : {}),
    ...(typeof payload.threshold === "number" ? { threshold: payload.threshold } : {}),
    ...(typeof payload.autoRepairBlocked === "boolean" ? { autoRepairBlocked: payload.autoRepairBlocked } : {}),
    chapterIds: payload.chapterIds,
    qualifiedCount: payload.qualifiedCount ?? 0,
    repairedCount: payload.repairedCount ?? 0,
    passedCount: payload.passedCount ?? 0,
    currentBatchStartOrder: payload.currentBatchStartOrder ?? null,
    currentBatchEndOrder: payload.currentBatchEndOrder ?? null,
    lastPassedOrder: payload.lastPassedOrder ?? null,
    blockedChapters: payload.blockedChapters ?? [],
    issueIdsByChapter: payload.issueIdsByChapter ?? {},
    message: payload.message ?? null,
  });
}

function toOutput(
  row: PrismaNovelReviewBatchJob & { novelId: string },
  payload = parsePayload(row.payload),
): NovelReviewBatchJob {
  return {
    id: row.id,
    novelId: row.novelId,
    jobType: row.jobType,
    status: row.status,
    progress: row.progress,
    completedCount: row.completedCount,
    totalCount: row.totalCount,
    retryCount: row.retryCount,
    maxRetries: row.maxRetries,
    heartbeatAt: row.heartbeatAt?.toISOString() ?? null,
    currentStage: row.currentStage ?? null,
    currentItemKey: row.currentItemKey ?? null,
    currentItemLabel: row.currentItemLabel ?? null,
    cancelRequestedAt: row.cancelRequestedAt?.toISOString() ?? null,
    error: row.error ?? null,
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    threshold: payload.threshold ?? null,
    qualifiedCount: payload.qualifiedCount ?? 0,
    repairedCount: payload.repairedCount ?? 0,
    passedCount: payload.passedCount ?? 0,
    currentBatchStartOrder: payload.currentBatchStartOrder ?? null,
    currentBatchEndOrder: payload.currentBatchEndOrder ?? null,
    lastPassedOrder: payload.lastPassedOrder ?? null,
    blockedChapters: payload.blockedChapters ?? [],
    message: payload.message ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class NovelCoreReviewBatchService {
  private static activeJobIds = new Set<string>();

  private readonly reviewService = new NovelCoreReviewService();

  async listReviewBatchJobs(
    novelId: string,
    input: {
      jobTypes?: Array<NovelReviewBatchJob["jobType"]>;
      limit?: number;
    } = {},
  ): Promise<NovelReviewBatchJob[]> {
    const rows = await prisma.novelReviewBatchJob.findMany({
      where: {
        novelId,
        ...(input.jobTypes?.length ? { jobType: { in: input.jobTypes } } : {}),
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: Math.max(1, Math.min(input.limit ?? 20, 50)),
    });
    return rows.map((row) => toOutput(row));
  }

  async getReviewBatchJob(novelId: string, jobId: string): Promise<NovelReviewBatchJob | null> {
    const row = await prisma.novelReviewBatchJob.findFirst({
      where: { id: jobId, novelId },
    });
    return row ? toOutput(row) : null;
  }

  private async markChapterQualityResult(chapter: ChapterCandidate, qualified: boolean): Promise<void> {
    const updateChapterProgress = async (progress: { generationState: string; chapterStatus: string }) => {
      // Status-only transitions must not refresh Chapter.updatedAt, otherwise the
      // freshly created quality report looks stale even though the content did not change.
      await prisma.$executeRaw`
        UPDATE "Chapter"
        SET "generationState" = ${progress.generationState},
            "chapterStatus" = ${progress.chapterStatus}
        WHERE "id" = ${chapter.id}
      `;
    };

    if (qualified) {
      const progress = buildApprovedChapterProgress(chapter.generationState === "published" ? "published" : "approved");
      await updateChapterProgress(progress);
      return;
    }

    if (isFinalizedChapter(chapter)) {
      return;
    }
    const progress = buildReviewedChapterProgress({ hasIssues: true });
    await updateChapterProgress(progress);
  }

  async startQualityReviewJob(novelId: string, options: ReviewBatchRunOptions = {}): Promise<NovelReviewBatchJob> {
    return this.startJob(novelId, "quality_review_all", options);
  }

  async startQualityRepairJob(novelId: string, options: ReviewBatchRunOptions = {}): Promise<NovelReviewBatchJob> {
    try {
      return await this.startJob(novelId, "quality_repair_until_pass", options);
    } catch (error) {
      if (error instanceof Error && error.message === "当前没有待处理的质量章节。") {
        return this.startJob(novelId, "quality_review_all", options);
      }
      throw error;
    }
  }

  async startContinuityAuditJob(novelId: string, options: ReviewBatchRunOptions = {}): Promise<NovelReviewBatchJob> {
    return this.startJob(novelId, "continuity_audit", options);
  }

  async startContinuityRepairJob(novelId: string, options: ReviewBatchRunOptions = {}): Promise<NovelReviewBatchJob> {
    try {
      return await this.startJob(novelId, "continuity_repair_blocked", options);
    } catch (error) {
      if (error instanceof Error && error.message === "当前没有待修复的连贯性阻塞章节。") {
        return this.startJob(novelId, "continuity_audit", {
          ...options,
          autoRepairBlocked: true,
        });
      }
      throw error;
    }
  }

  async cancelReviewBatchJob(jobId: string): Promise<NovelReviewBatchJob> {
    const row = await prisma.novelReviewBatchJob.findUnique({ where: { id: jobId } });
    if (!row) {
      throw new Error("后台审校任务不存在。");
    }
    if (row.status === "succeeded" || row.status === "failed" || row.status === "cancelled") {
      throw new Error("仅排队中或运行中的后台审校任务可取消。");
    }
    const updated = row.status === "queued"
      ? await prisma.novelReviewBatchJob.update({
        where: { id: jobId },
        data: {
          status: "cancelled",
          cancelRequestedAt: null,
          heartbeatAt: null,
          currentStage: null,
          currentItemKey: null,
          currentItemLabel: null,
          finishedAt: new Date(),
        },
      })
      : await prisma.novelReviewBatchJob.update({
        where: { id: jobId },
        data: {
          status: "cancelled",
          cancelRequestedAt: new Date(),
          heartbeatAt: new Date(),
        },
      });
    return toOutput(updated);
  }

  async listPendingCancellationReviewBatchJobs(): Promise<Array<{ id: string; status: string }>> {
    const rows = await prisma.novelReviewBatchJob.findMany({
      where: {
        status: "cancelled",
        cancelRequestedAt: { not: null },
        finishedAt: null,
      },
      select: { id: true, status: true },
    });
    return rows;
  }

  async listRecoverableReviewBatchJobs(): Promise<Array<{ id: string; status: string }>> {
    const rows = await prisma.novelReviewBatchJob.findMany({
      where: {
        status: { in: ["queued", "running"] },
        cancelRequestedAt: null,
      },
      select: { id: true, status: true },
    });
    return rows;
  }

  async listStaleRecoverableReviewBatchJobs(cutoff: Date): Promise<Array<{ id: string; status: string }>> {
    const rows = await prisma.novelReviewBatchJob.findMany({
      where: {
        cancelRequestedAt: null,
        OR: [
          {
            status: "queued",
            updatedAt: { lt: cutoff },
          },
          {
            status: "running",
            OR: [
              {
                heartbeatAt: null,
                updatedAt: { lt: cutoff },
              },
              { heartbeatAt: { lt: cutoff } },
            ],
          },
        ],
      },
      select: { id: true, status: true },
    });
    return rows;
  }

  async markReviewBatchJobCancelled(jobId: string): Promise<void> {
    await this.updateJobSafe(jobId, {
      status: "cancelled",
      cancelRequestedAt: null,
      heartbeatAt: null,
      currentStage: null,
      currentItemKey: null,
      currentItemLabel: null,
      finishedAt: new Date(),
    });
  }

  async markReviewBatchJobFailed(jobId: string, message: string): Promise<void> {
    await this.updateJobSafe(jobId, {
      status: "failed",
      error: message,
      heartbeatAt: null,
      currentStage: null,
      currentItemKey: null,
      currentItemLabel: null,
      finishedAt: new Date(),
    });
  }

  async resumeReviewBatchJob(jobId: string): Promise<void> {
    const row = await prisma.novelReviewBatchJob.findUnique({
      where: { id: jobId },
      select: {
        id: true,
        novelId: true,
        jobType: true,
        status: true,
        payload: true,
        maxRetries: true,
      },
    });
    if (!row || !isActiveStatus(row.status)) {
      return;
    }
    this.scheduleJobExecution(row.id, row.novelId);
  }

  private async startJob(
    novelId: string,
    jobType: NovelReviewBatchJob["jobType"],
    options: ReviewBatchRunOptions,
  ): Promise<NovelReviewBatchJob> {
    const activeJob = await this.findActiveJob(novelId);
    if (activeJob) {
      const output = toOutput(activeJob);
      if (activeJob.jobType === jobType) {
        return {
          ...output,
          reusedExisting: true,
        };
      }
      throw new Error("当前已有其他质量/连贯性后台任务在运行，请等待完成后再启动新的后台任务。");
    }

    const prepared = await this.prepareJobPayload(novelId, jobType, options);
    const row = await prisma.novelReviewBatchJob.create({
      data: {
        novelId,
        jobType,
        status: "queued",
        totalCount: prepared.payload.chapterIds.length,
        maxRetries: prepared.maxRetries,
        currentStage: "queued",
        payload: stringifyPayload(prepared.payload),
      },
    });
    this.scheduleJobExecution(row.id, novelId);
    return toOutput(row, prepared.payload);
  }

  private async prepareJobPayload(
    novelId: string,
    jobType: NovelReviewBatchJob["jobType"],
    options: ReviewBatchRunOptions,
  ): Promise<{
    payload: ReviewBatchPayload;
    maxRetries: number;
  }> {
    const threshold = options.threshold ?? DEFAULT_THRESHOLD;
    if (jobType === "quality_review_all" || jobType === "quality_repair_until_pass") {
      const candidates = await this.getQualityCandidates(novelId, threshold, options.includeFinalizedRecheck ?? false);
      if (candidates.length === 0) {
        throw new Error(
          jobType === "quality_review_all"
            ? "当前没有待审校章节。"
            : "当前没有待处理的质量章节。",
        );
      }
      return {
        payload: {
          provider: options.provider,
        model: options.model,
        temperature: options.temperature,
        threshold,
        includeFinalizedRecheck: options.includeFinalizedRecheck,
        chapterIds: candidates.map((chapter) => chapter.id),
        qualifiedCount: 0,
        repairedCount: 0,
        message: jobType === "quality_review_all" ? "准备开始批量审校。" : "准备开始批量修复。",
        },
        maxRetries: jobType === "quality_repair_until_pass"
          ? Math.max(1, options.maxRepairAttempts ?? DEFAULT_QUALITY_REPAIR_ATTEMPTS)
          : 0,
      };
    }

    if (jobType === "continuity_audit") {
      const autoRepairBlocked = options.autoRepairBlocked ?? true;
      const progress = await this.reviewService.getContinuityAuditProgress(novelId, threshold);
      const chapters = (await prisma.chapter.findMany({
        where: { novelId },
        select: {
          id: true,
          title: true,
          order: true,
          content: true,
          generationState: true,
          chapterStatus: true,
          updatedAt: true,
        },
        orderBy: { order: "asc" },
      })).filter((chapter) => hasChapterContent(chapter) && chapter.order >= progress.resumeOrder);
      if (chapters.length === 0) {
        throw new Error("当前所有已写章节都已完成连贯性审查，可等待新章节生成后再继续。");
      }
      return {
        payload: {
          provider: options.provider,
          model: options.model,
          temperature: options.temperature,
          threshold,
          autoRepairBlocked,
          chapterIds: chapters.map((chapter) => chapter.id),
          passedCount: 0,
          repairedCount: 0,
          lastPassedOrder: progress.lastPassedOrder ?? null,
          currentBatchStartOrder: progress.nextBatchStartOrder ?? chapters[0]?.order ?? null,
          currentBatchEndOrder: progress.nextBatchEndOrder ?? chapters[Math.min(chapters.length, CONTINUITY_AUDIT_BATCH_SIZE) - 1]?.order ?? null,
          blockedChapters: progress.blockedChapters,
          issueIdsByChapter: Object.fromEntries(
            progress.blockedChapters.map((chapter) => [chapter.chapterId, chapter.issueIds]),
          ),
          message: progress.blockedChapters.length > 0
            ? autoRepairBlocked
              ? "已恢复上一批阻塞章节，将重新审查并在发现问题后自动修复。"
              : "已恢复上一批阻塞章节，可继续全书连贯守门。"
            : autoRepairBlocked
              ? "准备开始整体连贯性自动审查（发现阻塞将自动修复并继续）。"
              : "准备开始全书连贯守门。",
        },
        maxRetries: autoRepairBlocked
          ? Math.max(1, options.maxRepairAttempts ?? DEFAULT_CONTINUITY_REPAIR_ATTEMPTS)
          : 0,
      };
    }

    const progress = await this.reviewService.getContinuityAuditProgress(novelId, threshold);
    if (progress.blockedChapters.length === 0) {
      throw new Error("当前没有待修复的连贯性阻塞章节。");
    }
    return {
      payload: {
        provider: options.provider,
        model: options.model,
        temperature: options.temperature,
        threshold,
        chapterIds: progress.blockedChapters.map((chapter) => chapter.chapterId),
        passedCount: 0,
        repairedCount: 0,
        lastPassedOrder: progress.lastPassedOrder ?? null,
        currentBatchStartOrder: progress.nextBatchStartOrder ?? progress.blockedChapters[0]?.chapterOrder ?? null,
        currentBatchEndOrder: progress.nextBatchEndOrder ?? progress.blockedChapters[progress.blockedChapters.length - 1]?.chapterOrder ?? null,
        blockedChapters: progress.blockedChapters,
        issueIdsByChapter: Object.fromEntries(
          progress.blockedChapters.map((chapter) => [chapter.chapterId, chapter.issueIds]),
        ),
        message: "准备开始修复当前阻塞章节。",
      },
      maxRetries: Math.max(1, options.maxRepairAttempts ?? DEFAULT_CONTINUITY_REPAIR_ATTEMPTS),
    };
  }

  private scheduleJobExecution(jobId: string, novelId: string): void {
    if (NovelCoreReviewBatchService.activeJobIds.has(jobId)) {
      return;
    }
    NovelCoreReviewBatchService.activeJobIds.add(jobId);
    void this.executeJob(jobId, novelId)
      .catch(() => {
        // 后台任务异常已在 executeJob 内兜底，这里防止未处理拒绝。
      })
      .finally(() => {
        NovelCoreReviewBatchService.activeJobIds.delete(jobId);
      });
  }

  private async executeJob(jobId: string, novelId: string): Promise<void> {
    const row = await prisma.novelReviewBatchJob.findUnique({
      where: { id: jobId },
    });
    if (!row) {
      return;
    }
    const payload = parsePayload(row.payload);
    try {
      await this.updateJobSafe(jobId, {
        status: "running",
        startedAt: row.startedAt ?? new Date(),
        heartbeatAt: new Date(),
        currentStage: row.jobType === "continuity_audit" ? "auditing" : "reviewing",
      });

      if (row.jobType === "quality_review_all") {
        await this.executeQualityReviewAll(row, payload);
      } else if (row.jobType === "quality_repair_until_pass") {
        await this.executeQualityRepairUntilPass(row, payload);
      } else if (row.jobType === "continuity_audit") {
        await this.executeContinuityAudit(row, payload);
      } else {
        await this.executeContinuityRepair(row, payload);
      }
    } catch (error) {
      if (error instanceof Error && error.message === "REVIEW_BATCH_CANCELLED") {
        await this.updateJobSafe(jobId, {
          status: "cancelled",
          heartbeatAt: null,
          currentStage: null,
          currentItemKey: null,
          currentItemLabel: null,
          cancelRequestedAt: null,
          finishedAt: new Date(),
        });
        return;
      }
      await this.updateJobSafe(jobId, {
        status: "failed",
        error: error instanceof Error ? error.message : "后台审校任务执行失败。",
        heartbeatAt: null,
        currentStage: null,
        currentItemKey: null,
        currentItemLabel: null,
        finishedAt: new Date(),
      });
    }
  }

  private async executeQualityReviewAll(
    row: PrismaNovelReviewBatchJob,
    payload: ReviewBatchPayload,
  ): Promise<void> {
    const threshold = payload.threshold ?? DEFAULT_THRESHOLD;
    const chapters = await this.loadOrderedChapters(row.novelId, payload.chapterIds);
    let completedCount = row.completedCount;
    let qualifiedCount = payload.qualifiedCount ?? 0;
    let deferredCount = 0;
    let currentStage = "reviewing";
    let currentItemKey: string | null = row.currentItemKey;
    let currentItemLabel: string | null = row.currentItemLabel;
    const heartbeatTimer = this.startHeartbeat(row.id, () => ({
      currentStage,
      currentItemKey,
      currentItemLabel,
      progress: row.totalCount > 0 ? Number((completedCount / row.totalCount).toFixed(4)) : 0,
    }));

    try {
      for (let index = completedCount; index < chapters.length; index += 1) {
        const chapter = chapters[index];
        await this.ensureNotCancelled(row.id);
        const chapterLabel = formatChapterLabel(chapter.order, chapter.title);
        payload.message = `正在审校 ${chapterLabel}。`;
        currentStage = "reviewing";
        currentItemKey = chapter.id;
        currentItemLabel = chapterLabel;
        await this.updateJobSafe(row.id, {
          heartbeatAt: new Date(),
          currentStage,
          currentItemKey,
          currentItemLabel,
          payload: stringifyPayload(payload),
        });

        let review: Awaited<ReturnType<NovelCoreReviewService["reviewChapter"]>>;
        try {
          review = await withTimeout(
            this.reviewService.reviewChapter(row.novelId, chapter.id, {
              provider: payload.provider,
              model: payload.model,
              temperature: payload.temperature,
            }),
            QUALITY_REVIEW_STEP_TIMEOUT_MS,
            `Quality review chapter ${chapter.order}`,
          );
        } catch (error) {
          if (!isRecoverableBatchStepError(error)) {
            throw error;
          }
          deferredCount += 1;
          completedCount = index + 1;
          payload.qualifiedCount = qualifiedCount;
          payload.message = `${chapterLabel} 审校超时或临时失败，已保留为待审校。原因：${getErrorMessage(error)}`;
          await this.updateJobSafe(row.id, {
            completedCount,
            progress: row.totalCount > 0 ? Number((completedCount / row.totalCount).toFixed(4)) : 1,
            heartbeatAt: new Date(),
            currentStage,
            currentItemKey,
            currentItemLabel,
            payload: stringifyPayload(payload),
          });
          continue;
        }
        const qualified = isQualityQualified(review.score, threshold);
        await this.markChapterQualityResult(chapter, qualified);
        if (qualified) {
          qualifiedCount += 1;
        }
        completedCount = index + 1;
        payload.qualifiedCount = qualifiedCount;
        payload.message = qualified
          ? `${chapterLabel} 已达标。`
          : `${chapterLabel} 需要修复。`;
        currentStage = "reviewing";
        currentItemKey = chapter.id;
        currentItemLabel = chapterLabel;
        await this.updateJobSafe(row.id, {
          completedCount,
          progress: row.totalCount > 0 ? Number((completedCount / row.totalCount).toFixed(4)) : 1,
          heartbeatAt: new Date(),
          currentStage,
          currentItemKey,
          currentItemLabel,
          payload: stringifyPayload(payload),
        });
      }
    } finally {
      clearInterval(heartbeatTimer);
    }

    payload.message = deferredCount > 0
      ? `批量审校完成，共 ${row.totalCount} 章，其中 ${qualifiedCount} 章已达标，${deferredCount} 章因模型超时/临时失败保留待审校。`
      : `批量审校完成，共 ${row.totalCount} 章，其中 ${qualifiedCount} 章已达标。`;
    await this.updateJobSafe(row.id, {
      status: "succeeded",
      progress: 1,
      completedCount: row.totalCount,
      heartbeatAt: null,
      currentStage: null,
      currentItemKey: null,
      currentItemLabel: null,
      finishedAt: new Date(),
      payload: stringifyPayload(payload),
      error: null,
    });
  }

  private async executeQualityRepairUntilPass(
    row: PrismaNovelReviewBatchJob,
    payload: ReviewBatchPayload,
  ): Promise<void> {
    const threshold = payload.threshold ?? DEFAULT_THRESHOLD;
    const chapters = await this.loadOrderedChapters(row.novelId, payload.chapterIds);
    let completedCount = row.completedCount;
    let qualifiedCount = payload.qualifiedCount ?? 0;
    let repairedCount = payload.repairedCount ?? 0;
    let retryCount = row.retryCount;
    let currentStage = row.currentStage ?? "reviewing";
    let currentItemKey: string | null = row.currentItemKey;
    let currentItemLabel: string | null = row.currentItemLabel;
    const heartbeatTimer = this.startHeartbeat(row.id, () => ({
      currentStage,
      currentItemKey,
      currentItemLabel,
      progress: row.totalCount > 0 ? Number((completedCount / row.totalCount).toFixed(4)) : 0,
    }));

    try {
      for (let index = completedCount; index < chapters.length; index += 1) {
        const chapter = chapters[index];
        await this.ensureNotCancelled(row.id);
        const chapterLabel = formatChapterLabel(chapter.order, chapter.title);
        payload.message = `正在审校 ${chapterLabel}。`;
        currentStage = "reviewing";
        currentItemKey = chapter.id;
        currentItemLabel = chapterLabel;
        await this.updateJobSafe(row.id, {
          heartbeatAt: new Date(),
          currentStage,
          currentItemKey,
          currentItemLabel,
          payload: stringifyPayload(payload),
        });

        let review = await withTimeout(
          this.reviewService.reviewChapter(row.novelId, chapter.id, {
            provider: payload.provider,
            model: payload.model,
            temperature: payload.temperature,
          }),
          QUALITY_REVIEW_STEP_TIMEOUT_MS,
          `Quality review chapter ${chapter.order}`,
        );
        let attempts = 0;
        let pendingContinuityIssueIds: string[] = [];
        while (true) {
          await this.ensureNotCancelled(row.id);
          if (!isQualityQualified(review.score, threshold)) {
            attempts += 1;
            retryCount += 1;
            repairedCount += 1;
            payload.repairedCount = repairedCount;
            payload.message = `${chapterLabel} 第 ${attempts} 次质量修复中。`;
            currentStage = "repairing";
            currentItemKey = chapter.id;
            currentItemLabel = chapterLabel;
            await this.updateJobSafe(row.id, {
              retryCount,
              heartbeatAt: new Date(),
              currentStage,
              currentItemKey,
              currentItemLabel,
              payload: stringifyPayload(payload),
            });
            if (attempts > row.maxRetries) {
              throw new Error(`${chapterLabel} 连续修复 ${row.maxRetries} 次后仍未达标，请检查该章问题后再继续。`);
            }
            await this.runRepair(row.novelId, chapter.id, {
              provider: payload.provider,
              model: payload.model,
              temperature: payload.temperature,
              reviewIssues: review.issues,
            });
            review = await this.reviewService.reviewChapter(row.novelId, chapter.id, {
              provider: payload.provider,
              model: payload.model,
              temperature: payload.temperature,
            });
            pendingContinuityIssueIds = [];
            continue;
          }

          const continuityAudit = await this.reviewService.auditChapter(row.novelId, chapter.id, "continuity", {
            provider: payload.provider,
            model: payload.model,
            temperature: payload.temperature ?? 0.1,
          });
          const continuityBlocked = buildContinuityBlockedChapter(chapter, continuityAudit, threshold);
          if (!continuityBlocked) {
            if (pendingContinuityIssueIds.length > 0) {
              await this.reviewService.resolveAuditIssues(row.novelId, pendingContinuityIssueIds).catch(() => null);
            }
            break;
          }

          attempts += 1;
          retryCount += 1;
          repairedCount += 1;
          pendingContinuityIssueIds = continuityBlocked.issueIds;
          payload.repairedCount = repairedCount;
          payload.message = `${chapterLabel} 触发连贯性护栏，第 ${attempts} 次修复中。`;
          currentStage = "repairing";
          currentItemKey = chapter.id;
          currentItemLabel = chapterLabel;
          await this.updateJobSafe(row.id, {
            retryCount,
            heartbeatAt: new Date(),
            currentStage,
            currentItemKey,
            currentItemLabel,
            payload: stringifyPayload(payload),
          });
          if (attempts > row.maxRetries) {
            throw new Error(`${chapterLabel} 质量已达标，但连贯性修复 ${row.maxRetries} 次后仍未通过，请检查上下文后再继续。`);
          }
          await this.runRepair(row.novelId, chapter.id, {
            provider: payload.provider,
            model: payload.model,
            temperature: payload.temperature,
            auditIssueIds: continuityBlocked.issueIds,
          });
          review = await this.reviewService.reviewChapter(row.novelId, chapter.id, {
            provider: payload.provider,
            model: payload.model,
            temperature: payload.temperature,
          });
        }

        qualifiedCount += 1;
        completedCount = index + 1;
        payload.qualifiedCount = qualifiedCount;
        payload.repairedCount = repairedCount;
        payload.message = `${chapterLabel} 已通过质量与连贯性护栏。`;
        await this.markChapterQualityResult(chapter, true);
        currentStage = "reviewing";
        currentItemKey = chapter.id;
        currentItemLabel = chapterLabel;
        await this.updateJobSafe(row.id, {
          completedCount,
          retryCount,
          progress: row.totalCount > 0 ? Number((completedCount / row.totalCount).toFixed(4)) : 1,
          heartbeatAt: new Date(),
          currentStage,
          currentItemKey,
          currentItemLabel,
          payload: stringifyPayload(payload),
        });
      }
    } finally {
      clearInterval(heartbeatTimer);
    }

    payload.message = `批量修复完成，共 ${row.totalCount} 章，已全部达到阈值 ${threshold}。`;
    await this.updateJobSafe(row.id, {
      status: "succeeded",
      progress: 1,
      completedCount: row.totalCount,
      retryCount,
      heartbeatAt: null,
      currentStage: null,
      currentItemKey: null,
      currentItemLabel: null,
      finishedAt: new Date(),
      payload: stringifyPayload(payload),
      error: null,
    });
  }

  private async executeContinuityAudit(
    row: PrismaNovelReviewBatchJob,
    payload: ReviewBatchPayload,
  ): Promise<void> {
    const threshold = payload.threshold ?? DEFAULT_THRESHOLD;
    const autoRepairBlocked = payload.autoRepairBlocked ?? true;
    const chapters = await this.loadOrderedChapters(row.novelId, payload.chapterIds);
    let completedCount = row.completedCount;
    let passedCount = payload.passedCount ?? 0;
    let repairedCount = payload.repairedCount ?? 0;
    let retryCount = row.retryCount;
    let lastPassedOrder = payload.lastPassedOrder ?? null;
    let currentStage = "auditing";
    let currentItemKey: string | null = row.currentItemKey;
    let currentItemLabel: string | null = row.currentItemLabel;
    const heartbeatTimer = this.startHeartbeat(row.id, () => ({
      currentStage,
      currentItemKey,
      currentItemLabel,
      progress: row.totalCount > 0 ? Number((completedCount / row.totalCount).toFixed(4)) : 0,
    }));

    try {
      if (payload.blockedChapters && payload.blockedChapters.length > 0 && autoRepairBlocked) {
        const repaired = await this.repairContinuityBlockedChapters({
          row,
          payload,
          chapters,
          blockedChapters: payload.blockedChapters,
          completedCount,
          passedCount,
          repairedCount,
          retryCount,
          countCompletedOnPass: false,
          onProgressState: (state) => {
            currentStage = state.currentStage;
            currentItemKey = state.currentItemKey;
            currentItemLabel = state.currentItemLabel;
          },
        });
        completedCount = repaired.completedCount;
        passedCount = repaired.passedCount;
        repairedCount = repaired.repairedCount;
        retryCount = repaired.retryCount;
        payload.issueIdsByChapter = repaired.issueIdsByChapter;
        if (repaired.remainingBlocked.length > 0) {
          payload.blockedChapters = repaired.remainingBlocked;
          payload.repairedCount = repairedCount;
          payload.passedCount = passedCount;
          payload.message = `本轮连贯性修复完成，仍有 ${repaired.remainingBlocked.length} 章暂未通过；已保留阻塞，可稍后继续一键修复。`;
          await this.updateJobSafe(row.id, {
            status: "succeeded",
            progress: row.totalCount > 0 ? Number((completedCount / row.totalCount).toFixed(4)) : 1,
            completedCount,
            retryCount,
            heartbeatAt: null,
            currentStage: null,
            currentItemKey: repaired.remainingBlocked[0]?.chapterId ?? null,
            currentItemLabel: repaired.remainingBlocked[0]?.chapterLabel ?? null,
            finishedAt: new Date(),
            payload: stringifyPayload(payload),
            error: null,
          });
          return;
        }
        payload.blockedChapters = [];
        lastPassedOrder = payload.currentBatchEndOrder ?? chapters[completedCount - 1]?.order ?? lastPassedOrder;
        payload.lastPassedOrder = lastPassedOrder;
      }

      while (completedCount < chapters.length) {
        const batchStartIndex = Math.floor(completedCount / CONTINUITY_AUDIT_BATCH_SIZE) * CONTINUITY_AUDIT_BATCH_SIZE;
        const batch = chapters.slice(batchStartIndex, batchStartIndex + CONTINUITY_AUDIT_BATCH_SIZE);
        const batchStartOrder = batch[0]?.order ?? null;
        const batchEndOrder = batch[batch.length - 1]?.order ?? null;
        const repairedCountBeforeBatch = repairedCount;
        const blockedInBatch = completedCount > batchStartIndex && payload.currentBatchStartOrder === batchStartOrder
          ? [...(payload.blockedChapters ?? [])]
          : [];
        payload.currentBatchStartOrder = batchStartOrder;
        payload.currentBatchEndOrder = batchEndOrder;
        payload.blockedChapters = blockedInBatch;

        for (let offset = completedCount - batchStartIndex; offset < batch.length; offset += CONTINUITY_AUDIT_CONCURRENCY) {
          await this.ensureNotCancelled(row.id);
          const auditGroup = batch.slice(offset, offset + CONTINUITY_AUDIT_CONCURRENCY);
          const firstChapter = auditGroup[0];
          const lastChapter = auditGroup[auditGroup.length - 1];
          const groupLabel = auditGroup.length === 1
            ? formatChapterLabel(firstChapter.order, firstChapter.title)
            : `第${firstChapter.order}章 - 第${lastChapter.order}章`;
          payload.message = `正在并行审查 ${groupLabel}。`;
          currentStage = "auditing";
          currentItemKey = firstChapter.id;
          currentItemLabel = groupLabel;
          await this.updateJobSafe(row.id, {
            heartbeatAt: new Date(),
            currentStage,
            currentItemKey,
            currentItemLabel,
            payload: stringifyPayload(payload),
          });

          const pendingAuditTasks = auditGroup.map((chapter) => ({
            chapterId: chapter.id,
            promise: withTimeout(
              this.reviewService.auditChapter(row.novelId, chapter.id, "continuity", {
                provider: payload.provider,
                model: payload.model,
                temperature: payload.temperature ?? 0.1,
              }),
              CONTINUITY_AUDIT_STEP_TIMEOUT_MS,
              `Continuity audit chapter ${chapter.order}`,
            )
              .then((auditResult) => ({
                chapter,
                status: "fulfilled" as const,
                auditResult,
              }))
              .catch((reason) => ({
                chapter,
                status: "rejected" as const,
                reason,
              })),
          }));

          let auditError: Error | null = null;
          while (pendingAuditTasks.length > 0) {
            const settled = await Promise.race(
              pendingAuditTasks.map(({ chapterId, promise }) => promise.then((result) => ({ chapterId, result }))),
            );
            const pendingIndex = pendingAuditTasks.findIndex((task) => task.chapterId === settled.chapterId);
            if (pendingIndex >= 0) {
              pendingAuditTasks.splice(pendingIndex, 1);
            }

            if (settled.result.status === "rejected") {
              if (!auditError) {
                auditError = settled.result.reason instanceof Error
                  ? settled.result.reason
                  : new Error("全书连贯守门失败。");
              }
              continue;
            }

            const { chapter, auditResult } = settled.result;
            const chapterLabel = formatChapterLabel(chapter.order, chapter.title);
            completedCount += 1;
            const blocked = buildContinuityBlockedChapter(chapter, auditResult, threshold);
            if (blocked) {
              if (!blockedInBatch.some((item) => item.chapterId === blocked.chapterId)) {
                blockedInBatch.push(blocked);
              }
            } else {
              passedCount += 1;
            }
            payload.passedCount = passedCount;
            payload.blockedChapters = blockedInBatch;
            payload.message = blocked
              ? `${chapterLabel} 存在连贯性问题，继续完成当前 20 章批次检查。`
              : blockedInBatch.length > 0
                ? `${chapterLabel} 审查通过；当前批次已发现 ${blockedInBatch.length} 章阻塞，完成剩余章节后将自动修复。`
                : `${chapterLabel} 审查通过。`;
            currentStage = "auditing";
            currentItemKey = chapter.id;
            currentItemLabel = chapterLabel;
            await this.updateJobSafe(row.id, {
              completedCount,
              progress: row.totalCount > 0 ? Number((completedCount / row.totalCount).toFixed(4)) : 1,
              heartbeatAt: new Date(),
              currentStage,
              currentItemKey,
              currentItemLabel,
              payload: stringifyPayload(payload),
            });
          }

          if (auditError) {
            throw auditError;
          }
        }

        if (blockedInBatch.length > 0) {
          payload.blockedChapters = blockedInBatch;
          payload.issueIdsByChapter = {
            ...(payload.issueIdsByChapter ?? {}),
            ...Object.fromEntries(blockedInBatch.map((chapter) => [chapter.chapterId, chapter.issueIds])),
          };
          if (!autoRepairBlocked) {
            payload.message = `第 ${batchStartOrder}-${batchEndOrder} 章中有 ${blockedInBatch.length} 章存在连贯性问题，请先修复后再继续。`;
            await this.updateJobSafe(row.id, {
              status: "succeeded",
              progress: row.totalCount > 0 ? Number((completedCount / row.totalCount).toFixed(4)) : 1,
              completedCount,
              retryCount,
              heartbeatAt: null,
              currentStage: null,
              currentItemKey: blockedInBatch[0]?.chapterId ?? null,
              currentItemLabel: blockedInBatch[0]?.chapterLabel ?? null,
              finishedAt: new Date(),
              payload: stringifyPayload(payload),
              error: null,
            });
            return;
          }

          payload.message = `第 ${batchStartOrder}-${batchEndOrder} 章发现 ${blockedInBatch.length} 章连贯性问题，开始自动修复。`;
          currentStage = "repairing";
          currentItemKey = blockedInBatch[0]?.chapterId ?? null;
          currentItemLabel = blockedInBatch[0]?.chapterLabel ?? null;
          await this.updateJobSafe(row.id, {
            retryCount,
            heartbeatAt: new Date(),
            currentStage,
            currentItemKey,
            currentItemLabel,
            payload: stringifyPayload(payload),
          });

          const repaired = await this.repairContinuityBlockedChapters({
            row,
            payload,
            chapters,
            blockedChapters: blockedInBatch,
            completedCount,
            passedCount,
            repairedCount,
            retryCount,
            countCompletedOnPass: false,
            onProgressState: (state) => {
              currentStage = state.currentStage;
              currentItemKey = state.currentItemKey;
              currentItemLabel = state.currentItemLabel;
            },
          });
          completedCount = repaired.completedCount;
          passedCount = repaired.passedCount;
          repairedCount = repaired.repairedCount;
          retryCount = repaired.retryCount;
          payload.issueIdsByChapter = repaired.issueIdsByChapter;
          if (repaired.remainingBlocked.length > 0) {
            payload.blockedChapters = repaired.remainingBlocked;
            payload.repairedCount = repairedCount;
            payload.passedCount = passedCount;
            payload.message = `第 ${batchStartOrder}-${batchEndOrder} 章本轮自动修复完成，仍有 ${repaired.remainingBlocked.length} 章暂未通过；已暂停后续批次，等待继续修复。`;
            await this.updateJobSafe(row.id, {
              status: "succeeded",
              progress: row.totalCount > 0 ? Number((completedCount / row.totalCount).toFixed(4)) : 1,
              completedCount,
              retryCount,
              heartbeatAt: null,
              currentStage: null,
              currentItemKey: repaired.remainingBlocked[0]?.chapterId ?? null,
              currentItemLabel: repaired.remainingBlocked[0]?.chapterLabel ?? null,
              finishedAt: new Date(),
              payload: stringifyPayload(payload),
              error: null,
            });
            return;
          }
          payload.blockedChapters = [];
        }

        lastPassedOrder = batchEndOrder;
        payload.lastPassedOrder = lastPassedOrder;
        payload.blockedChapters = [];
        payload.repairedCount = repairedCount;
        payload.passedCount = passedCount;
        payload.message = autoRepairBlocked && repairedCount > repairedCountBeforeBatch
          ? `第 ${batchStartOrder}-${batchEndOrder} 章已完成审查，阻塞章节已自动修复并复审通过，准备进入下一批。`
          : `第 ${batchStartOrder}-${batchEndOrder} 章已通过连贯性审查，准备进入下一批。`;
        currentStage = "auditing";
        currentItemKey = batch[batch.length - 1]?.id ?? null;
        currentItemLabel = batch[batch.length - 1]
          ? formatChapterLabel(batch[batch.length - 1].order, batch[batch.length - 1].title)
          : null;
        await this.updateJobSafe(row.id, {
          completedCount,
          retryCount,
          progress: row.totalCount > 0 ? Number((completedCount / row.totalCount).toFixed(4)) : 1,
          heartbeatAt: new Date(),
          currentStage,
          currentItemKey,
          currentItemLabel,
          payload: stringifyPayload(payload),
        });
      }
    } finally {
      clearInterval(heartbeatTimer);
    }

    payload.message = `全书连贯守门完成，已通过当前全部 ${row.totalCount} 章。`;
    payload.blockedChapters = [];
    await this.updateJobSafe(row.id, {
      status: "succeeded",
      progress: 1,
      completedCount: row.totalCount,
      retryCount,
      heartbeatAt: null,
      currentStage: null,
      currentItemKey: null,
      currentItemLabel: null,
      finishedAt: new Date(),
      payload: stringifyPayload(payload),
      error: null,
    });
  }

  private async executeContinuityRepair(
    row: PrismaNovelReviewBatchJob,
    payload: ReviewBatchPayload,
  ): Promise<void> {
    const chapters = await this.loadOrderedChapters(row.novelId, payload.chapterIds);
    let completedCount = row.completedCount;
    let passedCount = payload.passedCount ?? 0;
    let repairedCount = payload.repairedCount ?? 0;
    let retryCount = row.retryCount;
    let currentStage = row.currentStage && row.currentStage !== "queued" ? row.currentStage : "repairing";
    let currentItemKey: string | null = row.currentItemKey;
    let currentItemLabel: string | null = row.currentItemLabel;
    const heartbeatTimer = this.startHeartbeat(row.id, () => ({
      currentStage,
      currentItemKey,
      currentItemLabel,
      progress: row.totalCount > 0 ? Number((completedCount / row.totalCount).toFixed(4)) : 0,
    }));

    try {
      const repaired = await this.repairContinuityBlockedChapters({
        row,
        payload,
        chapters,
        blockedChapters: payload.blockedChapters ?? [],
        completedCount,
        passedCount,
        repairedCount,
        retryCount,
        countCompletedOnPass: true,
        onProgressState: (state) => {
          currentStage = state.currentStage;
          currentItemKey = state.currentItemKey;
          currentItemLabel = state.currentItemLabel;
        },
      });
      completedCount = repaired.completedCount;
      passedCount = repaired.passedCount;
      repairedCount = repaired.repairedCount;
      retryCount = repaired.retryCount;
      payload.issueIdsByChapter = repaired.issueIdsByChapter;
      payload.blockedChapters = repaired.remainingBlocked;
    } finally {
      clearInterval(heartbeatTimer);
    }

    const remainingBlocked = payload.blockedChapters ?? [];
    payload.message = remainingBlocked.length > 0
      ? `本轮修复已结束，仍有 ${remainingBlocked.length} 章暂未通过；可再次点击一键修复当前阻塞继续。`
      : "当前阻塞章节已全部修复，可继续进行全书连贯守门。";
    await this.updateJobSafe(row.id, {
      status: "succeeded",
      progress: remainingBlocked.length > 0 && row.totalCount > 0
        ? Number((completedCount / row.totalCount).toFixed(4))
        : 1,
      completedCount: remainingBlocked.length > 0 ? completedCount : row.totalCount,
      retryCount,
      heartbeatAt: null,
      currentStage: null,
      currentItemKey: remainingBlocked[0]?.chapterId ?? null,
      currentItemLabel: remainingBlocked[0]?.chapterLabel ?? null,
      finishedAt: new Date(),
      payload: stringifyPayload(payload),
      error: null,
    });
  }

  private async repairContinuityBlockedChapters(input: {
    row: PrismaNovelReviewBatchJob;
    payload: ReviewBatchPayload;
    chapters: ChapterCandidate[];
    blockedChapters: ContinuityBlockedChapterSummary[];
    completedCount: number;
    passedCount: number;
    repairedCount: number;
    retryCount: number;
    countCompletedOnPass: boolean;
    onProgressState?: (state: {
      currentStage: string;
      currentItemKey: string | null;
      currentItemLabel: string | null;
    }) => void;
  }): Promise<{
    completedCount: number;
    passedCount: number;
    repairedCount: number;
    retryCount: number;
    remainingBlocked: ContinuityBlockedChapterSummary[];
    issueIdsByChapter: Record<string, string[]>;
  }> {
    const threshold = input.payload.threshold ?? DEFAULT_THRESHOLD;
    const chapterById = new Map(input.chapters.map((chapter) => [chapter.id, chapter]));
    const remainingBlocked = [...input.blockedChapters];
    const issueIdsByChapter = {
      ...(input.payload.issueIdsByChapter ?? {}),
    };
    let completedCount = input.completedCount;
    let passedCount = input.passedCount;
    let repairedCount = input.repairedCount;
    let retryCount = input.retryCount;

    const chaptersToRepair = input.chapters.filter((chapter) => (
      remainingBlocked.some((item) => item.chapterId === chapter.id)
    ));

    for (const chapter of chaptersToRepair) {
      const chapterLabel = formatChapterLabel(chapter.order, chapter.title);
      let latestBlocked = remainingBlocked.find((item) => item.chapterId === chapter.id) ?? {
        chapterId: chapter.id,
        chapterOrder: chapter.order,
        chapterLabel,
        coherence: 0,
        issueIds: issueIdsByChapter[chapter.id] ?? [],
      };
      let attempts = 0;

      while (true) {
        await this.ensureNotCancelled(input.row.id);
        const latestChapterRow = await prisma.chapter.findUnique({
          where: { id: chapter.id },
          select: { id: true, title: true, order: true, content: true, updatedAt: true, generationState: true, chapterStatus: true },
        });
        const latestChapter = latestChapterRow ?? chapterById.get(chapter.id) ?? chapter;
        const latestContinuityReport = await this.loadLatestContinuityAuditSnapshot(input.row.novelId, chapter.id);
        let currentBlocked = isFreshContinuityAuditReport(
          latestChapter.updatedAt,
          latestContinuityReport?.createdAt,
        )
          ? buildContinuityBlockedChapter(latestChapter, {
            score: { coherence: latestContinuityReport?.overallScore ?? 0 },
            auditReports: latestContinuityReport ? [{
              issues: latestContinuityReport.issues.map((issue) => ({
                id: issue.id,
                status: issue.status,
                severity: issue.severity,
              })),
            }] : [],
          }, threshold)
          : latestBlocked;

        if (!currentBlocked) {
          await this.reviewService.resolveAuditIssues(input.row.novelId, latestBlocked.issueIds).catch(() => null);
          passedCount += 1;
          input.payload.passedCount = passedCount;
          input.payload.lastPassedOrder = latestChapter.order;
          delete issueIdsByChapter[chapter.id];
          const removeIndex = remainingBlocked.findIndex((item) => item.chapterId === chapter.id);
          if (removeIndex >= 0) {
            remainingBlocked.splice(removeIndex, 1);
          }
          if (input.countCompletedOnPass) {
            completedCount += 1;
          }
          input.payload.blockedChapters = remainingBlocked;
          input.payload.issueIdsByChapter = issueIdsByChapter;
          input.payload.message = input.countCompletedOnPass
            ? `${chapterLabel} 已通过连贯性审查，可继续下一批。`
            : `${chapterLabel} 已通过最新连贯性复审。`;
          input.onProgressState?.({
            currentStage: "auditing",
            currentItemKey: chapter.id,
            currentItemLabel: chapterLabel,
          });
          await this.updateJobSafe(input.row.id, {
            completedCount,
            retryCount,
            progress: input.row.totalCount > 0 ? Number((completedCount / input.row.totalCount).toFixed(4)) : 1,
            heartbeatAt: new Date(),
            currentStage: "auditing",
            currentItemKey: chapter.id,
            currentItemLabel: chapterLabel,
            payload: stringifyPayload(input.payload),
          });
          break;
        }

        if (currentBlocked.isExpired || currentBlocked.isMissing || currentBlocked.issueIds.length === 0) {
          input.payload.blockedChapters = remainingBlocked;
          input.payload.issueIdsByChapter = issueIdsByChapter;
          input.payload.message = `${chapterLabel} 的连贯性报告已过期或缺少具体问题，先复审再决定是否修复。`;
          input.onProgressState?.({
            currentStage: "auditing",
            currentItemKey: chapter.id,
            currentItemLabel: chapterLabel,
          });
          await this.updateJobSafe(input.row.id, {
            retryCount,
            heartbeatAt: new Date(),
            currentStage: "auditing",
            currentItemKey: chapter.id,
            currentItemLabel: chapterLabel,
            payload: stringifyPayload(input.payload),
          });

          let recheckedBlocked: ContinuityBlockedChapterSummary | null;
          try {
            const auditResult = await withTimeout(
              this.reviewService.auditChapter(input.row.novelId, chapter.id, "continuity", {
                provider: input.payload.provider,
                model: input.payload.model,
                temperature: input.payload.temperature ?? 0.1,
              }),
              CONTINUITY_REAUDIT_STEP_TIMEOUT_MS,
              `Continuity pre-repair audit chapter ${chapter.order}`,
            );
            recheckedBlocked = buildContinuityBlockedChapter(latestChapter, auditResult, threshold);
          } catch (error) {
            if (!isRecoverableBatchStepError(error)) {
              throw error;
            }
            input.payload.message = `${chapterLabel} 复审超时或临时失败，已保留为阻塞，继续处理其他章节。原因：${getErrorMessage(error)}`;
            await this.updateJobSafe(input.row.id, {
              retryCount,
              heartbeatAt: new Date(),
              currentStage: "auditing",
              currentItemKey: chapter.id,
              currentItemLabel: chapterLabel,
              payload: stringifyPayload(input.payload),
            });
            break;
          }

          if (!recheckedBlocked) {
            await this.reviewService.resolveAuditIssues(input.row.novelId, latestBlocked.issueIds).catch(() => null);
            passedCount += 1;
            input.payload.passedCount = passedCount;
            input.payload.lastPassedOrder = latestChapter.order;
            delete issueIdsByChapter[chapter.id];
            const removeIndex = remainingBlocked.findIndex((item) => item.chapterId === chapter.id);
            if (removeIndex >= 0) {
              remainingBlocked.splice(removeIndex, 1);
            }
            if (input.countCompletedOnPass) {
              completedCount += 1;
            }
            input.payload.blockedChapters = remainingBlocked;
            input.payload.issueIdsByChapter = issueIdsByChapter;
            input.payload.message = input.countCompletedOnPass
              ? `${chapterLabel} 复审通过，可继续下一批。`
              : `${chapterLabel} 复审通过，无需重写修复。`;
            input.onProgressState?.({
              currentStage: "auditing",
              currentItemKey: chapter.id,
              currentItemLabel: chapterLabel,
            });
            await this.updateJobSafe(input.row.id, {
              completedCount,
              retryCount,
              progress: input.row.totalCount > 0 ? Number((completedCount / input.row.totalCount).toFixed(4)) : 1,
              heartbeatAt: new Date(),
              currentStage: "auditing",
              currentItemKey: chapter.id,
              currentItemLabel: chapterLabel,
              payload: stringifyPayload(input.payload),
            });
            break;
          }

          currentBlocked = recheckedBlocked;
          latestBlocked = recheckedBlocked;
          issueIdsByChapter[chapter.id] = latestBlocked.issueIds;
          const existingIndex = remainingBlocked.findIndex((item) => item.chapterId === chapter.id);
          if (existingIndex >= 0) {
            remainingBlocked[existingIndex] = latestBlocked;
          } else {
            remainingBlocked.push(latestBlocked);
          }
          input.payload.blockedChapters = remainingBlocked;
          input.payload.issueIdsByChapter = issueIdsByChapter;
          input.payload.message = `${chapterLabel} 复审仍未通过，开始按最新问题修复。`;
          await this.updateJobSafe(input.row.id, {
            retryCount,
            heartbeatAt: new Date(),
            currentStage: "auditing",
            currentItemKey: chapter.id,
            currentItemLabel: chapterLabel,
            payload: stringifyPayload(input.payload),
          });
        }

        latestBlocked = currentBlocked;
        attempts += 1;
        retryCount += 1;
        repairedCount += 1;
        issueIdsByChapter[chapter.id] = latestBlocked.issueIds;
        input.payload.repairedCount = repairedCount;
        input.payload.passedCount = passedCount;
        input.payload.blockedChapters = remainingBlocked;
        input.payload.issueIdsByChapter = issueIdsByChapter;
        input.payload.message = `${chapterLabel} 第 ${attempts} 次连贯性修复中。`;
        input.onProgressState?.({
          currentStage: "repairing",
          currentItemKey: chapter.id,
          currentItemLabel: chapterLabel,
        });
        await this.updateJobSafe(input.row.id, {
          retryCount,
          heartbeatAt: new Date(),
          currentStage: "repairing",
          currentItemKey: chapter.id,
          currentItemLabel: chapterLabel,
          payload: stringifyPayload(input.payload),
        });

        if (attempts > input.row.maxRetries) {
          input.payload.message = `${chapterLabel} 已达到本轮 ${input.row.maxRetries} 次修复上限，已保留为阻塞，继续处理其他章节。`;
          input.onProgressState?.({
            currentStage: "auditing",
            currentItemKey: chapter.id,
            currentItemLabel: chapterLabel,
          });
          await this.updateJobSafe(input.row.id, {
            retryCount,
            heartbeatAt: new Date(),
            currentStage: "auditing",
            currentItemKey: chapter.id,
            currentItemLabel: chapterLabel,
            payload: stringifyPayload(input.payload),
          });
          break;
        }

        let latestChapterAfterRepair = latestChapter;
        let nextBlocked: ContinuityBlockedChapterSummary | null;
        try {
          await withTimeout(
            this.runRepair(input.row.novelId, chapter.id, {
              provider: input.payload.provider,
              model: input.payload.model,
              temperature: input.payload.temperature,
              auditIssueIds: latestBlocked.issueIds,
              repairMode: "continuity_only",
            }),
            CONTINUITY_REPAIR_STEP_TIMEOUT_MS,
            `Repair chapter ${chapter.order}`,
          );

          const latestChapterRowAfterRepair = await prisma.chapter.findUnique({
            where: { id: chapter.id },
            select: { id: true, title: true, order: true, content: true, updatedAt: true, generationState: true, chapterStatus: true },
          });
          latestChapterAfterRepair = latestChapterRowAfterRepair ?? latestChapter;
          const auditResult = await withTimeout(
            this.reviewService.auditChapter(input.row.novelId, chapter.id, "continuity", {
              provider: input.payload.provider,
              model: input.payload.model,
              temperature: input.payload.temperature ?? 0.1,
            }),
            CONTINUITY_REAUDIT_STEP_TIMEOUT_MS,
            `Continuity re-audit chapter ${chapter.order}`,
          );
          nextBlocked = buildContinuityBlockedChapter(latestChapterAfterRepair, auditResult, threshold);
        } catch (error) {
          if (!isRecoverableBatchStepError(error)) {
            throw error;
          }
          const existingIndex = remainingBlocked.findIndex((item) => item.chapterId === chapter.id);
          if (existingIndex >= 0) {
            remainingBlocked[existingIndex] = latestBlocked;
          } else {
            remainingBlocked.push(latestBlocked);
          }
          input.payload.blockedChapters = remainingBlocked;
          input.payload.issueIdsByChapter = issueIdsByChapter;
          input.payload.message = `${chapterLabel} 本轮修复超时或临时失败，已保留为阻塞，继续处理其他章节。原因：${getErrorMessage(error)}`;
          input.onProgressState?.({
            currentStage: "auditing",
            currentItemKey: chapter.id,
            currentItemLabel: chapterLabel,
          });
          await this.updateJobSafe(input.row.id, {
            retryCount,
            heartbeatAt: new Date(),
            currentStage: "auditing",
            currentItemKey: chapter.id,
            currentItemLabel: chapterLabel,
            payload: stringifyPayload(input.payload),
          });
          break;
        }
        if (!nextBlocked) {
          await this.reviewService.resolveAuditIssues(input.row.novelId, latestBlocked.issueIds).catch(() => null);
          passedCount += 1;
          input.payload.passedCount = passedCount;
          input.payload.lastPassedOrder = latestChapterAfterRepair.order;
          delete issueIdsByChapter[chapter.id];
          const removeIndex = remainingBlocked.findIndex((item) => item.chapterId === chapter.id);
          if (removeIndex >= 0) {
            remainingBlocked.splice(removeIndex, 1);
          }
          if (input.countCompletedOnPass) {
            completedCount += 1;
          }
          input.payload.blockedChapters = remainingBlocked;
          input.payload.issueIdsByChapter = issueIdsByChapter;
          input.payload.message = input.countCompletedOnPass
            ? `${chapterLabel} 已通过连贯性审查，可继续下一批。`
            : `${chapterLabel} 已自动修复并通过复审。`;
          input.onProgressState?.({
            currentStage: "auditing",
            currentItemKey: chapter.id,
            currentItemLabel: chapterLabel,
          });
          await this.updateJobSafe(input.row.id, {
            completedCount,
            retryCount,
            progress: input.row.totalCount > 0 ? Number((completedCount / input.row.totalCount).toFixed(4)) : 1,
            heartbeatAt: new Date(),
            currentStage: "auditing",
            currentItemKey: chapter.id,
            currentItemLabel: chapterLabel,
            payload: stringifyPayload(input.payload),
          });
          break;
        }

        latestBlocked = nextBlocked;
        issueIdsByChapter[chapter.id] = latestBlocked.issueIds;
        const existingIndex = remainingBlocked.findIndex((item) => item.chapterId === chapter.id);
        if (existingIndex >= 0) {
          remainingBlocked[existingIndex] = latestBlocked;
        } else {
          remainingBlocked.push(latestBlocked);
        }
        input.payload.blockedChapters = remainingBlocked;
        input.payload.issueIdsByChapter = issueIdsByChapter;
        input.payload.message = `${chapterLabel} 仍未通过连贯性审查，继续修复。`;
        input.onProgressState?.({
          currentStage: "auditing",
          currentItemKey: chapter.id,
          currentItemLabel: chapterLabel,
        });
        await this.updateJobSafe(input.row.id, {
          retryCount,
          heartbeatAt: new Date(),
          currentStage: "auditing",
          currentItemKey: chapter.id,
          currentItemLabel: chapterLabel,
          payload: stringifyPayload(input.payload),
        });
      }
    }

    return {
      completedCount,
      passedCount,
      repairedCount,
      retryCount,
      remainingBlocked,
      issueIdsByChapter,
    };
  }

  private async loadLatestContinuityAuditSnapshot(novelId: string, chapterId: string) {
    return prisma.auditReport.findFirst({
      where: {
        novelId,
        chapterId,
        auditType: "continuity",
      },
      include: {
        issues: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    });
  }

  private async getQualityCandidates(
    novelId: string,
    threshold: number,
    includeFinalizedRecheck = false,
  ): Promise<ChapterCandidate[]> {
    const [chapters, qualityReport] = await Promise.all([
      prisma.chapter.findMany({
        where: { novelId },
        select: {
          id: true,
          title: true,
          order: true,
          content: true,
          generationState: true,
          chapterStatus: true,
          updatedAt: true,
        },
        orderBy: { order: "asc" },
      }),
      this.reviewService.getQualityReport(novelId),
    ]);
    const reportByChapterId = new Map(
      (qualityReport.chapterReports ?? []).flatMap((item) => (
        item.chapterId ? [[item.chapterId, item] as const] : []
      )),
    );
    return chapters
      .filter((chapter) => {
        if (!hasChapterContent(chapter)) {
          return false;
        }
        const report = reportByChapterId.get(chapter.id);
        if (isFreshQualifiedQualityReport(report, threshold)) {
          return false;
        }
        if (isChapterMarkedForRepair(chapter) || isFreshLowScoreReport(report, threshold)) {
          return true;
        }
        if (resolveEffectiveChapterStatus(chapter) === "pending_review") {
          return true;
        }
        if (isReportPendingRecheck(report)) {
          return includeFinalizedRecheck || !isFinalizedChapter(chapter);
        }
        return false;
      })
      .sort((left, right) => {
        const leftPriority = getQualityReviewPriority(left, reportByChapterId.get(left.id), threshold);
        const rightPriority = getQualityReviewPriority(right, reportByChapterId.get(right.id), threshold);
        if (leftPriority !== rightPriority) {
          return leftPriority - rightPriority;
        }
        return left.order - right.order;
      });
  }

  private async loadOrderedChapters(novelId: string, chapterIds: string[]): Promise<ChapterCandidate[]> {
    if (chapterIds.length === 0) {
      return [];
    }
    const rows = await prisma.chapter.findMany({
      where: {
        novelId,
        id: { in: chapterIds },
      },
      select: {
        id: true,
        title: true,
        order: true,
        content: true,
        generationState: true,
        chapterStatus: true,
        updatedAt: true,
      },
    });
    const rowMap = new Map(rows.map((row) => [row.id, row]));
    return chapterIds.map((chapterId) => {
      const row = rowMap.get(chapterId);
      if (!row) {
        throw new Error(`章节 ${chapterId} 不存在，无法继续后台审校任务。`);
      }
      return row;
    }).sort((left, right) => left.order - right.order);
  }

  private async runRepair(
    novelId: string,
    chapterId: string,
    options: {
      provider?: LLMProvider;
      model?: string;
      temperature?: number;
      reviewIssues?: Array<{
        severity: "low" | "medium" | "high" | "critical";
        category: "coherence" | "repetition" | "pacing" | "voice" | "engagement" | "logic";
        evidence: string;
        fixSuggestion: string;
      }>;
      auditIssueIds?: string[];
      repairMode?: RepairOptions["repairMode"];
    },
  ): Promise<void> {
    const execution = await this.reviewService.createRepairStream(novelId, chapterId, {
      provider: options.provider,
      model: options.model,
      temperature: options.temperature,
      reviewIssues: options.reviewIssues,
      auditIssueIds: options.auditIssueIds,
      repairMode: options.repairMode,
    });
    const fullContent = await collectStream(execution.stream);
    await execution.onDone(fullContent);
  }

  private async findActiveJob(novelId: string): Promise<PrismaNovelReviewBatchJob | null> {
    return prisma.novelReviewBatchJob.findFirst({
      where: {
        novelId,
        status: { in: ["queued", "running"] },
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    });
  }

  private startHeartbeat(
    jobId: string,
    stateFactory: () => {
      currentStage?: string | null;
      currentItemKey?: string | null;
      currentItemLabel?: string | null;
      progress?: number;
    },
  ): NodeJS.Timeout {
    let timer: NodeJS.Timeout;
    timer = setInterval(() => {
      const state = stateFactory();
      void prisma.novelReviewBatchJob.updateMany({
        where: {
          id: jobId,
          status: { in: ["queued", "running"] },
        },
        data: {
          heartbeatAt: new Date(),
          currentStage: state.currentStage ?? null,
          currentItemKey: state.currentItemKey ?? null,
          currentItemLabel: state.currentItemLabel ?? null,
          ...(typeof state.progress === "number" ? { progress: state.progress } : {}),
        },
      })
        .then((result) => {
          if (result.count === 0) {
            clearInterval(timer);
          }
        })
        .catch(() => {
          // 后台心跳更新失败不应影响主流程稳定性
        });
    }, REVIEW_BATCH_HEARTBEAT_INTERVAL_MS);
    timer.unref?.();
    return timer;
  }

  private async ensureNotCancelled(jobId: string): Promise<void> {
    const row = await prisma.novelReviewBatchJob.findUnique({
      where: { id: jobId },
      select: {
        status: true,
        cancelRequestedAt: true,
      },
    });
    if (!row || row.status === "cancelled" || row.cancelRequestedAt) {
      throw new Error("REVIEW_BATCH_CANCELLED");
    }
  }

  private async updateJobSafe(
    jobId: string,
    data: {
      status?: "queued" | "running" | "succeeded" | "failed" | "cancelled";
      progress?: number;
      completedCount?: number;
      retryCount?: number;
      heartbeatAt?: Date | null;
      currentStage?: string | null;
      currentItemKey?: string | null;
      currentItemLabel?: string | null;
      cancelRequestedAt?: Date | null;
      error?: string | null;
      startedAt?: Date | null;
      finishedAt?: Date | null;
      payload?: string | null;
    },
  ): Promise<void> {
    try {
      await prisma.novelReviewBatchJob.update({
        where: { id: jobId },
        data,
      });
    } catch {
      // 后台任务状态更新失败不应影响主流程稳定性
    }
  }
}
