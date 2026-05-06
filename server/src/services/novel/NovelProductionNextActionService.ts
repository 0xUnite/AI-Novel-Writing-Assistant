import type { NovelProductionNextAction } from "@ai-novel/shared/types/novel";
import { prisma } from "../../db/prisma";
import { NovelCoreReviewService } from "./novelCoreReviewService";

const QUALITY_REPORT_SKEW_TOLERANCE_MS = 10_000;

function hasContent(value: string | null | undefined): boolean {
  return Boolean(value?.trim());
}

function isFinalizedChapter(input: { generationState?: string | null }): boolean {
  return input.generationState === "approved" || input.generationState === "published";
}

function isQualityReportExpired(input: {
  chapterUpdatedAt: Date;
  reportCreatedAt?: Date | string | null;
}): boolean {
  if (!input.reportCreatedAt) {
    return true;
  }
  const reportCreatedAt = input.reportCreatedAt instanceof Date
    ? input.reportCreatedAt
    : new Date(input.reportCreatedAt);
  if (!Number.isFinite(reportCreatedAt.getTime())) {
    return true;
  }
  return reportCreatedAt.getTime() < input.chapterUpdatedAt.getTime() - QUALITY_REPORT_SKEW_TOLERANCE_MS;
}

function resolveChapterStatus(chapter: {
  content?: string | null;
  chapterStatus?: string | null;
  generationState?: string | null;
}): string {
  if (isFinalizedChapter(chapter)) {
    return "completed";
  }
  if (chapter.chapterStatus === "needs_repair") {
    return "needs_repair";
  }
  if (
    (chapter.generationState === "drafted" || chapter.generationState === "reviewed" || chapter.generationState === "repaired")
    && hasContent(chapter.content)
  ) {
    return "pending_review";
  }
  if (chapter.chapterStatus === "generating" && !hasContent(chapter.content)) {
    return "generating";
  }
  return chapter.chapterStatus ?? (hasContent(chapter.content) ? "pending_review" : "pending_generation");
}

function isQualityQualifiedReport(
  report:
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
  if (!report) {
    return false;
  }
  return (report.coherence ?? 0) >= 60
    && (report.repetition ?? 100) <= 40
    && (report.pacing ?? 0) >= 60
    && (report.voice ?? 0) >= 60
    && (report.engagement ?? 0) >= 60
    && (report.overall ?? 0) >= threshold;
}

function findLastContinuousDraftOrder(
  chapters: Array<{ order: number; content?: string | null }>,
  startOrder: number,
  endOrder: number,
): number | null {
  const chapterByOrder = new Map(chapters.map((chapter) => [chapter.order, chapter]));
  let lastContinuousOrder: number | null = null;
  for (let order = startOrder; order <= endOrder; order += 1) {
    const chapter = chapterByOrder.get(order);
    if (!hasContent(chapter?.content)) {
      break;
    }
    lastContinuousOrder = order;
  }
  return lastContinuousOrder;
}

export class NovelProductionNextActionService {
  private readonly reviewService = new NovelCoreReviewService();

  async getNextAction(novelId: string, threshold = 75): Promise<NovelProductionNextAction> {
    const normalizedThreshold = Math.max(0, Math.min(100, Math.round(threshold)));
    const [
      characterCount,
      chapters,
      reports,
      activePipelineJob,
      activeReviewJobs,
      continuityProgress,
    ] = await Promise.all([
      prisma.character.count({ where: { novelId } }),
      prisma.chapter.findMany({
        where: { novelId },
        select: {
          id: true,
          order: true,
          title: true,
          content: true,
          chapterStatus: true,
          generationState: true,
          updatedAt: true,
        },
        orderBy: { order: "asc" },
      }),
      prisma.qualityReport.findMany({
        where: { novelId },
        orderBy: [{ chapterId: "asc" }, { createdAt: "desc" }],
      }),
      prisma.generationJob.findFirst({
        where: {
          novelId,
          status: { in: ["queued", "running"] },
          cancelRequestedAt: null,
        },
        orderBy: { createdAt: "desc" },
        select: { id: true, status: true, currentItemLabel: true },
      }),
      prisma.novelReviewBatchJob.findMany({
        where: {
          novelId,
          status: { in: ["queued", "running"] },
          cancelRequestedAt: null,
        },
        orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
        select: { id: true, jobType: true, status: true, currentItemLabel: true },
        take: 5,
      }),
      this.reviewService.getContinuityAuditProgress(novelId, normalizedThreshold),
    ]);

    const latestReportByChapter = new Map<string, (typeof reports)[number]>();
    for (const report of reports) {
      if (report.chapterId && !latestReportByChapter.has(report.chapterId)) {
        latestReportByChapter.set(report.chapterId, report);
      }
    }

    const writtenChapters = chapters.filter((chapter) => hasContent(chapter.content));
    const qualityRepairCount = writtenChapters.filter((chapter) => {
      const report = latestReportByChapter.get(chapter.id);
      const reportStale = isQualityReportExpired({
        chapterUpdatedAt: chapter.updatedAt,
        reportCreatedAt: report?.createdAt,
      });
      const freshQualified = Boolean(report && !reportStale && isQualityQualifiedReport(report, normalizedThreshold));
      const freshLowScore = Boolean(report && !reportStale && !freshQualified);
      return (resolveChapterStatus(chapter) === "needs_repair" && !freshQualified) || freshLowScore;
    }).length;

    const qualityReviewCount = writtenChapters.filter((chapter) => {
      const report = latestReportByChapter.get(chapter.id);
      const reportStale = isQualityReportExpired({
        chapterUpdatedAt: chapter.updatedAt,
        reportCreatedAt: report?.createdAt,
      });
      if (resolveChapterStatus(chapter) === "needs_repair") {
        return !report || reportStale || !isQualityQualifiedReport(report, normalizedThreshold);
      }
      if (report && !reportStale && !isQualityQualifiedReport(report, normalizedThreshold)) {
        return true;
      }
      if (resolveChapterStatus(chapter) === "pending_review") {
        return true;
      }
      return reportStale && !isFinalizedChapter(chapter);
    }).length;
    const finalizedQualityReviewCount = writtenChapters.filter((chapter) => {
      if (!isFinalizedChapter(chapter)) {
        return false;
      }
      const report = latestReportByChapter.get(chapter.id);
      return isQualityReportExpired({
        chapterUpdatedAt: chapter.updatedAt,
        reportCreatedAt: report?.createdAt,
      });
    }).length;

    const hasActiveQualityJob = activeReviewJobs.some((job) => (
      job.jobType === "quality_review_all" || job.jobType === "quality_repair_until_pass"
    ));
    const hasActiveContinuityJob = activeReviewJobs.some((job) => (
      job.jobType === "continuity_audit" || job.jobType === "continuity_repair_blocked"
    ));

    const chapterCount = Math.max(chapters.length, 1);
    const lastContinuousDraftOrder = findLastContinuousDraftOrder(chapters, 1, chapterCount);
    const quickContinueStartOrder = (lastContinuousDraftOrder ?? 0) + 1;
    const hasQuickContinueTarget = quickContinueStartOrder <= chapterCount;
    const quickContinueEndOrder = hasQuickContinueTarget
      ? Math.min(chapterCount, quickContinueStartOrder + 9)
      : quickContinueStartOrder + 9;
    const continuityBlockedCount = continuityProgress.blockedChapters.length;

    const diagnostics = {
      characterCount,
      chapterCount,
      writtenChapterCount: writtenChapters.length,
      qualityRepairCount,
      qualityReviewCount,
      finalizedQualityReviewCount,
      continuityBlockedCount,
      hasActivePipelineJob: Boolean(activePipelineJob),
      hasActiveQualityJob,
      hasActiveContinuityJob,
      continuityStatus: continuityProgress.status,
    };

    const base = {
      novelId,
      diagnostics,
    };

    if (characterCount === 0) {
      return {
        ...base,
        action: "prepare_characters",
        title: "先补角色资料",
        description: "批量出稿、单章修复和连贯守门都会读取角色状态；先补至少 1 个角色，后面生成更稳。",
        buttonLabel: "去角色管理",
        disabled: false,
        payload: null,
      };
    }

    if (activePipelineJob) {
      return {
        ...base,
        action: "wait_pipeline",
        title: "等待当前批量出稿完成",
        description: "已经有章节流水线在运行。重复点击会增加并发写入风险，先看下方任务状态即可。",
        buttonLabel: "流水线运行中",
        disabled: true,
        reason: activePipelineJob.currentItemLabel ?? activePipelineJob.status,
        payload: null,
      };
    }

    if (hasActiveQualityJob) {
      return {
        ...base,
        action: "wait_quality",
        title: "等待单章质检完成",
        description: "单章审校/修复正在处理正文，完成后系统会刷新待修、待审校与连贯状态。",
        buttonLabel: "质检处理中",
        disabled: true,
        payload: null,
      };
    }

    if (hasActiveContinuityJob) {
      return {
        ...base,
        action: "wait_continuity",
        title: "等待全书连贯守门完成",
        description: "当前正在按章节顺序检查跨章承接，先让这轮跑完，避免同一批章节被重复修写。",
        buttonLabel: "连贯守门中",
        disabled: true,
        payload: null,
      };
    }

    if (qualityRepairCount > 0) {
      return {
        ...base,
        action: "repair_quality",
        title: "先修真实低分章",
        description: `当前有 ${qualityRepairCount} 章低于阈值或被标记需修复。建议先用“一键修复到合格”，它会做单章质量修复并补局部连贯护栏。`,
        buttonLabel: "一键修复到合格",
        disabled: false,
        payload: { qualityRepairCount },
      };
    }

    if (qualityReviewCount > 0) {
      return {
        ...base,
        action: "review_quality",
        title: "先审校待检新稿",
        description: `当前有 ${qualityReviewCount} 章需要质量评分。先审校再决定是否修复，能避免低分章漏进后续连贯守门。`,
        buttonLabel: "一键审校待检章节",
        disabled: false,
        payload: { qualityReviewCount },
      };
    }

    if (continuityBlockedCount > 0) {
      return {
        ...base,
        action: "repair_continuity",
        title: "修复全书连贯阻塞",
        description: `全书连贯守门发现 ${continuityBlockedCount} 章阻塞。先清掉阻塞，再继续写下一批会更稳。`,
        buttonLabel: "一键修复当前阻塞",
        disabled: false,
        payload: {
          continuityBlockedCount,
          continuityResumeOrder: continuityProgress.resumeOrder,
        },
      };
    }

    if (writtenChapters.length > 0 && continuityProgress.nextBatchStartOrder && continuityProgress.status !== "completed") {
      return {
        ...base,
        action: "audit_continuity",
        title: "继续全书连贯守门",
        description: "单章质量已没有明显待处理项。建议按 20 章窗口做跨章承接检查，确认时间、地点、物件和人物状态没有断裂。",
        buttonLabel: continuityProgress.resumeOrder > 1 ? "继续自动连贯性审查" : "开始自动连贯性审查",
        disabled: false,
        payload: {
          startOrder: continuityProgress.nextBatchStartOrder,
          endOrder: continuityProgress.nextBatchEndOrder ?? continuityProgress.nextBatchStartOrder,
          continuityResumeOrder: continuityProgress.resumeOrder,
        },
      };
    }

    if (finalizedQualityReviewCount > 0) {
      return {
        ...base,
        action: "review_quality",
        title: "复核已定稿旧章",
        description: `当前有 ${finalizedQualityReviewCount} 章已定稿正文的质量报告过期或缺失。导出前建议做一次终检复审，避免旧报告掩盖新改动。`,
        buttonLabel: "复核已定稿旧章",
        disabled: false,
        payload: {
          finalizedQualityReviewCount,
          qualityReviewCount: finalizedQualityReviewCount,
          includeFinalizedRecheck: true,
        },
      };
    }

    if (hasQuickContinueTarget) {
      return {
        ...base,
        action: "continue_writing",
        title: "可以继续写下一批",
        description: `当前连续正文已到第 ${lastContinuousDraftOrder ?? 0} 章，下一批会从第 ${quickContinueStartOrder} 章写到第 ${quickContinueEndOrder} 章，并且不会超过已规划章节上限。`,
        buttonLabel: "续写 10 章",
        disabled: false,
        payload: {
          startOrder: quickContinueStartOrder,
          endOrder: quickContinueEndOrder,
        },
      };
    }

    return {
      ...base,
      action: "completed",
      title: "当前短篇已整理到可导出状态",
      description: "正文、单章质量和全书连贯守门都没有明显待处理项，可以导出全文或继续人工微调。",
      buttonLabel: "已完成",
      disabled: true,
      payload: null,
    };
  }
}
