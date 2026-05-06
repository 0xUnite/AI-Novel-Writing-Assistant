import type { ReviewIssue } from "@ai-novel/shared/types/novel";
import { prisma } from "../../db/prisma";
import { novelEventBus } from "../../events";
import { ChapterRuntimeCoordinator } from "./runtime/ChapterRuntimeCoordinator";
import { NovelVolumeService } from "./volume/NovelVolumeService";
import { NovelCoreGenerationService } from "./novelCoreGenerationService";
import {
  logPipelineError,
  logPipelineInfo,
  logPipelineWarn,
  normalizeScore,
  PipelinePayload,
  PipelineRunOptions,
} from "./novelCoreShared";
import { ensureNovelCharacters } from "./novelCoreSupport";
import { createQualityReport } from "./novelCoreReviewService";
import { collectStream } from "./novelProductionHelpers";

const PIPELINE_ACTIVE_STAGES = ["queued", "generating_chapters", "reviewing", "repairing", "finalizing"] as const;
const PIPELINE_HEARTBEAT_INTERVAL_MS = 15000;
const PIPELINE_STAGE_PROGRESS = {
  queued: 0,
  generating_chapters: 0.2,
  reviewing: 0.65,
  repairing: 0.88,
  finalizing: 0.98,
} as const;

type PipelineActiveStage = (typeof PIPELINE_ACTIVE_STAGES)[number];

function countPlannedVolumeChaptersInRange(
  volumes: Array<{ chapters?: Array<{ chapterOrder: number }> }>,
  startOrder: number,
  endOrder: number,
): number {
  const chapterOrders = new Set<number>();
  for (const volume of volumes) {
    for (const chapter of volume.chapters ?? []) {
      if (chapter.chapterOrder >= startOrder && chapter.chapterOrder <= endOrder) {
        chapterOrders.add(chapter.chapterOrder);
      }
    }
  }
  return chapterOrders.size;
}

function isPipelineActiveStage(value: string | null | undefined): value is PipelineActiveStage {
  return PIPELINE_ACTIVE_STAGES.includes((value ?? "") as PipelineActiveStage);
}

function clampPipelineProgress(value: number, stage: PipelineActiveStage): number {
  const max = stage === "finalizing" ? 0.999 : 0.995;
  return Number(Math.max(0, Math.min(max, value)).toFixed(4));
}

export function buildPipelineStageProgress(input: {
  completedCount: number;
  totalCount: number;
  stage: PipelineActiveStage;
}): number {
  if (input.totalCount <= 0) {
    return 0;
  }
  const completedBase = Math.max(0, input.completedCount) / input.totalCount;
  const stageFraction = PIPELINE_STAGE_PROGRESS[input.stage] ?? 0;
  return clampPipelineProgress((Math.max(0, input.completedCount) + stageFraction) / input.totalCount, input.stage)
    || Number(completedBase.toFixed(4));
}

export function buildPipelineCurrentItemLabel(input: {
  completedCount: number;
  totalCount: number;
  title: string;
}): string {
  const currentIndex = Math.min(input.totalCount, Math.max(1, input.completedCount + 1));
  return `第 ${currentIndex}/${input.totalCount} 章 · ${input.title.trim()}`;
}

function isApprovedChapterState(generationState: string | null | undefined): boolean {
  return generationState === "approved" || generationState === "published";
}

function isPipelineProcessedChapterState(generationState: string | null | undefined): boolean {
  return isApprovedChapterState(generationState);
}

function parseQueueBaselineAt(value: string | null | undefined): Date | null {
  if (!value?.trim()) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function shouldSkipChapterForSkipCompleted(
  chapter: {
    generationState: string | null | undefined;
    chapterStatus?: string | null;
    content?: string | null;
  },
  _queueBaselineAt: Date | null,
): boolean {
  // “跳过已完成”在批量续写里更像“不要覆盖已有正文”：
  // 但 needs_repair 是硬阻断状态，不能被已有正文绕过。
  if (chapter.chapterStatus === "needs_repair") {
    return false;
  }
  return isApprovedChapterState(chapter.generationState) || Boolean(chapter.content?.trim());
}

function hasUsableBible(
  bible:
    | {
      rawContent?: string | null;
      mainPromise?: string | null;
      coreSetting?: string | null;
      worldRules?: string | null;
    }
    | null
    | undefined,
): boolean {
  return Boolean(
    bible?.rawContent?.trim()
    || bible?.mainPromise?.trim()
    || bible?.coreSetting?.trim()
    || bible?.worldRules?.trim(),
  );
}

export class NovelCorePipelineService {
  private static readonly activeJobIds = new Set<string>();
  private readonly chapterRuntimeCoordinator = new ChapterRuntimeCoordinator();
  private readonly volumeService = new NovelVolumeService();
  private readonly generationService = new NovelCoreGenerationService();

  private async findActivePipelineJob(novelId: string) {
    return prisma.generationJob.findFirst({
      where: {
        novelId,
        status: { in: ["queued", "running"] },
        cancelRequestedAt: null,
      },
      orderBy: { createdAt: "desc" },
    });
  }

  private async syncMissingPipelineChaptersFromVolumes(
    novelId: string,
    options: Pick<PipelineRunOptions, "startOrder" | "endOrder">,
  ): Promise<number> {
    try {
      const workspace = await this.volumeService.getVolumes(novelId);
      const plannedCountInRange = countPlannedVolumeChaptersInRange(
        workspace.volumes,
        options.startOrder,
        options.endOrder,
      );
      if (plannedCountInRange === 0) {
        return 0;
      }

      const existingCountInRange = await prisma.chapter.count({
        where: {
          novelId,
          order: { gte: options.startOrder, lte: options.endOrder },
        },
      });
      if (existingCountInRange >= plannedCountInRange) {
        return plannedCountInRange;
      }

      const preview = await this.volumeService.syncVolumeChapters(novelId, {
        volumes: workspace.volumes,
        preserveContent: true,
        applyDeletes: false,
      });
      logPipelineInfo("启动前自动补齐章节目录", {
        novelId,
        requestedRange: `${options.startOrder}-${options.endOrder}`,
        plannedCountInRange,
        existingCountInRange,
        createCount: preview.createCount,
        updateCount: preview.updateCount,
        moveCount: preview.moveCount,
      });
      return plannedCountInRange;
    } catch (error) {
      logPipelineWarn("启动前自动补齐章节目录失败", {
        novelId,
        requestedRange: `${options.startOrder}-${options.endOrder}`,
        message: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }

  private async createPlaceholderPipelineChapters(
    novelId: string,
    options: Pick<PipelineRunOptions, "startOrder" | "endOrder">,
  ): Promise<void> {
    const placeholderEndOrder = options.endOrder;
    if (placeholderEndOrder < options.startOrder) {
      return;
    }

    const existing = await prisma.chapter.findMany({
      where: {
        novelId,
        order: { gte: options.startOrder, lte: placeholderEndOrder },
      },
      select: { order: true },
    });
    const existingOrders = new Set(existing.map((chapter) => chapter.order));
    const missingOrders: number[] = [];
    for (let order = options.startOrder; order <= placeholderEndOrder; order += 1) {
      if (!existingOrders.has(order)) {
        missingOrders.push(order);
      }
    }
    if (missingOrders.length === 0) {
      return;
    }

    await prisma.chapter.createMany({
      data: missingOrders.map((order) => ({
        novelId,
        title: `第${order}章`,
        order,
        content: "",
        generationState: "planned",
        chapterStatus: "unplanned",
      })),
    });
    logPipelineInfo("启动前自动补齐占位章节", {
      novelId,
      requestedRange: `${options.startOrder}-${options.endOrder}`,
      createdCount: missingOrders.length,
      placeholderEndOrder,
    });
  }

  private async assertNoUnresolvedPreflightBlockers(
    novelId: string,
    options: Pick<PipelineRunOptions, "startOrder">,
  ): Promise<void> {
    if (options.startOrder <= 1) {
      return;
    }
    const [repairChapters, openConflicts] = await Promise.all([
      prisma.chapter.findMany({
        where: {
          novelId,
          order: { lt: options.startOrder },
          chapterStatus: "needs_repair",
        },
        orderBy: { order: "asc" },
        take: 5,
        select: { order: true, title: true },
      }),
      prisma.openConflict.findMany({
        where: {
          novelId,
          status: "open",
          severity: { in: ["high", "critical"] },
          OR: [
            { lastSeenChapterOrder: { lt: options.startOrder } },
            { chapter: { order: { lt: options.startOrder } } },
          ],
        },
        orderBy: { updatedAt: "desc" },
        take: 5,
        select: { title: true, lastSeenChapterOrder: true, severity: true },
      }),
    ]);
    if (repairChapters.length === 0 && openConflicts.length === 0) {
      return;
    }
    const repairText = repairChapters
      .map((chapter) => `第${chapter.order}章《${chapter.title}》`)
      .join("、");
    const conflictText = openConflicts
      .map((conflict) => `${conflict.severity}｜${conflict.lastSeenChapterOrder ? `第${conflict.lastSeenChapterOrder}章` : "前文"}｜${conflict.title}`)
      .join("；");
    throw new Error([
      `流水线已阻断：第 ${options.startOrder} 章之前仍有未修复质量问题，不能继续向后生成。`,
      repairText ? `待修章节：${repairText}。` : "",
      conflictText ? `高危连续性问题：${conflictText}。` : "",
      "请先修复这些章节或解决高危冲突，再从最早问题章重新运行。",
    ].filter(Boolean).join("\n"));
  }

  async listRecoverablePipelineJobs(): Promise<Array<{ id: string; status: string }>> {
    const rows = await prisma.generationJob.findMany({
      where: {
        status: { in: ["queued", "running"] },
        finishedAt: null,
        cancelRequestedAt: null,
      },
      select: {
        id: true,
        status: true,
      },
      orderBy: [{ updatedAt: "asc" }, { createdAt: "asc" }],
    });
    return rows.map((row) => ({
      id: row.id,
      status: row.status,
    }));
  }

  async listPendingCancellationPipelineJobs(): Promise<Array<{ id: string; status: string }>> {
    const rows = await prisma.generationJob.findMany({
      where: {
        finishedAt: null,
        cancelRequestedAt: { not: null },
      },
      select: {
        id: true,
        status: true,
      },
      orderBy: [{ updatedAt: "asc" }, { createdAt: "asc" }],
    });
    return rows.map((row) => ({
      id: row.id,
      status: row.status,
    }));
  }

  async listStaleRecoverablePipelineJobs(cutoff: Date): Promise<Array<{ id: string; status: string }>> {
    const rows = await prisma.generationJob.findMany({
      where: {
        status: { in: ["queued", "running"] },
        finishedAt: null,
        cancelRequestedAt: null,
        OR: [
          { heartbeatAt: { lt: cutoff } },
          { heartbeatAt: null, updatedAt: { lt: cutoff } },
        ],
      },
      select: {
        id: true,
        status: true,
      },
      orderBy: [{ updatedAt: "asc" }, { createdAt: "asc" }],
    });
    return rows.map((row) => ({
      id: row.id,
      status: row.status,
    }));
  }

  async markPipelineJobFailed(jobId: string, message: string): Promise<void> {
    await this.updateJobSafe(jobId, {
      status: "failed",
      error: message.trim(),
      heartbeatAt: null,
      currentStage: null,
      currentItemKey: null,
      currentItemLabel: null,
      cancelRequestedAt: null,
      finishedAt: new Date(),
    });
  }

  async markPipelineJobCancelled(jobId: string): Promise<void> {
    await this.updateJobSafe(jobId, {
      status: "cancelled",
      heartbeatAt: null,
      currentStage: null,
      currentItemKey: null,
      currentItemLabel: null,
      cancelRequestedAt: null,
      finishedAt: new Date(),
    });
  }

  async resumePipelineJob(jobId: string): Promise<void> {
    const job = await prisma.generationJob.findUnique({
      where: { id: jobId },
      select: {
        id: true,
        novelId: true,
        status: true,
        startOrder: true,
        endOrder: true,
        runMode: true,
        autoReview: true,
        autoRepair: true,
        skipCompleted: true,
        qualityThreshold: true,
        repairMode: true,
        maxRetries: true,
        payload: true,
      },
    });
    if (!job) {
      throw new Error("章节流水线任务不存在。");
    }
    if (job.status !== "queued" && job.status !== "running") {
      return;
    }
    const payload = this.parsePipelinePayload(job.payload);
    this.schedulePipelineExecution(job.id, job.novelId, {
      startOrder: job.startOrder,
      endOrder: job.endOrder,
      maxRetries: job.maxRetries,
      runMode: job.runMode ?? payload.runMode,
      autoReview: job.autoReview ?? payload.autoReview,
      autoRepair: job.autoRepair ?? payload.autoRepair,
      autoPrepareStoryAssets: payload.autoPrepareStoryAssets,
      skipCompleted: job.skipCompleted ?? payload.skipCompleted,
      qualityThreshold: job.qualityThreshold ?? payload.qualityThreshold,
      repairMode: job.repairMode ?? payload.repairMode,
      provider: payload.provider,
      model: payload.model,
      temperature: payload.temperature,
    });
  }

  async startPipelineJob(novelId: string, options: PipelineRunOptions) {
    await ensureNovelCharacters(novelId, "启动批量章节流水", 0);
    const activeJob = await this.findActivePipelineJob(novelId);
    if (activeJob) {
      logPipelineWarn("检测到重复启动请求，复用现有批量任务", {
        novelId,
        activeJobId: activeJob.id,
        range: `${activeJob.startOrder}-${activeJob.endOrder}`,
        status: activeJob.status,
      });
      return {
        ...activeJob,
        reusedExisting: true,
      };
    }

    const plannedCountInRange = await this.syncMissingPipelineChaptersFromVolumes(novelId, options);
    if (plannedCountInRange === 0) {
      await this.createPlaceholderPipelineChapters(novelId, options);
    }
    await this.assertNoUnresolvedPreflightBlockers(novelId, options);

    const chapterStats = await prisma.chapter.aggregate({
      where: { novelId },
      _min: { order: true },
      _max: { order: true },
      _count: { order: true },
    });
    if ((chapterStats._count.order ?? 0) === 0) {
      throw new Error("当前小说还没有章节，请先创建章节后再启动流水线");
    }

    const queueBaselineAt = new Date();
    const chapters = await prisma.chapter.findMany({
      where: {
        novelId,
        order: { gte: options.startOrder, lte: options.endOrder },
      },
      orderBy: { order: "asc" },
      select: {
        id: true,
        generationState: true,
        chapterStatus: true,
        content: true,
        updatedAt: true,
      },
    });
    const candidateChapters = options.skipCompleted
      ? chapters.filter((chapter) => !shouldSkipChapterForSkipCompleted(chapter, queueBaselineAt))
      : chapters;
    if (candidateChapters.length === 0) {
      const minOrder = chapterStats._min.order ?? 1;
      const maxOrder = chapterStats._max.order ?? 1;
      throw new Error(`指定区间内没有可生成的章节。当前可用章节范围为 ${minOrder} 章到 ${maxOrder} 章。`);
    }

    logPipelineInfo("创建批量任务", {
      novelId,
      range: `${options.startOrder}-${options.endOrder}`,
      matchedChapters: candidateChapters.length,
      availableRange: `${chapterStats._min.order ?? 1}-${chapterStats._max.order ?? 1}`,
      maxRetries: options.maxRetries ?? 2,
      provider: options.provider ?? null,
      model: options.model ?? null,
    });

    const job = await prisma.generationJob.create({
      data: {
        novelId,
        startOrder: options.startOrder,
        endOrder: options.endOrder,
        runMode: options.runMode ?? "fast",
        autoReview: options.autoReview ?? true,
        autoRepair: options.autoRepair ?? true,
        skipCompleted: options.skipCompleted ?? true,
        qualityThreshold: options.qualityThreshold ?? null,
        repairMode: options.repairMode ?? "light_repair",
        status: "queued",
        totalCount: candidateChapters.length,
        maxRetries: options.maxRetries ?? 2,
        currentStage: "queued",
        payload: this.stringifyPipelinePayload({
          provider: options.provider,
          model: options.model,
          temperature: options.temperature ?? 0.8,
          maxRetries: options.maxRetries ?? 2,
          runMode: options.runMode ?? "fast",
          autoReview: options.autoReview ?? true,
          autoRepair: options.autoRepair ?? true,
          autoPrepareStoryAssets: options.autoPrepareStoryAssets ?? false,
          skipCompleted: options.skipCompleted ?? true,
          queueBaselineAt: queueBaselineAt.toISOString(),
          qualityThreshold: options.qualityThreshold,
          repairMode: options.repairMode ?? "light_repair",
        }),
      },
    });

    logPipelineInfo("批量任务已入队", {
      jobId: job.id,
      novelId,
      totalCount: job.totalCount,
    });

    this.schedulePipelineExecution(job.id, novelId, options);
    return job;
  }

  async getPipelineJob(novelId: string, jobId: string) {
    return prisma.generationJob.findFirst({ where: { id: jobId, novelId } });
  }

  async getPipelineJobById(jobId: string) {
    return prisma.generationJob.findUnique({ where: { id: jobId } });
  }

  async retryPipelineJob(jobId: string) {
    const job = await prisma.generationJob.findUnique({
      where: { id: jobId },
    });
    if (!job) {
      throw new Error("任务不存在。");
    }
    if (job.status !== "failed" && job.status !== "cancelled") {
      throw new Error("仅失败或已取消的任务支持重试。");
    }
    if (job.status === "cancelled" && job.cancelRequestedAt && !job.finishedAt) {
      throw new Error("任务仍在取消中，请等待取消完成后再重试。");
    }

    const payload = this.parsePipelinePayload(job.payload);
    return this.startPipelineJob(job.novelId, {
      startOrder: job.startOrder,
      endOrder: job.endOrder,
      maxRetries: job.maxRetries,
      runMode: job.runMode ?? payload.runMode,
        autoReview: job.autoReview ?? payload.autoReview,
        autoRepair: job.autoRepair ?? payload.autoRepair,
        autoPrepareStoryAssets: payload.autoPrepareStoryAssets,
        skipCompleted: job.skipCompleted ?? payload.skipCompleted,
      qualityThreshold: job.qualityThreshold ?? payload.qualityThreshold,
      repairMode: job.repairMode ?? payload.repairMode,
      provider: payload.provider,
      model: payload.model,
      temperature: payload.temperature,
    });
  }

  async cancelPipelineJob(jobId: string) {
    const job = await prisma.generationJob.findUnique({
      where: { id: jobId },
    });
    if (!job) {
      throw new Error("任务不存在。");
    }
    if (job.status === "succeeded" || job.status === "failed" || job.status === "cancelled") {
      throw new Error("仅排队中或运行中的任务可取消。");
    }
    if (job.status === "queued") {
      return prisma.generationJob.update({
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
      });
    }
    return prisma.generationJob.update({
      where: { id: jobId },
      data: {
        status: "cancelled",
        cancelRequestedAt: new Date(),
        heartbeatAt: new Date(),
        finishedAt: null,
      },
    });
  }

  private parsePipelinePayload(payload: string | null | undefined): PipelinePayload {
    if (!payload?.trim()) {
      return {};
    }
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      return {
        provider: typeof parsed.provider === "string" ? (parsed.provider as PipelinePayload["provider"]) : undefined,
        model: typeof parsed.model === "string" ? parsed.model : undefined,
        temperature: typeof parsed.temperature === "number" ? parsed.temperature : undefined,
        maxRetries: typeof parsed.maxRetries === "number" ? parsed.maxRetries : undefined,
        runMode: parsed.runMode === "polish" ? "polish" : parsed.runMode === "fast" ? "fast" : undefined,
        autoReview: typeof parsed.autoReview === "boolean" ? parsed.autoReview : undefined,
        autoRepair: typeof parsed.autoRepair === "boolean" ? parsed.autoRepair : undefined,
        autoPrepareStoryAssets: typeof parsed.autoPrepareStoryAssets === "boolean" ? parsed.autoPrepareStoryAssets : undefined,
        skipCompleted: typeof parsed.skipCompleted === "boolean" ? parsed.skipCompleted : undefined,
        queueBaselineAt: typeof parsed.queueBaselineAt === "string" ? parsed.queueBaselineAt : undefined,
        qualityThreshold: typeof parsed.qualityThreshold === "number" ? parsed.qualityThreshold : undefined,
        repairMode:
          parsed.repairMode === "detect_only"
          || parsed.repairMode === "light_repair"
          || parsed.repairMode === "heavy_repair"
          || parsed.repairMode === "continuity_only"
          || parsed.repairMode === "character_only"
          || parsed.repairMode === "ending_only"
            ? parsed.repairMode
            : undefined,
        failedDetails: Array.isArray(parsed.failedDetails)
          ? parsed.failedDetails.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
          : undefined,
      };
    } catch {
      return {};
    }
  }

  private stringifyPipelinePayload(input: PipelinePayload): string {
    const failedDetails = Array.isArray(input.failedDetails)
      ? input.failedDetails.map((item) => item.trim()).filter(Boolean)
      : [];
    const normalizedModel = typeof input.model === "string" && input.model.trim().length > 0
      ? input.model.trim()
      : undefined;
    return JSON.stringify({
      ...(input.provider ? { provider: input.provider } : {}),
      ...(normalizedModel ? { model: normalizedModel } : {}),
      temperature: input.temperature ?? 0.8,
      ...(typeof input.maxRetries === "number" ? { maxRetries: input.maxRetries } : {}),
      runMode: input.runMode ?? "fast",
      autoReview: input.autoReview ?? true,
      autoRepair: input.autoRepair ?? true,
      autoPrepareStoryAssets: input.autoPrepareStoryAssets ?? false,
      skipCompleted: input.skipCompleted ?? true,
      ...(typeof input.queueBaselineAt === "string" && input.queueBaselineAt.trim().length > 0
        ? { queueBaselineAt: input.queueBaselineAt.trim() }
        : {}),
      qualityThreshold: input.qualityThreshold ?? null,
      repairMode: input.repairMode ?? "light_repair",
      ...(failedDetails.length > 0 ? { failedDetails } : {}),
    });
  }

  private async ensurePipelineNotCancelled(jobId: string): Promise<void> {
    const job = await prisma.generationJob.findUnique({
      where: { id: jobId },
      select: {
        status: true,
        cancelRequestedAt: true,
      },
    });
    if (!job || job.status === "cancelled" || job.cancelRequestedAt) {
      throw new Error("PIPELINE_CANCELLED");
    }
  }

  private async updateJobSafe(jobId: string, data: {
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
  }) {
    try {
      await prisma.generationJob.update({
        where: { id: jobId },
        data,
      });
    } catch {
      // 后台任务状态更新失败不应影响主服务稳定
    }
  }

  private async ensurePipelineStoryAssets(
    jobId: string,
    novelId: string,
    options: Pick<PipelineRunOptions, "startOrder" | "endOrder">,
    runtimePayload: PipelinePayload,
  ): Promise<void> {
    const novel = await prisma.novel.findUnique({
      where: { id: novelId },
      include: {
        bible: true,
        _count: {
          select: {
            characters: true,
          },
        },
      },
    });
    if (!novel) {
      throw new Error("任务执行失败：小说不存在，无法自动准备圣经和拍点。");
    }

    if ((novel._count?.characters ?? 0) <= 0) {
      logPipelineWarn("跳过自动准备圣经和拍点：当前小说还没有角色资料", {
        jobId,
        novelId,
      });
      return;
    }

    if (!hasUsableBible(novel.bible)) {
      await this.ensurePipelineNotCancelled(jobId);
      await this.updateJobSafe(jobId, {
        heartbeatAt: new Date(),
        currentStage: "queued",
        currentItemKey: "story_bible",
        currentItemLabel: "自动准备作品圣经",
        progress: 0.01,
      });
      logPipelineInfo("流水线启动前自动生成作品圣经", {
        jobId,
        novelId,
      });
      const bibleExecution = await this.generationService.createBibleStream(novelId, {
        provider: runtimePayload.provider,
        model: runtimePayload.model,
        temperature: runtimePayload.temperature ?? 0.6,
      });
      const bibleContent = await collectStream(bibleExecution.stream);
      await bibleExecution.onDone(bibleContent);
    }

    const requestedBeatCount = Math.max(options.endOrder - options.startOrder + 1, 1);
    const existingBeatCount = await prisma.plotBeat.count({
      where: {
        novelId,
        chapterOrder: {
          gte: options.startOrder,
          lte: options.endOrder,
        },
      },
    });
    if (existingBeatCount >= requestedBeatCount) {
      return;
    }

    await this.ensurePipelineNotCancelled(jobId);
    await this.updateJobSafe(jobId, {
      heartbeatAt: new Date(),
      currentStage: "queued",
      currentItemKey: "plot_beats",
      currentItemLabel: `自动准备第 ${options.startOrder} 章 - 第 ${options.endOrder} 章剧情拍点`,
      progress: 0.03,
    });
    logPipelineInfo("流水线启动前自动生成剧情拍点", {
      jobId,
      novelId,
      range: `${options.startOrder}-${options.endOrder}`,
      existingBeatCount,
      requestedBeatCount,
    });
    const beatExecution = await this.generationService.createBeatStream(novelId, {
      provider: runtimePayload.provider,
      model: runtimePayload.model,
      temperature: runtimePayload.temperature ?? 0.7,
      startOrder: options.startOrder,
      targetChapters: options.endOrder,
    });
    const beatContent = await collectStream(beatExecution.stream);
    await beatExecution.onDone(beatContent);
  }

  private schedulePipelineExecution(jobId: string, novelId: string, options: PipelineRunOptions): void {
    if (NovelCorePipelineService.activeJobIds.has(jobId)) {
      return;
    }
    NovelCorePipelineService.activeJobIds.add(jobId);
    void this.executePipeline(jobId, novelId, options)
      .catch(() => {
        // 防止后台任务未处理拒绝导致进程不稳定
      })
      .finally(() => {
        NovelCorePipelineService.activeJobIds.delete(jobId);
      });
  }

  private async executePipeline(jobId: string, novelId: string, options: PipelineRunOptions) {
    const maxRetries = options.maxRetries ?? 2;
    const qualityThreshold = options.qualityThreshold ?? 75;
    const existingJob = await prisma.generationJob.findUnique({
      where: { id: jobId },
      select: {
        startedAt: true,
        completedCount: true,
        totalCount: true,
        retryCount: true,
        payload: true,
      },
    });
    const persistedPayload = this.parsePipelinePayload(existingJob?.payload);
    const runtimePayload: PipelinePayload = {
      provider: persistedPayload.provider ?? options.provider,
      model: persistedPayload.model ?? options.model,
      temperature: persistedPayload.temperature ?? options.temperature ?? 0.8,
      maxRetries: persistedPayload.maxRetries ?? options.maxRetries ?? 2,
      runMode: persistedPayload.runMode ?? options.runMode ?? "fast",
      autoReview: persistedPayload.autoReview ?? options.autoReview ?? true,
      autoRepair: persistedPayload.autoRepair ?? options.autoRepair ?? true,
      autoPrepareStoryAssets: persistedPayload.autoPrepareStoryAssets ?? options.autoPrepareStoryAssets ?? false,
      skipCompleted: persistedPayload.skipCompleted ?? options.skipCompleted ?? true,
      queueBaselineAt: persistedPayload.queueBaselineAt,
      qualityThreshold: persistedPayload.qualityThreshold ?? options.qualityThreshold,
      repairMode: persistedPayload.repairMode ?? options.repairMode ?? "light_repair",
    };
    const queueBaselineAt = parseQueueBaselineAt(runtimePayload.queueBaselineAt);
    let totalRetryCount = Math.max(existingJob?.retryCount ?? 0, 0);
    const failedDetails = [...(persistedPayload.failedDetails ?? [])];

    try {
      await this.updateJobSafe(jobId, {
        status: "running",
        startedAt: existingJob?.startedAt ?? new Date(),
        heartbeatAt: new Date(),
        currentStage: "queued",
        currentItemKey: "pipeline_preflight",
        currentItemLabel: runtimePayload.autoPrepareStoryAssets
          ? "正在检查作品圣经与剧情拍点"
          : "正在准备章节流水线",
      });
      logPipelineInfo("任务开始执行", {
        jobId,
        novelId,
        range: `${options.startOrder}-${options.endOrder}`,
        maxRetries,
      });

      if (runtimePayload.autoPrepareStoryAssets) {
        await this.ensurePipelineStoryAssets(jobId, novelId, options, runtimePayload);
      }

      const [novel, chapters] = await Promise.all([
        prisma.novel.findUnique({ where: { id: novelId } }),
        prisma.chapter.findMany({
          where: {
            novelId,
            order: { gte: options.startOrder, lte: options.endOrder },
          },
          orderBy: { order: "asc" },
        }),
      ]);
      if (!novel || chapters.length === 0) {
        throw new Error("任务执行失败：小说或章节不存在");
      }

      logPipelineInfo("任务加载完成", {
        jobId,
        novelId,
        title: novel.title,
        chapterCount: chapters.length,
      });

      const candidateChapters = chapters.filter((chapter) => !(
        runtimePayload.skipCompleted
        && shouldSkipChapterForSkipCompleted(chapter, queueBaselineAt)
      ));
      const totalCount = Math.max(existingJob?.totalCount ?? candidateChapters.length, 1);
      const isResumingExistingRun = Boolean(existingJob?.startedAt) || (existingJob?.completedCount ?? 0) > 0;
      const firstPendingIndex = isResumingExistingRun
        ? candidateChapters.findIndex((chapter) => !isPipelineProcessedChapterState(chapter.generationState))
        : 0;
      const completedFromState = isResumingExistingRun && firstPendingIndex === -1
        ? candidateChapters.length
        : Math.max(firstPendingIndex, 0);
      const persistedCompletedCount = Math.max(existingJob?.completedCount ?? 0, 0);
      const resumeIndex = Math.min(completedFromState, candidateChapters.length);
      let completed = Math.min(resumeIndex, totalCount);
      if (persistedCompletedCount > completedFromState) {
        logPipelineWarn("任务计数超前于真实章节状态，已按最早未完成章节恢复", {
          jobId,
          novelId,
          persistedCompletedCount,
          completedFromState,
          resumeOrder: candidateChapters[resumeIndex]?.order ?? null,
        });
      }
      const chaptersToProcess = resumeIndex >= candidateChapters.length
        ? []
        : candidateChapters.slice(resumeIndex);
      for (const chapter of chaptersToProcess) {
        await this.ensurePipelineNotCancelled(jobId);
        let final = { score: normalizeScore({}), issues: [] as ReviewIssue[] };
        const currentItemLabel = buildPipelineCurrentItemLabel({
          completedCount: completed,
          totalCount,
          title: chapter.title,
        });
        let activeStage: PipelineActiveStage = "generating_chapters";
        const applyChapterStage = async (stage: PipelineActiveStage) => {
          activeStage = stage;
          await this.updateJobSafe(jobId, {
            heartbeatAt: new Date(),
            currentStage: stage,
            currentItemKey: chapter.id,
            currentItemLabel,
            progress: buildPipelineStageProgress({
              completedCount: completed,
              totalCount,
              stage,
            }),
          });
        };
        await applyChapterStage("generating_chapters");
        logPipelineInfo("开始处理章节", {
          jobId,
          chapterId: chapter.id,
          order: chapter.order,
          hasDraft: Boolean((chapter.content ?? "").trim()),
        });

        const heartbeatTimer = setInterval(() => {
          void this.updateJobSafe(jobId, {
            heartbeatAt: new Date(),
            currentStage: activeStage,
            currentItemKey: chapter.id,
            currentItemLabel,
            progress: buildPipelineStageProgress({
              completedCount: completed,
              totalCount,
              stage: activeStage,
            }),
          });
        }, PIPELINE_HEARTBEAT_INTERVAL_MS);
        heartbeatTimer.unref?.();

        const chapterResult = await this.chapterRuntimeCoordinator.runPipelineChapter(
          novelId,
          chapter.id,
          {
            provider: options.provider,
            model: options.model,
            temperature: options.temperature,
            maxRetries,
            autoRepair: options.autoRepair,
            qualityThreshold,
            repairMode: options.repairMode,
          },
          {
            onCheckCancelled: () => this.ensurePipelineNotCancelled(jobId),
            onStageChange: async (stage) => {
              await applyChapterStage(stage);
            },
          },
        ).finally(() => {
          clearInterval(heartbeatTimer);
        });

        totalRetryCount += chapterResult.retryCountUsed;
        final = { score: chapterResult.score, issues: chapterResult.issues };
        await createQualityReport(novelId, chapter.id, final.score, final.issues);

        if (!chapterResult.pass) {
          const failedDetail = `${chapter.order}章（coherence=${final.score.coherence}, repetition=${final.score.repetition}, engagement=${final.score.engagement}）`;
          failedDetails.push(failedDetail);
          logPipelineWarn("章节修复后仍未达标，已标记待修并阻断后续章节", {
            jobId,
            order: chapter.order,
            score: final.score,
            failedDetail,
          });
          throw new Error(`第${chapter.order}章修复后仍未达标，流水线已停止。请先修复该章再从第${chapter.order}章重新运行。`);
        }

        completed += 1;
        await this.updateJobSafe(jobId, {
          completedCount: completed,
          progress: Number((completed / totalCount).toFixed(4)),
          retryCount: totalRetryCount,
          heartbeatAt: new Date(),
          payload: this.stringifyPipelinePayload({
            ...runtimePayload,
            failedDetails,
          }),
        });
        logPipelineInfo("任务进度更新", {
          jobId,
          completed,
          total: totalCount,
          progress: Number((completed / totalCount).toFixed(4)),
          retryCount: totalRetryCount,
        });
      }

      const finalStatus = "succeeded";
      await this.updateJobSafe(jobId, {
        heartbeatAt: new Date(),
        currentStage: "finalizing",
        currentItemKey: null,
        currentItemLabel: "正在收尾章节流水线任务",
        progress: buildPipelineStageProgress({
          completedCount: completed,
          totalCount,
          stage: "finalizing",
        }),
      });
      await this.updateJobSafe(jobId, {
        status: finalStatus,
        error: failedDetails.length === 0
          ? null
          : `批量生成已完成，但以下章节仍需进入单章质量修复：${failedDetails.join("；")}`,
        heartbeatAt: null,
        currentStage: null,
        currentItemKey: null,
        currentItemLabel: null,
        cancelRequestedAt: null,
        finishedAt: new Date(),
        payload: this.stringifyPipelinePayload({
          ...runtimePayload,
          failedDetails,
        }),
      });
      logPipelineInfo("任务执行结束", {
        jobId,
        status: finalStatus,
        failedDetails,
      });
      void novelEventBus.emit({
        type: "pipeline:completed",
        payload: { novelId, jobId, status: finalStatus },
      }).catch(() => {});
    } catch (error) {
      if (error instanceof Error && error.message === "PIPELINE_CANCELLED") {
        await this.updateJobSafe(jobId, {
          status: "cancelled",
          heartbeatAt: null,
          currentStage: null,
          currentItemKey: null,
          currentItemLabel: null,
          cancelRequestedAt: null,
          finishedAt: new Date(),
          payload: this.stringifyPipelinePayload({
            ...runtimePayload,
            failedDetails,
          }),
        });
        void novelEventBus.emit({
          type: "pipeline:completed",
          payload: { novelId, jobId, status: "cancelled" },
        }).catch(() => {});
        return;
      }

      await this.updateJobSafe(jobId, {
        status: "failed",
        error: error instanceof Error ? error.message : "流水线执行失败",
        finishedAt: new Date(),
        payload: this.stringifyPipelinePayload({
          ...runtimePayload,
          failedDetails,
        }),
      });
      logPipelineError("任务执行异常", {
        jobId,
        novelId,
        message: error instanceof Error ? error.message : "流水线执行失败",
      });
      void novelEventBus.emit({
        type: "pipeline:completed",
        payload: { novelId, jobId, status: "failed" },
      }).catch(() => {});
    }
  }
}
