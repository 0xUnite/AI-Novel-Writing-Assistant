import type { Chapter, PipelineJob } from "@ai-novel/shared/types/novel";

export interface PipelineStageItem {
  key: string;
  label: string;
}

export interface ChapterReportSummary {
  chapterId?: string | null;
  chapterOrder?: number | null;
  overall: number;
  isStale?: boolean;
  isMissing?: boolean;
}

function toSafeChapterArray(chapters: Chapter[] | undefined | null): Chapter[] {
  return Array.isArray(chapters) ? chapters.filter((chapter): chapter is Chapter => Boolean(chapter)) : [];
}

function toSafeChapterReportArray(
  chapterReports: ChapterReportSummary[] | undefined | null,
): ChapterReportSummary[] {
  return Array.isArray(chapterReports)
    ? chapterReports.filter((report): report is ChapterReportSummary => Boolean(report))
    : [];
}

function isChapterMarkedForQualityAttention(chapter: Chapter): boolean {
  const status = resolvePipelineChapterStatus(chapter);
  return status === "needs_repair" || status === "pending_review";
}

function isChapterMarkedForRepair(chapter: Chapter): boolean {
  return resolvePipelineChapterStatus(chapter) === "needs_repair";
}

function isReportPendingRecheck(report: ChapterReportSummary | undefined): boolean {
  return Boolean(report?.isMissing || report?.isStale);
}

function isFreshLowScoreReport(
  report: ChapterReportSummary | undefined,
  threshold: number,
): boolean {
  return !isReportPendingRecheck(report) && typeof report?.overall === "number" && report.overall < threshold;
}

function getQualityReviewPriority(
  chapter: Chapter,
  report: ChapterReportSummary | undefined,
  threshold: number,
): number {
  if (isChapterMarkedForRepair(chapter) || isFreshLowScoreReport(report, threshold)) {
    return 0;
  }
  if (resolvePipelineChapterStatus(chapter) === "pending_review") {
    return 1;
  }
  if (isReportPendingRecheck(report) && !isFinalizedChapter(chapter)) {
    return 2;
  }
  return 3;
}

function buildChapterReportMap(
  chapterReports: ChapterReportSummary[] | undefined | null,
): Map<string, ChapterReportSummary> {
  return new Map(
    toSafeChapterReportArray(chapterReports)
      .flatMap((item) => item.chapterId ? [[item.chapterId, item] as const] : []),
  );
}

export const PIPELINE_STAGE_ITEMS: PipelineStageItem[] = [
  { key: "assemble_context", label: "装配上下文" },
  { key: "generate_task_sheet", label: "生成任务单" },
  { key: "generate_scene_cards", label: "生成场景拍点" },
  { key: "generate_content", label: "生成正文" },
  { key: "quality_check", label: "质量检测" },
  { key: "auto_repair", label: "自动修复" },
  { key: "update_memory", label: "更新剧情记忆" },
];

function mapCurrentStage(currentStage: string | null | undefined): string | null {
  if (!currentStage) {
    return null;
  }
  const mapping: Record<string, string> = {
    queued: "assemble_context",
    generating_chapters: "generate_content",
    reviewing: "quality_check",
    repairing: "auto_repair",
    finalizing: "update_memory",
  };
  return mapping[currentStage] ?? currentStage;
}

export function getPipelineStageState(
  stageKey: string,
  job: PipelineJob | undefined,
  order: PipelineStageItem[],
): "pending" | "active" | "completed" | "failed" {
  if (!job) {
    return "pending";
  }
  const normalizedCurrent = mapCurrentStage(job.currentStage);
  if (job.status === "succeeded") {
    return "completed";
  }
  if ((job.status === "failed" || job.status === "cancelled") && normalizedCurrent === stageKey) {
    return "failed";
  }
  const currentIndex = normalizedCurrent ? order.findIndex((item) => item.key === normalizedCurrent) : -1;
  const stageIndex = order.findIndex((item) => item.key === stageKey);
  if (normalizedCurrent === stageKey) {
    return "active";
  }
  if (currentIndex > stageIndex && stageIndex >= 0) {
    return "completed";
  }
  return "pending";
}

export function getLowScoreChapterRange(
  chapters: Chapter[],
  chapterReports: ChapterReportSummary[],
  threshold: number,
): { startOrder: number; endOrder: number; count: number } | null {
  const safeChapters = toSafeChapterArray(chapters);
  const reportMap = buildChapterReportMap(chapterReports);

  const lowScoreIds = safeChapters
    .filter((chapter) => {
      const report = reportMap.get(chapter.id);
      return isFreshLowScoreReport(report, threshold) || isChapterMarkedForRepair(chapter);
    })
    .map((chapter) => chapter.id);

  if (lowScoreIds.length === 0) {
    return null;
  }
  const matched = safeChapters
    .filter((chapter) => lowScoreIds.includes(chapter.id))
    .sort((a, b) => a.order - b.order);
  if (matched.length === 0) {
    return null;
  }
  return {
    startOrder: matched[0].order,
    endOrder: matched[matched.length - 1].order,
    count: matched.length,
  };
}

function hasChapterContent(chapter: Chapter): boolean {
  return Boolean(chapter.content?.trim());
}

export function resolvePipelineChapterStatus(chapter: Chapter): NonNullable<Chapter["chapterStatus"]> {
  const hasContent = hasChapterContent(chapter);
  if (chapter.generationState === "approved" || chapter.generationState === "published") {
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

function isFinalizedChapter(chapter: Chapter): boolean {
  return chapter.generationState === "approved" || chapter.generationState === "published";
}

export function getQualityReviewCandidates(
  chapters: Chapter[],
  chapterReports: ChapterReportSummary[],
  threshold: number,
): Chapter[] {
  const safeChapters = toSafeChapterArray(chapters);
  const reportByChapterId = buildChapterReportMap(chapterReports);

  return [...safeChapters]
    .filter((chapter) => {
      if (!hasChapterContent(chapter)) {
        return false;
      }
      const report = reportByChapterId.get(chapter.id);
      const needsRecheck = isReportPendingRecheck(report);
      if (isChapterMarkedForRepair(chapter) || isFreshLowScoreReport(report, threshold)) {
        return true;
      }
      if (resolvePipelineChapterStatus(chapter) === "pending_review") {
        return true;
      }
      if (needsRecheck) {
        return !isFinalizedChapter(chapter);
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

export function getQualityRepairTargets(
  chapters: Chapter[],
  chapterReports: ChapterReportSummary[],
  threshold: number,
): Chapter[] {
  const reportByChapterId = buildChapterReportMap(chapterReports);

  return getQualityReviewCandidates(chapters, chapterReports, threshold)
    .filter((chapter) => {
      const report = reportByChapterId.get(chapter.id);
      return isChapterMarkedForRepair(chapter) || isFreshLowScoreReport(report, threshold);
    })
    .sort((left, right) => left.order - right.order);
}
