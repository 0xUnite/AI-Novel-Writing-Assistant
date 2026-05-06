import { useMemo } from "react";
import type {
  Chapter,
  ContinuityBlockedChapterSummary,
  NovelBible,
  NovelProductionNextAction,
  PipelineJob,
  PlotBeat,
  QualityScore,
  ReviewIssue,
} from "@ai-novel/shared/types/novel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import LLMSelector from "@/components/common/LLMSelector";
import StreamOutput from "@/components/common/StreamOutput";
import { formatCurrentItemLabel, parseCurrentItemLabel } from "@/lib/formatCurrentItemLabel";
import { buildNovelPlainTextExport, copyTextToClipboard } from "../chapterExport.utils";
import WorldInjectionHint from "./WorldInjectionHint";
import {
  getLowScoreChapterRange,
  getPipelineStageState,
  getQualityRepairTargets,
  getQualityReviewCandidates,
  PIPELINE_STAGE_ITEMS,
  resolvePipelineChapterStatus,
} from "./pipelineTab.utils";

interface PipelineTabProps {
  novelId: string;
  novelTitle: string;
  worldInjectionSummary: string | null;
  hasCharacters: boolean;
  onGoToCharacterTab: () => void;
  pipelineForm: {
    startOrder: number;
    endOrder: number;
    maxRetries: number;
    runMode: "fast" | "polish";
    autoReview: boolean;
    autoRepair: boolean;
    skipCompleted: boolean;
    qualityThreshold: number;
    repairMode: "detect_only" | "light_repair" | "heavy_repair" | "continuity_only" | "character_only" | "ending_only";
  };
  onPipelineFormChange: (
    field: "startOrder" | "endOrder" | "maxRetries" | "runMode" | "autoReview" | "autoRepair" | "skipCompleted" | "qualityThreshold" | "repairMode",
    value: number | boolean | string,
  ) => void;
  maxOrder: number;
  onGenerateBible: () => void;
  onAbortBible: () => void;
  isBibleStreaming: boolean;
  bibleStreamContent: string;
  onGenerateBeats: () => void;
  onAbortBeats: () => void;
  isBeatsStreaming: boolean;
  beatsStreamContent: string;
  onRunPipeline: (patch?: Partial<PipelineTabProps["pipelineForm"]>) => void;
  isRunningPipeline: boolean;
  pipelineMessage: string;
  pipelineJob?: PipelineJob;
  chapters: Chapter[];
  selectedChapterId: string;
  onSelectedChapterChange: (chapterId: string) => void;
  onReviewChapter: () => void;
  onReviewAllQualityChapters: () => void;
  onReviewFinalizedQualityChapters: () => void;
  isReviewing: boolean;
  onRepairChapter: () => void;
  onRepairAllQualityChapters: () => void;
  isRepairing: boolean;
  isQualityBatchRunning: boolean;
  qualityBatchState?: {
    jobId?: string | null;
    mode: "review_all" | "repair_until_pass";
    status?: string | null;
    currentStage?: string | null;
    currentChapterId?: string | null;
    currentChapterLabel?: string | null;
    completedCount: number;
    totalCount: number;
    qualifiedCount: number;
    repairedCount: number;
    retryCount?: number | null;
    maxRetries?: number | null;
    heartbeatAt?: string | null;
    startedAt?: string | null;
    updatedAt?: string | null;
    message?: string | null;
  } | null;
  onCancelQualityBatch?: () => void;
  isCancellingQualityBatch?: boolean;
  onRunContinuityAuditBatches: () => void;
  onRepairBlockedContinuityChapters: () => void;
  onCancelContinuityBatch?: () => void;
  isCancellingContinuityBatch?: boolean;
  isContinuityBatchRunning: boolean;
  continuityResumeOrder: number;
  continuityLastPassedOrder?: number | null;
  continuityBatchState?: {
    jobId?: string | null;
    mode: "audit_batches" | "repair_blocked" | "blocked" | "completed" | "ready";
    status?: string | null;
    currentStage?: string | null;
    currentChapterId?: string | null;
    currentChapterLabel?: string | null;
    completedCount: number;
    totalCount: number;
    passedCount: number;
    currentBatchStartOrder?: number | null;
    currentBatchEndOrder?: number | null;
    lastPassedOrder?: number | null;
    blockedChapters: ContinuityBlockedChapterSummary[];
    retryCount?: number | null;
    maxRetries?: number | null;
    heartbeatAt?: string | null;
    startedAt?: string | null;
    updatedAt?: string | null;
    message?: string | null;
  } | null;
  productionNextAction?: NovelProductionNextAction | null;
  onGenerateHook: () => void;
  isGeneratingHook: boolean;
  reviewResult: {
    score: QualityScore;
    issues: ReviewIssue[];
  } | null;
  repairBeforeContent: string;
  repairAfterContent: string;
  repairStreamContent: string;
  isRepairStreaming: boolean;
  onAbortRepair: () => void;
  qualitySummary?: QualityScore;
  chapterReports: Array<{
    chapterId?: string | null;
    chapterOrder?: number | null;
    chapterLabel?: string | null;
    chapterStatus?: string | null;
    generationState?: string | null;
    coherence: number;
    repetition: number;
    pacing: number;
    voice: number;
    engagement: number;
    overall: number;
    issues?: string | null;
    isStale?: boolean;
    isMissing?: boolean;
  }>;
  bible?: NovelBible | null;
  plotBeats: PlotBeat[];
}

function repairModeLabel(mode: PipelineTabProps["pipelineForm"]["repairMode"]): string {
  const mapping: Record<PipelineTabProps["pipelineForm"]["repairMode"], string> = {
    detect_only: "只检测不修复",
    light_repair: "自动轻修",
    heavy_repair: "自动重修",
    continuity_only: "只修连续性",
    character_only: "只修人设",
    ending_only: "只修结尾力度",
  };
  return mapping[mode];
}

function stageStatusLabel(state: "pending" | "active" | "completed" | "failed"): string {
  if (state === "active") return "进行中";
  if (state === "completed") return "已完成";
  if (state === "failed") return "异常";
  return "待执行";
}

function batchStageLabel(stage?: string | null): string {
  const mapping: Record<string, string> = {
    queued: "排队/准备",
    reviewing: "审校中",
    repairing: "修复中",
    auditing: "连贯审查中",
    finalizing: "收尾中",
  };
  return stage ? mapping[stage] ?? stage : "-";
}

function formatRelativeTime(value?: string | null): string {
  if (!value) {
    return "-";
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return "-";
  }
  const diffMs = Date.now() - timestamp;
  if (diffMs < 0) {
    return "刚刚";
  }
  const diffSeconds = Math.floor(diffMs / 1000);
  if (diffSeconds < 10) {
    return "刚刚";
  }
  if (diffSeconds < 60) {
    return `${diffSeconds} 秒前`;
  }
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) {
    return `${diffMinutes} 分钟前`;
  }
  const diffHours = Math.floor(diffMinutes / 60);
  return `${diffHours} 小时前`;
}

function isHeartbeatPossiblyStale(value?: string | null): boolean {
  if (!value) {
    return false;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return false;
  }
  return Date.now() - timestamp > 90_000;
}

function formatBatchStatus(status?: string | null): string {
  if (status === "queued") return "排队中";
  if (status === "running") return "运行中";
  if (status === "succeeded") return "已完成";
  if (status === "failed") return "失败";
  if (status === "cancelled") return "已取消";
  return status ?? "-";
}

function continuityStatusBadgeClass(
  mode: PipelineTabProps["continuityBatchState"] extends { mode: infer Mode } ? Mode : string | null | undefined,
): string {
  if (mode === "audit_batches") {
    return "border-primary/20 bg-primary/10 text-primary";
  }
  if (mode === "repair_blocked") {
    return "border-amber-200 bg-amber-100 text-amber-900";
  }
  if (mode === "blocked") {
    return "border-red-200 bg-red-100 text-red-700";
  }
  if (mode === "completed") {
    return "border-emerald-200 bg-emerald-100 text-emerald-700";
  }
  if (mode === "ready") {
    return "border-sky-200 bg-sky-100 text-sky-700";
  }
  return "border-border bg-muted text-muted-foreground";
}

function continuityStatusHint(
  mode: PipelineTabProps["continuityBatchState"] extends { mode: infer Mode } ? Mode : string | null | undefined,
  blockedCount = 0,
): string {
  if (mode === "audit_batches") {
    return blockedCount > 0
      ? `当前批次已发现 ${blockedCount} 章阻塞；系统会先完成剩余章节审查，再自动修复并复审。`
      : "正在逐章审查当前 20 章批次；发现阻塞后会自动修复、复审并继续下一批。";
  }
  if (mode === "repair_blocked") {
    return "批次扫描已结束，阻塞章节正在自动修复并等待复审通过。";
  }
  if (mode === "blocked") {
    return "当前批次发现阻塞章节；你可以手动修复，也可以直接重新启动自动连贯性审查。";
  }
  if (mode === "completed") {
    return "当前已写章节都已完成连贯性审查。";
  }
  if (mode === "ready") {
    return "已经恢复到上次进度，可以从下一批继续审查。";
  }
  return "尚未开始全书连贯守门。";
}

function formatChapterReportLabel(chapters: Chapter[], chapterId?: string | null): string {
  if (!chapterId) {
    return "全书";
  }
  const chapter = chapters.find((item) => item.id === chapterId);
  if (!chapter) {
    return chapterId;
  }
  const title = chapter.title?.trim() || "未命名章节";
  return `第${chapter.order}章 - ${title}`;
}

function findLastContinuousDraftOrder(
  chapters: Chapter[],
  startOrder: number,
  endOrder: number,
): number | null {
  const chapterByOrder = new Map(chapters.map((chapter) => [chapter.order, chapter]));
  let lastContinuousOrder: number | null = null;
  for (let order = startOrder; order <= endOrder; order += 1) {
    const chapter = chapterByOrder.get(order);
    const hasContent = Boolean(chapter?.content?.trim());
    if (!hasContent) {
      break;
    }
    lastContinuousOrder = order;
  }
  return lastContinuousOrder;
}

export default function PipelineTab(props: PipelineTabProps) {
  const {
    novelTitle,
    worldInjectionSummary,
    hasCharacters,
    onGoToCharacterTab,
    pipelineForm,
    onPipelineFormChange,
    maxOrder,
    onGenerateBible,
    onAbortBible,
    isBibleStreaming,
    bibleStreamContent,
    onGenerateBeats,
    onAbortBeats,
    isBeatsStreaming,
    beatsStreamContent,
    onRunPipeline,
    isRunningPipeline,
    pipelineMessage,
    pipelineJob,
    chapters,
    selectedChapterId,
    onSelectedChapterChange,
    onReviewChapter,
    onReviewAllQualityChapters,
    onReviewFinalizedQualityChapters,
    isReviewing,
    onRepairChapter,
    onRepairAllQualityChapters,
    isRepairing,
    isQualityBatchRunning,
    qualityBatchState,
    onCancelQualityBatch,
    isCancellingQualityBatch,
    onRunContinuityAuditBatches,
    onRepairBlockedContinuityChapters,
    onCancelContinuityBatch,
    isCancellingContinuityBatch,
    isContinuityBatchRunning,
    continuityResumeOrder,
    continuityLastPassedOrder,
    continuityBatchState,
    productionNextAction,
    onGenerateHook,
    isGeneratingHook,
    reviewResult,
    repairBeforeContent,
    repairAfterContent,
    repairStreamContent,
    isRepairStreaming,
    onAbortRepair,
    qualitySummary,
    chapterReports,
    bible,
    plotBeats,
  } = props;

  const safeChapters = Array.isArray(chapters) ? chapters.filter((chapter): chapter is Chapter => Boolean(chapter)) : [];
  const safeChapterReports = Array.isArray(chapterReports)
    ? chapterReports.filter((report) => Boolean(report))
    : [];
  const safePlotBeats = Array.isArray(plotBeats) ? plotBeats.filter((beat): beat is PlotBeat => Boolean(beat)) : [];
  const safeBlockedChapters = continuityBatchState?.blockedChapters ?? [];
  const hasActivePipelineJob = pipelineJob?.status === "queued" || pipelineJob?.status === "running";
  const hasActiveQualityJob = Boolean(isQualityBatchRunning);
  const hasActiveContinuityJob = Boolean(isContinuityBatchRunning);

  const lowScoreRange = getLowScoreChapterRange(safeChapters, safeChapterReports, pipelineForm.qualityThreshold);
  const qualityReviewCandidates = getQualityReviewCandidates(safeChapters, safeChapterReports, pipelineForm.qualityThreshold);
  const qualityRepairTargets = getQualityRepairTargets(safeChapters, safeChapterReports, pipelineForm.qualityThreshold);

  const qualityIssueReports = useMemo(() => {
    const reportMap = new Map(
      safeChapterReports
        .flatMap((report) => report.chapterId ? [[report.chapterId, report] as const] : []),
    );

    return safeChapters
      .filter((chapter) => {
        const report = reportMap.get(chapter.id);
        const needsRecheck = Boolean(report?.isMissing || report?.isStale);
        const isLowScore = !needsRecheck && typeof report?.overall === "number" ? report.overall < pipelineForm.qualityThreshold : false;
        const needsAttention = resolvePipelineChapterStatus(chapter) === "needs_repair";
        return isLowScore || needsAttention;
      })
      .map((chapter) => {
        const report = reportMap.get(chapter.id);
        return {
          chapterId: chapter.id,
          chapterOrder: chapter.order ?? 0,
          overall: report?.overall ?? 0,
          status: resolvePipelineChapterStatus(chapter),
        };
      })
      .sort((a, b) => {
        if (a.overall !== b.overall) {
          return a.overall - b.overall;
        }
        return a.chapterOrder - b.chapterOrder;
      })
      .slice(0, 20);
  }, [safeChapters, safeChapterReports, pipelineForm.qualityThreshold]);
  const pendingRecheckReports = useMemo(() => {
    const reportMap = new Map(
      safeChapterReports
        .flatMap((report) => report.chapterId ? [[report.chapterId, report] as const] : []),
    );

    return safeChapters
      .filter((chapter) => {
        const report = reportMap.get(chapter.id);
        const needsRecheck = Boolean(report?.isMissing || report?.isStale);
        const isLowScore = !needsRecheck && typeof report?.overall === "number" ? report.overall < pipelineForm.qualityThreshold : false;
        const needsRepair = resolvePipelineChapterStatus(chapter) === "needs_repair";
        const isFinalized = chapter.generationState === "approved" || chapter.generationState === "published";
        return needsRecheck && !isLowScore && !needsRepair && !isFinalized;
      })
      .map((chapter) => ({
        chapterId: chapter.id,
        chapterOrder: chapter.order ?? 0,
      }))
      .sort((a, b) => a.chapterOrder - b.chapterOrder);
  }, [safeChapters, safeChapterReports, pipelineForm.qualityThreshold]);
  const finalizedStaleReports = useMemo(() => {
    const reportMap = new Map(
      safeChapterReports
        .flatMap((report) => report.chapterId ? [[report.chapterId, report] as const] : []),
    );

    return safeChapters
      .filter((chapter) => {
        const report = reportMap.get(chapter.id);
        const needsRecheck = Boolean(report?.isMissing || report?.isStale);
        const isFinalized = chapter.generationState === "approved" || chapter.generationState === "published";
        return needsRecheck && isFinalized;
      })
      .map((chapter) => ({
        chapterId: chapter.id,
        chapterOrder: chapter.order ?? 0,
      }))
      .sort((a, b) => a.chapterOrder - b.chapterOrder);
  }, [safeChapters, safeChapterReports]);
  const syncedChapterMaxOrder = safeChapters.reduce((max, chapter) => Math.max(max, chapter.order), 0);
  const hasPendingChapterDirectorySync = maxOrder > syncedChapterMaxOrder;
  const draftedChapterCount = safeChapters.filter((chapter) => (chapter.content?.trim().length ?? 0) > 0).length;
  const latestDraftedChapter = [...safeChapters]
    .filter((chapter) => (chapter.content?.trim().length ?? 0) > 0)
    .sort((left, right) => right.order - left.order)[0] ?? null;
  const currentPipelineItemLabel = formatCurrentItemLabel(pipelineJob?.currentItemLabel);
  const currentPipelineItemParts = parseCurrentItemLabel(pipelineJob?.currentItemLabel);
  const currentPipelineChapter = safeChapters.find((chapter) => chapter.id === pipelineJob?.currentItemKey) ?? null;
  const skippedExistingContentChapterCount = (pipelineJob?.skipCompleted && pipelineJob.totalCount > 0)
    ? Math.max((pipelineJob.endOrder - pipelineJob.startOrder + 1) - pipelineJob.totalCount, 0)
    : 0;
  const qualitySelectedChapter = qualityRepairTargets.find((chapter) => chapter.id === selectedChapterId) ?? null;
  const globalContinuityScanEndOrder = Math.max(maxOrder, latestDraftedChapter?.order ?? 0, 1);
  const globalLastContinuousDraftOrder = findLastContinuousDraftOrder(safeChapters, 1, globalContinuityScanEndOrder);
  const globalNextContinuityOrder = (globalLastContinuousDraftOrder ?? 0) < maxOrder
    ? (globalLastContinuousDraftOrder ?? 0) + 1
    : null;
  const draftedGapCount = latestDraftedChapter
    ? Math.max(0, latestDraftedChapter.order - draftedChapterCount)
    : 0;
  const quickContinueStartOrder = (globalLastContinuousDraftOrder ?? 0) + 1;
  const hasQuickContinueTarget = maxOrder > 0 && quickContinueStartOrder <= maxOrder;
  const quickContinueEndOrder = hasQuickContinueTarget
    ? Math.min(maxOrder, quickContinueStartOrder + 9)
    : quickContinueStartOrder + 9;
  const writtenContinuityChapters = [...safeChapters]
    .filter((chapter) => Boolean(chapter.content?.trim()))
    .sort((left, right) => left.order - right.order);
  const nextContinuityBatchStartIndex = writtenContinuityChapters.findIndex((chapter) => chapter.order >= continuityResumeOrder);
  const nextContinuityBatch = nextContinuityBatchStartIndex >= 0
    ? writtenContinuityChapters.slice(nextContinuityBatchStartIndex, nextContinuityBatchStartIndex + 20)
    : [];
  const nextContinuityBatchStartOrder = nextContinuityBatch[0]?.order ?? null;
  const nextContinuityBatchEndOrder = nextContinuityBatch[nextContinuityBatch.length - 1]?.order ?? null;
  const continuityWrittenChapterCount = Math.max(writtenContinuityChapters.length, continuityBatchState?.totalCount ?? 0);
  const continuityDisplayNextBatchStartOrder = !hasActiveContinuityJob && continuityBatchState?.currentBatchStartOrder
    ? continuityBatchState.currentBatchStartOrder
    : nextContinuityBatchStartOrder;
  const continuityDisplayNextBatchEndOrder = !hasActiveContinuityJob && continuityBatchState?.currentBatchStartOrder
    ? continuityBatchState.currentBatchEndOrder ?? continuityBatchState.currentBatchStartOrder
    : nextContinuityBatchEndOrder;
  const hasContinuityBlockedChapters = safeBlockedChapters.length > 0;
  const isPipelineStartBlocked = isRunningPipeline || hasActivePipelineJob;
  const isQualityActionBlocked = hasActiveQualityJob || isReviewing || isRepairing || hasActiveContinuityJob;
  const isContinuityActionBlocked = hasActiveQualityJob || hasActiveContinuityJob || isReviewing || isRepairing;
  const isContinuityAuditButtonDisabled = isContinuityActionBlocked || continuityWrittenChapterCount === 0;
  const isContinuityRepairButtonDisabled = !hasContinuityBlockedChapters || isContinuityActionBlocked;
  const continuityActionBlockReason = hasActiveQualityJob
    ? "当前有质量批处理正在运行，完成后才能开始连贯性修复。"
    : hasActiveContinuityJob
      ? "当前已有连贯性审查或修复任务在运行，请等待本轮完成。"
      : isReviewing
        ? "当前有单章审校任务正在运行；点击按钮会直接提示并在审校结束后可重试。"
        : isRepairing
          ? "当前有单章修复任务正在运行；点击按钮会直接提示并在修复结束后可重试。"
          : null;
  const continuityActionLabel = hasActiveContinuityJob
    ? "自动连贯性审查运行中"
    : continuityResumeOrder > 1
      ? "继续自动连贯性审查"
      : "开始自动连贯性审查";
  const continuityBlockedCount = safeBlockedChapters.length;
  const continuityPendingAutoRepair = continuityBatchState?.mode === "audit_batches" && continuityBlockedCount > 0;
  const continuityStatusLabel = hasActiveContinuityJob && continuityBatchState?.mode === "repair_blocked"
    ? "修复中"
    : hasActiveContinuityJob
      ? "审查中"
    : continuityBatchState?.mode === "repair_blocked"
      ? "修复中"
    : continuityPendingAutoRepair
      ? "审查中"
      : continuityBatchState?.mode === "audit_batches"
      ? "审查中"
      : continuityBatchState?.mode === "ready"
        ? "可继续"
      : continuityBatchState?.mode === "blocked"
        ? "等待修复"
        : continuityBatchState?.mode === "completed"
          ? "已完成"
          : "未开始";
  const continuityIsRepairing = hasActiveContinuityJob && continuityBatchState?.mode === "repair_blocked";
  const continuityCurrentBatchLabel = continuityBatchState?.currentBatchStartOrder
    ? `第 ${continuityBatchState.currentBatchStartOrder} 章 - 第 ${continuityBatchState.currentBatchEndOrder} 章`
    : "-";
  const continuityCurrentChapterOrder = continuityBatchState?.currentChapterId
    ? chapters.find((chapter) => chapter.id === continuityBatchState.currentChapterId)?.order ?? null
    : null;
  const continuityIsRepairingHistoricalBlocker = Boolean(
    continuityCurrentChapterOrder
    && continuityBatchState?.currentBatchStartOrder
    && continuityBatchState?.currentBatchEndOrder
    && (
      continuityCurrentChapterOrder < continuityBatchState.currentBatchStartOrder
      || continuityCurrentChapterOrder > continuityBatchState.currentBatchEndOrder
    ),
  );
  const continuityRepairingHistoricalBlockerHint = continuityIsRepairingHistoricalBlocker
    ? `当前显示的章节是系统回头清理的历史阻塞章（第 ${continuityCurrentChapterOrder} 章）；这章通过后，流程会回到第 ${continuityBatchState?.currentBatchStartOrder} 章 - 第 ${continuityBatchState?.currentBatchEndOrder} 章窗口继续推进。`
    : null;
  const continuityWindowShiftHint = hasActiveContinuityJob
    && continuityBatchState?.currentBatchStartOrder
    && continuityDisplayNextBatchStartOrder
    && (
      continuityBatchState.currentBatchStartOrder !== continuityDisplayNextBatchStartOrder
      || continuityBatchState.currentBatchEndOrder !== continuityDisplayNextBatchEndOrder
    )
    ? `当前活跃任务窗口是第 ${continuityBatchState.currentBatchStartOrder} 章 - 第 ${continuityBatchState.currentBatchEndOrder} 章；“下一批目标”显示的是这一轮处理完成后将继续接上的窗口。`
    : null;
  const continuityProgressPercent = continuityBatchState?.totalCount
    ? Math.max(0, Math.min(100, Math.round((continuityBatchState.completedCount / Math.max(continuityBatchState.totalCount, 1)) * 100)))
    : continuityBatchState?.mode === "completed"
      ? 100
      : 0;
  const continuityProgressDisplay = continuityIsRepairing ? "修复中" : `${continuityProgressPercent}%`;
  const continuityProgressCaption = continuityIsRepairing ? "正在修复/复审" : "累计进度";
  const qualityProgressPercent = qualityBatchState?.totalCount
    ? Math.max(0, Math.min(100, Math.round((qualityBatchState.completedCount / Math.max(qualityBatchState.totalCount, 1)) * 100)))
    : 0;
  const hasVisibleBackgroundJob = hasActivePipelineJob || hasActiveQualityJob || hasActiveContinuityJob;
  const expectedPipelineBeatCount = Math.max(pipelineForm.endOrder - pipelineForm.startOrder + 1, 1);
  const plotBeatCountInPipelineRange = safePlotBeats.filter((beat) => (
    typeof beat.chapterOrder === "number"
    && beat.chapterOrder >= pipelineForm.startOrder
    && beat.chapterOrder <= pipelineForm.endOrder
  )).length;
  const hasPipelineRangeBeats = plotBeatCountInPipelineRange >= expectedPipelineBeatCount;

  const recommendedNextAction = useMemo(() => {
    if (productionNextAction) {
      const continueWritingStart = productionNextAction.payload?.startOrder ?? quickContinueStartOrder;
      const continueWritingEnd = productionNextAction.payload?.endOrder ?? quickContinueEndOrder;
      const actionMap: Record<NovelProductionNextAction["action"], {
        onClick?: () => void;
        disabled?: boolean;
      }> = {
        prepare_characters: {
          onClick: onGoToCharacterTab,
          disabled: false,
        },
        wait_pipeline: {
          disabled: true,
        },
        wait_quality: {
          disabled: true,
        },
        wait_continuity: {
          disabled: true,
        },
        repair_quality: {
          onClick: onRepairAllQualityChapters,
          disabled: isQualityActionBlocked,
        },
        review_quality: {
          onClick: productionNextAction.payload?.includeFinalizedRecheck
            ? onReviewFinalizedQualityChapters
            : onReviewAllQualityChapters,
          disabled: isQualityActionBlocked,
        },
        repair_continuity: {
          onClick: onRepairBlockedContinuityChapters,
          disabled: isContinuityActionBlocked,
        },
        audit_continuity: {
          onClick: onRunContinuityAuditBatches,
          disabled: isContinuityAuditButtonDisabled,
        },
        continue_writing: {
          onClick: () => onRunPipeline({
            startOrder: continueWritingStart,
            endOrder: continueWritingEnd,
            autoReview: true,
            autoRepair: true,
            skipCompleted: true,
          }),
          disabled: isPipelineStartBlocked,
        },
        completed: {
          disabled: true,
        },
      };
      const action = actionMap[productionNextAction.action];
      return {
        title: productionNextAction.title,
        description: productionNextAction.description,
        buttonLabel: productionNextAction.buttonLabel,
        onClick: action.onClick,
        disabled: productionNextAction.disabled || Boolean(action.disabled),
      };
    }
    if (!hasCharacters) {
      return {
        title: "先补角色资料",
        description: "批量出稿、单章修复和连贯守门都会读取角色状态；先补至少 1 个角色，后面生成更稳。",
        buttonLabel: "去角色管理",
        onClick: onGoToCharacterTab,
        disabled: false,
  };
}
    if (hasActivePipelineJob || isRunningPipeline) {
      return {
        title: "等待当前批量出稿完成",
        description: "已经有章节流水线在运行。重复点击会增加并发写入风险，先看下方任务状态即可。",
        buttonLabel: "流水线运行中",
        onClick: undefined,
        disabled: true,
      };
    }
    if (hasActiveQualityJob || isReviewing || isRepairing) {
      return {
        title: "等待单章质检完成",
        description: "单章审校/修复正在处理正文，完成后系统会刷新待修、待审校与连贯状态。",
        buttonLabel: "质检处理中",
        onClick: undefined,
        disabled: true,
      };
    }
    if (hasActiveContinuityJob) {
      return {
        title: "等待全书连贯守门完成",
        description: "当前正在按章节顺序检查跨章承接，先让这轮跑完，避免同一批章节被重复修写。",
        buttonLabel: "连贯守门中",
        onClick: undefined,
        disabled: true,
      };
    }
    if (qualityRepairTargets.length > 0) {
      return {
        title: "先修真实低分章",
        description: `当前有 ${qualityRepairTargets.length} 章低于阈值或被标记需修复。建议先用“一键修复到合格”，它会做单章质量修复并补局部连贯护栏。`,
        buttonLabel: "一键修复到合格",
        onClick: onRepairAllQualityChapters,
        disabled: isQualityActionBlocked || qualityReviewCandidates.length === 0,
      };
    }
    if (qualityReviewCandidates.length > 0 || pendingRecheckReports.length > 0) {
      return {
        title: "先审校待检新稿",
        description: `当前有 ${qualityReviewCandidates.length || pendingRecheckReports.length} 章需要质量评分。先审校再决定是否修复，能避免低分章漏进后续连贯守门。`,
        buttonLabel: "一键审校待检章节",
        onClick: onReviewAllQualityChapters,
        disabled: isQualityActionBlocked || qualityReviewCandidates.length === 0,
      };
    }
    if (hasContinuityBlockedChapters) {
      return {
        title: "修复全书连贯阻塞",
        description: `全书连贯守门发现 ${continuityBlockedCount} 章阻塞。先清掉阻塞，再继续写下一批会更稳。`,
        buttonLabel: "一键修复当前阻塞",
        onClick: onRepairBlockedContinuityChapters,
        disabled: isContinuityRepairButtonDisabled,
      };
    }
    if (writtenContinuityChapters.length > 0 && nextContinuityBatchStartOrder && continuityBatchState?.mode !== "completed") {
      return {
        title: "继续全书连贯守门",
        description: "单章质量已没有明显待处理项。建议按 20 章窗口做跨章承接检查，确认时间、地点、物件和人物状态没有断裂。",
        buttonLabel: continuityActionLabel,
        onClick: onRunContinuityAuditBatches,
        disabled: isContinuityAuditButtonDisabled,
      };
    }
    if (hasQuickContinueTarget) {
      return {
        title: "可以继续写下一批",
        description: `当前连续正文已到第 ${globalLastContinuousDraftOrder ?? 0} 章，下一批会从第 ${quickContinueStartOrder} 章写到第 ${quickContinueEndOrder} 章，并且不会超过已规划章节上限。`,
        buttonLabel: "续写 10 章",
        onClick: () => onRunPipeline({
          startOrder: quickContinueStartOrder,
          endOrder: quickContinueEndOrder,
          autoReview: true,
          autoRepair: true,
          skipCompleted: true,
        }),
        disabled: isPipelineStartBlocked,
      };
    }
    return {
      title: "当前已到规划章节上限",
      description: "如果这本书还要继续写，建议先使用“创建续写项目/导入大纲”把已完成大纲迁入新项目，再规划下一阶段卷战略与章节骨架。",
      buttonLabel: "已到上限",
      onClick: undefined,
      disabled: true,
    };
  }, [
    hasCharacters,
    productionNextAction,
    hasActivePipelineJob,
    isRunningPipeline,
    hasActiveQualityJob,
    isReviewing,
    isRepairing,
    hasActiveContinuityJob,
    qualityRepairTargets.length,
    qualityReviewCandidates.length,
    pendingRecheckReports.length,
    isQualityActionBlocked,
    hasContinuityBlockedChapters,
    continuityBlockedCount,
    isContinuityRepairButtonDisabled,
    isContinuityActionBlocked,
    writtenContinuityChapters.length,
    nextContinuityBatchStartOrder,
    continuityBatchState?.mode,
    continuityActionLabel,
    isContinuityAuditButtonDisabled,
    hasQuickContinueTarget,
    globalLastContinuousDraftOrder,
    quickContinueStartOrder,
    quickContinueEndOrder,
    isPipelineStartBlocked,
    onGoToCharacterTab,
    onRepairAllQualityChapters,
    onReviewAllQualityChapters,
    onRepairBlockedContinuityChapters,
    onRunContinuityAuditBatches,
    onRunPipeline,
  ]);

  const exportPipelineReport = () => {
    const report = {
      generatedAt: new Date().toISOString(),
      pipelineForm,
      pipelineJob,
      qualitySummary,
      chapterReports,
      lowScoreThreshold: pipelineForm.qualityThreshold,
    };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `pipeline-report-${Date.now()}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const copyFullNovelText = async () => {
    const exportChapters = safeChapters
      .filter((chapter) => (chapter.title?.trim() || chapter.content?.trim()))
      .sort((left, right) => left.order - right.order);
    if (exportChapters.length === 0) {
      toast.error("当前还没有可导出的章节。");
      return;
    }

    const emptyContentCount = exportChapters.filter((chapter) => !chapter.content?.trim()).length;
    try {
      await copyTextToClipboard(buildNovelPlainTextExport(exportChapters, novelTitle));
      toast.success(
        emptyContentCount > 0
          ? `已复制全文，共 ${exportChapters.length} 章，其中 ${emptyContentCount} 章暂无正文。`
          : `已复制全文，共 ${exportChapters.length} 章。`,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "复制全文失败。");
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>批量生成与质检</CardTitle>
          <LLMSelector />
        </CardHeader>
        <CardContent className="space-y-3">
          <WorldInjectionHint worldInjectionSummary={worldInjectionSummary} />
          {!hasCharacters ? (
            <div className="flex items-center justify-between gap-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
              <span>请先添加至少 1 个角色，再执行流水线。</span>
              <Button size="sm" variant="outline" onClick={onGoToCharacterTab}>去角色管理</Button>
            </div>
          ) : null}
          {pipelineMessage ? <div className="text-sm text-muted-foreground">{pipelineMessage}</div> : null}
        </CardContent>
      </Card>

      <Card className="border-primary/20 bg-primary/5">
        <CardHeader>
          <CardTitle>推荐下一步</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="space-y-1">
            <div className="font-medium">{recommendedNextAction.title}</div>
            <div className="text-sm text-muted-foreground">{recommendedNextAction.description}</div>
          </div>
          <Button
            className="shrink-0"
            onClick={recommendedNextAction.onClick}
            disabled={recommendedNextAction.disabled || !recommendedNextAction.onClick}
          >
            {recommendedNextAction.buttonLabel}
          </Button>
        </CardContent>
      </Card>

      {hasVisibleBackgroundJob ? (
        <Card className="border-sky-200 bg-sky-50/70">
          <CardHeader>
            <CardTitle>实时后台状态</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 lg:grid-cols-3">
            <div className="rounded-lg border bg-background/80 p-3 text-sm">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="font-medium">批量出稿</div>
                <Badge variant={hasActivePipelineJob ? "default" : "outline"}>
                  {pipelineJob ? formatBatchStatus(pipelineJob.status) : "空闲"}
                </Badge>
              </div>
              {pipelineJob ? (
                <div className="space-y-1 text-xs text-muted-foreground">
                  <div>当前阶段：{pipelineJob.currentStage || "-"}</div>
                  <div>当前处理：{currentPipelineItemLabel || "-"}</div>
                  <div>进度：{pipelineJob.completedCount}/{pipelineJob.totalCount}，{Math.round((pipelineJob.progress ?? 0) * 100)}%</div>
                  {pipelineJob.error ? (
                    <div className={pipelineJob.status === "succeeded" ? "text-amber-700" : "text-red-600"}>
                      {pipelineJob.status === "succeeded" ? "质量提示" : "错误"}：{pipelineJob.error}
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="text-xs text-muted-foreground">当前没有批量出稿任务。</div>
              )}
            </div>

            <div className="rounded-lg border bg-background/80 p-3 text-sm">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="font-medium">单章质检</div>
                <Badge variant={hasActiveQualityJob ? "default" : "outline"}>
                  {qualityBatchState ? formatBatchStatus(qualityBatchState.status) : "空闲"}
                </Badge>
              </div>
              {qualityBatchState ? (
                <div className="space-y-2 text-xs text-muted-foreground">
                  <div className="grid gap-1">
                    <div>任务类型：{qualityBatchState.mode === "repair_until_pass" ? "一键修复到合格" : "批量审校"}</div>
                    <div>当前阶段：{batchStageLabel(qualityBatchState.currentStage)}</div>
                    <div>当前章节：{qualityBatchState.currentChapterLabel ?? "-"}</div>
                    <div>进度：{qualityBatchState.completedCount}/{qualityBatchState.totalCount}，{qualityProgressPercent}%</div>
                    <div>已达标：{qualityBatchState.qualifiedCount}，已修复：{qualityBatchState.repairedCount}</div>
                    <div>
                      最近心跳：{formatRelativeTime(qualityBatchState.heartbeatAt ?? qualityBatchState.updatedAt)}
                      {isHeartbeatPossiblyStale(qualityBatchState.heartbeatAt ?? qualityBatchState.updatedAt) ? "（可能卡住）" : ""}
                    </div>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${qualityProgressPercent}%` }} />
                  </div>
                  {qualityBatchState.message ? <div>{qualityBatchState.message}</div> : null}
                  {onCancelQualityBatch && hasActiveQualityJob ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={onCancelQualityBatch}
                      disabled={Boolean(isCancellingQualityBatch)}
                    >
                      {isCancellingQualityBatch ? "停止中..." : "停止单章质检"}
                    </Button>
                  ) : null}
                </div>
              ) : (
                <div className="text-xs text-muted-foreground">当前没有单章审校或修复任务。</div>
              )}
            </div>

            <div className="rounded-lg border bg-background/80 p-3 text-sm">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="font-medium">全书连贯守门</div>
                <Badge variant={hasActiveContinuityJob ? "default" : "outline"}>
                  {continuityBatchState ? continuityStatusLabel : "空闲"}
                </Badge>
              </div>
              {continuityBatchState ? (
                <div className="space-y-2 text-xs text-muted-foreground">
                  <div className="grid gap-1">
                    <div>当前阶段：{batchStageLabel(continuityBatchState.currentStage)}</div>
                    <div>当前章节：{continuityBatchState.currentChapterLabel ?? "-"}</div>
                    <div>当前批次：{continuityCurrentBatchLabel}</div>
                    <div>进度：{continuityBatchState.completedCount}/{continuityBatchState.totalCount}，{continuityProgressDisplay}</div>
                    <div>
                      最近心跳：{formatRelativeTime(continuityBatchState.heartbeatAt ?? continuityBatchState.updatedAt)}
                      {isHeartbeatPossiblyStale(continuityBatchState.heartbeatAt ?? continuityBatchState.updatedAt) ? "（可能卡住）" : ""}
                    </div>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${continuityProgressPercent}%` }} />
                  </div>
                  {continuityBatchState.message ? <div>{continuityBatchState.message}</div> : null}
                </div>
              ) : (
                <div className="text-xs text-muted-foreground">当前没有全书连贯守门任务。</div>
              )}
            </div>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>配置区</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 md:grid-cols-3">
              <div className="space-y-1">
                <div className="text-xs font-medium text-muted-foreground">起始章节</div>
                <Input
                  type="number"
                  min={1}
                  max={maxOrder}
                  value={pipelineForm.startOrder}
                  onChange={(event) => onPipelineFormChange("startOrder", Number(event.target.value) || 1)}
                />
              </div>
              <div className="space-y-1">
                <div className="text-xs font-medium text-muted-foreground">结束章节</div>
                <Input
                  type="number"
                  min={1}
                  max={maxOrder}
                  value={pipelineForm.endOrder}
                  onChange={(event) => onPipelineFormChange("endOrder", Number(event.target.value) || 1)}
                />
              </div>
              <div className="space-y-1">
                <div className="text-xs font-medium text-muted-foreground">失败重试</div>
                <Input
                  type="number"
                  min={0}
                  max={5}
                  value={pipelineForm.maxRetries}
                  onChange={(event) => onPipelineFormChange("maxRetries", Number(event.target.value) || 0)}
                />
              </div>
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              <div className="space-y-1">
                <div className="text-xs font-medium text-muted-foreground">运行模式</div>
                <select
                  className="w-full rounded-md border bg-background p-2 text-sm"
                  value={pipelineForm.runMode}
                  onChange={(event) => onPipelineFormChange("runMode", event.target.value)}
                >
                  <option value="fast">快速</option>
                  <option value="polish">精修</option>
                </select>
              </div>
              <div className="space-y-1">
                <div className="text-xs font-medium text-muted-foreground">质量阈值</div>
                <Input
                  type="number"
                  min={0}
                  max={100}
                  value={pipelineForm.qualityThreshold}
                  onChange={(event) => onPipelineFormChange("qualityThreshold", Number(event.target.value) || 75)}
                />
              </div>
              <div className="space-y-1">
                <div className="text-xs font-medium text-muted-foreground">修复模式</div>
                <select
                  className="w-full rounded-md border bg-background p-2 text-sm"
                  value={pipelineForm.repairMode}
                  onChange={(event) => onPipelineFormChange("repairMode", event.target.value)}
                >
                  <option value="detect_only">只检测不修复</option>
                  <option value="light_repair">自动轻修</option>
                  <option value="heavy_repair">自动重修</option>
                  <option value="continuity_only">只修连续性</option>
                  <option value="character_only">只修人设</option>
                  <option value="ending_only">只修结尾力度</option>
                </select>
              </div>
            </div>
            <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
              <label className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={pipelineForm.autoReview}
                  onChange={(event) => onPipelineFormChange("autoReview", event.target.checked)}
                />
                自动审校
              </label>
              <label className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={pipelineForm.autoRepair}
                  onChange={(event) => onPipelineFormChange("autoRepair", event.target.checked)}
                />
                自动修复
              </label>
              <label className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={pipelineForm.skipCompleted}
                  onChange={(event) => onPipelineFormChange("skipCompleted", event.target.checked)}
                />
                跳过已完成章节
              </label>
            </div>
            <div className="rounded-md border bg-muted/20 p-2 text-xs text-muted-foreground">
              当前设置：{pipelineForm.runMode === "polish" ? "精修" : "快速"} | 阈值 {pipelineForm.qualityThreshold} | {repairModeLabel(pipelineForm.repairMode)}
            </div>
            {hasPendingChapterDirectorySync ? (
              <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
                当前章节执行区已同步到第 {Math.max(syncedChapterMaxOrder, 1)} 章，目标范围已配置到第 {maxOrder} 章。
                启动批量生成时会优先补齐结构化拆章里缺失的章节目录。
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>阶段可视化</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {PIPELINE_STAGE_ITEMS.map((stage) => {
              const state = getPipelineStageState(stage.key, pipelineJob, PIPELINE_STAGE_ITEMS);
              return (
                <div
                  key={stage.key}
                  className={`rounded-md border px-3 py-2 text-sm ${
                    state === "active"
                      ? "border-primary bg-primary/10"
                      : state === "completed"
                        ? "border-emerald-500/30 bg-emerald-500/10"
                        : state === "failed"
                          ? "border-red-400/40 bg-red-500/10"
                          : "border-border bg-background"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span>{stage.label}</span>
                    <span className="text-xs text-muted-foreground">{stageStatusLabel(state)}</span>
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>运行面板</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => onRunPipeline()} disabled={isPipelineStartBlocked}>启动批量生成</Button>
              <Button
                variant="secondary"
                onClick={() => {
                  onRunPipeline({
                    startOrder: quickContinueStartOrder,
                    endOrder: quickContinueEndOrder,
                    skipCompleted: true,
                  });
                }}
                disabled={isPipelineStartBlocked || !hasQuickContinueTarget}
              >
                续写 10 章
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  if (!lowScoreRange) {
                    return;
                  }
                  onRunPipeline({
                    startOrder: lowScoreRange.startOrder,
                    endOrder: lowScoreRange.endOrder,
                    skipCompleted: false, // 修复：重跑低分章节时不应跳过
                  });
                }}
                disabled={isPipelineStartBlocked || !lowScoreRange}
              >
                仅重跑低分章节
              </Button>
              <Button variant="outline" onClick={exportPipelineReport}>导出任务报告</Button>
              <Button variant="outline" onClick={copyFullNovelText}>一键导出全文</Button>
              <Button variant="outline" onClick={onGenerateBible} disabled={isBibleStreaming || !hasCharacters}>手动重生成圣经</Button>
              <Button variant="secondary" onClick={onAbortBible} disabled={!isBibleStreaming}>停止圣经</Button>
              <Button variant="outline" onClick={onGenerateBeats} disabled={isBeatsStreaming || !hasCharacters}>手动重生成拍点</Button>
              <Button variant="secondary" onClick={onAbortBeats} disabled={!isBeatsStreaming}>停止拍点</Button>
            </div>
            <div className="rounded-md border bg-muted/20 p-2 text-xs text-muted-foreground">
              自动准备已并入批量出稿：启动流水线时会先检查作品圣经和本次章节范围的剧情拍点，缺失时自动生成，已存在则跳过。
              当前圣经：{bible ? "已保存" : "待自动生成"}；本次范围拍点：{plotBeatCountInPipelineRange}/{expectedPipelineBeatCount}
              {hasPipelineRangeBeats ? "，已覆盖当前范围。" : "，启动流水线时会自动补齐。"}
            </div>
            <div className="text-xs text-muted-foreground">
              {hasQuickContinueTarget
                ? `快捷续写会从当前连续正文后的下一章开始，本次目标：第 ${quickContinueStartOrder} 章 - 第 ${quickContinueEndOrder} 章；不会超过已规划的第 ${maxOrder} 章。`
                : `当前已连续写到规划上限第 ${maxOrder} 章，快捷续写已锁住；若要继续，请先创建续写项目或扩展卷战略/章节骨架。`}
            </div>
            {hasActivePipelineJob ? (
              <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
                当前已有批量任务在运行，系统会沿这条任务继续推进章节，无需重复点击“启动批量生成”。
              </div>
            ) : null}
            {lowScoreRange ? (
              <div className="text-xs text-muted-foreground">
                低分章节 {lowScoreRange.count} 个，可重跑范围：第 {lowScoreRange.startOrder} 章 - 第 {lowScoreRange.endOrder} 章。
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">当前无低于阈值的章节。</div>
            )}
            <div className="rounded-md border p-3 text-sm">
              <div className="mb-2 font-medium">任务状态</div>
              {pipelineJob ? (
                <div className="space-y-1">
                  <div>任务ID：{pipelineJob.id}</div>
                  <div>状态：{pipelineJob.status}</div>
                  <div>当前阶段：{pipelineJob.currentStage || "-"}</div>
                  <div>当前处理：{currentPipelineItemLabel || "-"}</div>
                  <div>进度：{Math.round((pipelineJob.progress ?? 0) * 100)}%</div>
                  <div>本轮完成：{pipelineJob.completedCount}/{pipelineJob.totalCount}</div>
                  {pipelineJob.skipCompleted ? (
                    <div>已跳过既有正文：{skippedExistingContentChapterCount} 章</div>
                  ) : null}
                  <div>
                    全书已有正文：{draftedChapterCount} 章
                    {latestDraftedChapter ? `，最高写到第 ${latestDraftedChapter.order} 章` : ""}
                    {draftedGapCount > 0 && globalLastContinuousDraftOrder
                      ? `，中间缺 ${draftedGapCount} 章（当前连续到第 ${globalLastContinuousDraftOrder} 章）`
                      : ""}
                  </div>
                  <div>累计重试：{pipelineJob.retryCount} 次（单章上限 {pipelineJob.maxRetries} 次）</div>
                  {pipelineJob.lastErrorType ? <div>失败分类：{pipelineJob.lastErrorType}</div> : null}
                  {pipelineJob.error ? (
                    <div className={pipelineJob.status === "succeeded" ? "text-amber-700" : "text-red-600"}>
                      {pipelineJob.status === "succeeded" ? "质量提示" : "错误"}：{pipelineJob.error}
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="text-muted-foreground">暂无运行中的流水线任务。</div>
              )}
            </div>
            <div className="rounded-md border bg-muted/20 p-3 text-sm">
              <div className="mb-2 font-medium">连续写作进度</div>
              <div className="space-y-1 text-muted-foreground">
                <div>已连续出稿到：{globalLastContinuousDraftOrder ? `第 ${globalLastContinuousDraftOrder} 章` : "当前还没有形成连续正文"}</div>
                <div>下一章目标：{globalNextContinuityOrder ? `第 ${globalNextContinuityOrder} 章` : "当前已连续写满"}</div>
                <div>当前聚焦：{currentPipelineChapter ? formatChapterReportLabel(safeChapters, currentPipelineChapter.id) : currentPipelineItemLabel || "-"}</div>
                <div>后台队列：{currentPipelineItemParts ? `${currentPipelineItemParts.queueIndex}/${currentPipelineItemParts.queueTotal}` : "-"}</div>
              </div>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <StreamOutput content={bibleStreamContent} isStreaming={isBibleStreaming} onAbort={onAbortBible} />
              <StreamOutput content={beatsStreamContent} isStreaming={isBeatsStreaming} onAbort={onAbortBeats} />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>全书连贯守门</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="rounded-md border bg-muted/20 p-2 text-xs text-muted-foreground">
              这里负责跨章顺序检查：上一章尾钩、本章开头、时间地点、物件归属、人物状态和未解决冲突。它不是单章润色工具，建议在单章质量修复通过后按 20 章一批运行。
            </div>
            <div className="grid gap-2 text-xs text-muted-foreground md:grid-cols-2">
              <div className="rounded-md border bg-muted/20 p-2">已写完正文：{continuityWrittenChapterCount} 章</div>
              <div className="rounded-md border bg-muted/20 p-2">已连续审查通过到：{continuityLastPassedOrder ? `第 ${continuityLastPassedOrder} 章` : "尚未开始"}</div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={onRunContinuityAuditBatches}
                disabled={isContinuityAuditButtonDisabled}
              >
                {continuityActionLabel}
              </Button>
              <Button
                variant="secondary"
                onClick={onRepairBlockedContinuityChapters}
                disabled={isContinuityRepairButtonDisabled}
              >
                一键修复当前阻塞
              </Button>
              {hasActiveContinuityJob ? (
                <Button
                  variant="outline"
                  onClick={onCancelContinuityBatch}
                  disabled={!onCancelContinuityBatch || Boolean(isCancellingContinuityBatch)}
                >
                  {isCancellingContinuityBatch ? "停止中..." : "停止当前审查"}
                </Button>
              ) : null}
            </div>
            {continuityActionBlockReason ? (
              <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
                {continuityActionBlockReason}
              </div>
            ) : null}
            <div className="rounded-xl border bg-muted/20 p-3 text-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-2">
                  <div className="text-xs uppercase tracking-wide text-muted-foreground">处理状态</div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className={continuityStatusBadgeClass(continuityBatchState?.mode)}>
                      {continuityStatusLabel}
                    </Badge>
                    {hasActiveContinuityJob ? <Badge variant="secondary">处理中</Badge> : null}
                    {continuityBlockedCount > 0 ? <Badge variant="secondary">阻塞 {continuityBlockedCount} 章</Badge> : null}
                  </div>
                  <div className="text-xs text-muted-foreground">{continuityStatusHint(continuityBatchState?.mode, continuityBlockedCount)}</div>
                </div>
                <div className="min-w-[120px] text-right">
                  <div className="text-2xl font-semibold leading-none">{continuityProgressDisplay}</div>
                  <div className="mt-1 text-xs text-muted-foreground">{continuityProgressCaption}</div>
                </div>
              </div>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{ width: `${continuityProgressPercent}%` }}
                />
              </div>
              <div className="mt-3 grid gap-2 text-xs text-muted-foreground md:grid-cols-2">
                <div className="rounded-md border bg-background/70 p-2">
                  <div className="font-medium text-foreground">下一批目标</div>
                  <div>{continuityDisplayNextBatchStartOrder ? `第 ${continuityDisplayNextBatchStartOrder} 章 - 第 ${continuityDisplayNextBatchEndOrder} 章` : "当前已写章节都已审查完毕"}</div>
                </div>
                <div className="rounded-md border bg-background/70 p-2">
                  <div className="font-medium text-foreground">当前批次</div>
                  <div>{continuityCurrentBatchLabel}</div>
                </div>
                <div className="rounded-md border bg-background/70 p-2">
                  <div className="font-medium text-foreground">当前章节</div>
                  <div>{continuityBatchState?.currentChapterLabel ?? "-"}</div>
                </div>
                <div className="rounded-md border bg-background/70 p-2">
                  <div className="font-medium text-foreground">累计通过</div>
                  <div>
                    {continuityBatchState
                      ? `${continuityBatchState.passedCount}/${continuityBatchState.totalCount || 0}`
                      : "-"}
                  </div>
                </div>
              </div>
              <div className="mt-3 space-y-1 text-muted-foreground">
                <div>累计进度：{continuityBatchState ? `${continuityBatchState.completedCount}/${continuityBatchState.totalCount}` : "-"}</div>
                {continuityBatchState?.message ? <div>{continuityBatchState.message}</div> : null}
                {continuityWindowShiftHint ? <div>{continuityWindowShiftHint}</div> : null}
                {continuityRepairingHistoricalBlockerHint ? <div>{continuityRepairingHistoricalBlockerHint}</div> : null}
              </div>
            </div>
            {hasContinuityBlockedChapters ? (
              <div className="space-y-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                <div className="font-medium">当前阻塞章节</div>
                {safeBlockedChapters.map((chapter) => (
                  <div key={chapter.chapterId} className="flex items-center justify-between gap-2">
                    <span>{chapter.chapterLabel}</span>
                    <div className="flex items-center gap-2">
                      {chapter.isMissing ? (
                        <Badge variant="outline" className="border-amber-500 text-amber-600">未审计</Badge>
                      ) : chapter.isExpired ? (
                        <Badge variant="outline" className="border-amber-500 text-amber-600">记录已过期</Badge>
                      ) : (
                        <Badge variant="secondary">连贯性 {chapter.coherence}</Badge>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                当前没有连贯性阻塞章节。点击“{continuityActionLabel}”后会按 20 章一批自动检查，发现阻塞会自动修复并复审，直到全书连贯守门完成。
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>单章质量修复</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-2 text-xs text-muted-foreground md:grid-cols-3">
              <div className="rounded-md border bg-muted/20 p-2">待审校章节：{qualityReviewCandidates.length}</div>
              <div className="rounded-md border bg-muted/20 p-2">待修复章节：{qualityRepairTargets.length}</div>
              <div className="rounded-md border bg-muted/20 p-2">待重检章节：{pendingRecheckReports.length}</div>
            </div>
            <div className="rounded-md border bg-muted/20 p-2 text-xs text-muted-foreground">
              这里负责单章质量：推进是否有效、节奏是否拖沓、重复是否过多、结尾是否有承接点。一键修复会先做质量审校，再补局部连贯护栏；全书级跨章窗口请交给“全书连贯守门”。
            </div>
            {qualityRepairTargets.length > 0 ? (
              <select
                className="w-full rounded-md border bg-background p-2 text-sm"
                value={qualitySelectedChapter?.id ?? ""}
                onChange={(event) => onSelectedChapterChange(event.target.value)}
              >
                {qualityRepairTargets.map((chapter) => (
                  <option key={chapter.id} value={chapter.id}>第{chapter.order}章 - {chapter.title}</option>
                ))}
              </select>
            ) : (
              <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                当前没有低于阈值的待修章节。若还有待检新稿，“一键修复到合格”会先自动审校，再继续修到达标。
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <Button onClick={onReviewAllQualityChapters} disabled={isQualityActionBlocked || qualityReviewCandidates.length === 0}>
                一键审校待检章节
              </Button>
              <Button
                variant="outline"
                onClick={onReviewFinalizedQualityChapters}
                disabled={isQualityActionBlocked || finalizedStaleReports.length === 0}
              >
                复核已定稿旧章
              </Button>
              <Button
                variant="secondary"
                onClick={onRepairAllQualityChapters}
                disabled={isQualityActionBlocked || qualityReviewCandidates.length === 0}
              >
                一键修复到合格
              </Button>
              <Button onClick={onReviewChapter} disabled={isQualityActionBlocked || !qualitySelectedChapter}>执行审校</Button>
              <Button variant="secondary" onClick={onRepairChapter} disabled={isQualityActionBlocked || !qualitySelectedChapter}>执行修复</Button>
              <Button variant="outline" onClick={onGenerateHook} disabled={isQualityActionBlocked || isGeneratingHook || !qualitySelectedChapter}>生成钩子</Button>
            </div>
            {qualityBatchState ? (
              <div className="rounded-md border p-3 text-sm">
                <div className="mb-2 font-medium">
                  {qualityBatchState.mode === "repair_until_pass" ? "批量修复中" : "批量审校中"}
                </div>
                <div className="space-y-1 text-muted-foreground">
                  <div>当前章节：{qualityBatchState.currentChapterLabel ?? "-"}</div>
                  <div>进度：{qualityBatchState.completedCount}/{qualityBatchState.totalCount}</div>
                  <div>已达标：{qualityBatchState.qualifiedCount}</div>
                  <div>已执行修复：{qualityBatchState.repairedCount}</div>
                  {qualityBatchState?.message ? <div>{qualityBatchState.message}</div> : null}
                </div>
              </div>
            ) : null}
            {reviewResult ? (
              <div className="rounded-md border p-3 text-sm">
                <div className="mb-2 font-medium">审校评分</div>
                <div className="grid gap-1 md:grid-cols-2">
                  <div>连贯性：{reviewResult.score.coherence}</div>
                  <div>重复率：{reviewResult.score.repetition}</div>
                  <div>节奏：{reviewResult.score.pacing}</div>
                  <div>口吻：{reviewResult.score.voice}</div>
                  <div>追更感：{reviewResult.score.engagement}</div>
                  <div>综合：{reviewResult.score.overall}</div>
                </div>
              </div>
            ) : null}
            <StreamOutput content={repairStreamContent} isStreaming={isRepairStreaming} onAbort={onAbortRepair} />
            {(repairBeforeContent || repairAfterContent) ? (
              <div className="grid gap-3 md:grid-cols-2">
                <pre className="max-h-[220px] overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-2 text-xs">{repairBeforeContent || "暂无"}</pre>
                <pre className="max-h-[220px] overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-2 text-xs">{repairAfterContent || "修复执行后显示"}</pre>
              </div>
            ) : null}
            {qualityIssueReports.length > 0 ? (
              <div className="space-y-2 rounded-md border p-2 text-xs">
                <div className="font-medium">真实低分 / 待修复章节（阈值 {pipelineForm.qualityThreshold}）</div>
                {qualityIssueReports.map((item, index) => (
                  <div key={`${item.chapterId}-${index}`} className="flex items-center justify-between">
                    <span>{formatChapterReportLabel(safeChapters, item.chapterId)}</span>
                    <Badge variant="secondary">overall {item.overall}</Badge>
                  </div>
                ))}
              </div>
            ) : null}
            {pendingRecheckReports.length > 0 ? (
              <div className="space-y-2 rounded-md border border-dashed p-2 text-xs text-muted-foreground">
                <div className="font-medium text-foreground">待重检章节</div>
                <div>
                  当前有 {pendingRecheckReports.length} 章会进入本轮统一重检，已从“待修复”列表中拆出；
                  点击“一键审校待检章节”只会重检这些待检章节，不会再把真实低分章和已定稿旧章混在一起。
                </div>
                <div className="flex flex-wrap gap-1">
                  {pendingRecheckReports.slice(0, 8).map((item) => (
                    <Badge key={item.chapterId} variant="outline">
                      {formatChapterReportLabel(safeChapters, item.chapterId)}
                    </Badge>
                  ))}
                </div>
                {pendingRecheckReports.length > 8 ? (
                  <div>其余 {pendingRecheckReports.length - 8} 章已省略显示。</div>
                ) : null}
              </div>
            ) : null}
            {finalizedStaleReports.length > 0 ? (
              <div className="space-y-2 rounded-md border border-dashed p-2 text-xs text-muted-foreground">
                <div className="font-medium text-foreground">已定稿待复核章节</div>
                <div>
                  另有 {finalizedStaleReports.length} 章已定稿章节存在历史质量报告过期记录；
                  它们不会出现在“待修复”里，但你可以用“复核已定稿旧章”单独补审。
                </div>
                <div className="flex flex-wrap gap-1">
                  {finalizedStaleReports.slice(0, 8).map((item) => (
                    <Badge key={item.chapterId} variant="outline">
                      {formatChapterReportLabel(safeChapters, item.chapterId)}
                    </Badge>
                  ))}
                </div>
                {finalizedStaleReports.length > 8 ? (
                  <div>其余 {finalizedStaleReports.length - 8} 章已省略显示。</div>
                ) : null}
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>质量报告总览</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {qualitySummary ? (
            <div className="grid gap-2 md:grid-cols-3">
              <Badge variant="outline">连贯性：{qualitySummary.coherence}</Badge>
              <Badge variant="outline">重复率：{qualitySummary.repetition}</Badge>
              <Badge variant="outline">节奏：{qualitySummary.pacing}</Badge>
              <Badge variant="outline">口吻：{qualitySummary.voice}</Badge>
              <Badge variant="outline">追更感：{qualitySummary.engagement}</Badge>
              <Badge variant="default">综合：{qualitySummary.overall}</Badge>
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">暂无质量报告。</div>
          )}
          <div className="space-y-2 text-sm">
            {safeChapterReports.slice(0, 10).map((item, index) => (
              <div key={`${item.chapterId ?? "novel"}-${index}`} className="rounded-md border p-2">
                <div>章节：{formatChapterReportLabel(safeChapters, item.chapterId)}</div>
                <div className="text-muted-foreground">
                  综合：{item.overall}，连贯性：{item.coherence}，重复率：{item.repetition}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>已保存圣经</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            {bible ? (
              <>
                <div className="rounded-md border p-2"><div className="font-medium">主线承诺</div><div className="text-muted-foreground">{bible.mainPromise ?? "暂无"}</div></div>
                <div className="rounded-md border p-2"><div className="font-medium">核心设定</div><div className="text-muted-foreground">{bible.coreSetting ?? "暂无"}</div></div>
                <div className="rounded-md border p-2"><div className="font-medium">世界规则</div><div className="text-muted-foreground">{bible.worldRules ?? "暂无"}</div></div>
              </>
            ) : (
              <div className="text-muted-foreground">暂无作品圣经。</div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>已保存拍点</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            {safePlotBeats.length > 0 ? (
              safePlotBeats.slice(0, 20).map((beat) => (
                <div key={beat.id} className="rounded-md border p-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-medium">第 {beat.chapterOrder ?? "-"} 章 · {beat.title}</div>
                    <Badge variant="outline">{beat.status}</Badge>
                  </div>
                  <div className="text-xs text-muted-foreground">类型：{beat.beatType}</div>
                </div>
              ))
            ) : (
              <div className="text-muted-foreground">暂无剧情拍点。</div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
