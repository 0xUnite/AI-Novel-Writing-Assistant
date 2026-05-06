import type {
  AuditReport,
  ContinuityBlockedChapterSummary,
  ContinuityAuditProgress,
  QualityScore,
  ReviewIssue,
} from "@ai-novel/shared/types/novel";
import type { GenerationContextPackage } from "@ai-novel/shared/types/chapterRuntime";
import type { BaseMessageChunk } from "@langchain/core/messages";
import { prisma } from "../../db/prisma";
import { runStructuredPrompt, streamTextPrompt } from "../../prompting/core/promptRunner";
import {
  chapterRepairPrompt,
  chapterReviewPrompt,
} from "../../prompting/prompts/novel/review.prompts";
import { ragServices } from "../rag";
import { auditService } from "../audit/AuditService";
import { plannerService } from "../planner/PlannerService";
import { stateService } from "../state/StateService";
import { syncChapterArtifacts } from "./novelChapterArtifacts";
import { sanitizeGeneratedChapterContent } from "./chapterContentSanitizer";
import {
  buildApprovedChapterProgress,
  buildDraftChapterProgress,
  buildReviewedChapterProgress,
} from "./chapterProgressState";
import {
  isPass,
  LLMGenerateOptions,
  logPipelineError,
  normalizeScore,
  RepairOptions,
  ReviewOptions,
  ruleScore,
} from "./novelCoreShared";
import { GenerationContextAssembler } from "./runtime/GenerationContextAssembler";
import {
  buildChapterRepairContextBlocks,
  resolveTargetWordRange,
  withChapterRepairContext,
} from "../../prompting/prompts/novel/chapterLayeredContext";

type AuditContextOperation = "review" | "audit" | "repair";

class ChapterContextAssemblyError extends Error {
  readonly code = "chapter_context_assembly_failed";
  readonly novelId: string;
  readonly chapterId: string;
  readonly operation: AuditContextOperation;
  readonly cause: unknown;

  constructor(
    novelId: string,
    chapterId: string,
    operation: AuditContextOperation,
    cause: unknown,
  ) {
    const operationLabel = operation === "review"
      ? "章节审阅"
      : operation === "audit"
        ? "章节审计"
        : "章节修复";
    super(`章节上下文装配失败，无法继续${operationLabel}。请先检查当前项目的卷级规划、章节计划和运行时资产是否完整后重试。`);
    this.name = "ChapterContextAssemblyError";
    this.novelId = novelId;
    this.chapterId = chapterId;
    this.operation = operation;
    this.cause = cause;
  }
}

const CONTINUITY_REPORT_SKEW_TOLERANCE_MS = 10_000;
const QUALITY_REPORT_SKEW_TOLERANCE_MS = 10_000;

function hasLengthRepairIntent(issues: ReviewIssue[]): boolean {
  return issues.some((issue) => (
    issue.category === "pacing"
    && /超过任务目标上限|超出最大长度|压缩正文到|控制在.+字以内/.test(
      `${issue.evidence}\n${issue.fixSuggestion}`,
    )
  ));
}

function stabilizeRepairOutput(input: {
  originalContent: string;
  repairedContent: string;
  targetWordCount: number | null | undefined;
  issues: ReviewIssue[];
}): string {
  const originalContent = input.originalContent.trim();
  const repairedContent = input.repairedContent.trim();
  if (!originalContent) {
    return repairedContent;
  }
  if (!repairedContent) {
    return originalContent;
  }

  const originalLength = originalContent.length;
  const repairedLength = repairedContent.length;
  const range = resolveTargetWordRange(input.targetWordCount ?? 5000);
  const hasCompressionIssue = hasLengthRepairIntent(input.issues);
  const ratioFloor = hasCompressionIssue ? 0.65 : 0.7;
  const absoluteFloor = Math.max(
    800,
    Math.floor(originalLength * ratioFloor),
    Math.floor((range.minWordCount ?? 800) * 0.85),
  );

  if (originalLength >= 2000 && repairedLength < absoluteFloor) {
    return originalContent;
  }

  return repairedContent;
}

export async function createQualityReport(
  novelId: string,
  chapterId: string,
  score: QualityScore,
  issues: ReviewIssue[],
) {
  await prisma.qualityReport.create({
    data: {
      novelId,
      chapterId,
      coherence: score.coherence,
      repetition: score.repetition,
      pacing: score.pacing,
      voice: score.voice,
      engagement: score.engagement,
      overall: score.overall,
      issues: issues.length > 0 ? JSON.stringify(issues) : null,
    },
  });
}

function formatContinuityChapterLabel(order: number, title: string): string {
  const safeTitle = title.trim() || "未命名章节";
  return `第${order}章 - ${safeTitle}`;
}

function hasBlockingContinuityIssue(issues: Array<{ status: string; severity: string }>): boolean {
  return issues.some((issue) => issue.status === "open" && (issue.severity === "high" || issue.severity === "critical"));
}

function isFreshContinuityPass(input: {
  chapterUpdatedAt: Date;
  threshold: number;
  report?:
    | {
      overallScore: number | null;
      createdAt: Date;
      issues: Array<{ status: string; severity: string }>;
    }
    | null;
}): boolean {
  if (!input.report) {
    return false;
  }
  const timestampDiff = input.report.createdAt.getTime() - input.chapterUpdatedAt.getTime();
  if (timestampDiff < -CONTINUITY_REPORT_SKEW_TOLERANCE_MS) {
    return false;
  }
  return (input.report.overallScore ?? 0) >= input.threshold && !hasBlockingContinuityIssue(input.report.issues);
}

function isContinuityReportExpired(input: {
  chapterUpdatedAt: Date;
  reportCreatedAt?: Date | null;
}): boolean {
  if (!input.reportCreatedAt) {
    return true;
  }
  return input.reportCreatedAt.getTime() < input.chapterUpdatedAt.getTime() - CONTINUITY_REPORT_SKEW_TOLERANCE_MS;
}

function buildContinuityBlockedChapterFromReport(input: {
  chapter: {
    id: string;
    title: string;
    order: number;
  };
  threshold: number;
  report:
    | {
      overallScore: number | null;
      issues: Array<{ id: string; status: string; severity: string }>;
    }
    | null;
}): ContinuityBlockedChapterSummary | null {
  if (!input.report) {
    return null;
  }
  const coherence = input.report.overallScore ?? 0;
  if (coherence >= input.threshold && !hasBlockingContinuityIssue(input.report.issues)) {
    return null;
  }
  return {
    chapterId: input.chapter.id,
    chapterOrder: input.chapter.order,
    chapterLabel: formatContinuityChapterLabel(input.chapter.order, input.chapter.title),
    coherence,
    issueIds: input.report.issues
      .filter((issue) => issue.status === "open")
      .map((issue) => issue.id),
  };
}

function reconcileBlockedChaptersFromPayload(input: {
  blockedChapters: ContinuityBlockedChapterSummary[];
  chaptersById: Map<string, {
    id: string;
    title: string;
    order: number;
    updatedAt: Date;
  }>;
  latestReports: Map<string, {
    overallScore: number | null;
    createdAt: Date;
    issues: Array<{ id: string; status: string; severity: string }>;
  }>;
  threshold: number;
  snapshotUpdatedAt: Date;
}): ContinuityBlockedChapterSummary[] {
  return input.blockedChapters.flatMap((blockedChapter) => {
    const chapter = input.chaptersById.get(blockedChapter.chapterId);
    if (!chapter) {
      return [];
    }

    const latestReport = input.latestReports.get(blockedChapter.chapterId) ?? null;
    const hasFreshReport = latestReport
      ? !isContinuityReportExpired({
        chapterUpdatedAt: chapter.updatedAt,
        reportCreatedAt: latestReport.createdAt,
      })
      : false;
    if (hasFreshReport) {
      const currentBlocked = buildContinuityBlockedChapterFromReport({
        chapter,
        threshold: input.threshold,
        report: latestReport,
      });
      return currentBlocked ? [currentBlocked] : [];
    }

    if (chapter.updatedAt.getTime() > input.snapshotUpdatedAt.getTime() + CONTINUITY_REPORT_SKEW_TOLERANCE_MS) {
      return [];
    }

    return [{
      chapterId: chapter.id,
      chapterOrder: chapter.order,
      chapterLabel: formatContinuityChapterLabel(chapter.order, chapter.title),
      coherence: blockedChapter.coherence ?? 0,
      issueIds: blockedChapter.issueIds ?? [],
    }];
  });
}

function parseContinuityBatchPayload(
  payload: string | null | undefined,
): {
  lastPassedOrder: number | null;
  currentBatchStartOrder: number | null;
  currentBatchEndOrder: number | null;
  blockedChapters: ContinuityBlockedChapterSummary[];
} {
  if (!payload?.trim()) {
    return {
      lastPassedOrder: null,
      currentBatchStartOrder: null,
      currentBatchEndOrder: null,
      blockedChapters: [],
    };
  }
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    const blockedChapters = Array.isArray(parsed.blockedChapters)
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
      : [];
    return {
      lastPassedOrder: typeof parsed.lastPassedOrder === "number" ? parsed.lastPassedOrder : null,
      currentBatchStartOrder: typeof parsed.currentBatchStartOrder === "number" ? parsed.currentBatchStartOrder : null,
      currentBatchEndOrder: typeof parsed.currentBatchEndOrder === "number" ? parsed.currentBatchEndOrder : null,
      blockedChapters,
    };
  } catch {
    return {
      lastPassedOrder: null,
      currentBatchStartOrder: null,
      currentBatchEndOrder: null,
      blockedChapters: [],
    };
  }
}

function isQualityReportExpired(input: {
  chapterUpdatedAt: Date;
  reportCreatedAt?: Date | null;
}): boolean {
  if (!input.reportCreatedAt) {
    return true;
  }
  return input.reportCreatedAt.getTime() < input.chapterUpdatedAt.getTime() - QUALITY_REPORT_SKEW_TOLERANCE_MS;
}

function getRepairModeHint(
  repairMode: "detect_only" | "light_repair" | "heavy_repair" | "continuity_only" | "character_only" | "ending_only" | undefined,
  issueContext: Array<{ code?: string | null; evidence?: string | null; fixSuggestion?: string | null }> = [],
): string {
  let baseHint = "";
  switch (repairMode) {
    case "continuity_only":
      baseHint = "优先修上下章承接、时间线过桥和开头续接，不做大幅风格重写。";
      break;
    case "character_only":
      baseHint = "优先修人物言行一致性、动机和关系表现，不改变主线任务。";
      break;
    case "ending_only":
      baseHint = "优先修章节收束、钩子和结尾决断感，让章节尾部更有拉力。";
      break;
    case "heavy_repair":
      baseHint = "允许较大幅度重写句段，只要剧情方向不变即可。";
      break;
    case "light_repair":
    case "detect_only":
    default:
      baseHint = "以轻修为主，优先保持原有内容框架和事件顺序。";
      break;
  }

  const issueText = issueContext
    .map((item) => `${item.code ?? ""}\n${item.evidence ?? ""}\n${item.fixSuggestion ?? ""}`)
    .join("\n");
  if (/(item_ownership_|归属|谁手里|何时转手|递给|接过|持有)/.test(issueText)) {
    return `${baseHint} 若涉及物品或道具归属，必须把谁拿着物品、何时递交、谁接过、转手后谁继续持有写成明确动作，不要用模糊代词带过。`;
  }

  return baseHint;
}

export class NovelCoreReviewService {
  private readonly generationContextAssembler = new GenerationContextAssembler();

  async reviewChapter(novelId: string, chapterId: string, options: ReviewOptions = {}) {
    const chapter = await prisma.chapter.findFirst({
      where: { id: chapterId, novelId },
      include: { novel: true },
    });
    if (!chapter) {
      throw new Error("章节不存在");
    }

    const review = await this.reviewChapterWithAudit(
      chapter.novel.title,
      chapter.title,
      options.content ?? chapter.content ?? "",
      options,
      novelId,
      chapterId,
    );

    const chapterProgress = buildReviewedChapterProgress({
      hasIssues: review.issues.length > 0,
    });
    await prisma.chapter.update({
      where: { id: chapterId },
      data: {
        generationState: chapterProgress.generationState,
        chapterStatus: chapterProgress.chapterStatus,
      },
    });
    await createQualityReport(novelId, chapterId, review.score, review.issues);
    if ((review.auditReports?.length ?? 0) > 0 && plannerService.shouldTriggerReplanFromAudit(review.auditReports ?? [])) {
      await plannerService.replan(novelId, {
        chapterId,
        triggerType: "audit_failure",
        reason: "High-severity audit issues require plan rebuild.",
        provider: options.provider,
        model: options.model,
        temperature: options.temperature,
      }).catch(() => null);
    }

    return review;
  }

  async createRepairStream(novelId: string, chapterId: string, options: RepairOptions = {}) {
    const [novel, chapter, bible] = await Promise.all([
      prisma.novel.findUnique({ where: { id: novelId } }),
      prisma.chapter.findFirst({ where: { id: chapterId, novelId } }),
      prisma.novelBible.findUnique({ where: { novelId } }),
    ]);
    if (!novel || !chapter) {
      throw new Error("小说或章节不存在");
    }

    const fallbackReview = options.reviewIssues ? null : await this.reviewChapter(novelId, chapterId, options);
    const auditIssues = options.auditIssueIds?.length
      ? await prisma.auditIssue.findMany({
        where: { id: { in: options.auditIssueIds } },
        orderBy: { createdAt: "asc" },
      })
      : [];
    const issues = options.reviewIssues
      ?? fallbackReview?.issues
      ?? auditIssues.map((item) => ({
        severity: item.severity as ReviewIssue["severity"],
        category: item.auditType === "continuity" ? "coherence" : item.auditType === "character" ? "logic" : "pacing",
        evidence: item.evidence,
        fixSuggestion: item.fixSuggestion,
      }));

    let ragContext = "";
    try {
      ragContext = await ragServices.hybridRetrievalService.buildContextBlock(
        `章节修复 ${novel.title}\n${chapter.title}\n${chapter.content ?? ""}`,
        {
          novelId,
          ownerTypes: ["novel", "chapter", "chapter_summary", "consistency_fact", "character", "bible"],
          finalTopK: 8,
        },
      );
    } catch {
      ragContext = "";
    }

    let repairContextBlocks:
      | ReturnType<typeof buildChapterRepairContextBlocks>
      | undefined;
    try {
      const assembledContextPackage = await this.assembleAuditContextPackage(novelId, chapterId, options, "repair");
      const repairContextPackage = withChapterRepairContext(assembledContextPackage, issues);
      if (!repairContextPackage.chapterRepairContext) {
        const error = new Error("chapterRepairContext missing after successful context assembly");
        logPipelineError("Failed to derive repair context from assembled chapter context package.", {
          novelId,
          chapterId,
          operation: "repair",
          provider: options.provider ?? null,
          model: options.model ?? null,
          error: error.message,
        });
        throw new ChapterContextAssemblyError(novelId, chapterId, "repair", error);
      } else {
        repairContextBlocks = buildChapterRepairContextBlocks(repairContextPackage.chapterRepairContext);
      }
    } catch (error) {
      throw error;
    }
    if (!repairContextBlocks) {
      throw new ChapterContextAssemblyError(
        novelId,
        chapterId,
        "repair",
        new Error("chapter repair context blocks unavailable"),
      );
    }

    const streamed = await streamTextPrompt({
      asset: chapterRepairPrompt,
      promptInput: {
        novelTitle: novel.title,
        bibleContent: bible?.rawContent ?? "暂无",
        chapterTitle: chapter.title,
        chapterContent: chapter.content ?? "",
        issuesJson: JSON.stringify(issues, null, 2),
        ragContext: ragContext || "",
        modeHint: getRepairModeHint(options.repairMode, [
          ...auditIssues.map((item) => ({
            code: item.code,
            evidence: item.evidence,
            fixSuggestion: item.fixSuggestion,
          })),
          ...issues.map((item) => ({
            evidence: item.evidence,
            fixSuggestion: item.fixSuggestion,
          })),
        ]),
      },
      contextBlocks: repairContextBlocks,
      options: {
        provider: options.provider,
        model: options.model,
        temperature: options.temperature ?? 0.5,
      },
    });

    return {
      stream: streamed.stream as AsyncIterable<BaseMessageChunk>,
      onDone: async (fullContent: string) => {
        const completed = await streamed.complete;
        const repairedContent = stabilizeRepairOutput({
          originalContent: chapter.content ?? "",
          repairedContent: sanitizeGeneratedChapterContent(completed.output.trim() || fullContent),
          targetWordCount: chapter.targetWordCount,
          issues,
        });
        const repairedProgress = buildDraftChapterProgress("repaired");
        await prisma.chapter.update({
          where: { id: chapterId },
          data: {
            content: repairedContent,
            generationState: repairedProgress.generationState,
            chapterStatus: repairedProgress.chapterStatus,
          },
        });
        await syncChapterArtifacts(novelId, chapterId, repairedContent);

        const review = await this.reviewChapter(novelId, chapterId, { ...options, content: repairedContent });
        if (isPass(review.score)) {
          const approvedProgress = buildApprovedChapterProgress();
          await prisma.chapter.update({
            where: { id: chapterId },
            data: {
              generationState: approvedProgress.generationState,
              chapterStatus: approvedProgress.chapterStatus,
            },
          });
          if (options.auditIssueIds?.length) {
            await auditService.resolveIssues(novelId, options.auditIssueIds).catch(() => null);
          }
        }
      },
    };
  }

  async getNovelState(novelId: string) {
    return stateService.getNovelState(novelId);
  }

  async getLatestStateSnapshot(novelId: string) {
    return stateService.getLatestSnapshot(novelId);
  }

  async getChapterStateSnapshot(novelId: string, chapterId: string) {
    return stateService.getChapterSnapshot(novelId, chapterId);
  }

  async rebuildNovelState(novelId: string, options: LLMGenerateOptions = {}) {
    return stateService.rebuildState(novelId, options);
  }

  async generateBookPlan(novelId: string, options: LLMGenerateOptions = {}) {
    return plannerService.generateBookPlan(novelId, options);
  }

  async generateArcPlan(novelId: string, arcId: string, options: LLMGenerateOptions = {}) {
    return plannerService.generateArcPlan(novelId, arcId, options);
  }

  async generateChapterPlan(novelId: string, chapterId: string, options: LLMGenerateOptions = {}) {
    return plannerService.generateChapterPlan(novelId, chapterId, options);
  }

  async getChapterPlan(novelId: string, chapterId: string) {
    return plannerService.getChapterPlan(novelId, chapterId);
  }

  async replanNovel(
    novelId: string,
    input: {
      chapterId?: string;
      triggerType?: string;
      sourceIssueIds?: string[];
      windowSize?: number;
      reason: string;
    } & LLMGenerateOptions,
  ) {
    return plannerService.replan(novelId, input);
  }

  async auditChapter(
    novelId: string,
    chapterId: string,
    scope: "full" | "continuity" | "character" | "plot" | "mode_fit",
    options: ReviewOptions = {},
  ) {
    let contextPackage: GenerationContextPackage | undefined;
    try {
      contextPackage = await this.assembleAuditContextPackage(novelId, chapterId, options, "audit");
    } catch (error) {
      throw error;
    }
    if (!contextPackage) {
      throw new ChapterContextAssemblyError(
        novelId,
        chapterId,
        "audit",
        new Error("chapter context package unavailable"),
      );
    }
    return auditService.auditChapter(novelId, chapterId, scope, {
      ...options,
      contextPackage,
    });
  }

  async listChapterAuditReports(novelId: string, chapterId: string) {
    return auditService.listChapterAuditReports(novelId, chapterId);
  }

  async resolveAuditIssues(novelId: string, issueIds: string[]) {
    return auditService.resolveIssues(novelId, issueIds);
  }

  async getContinuityAuditProgress(novelId: string, threshold = 75): Promise<ContinuityAuditProgress> {
    const chapters = (await prisma.chapter.findMany({
      where: { novelId },
      select: {
        id: true,
        title: true,
        order: true,
        content: true,
        updatedAt: true,
      },
      orderBy: { order: "asc" },
    }))
      .filter((chapter) => Boolean(chapter.content?.trim()));

    if (chapters.length === 0) {
      return {
        novelId,
        threshold,
        writtenChapterCount: 0,
        lastPassedOrder: null,
        resumeOrder: 1,
        nextBatchStartOrder: null,
        nextBatchEndOrder: null,
        blockedChapters: [],
        status: "not_started",
      };
    }

    const chaptersById = new Map(chapters.map((chapter) => [chapter.id, chapter]));
    let latestReportsCache:
      | Map<string, {
        overallScore: number | null;
        createdAt: Date;
        issues: Array<{ id: string; status: string; severity: string }>;
      }>
      | null = null;
    const loadLatestReports = async () => {
      if (latestReportsCache) {
        return latestReportsCache;
      }
      latestReportsCache = new Map<string, {
        overallScore: number | null;
        createdAt: Date;
        issues: Array<{ id: string; status: string; severity: string }>;
      }>();
      const reports = await prisma.auditReport.findMany({
        where: {
          novelId,
          auditType: "continuity",
          chapterId: { in: chapters.map((chapter) => chapter.id) },
        },
        include: { issues: true },
        orderBy: [
          { chapterId: "asc" },
          { createdAt: "desc" },
        ],
      });

      for (const report of reports) {
        if (!latestReportsCache.has(report.chapterId)) {
          latestReportsCache.set(report.chapterId, report);
        }
      }
      return latestReportsCache;
    };

    let continuityAnchorLastPassedOrder: number | null = null;
    const continuityJobs = await prisma.novelReviewBatchJob.findMany({
      where: {
        novelId,
        jobType: { in: ["continuity_audit", "continuity_repair_blocked"] },
        status: { in: ["queued", "running", "succeeded", "cancelled", "failed"] },
      },
      select: {
        id: true,
        jobType: true,
        status: true,
        payload: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: [
        { createdAt: "asc" },
        { id: "asc" },
      ],
    });

    if (continuityJobs.length > 0) {
      let lastPassedOrder: number | null = null;
      let pendingBlockedState: {
        batchStartOrder: number | null;
        batchEndOrder: number | null;
        blockedChapters: ContinuityBlockedChapterSummary[];
      } | null = null;
      let hasInFlightContinuityJob = false;

      for (const job of continuityJobs) {
        if (job.status === "queued" || job.status === "running") {
          hasInFlightContinuityJob = true;
        }
        const payload = parseContinuityBatchPayload(job.payload);
        const isRecoverableFailedJob = job.status === "failed"
          && (
            typeof payload.lastPassedOrder === "number"
            || typeof payload.currentBatchEndOrder === "number"
            || payload.blockedChapters.length > 0
          );
        if (job.status === "failed" && !isRecoverableFailedJob) {
          continue;
        }
        const isCancelledJob = job.status === "cancelled";
        if (job.jobType === "continuity_audit") {
          const reconciledBlockedChapters = payload.blockedChapters.length > 0
            ? reconcileBlockedChaptersFromPayload({
              blockedChapters: payload.blockedChapters,
              chaptersById,
              latestReports: await loadLatestReports(),
              threshold,
              snapshotUpdatedAt: job.updatedAt,
            })
            : [];
          if (isCancelledJob && reconciledBlockedChapters.length > 0) {
            continue;
          }
          if (reconciledBlockedChapters.length > 0) {
            pendingBlockedState = {
              batchStartOrder: payload.currentBatchStartOrder ?? ((payload.lastPassedOrder ?? lastPassedOrder ?? 0) + 1),
              batchEndOrder: payload.currentBatchEndOrder,
              blockedChapters: reconciledBlockedChapters,
            };
            lastPassedOrder = payload.lastPassedOrder ?? lastPassedOrder;
            continue;
          }
          if (typeof payload.lastPassedOrder === "number") {
            lastPassedOrder = Math.max(lastPassedOrder ?? 0, payload.lastPassedOrder);
          } else if (typeof payload.currentBatchEndOrder === "number") {
            lastPassedOrder = Math.max(lastPassedOrder ?? 0, payload.currentBatchEndOrder);
          }
          pendingBlockedState = null;
          continue;
        }

        if (job.jobType === "continuity_repair_blocked" && job.status === "succeeded") {
          const reconciledBlockedChapters = payload.blockedChapters.length > 0
            ? reconcileBlockedChaptersFromPayload({
              blockedChapters: payload.blockedChapters,
              chaptersById,
              latestReports: await loadLatestReports(),
              threshold,
              snapshotUpdatedAt: job.updatedAt,
            })
            : [];
          if (reconciledBlockedChapters.length > 0) {
            pendingBlockedState = {
              batchStartOrder: payload.currentBatchStartOrder
                ?? pendingBlockedState?.batchStartOrder
                ?? ((payload.lastPassedOrder ?? lastPassedOrder ?? 0) + 1),
              batchEndOrder: payload.currentBatchEndOrder ?? pendingBlockedState?.batchEndOrder ?? null,
              blockedChapters: reconciledBlockedChapters,
            };
            lastPassedOrder = payload.lastPassedOrder ?? lastPassedOrder;
            continue;
          }

          if (pendingBlockedState) {
            const repairedBatchEndOrder = pendingBlockedState.batchEndOrder
              ?? payload.currentBatchEndOrder
              ?? payload.lastPassedOrder
              ?? lastPassedOrder;
            if (typeof repairedBatchEndOrder === "number") {
              lastPassedOrder = Math.max(lastPassedOrder ?? 0, repairedBatchEndOrder);
            }
            pendingBlockedState = null;
          }
        }
      }

      continuityAnchorLastPassedOrder = lastPassedOrder;

      const highestWrittenOrder = chapters[chapters.length - 1]?.order ?? null;
      if (pendingBlockedState) {
        return {
          novelId,
          threshold,
          writtenChapterCount: chapters.length,
          lastPassedOrder,
          resumeOrder: pendingBlockedState.batchStartOrder ?? ((lastPassedOrder ?? 0) + 1),
          nextBatchStartOrder: pendingBlockedState.batchStartOrder,
          nextBatchEndOrder: pendingBlockedState.batchEndOrder,
          blockedChapters: pendingBlockedState.blockedChapters,
          status: hasInFlightContinuityJob ? "running" : "blocked",
        };
      }

      if (hasInFlightContinuityJob) {
        if (highestWrittenOrder != null && (lastPassedOrder ?? 0) >= highestWrittenOrder) {
          return {
            novelId,
            threshold,
            writtenChapterCount: chapters.length,
            lastPassedOrder: highestWrittenOrder,
            resumeOrder: highestWrittenOrder + 1,
            nextBatchStartOrder: null,
            nextBatchEndOrder: null,
            blockedChapters: [],
            status: "completed",
          };
        }

        const resumeOrder = Math.max((lastPassedOrder ?? 0) + 1, 1);
        const nextBatch = chapters.filter((chapter) => chapter.order >= resumeOrder).slice(0, 20);
        return {
          novelId,
          threshold,
          writtenChapterCount: chapters.length,
          lastPassedOrder,
          resumeOrder,
          nextBatchStartOrder: nextBatch[0]?.order ?? null,
          nextBatchEndOrder: nextBatch[nextBatch.length - 1]?.order ?? null,
          blockedChapters: [],
          status: "running",
        };
      }
    }

    const latestReports = await loadLatestReports();
    const shouldTreatMissingOrExpiredReportsAsBlocked = continuityAnchorLastPassedOrder == null;

    let lastPassedOrder: number | null = continuityAnchorLastPassedOrder;
    let resumeIndex = typeof continuityAnchorLastPassedOrder === "number"
      ? chapters.findIndex((chapter) => chapter.order > continuityAnchorLastPassedOrder)
      : 0;
    if (resumeIndex < 0) {
      resumeIndex = chapters.length;
    }
    for (let index = resumeIndex; index < chapters.length; index += 1) {
      const chapter = chapters[index];
      const report = latestReports.get(chapter.id) ?? null;
      if (!isFreshContinuityPass({
        chapterUpdatedAt: chapter.updatedAt,
        threshold,
        report,
      })) {
        resumeIndex = index;
        break;
      }
      lastPassedOrder = chapter.order;
      resumeIndex = index + 1;
    }

    if (resumeIndex >= chapters.length) {
      const lastOrder = chapters[chapters.length - 1]?.order ?? null;
      return {
        novelId,
        threshold,
        writtenChapterCount: chapters.length,
        lastPassedOrder: lastOrder,
        resumeOrder: (lastOrder ?? 0) + 1,
        nextBatchStartOrder: null,
        nextBatchEndOrder: null,
        blockedChapters: [],
        status: "completed",
      };
    }

    const nextBatch = chapters.slice(resumeIndex, resumeIndex + 20);
    const blockedChapters = nextBatch.flatMap((chapter) => {
      const report = latestReports.get(chapter.id) ?? null;
      const isExpired = isContinuityReportExpired({
        chapterUpdatedAt: chapter.updatedAt,
        reportCreatedAt: report?.createdAt,
      });
      if (!report || isExpired) {
        if (!shouldTreatMissingOrExpiredReportsAsBlocked) {
          return [];
        }
        return [{
          chapterId: chapter.id,
          chapterOrder: chapter.order,
          chapterLabel: formatContinuityChapterLabel(chapter.order, chapter.title),
          coherence: report?.overallScore ?? 0,
          issueIds: report?.issues.filter((issue) => issue.status === "open").map((issue) => issue.id) ?? [],
          isExpired: Boolean(report),
          isMissing: !report,
        }];
      }
      const blocked = buildContinuityBlockedChapterFromReport({
        chapter,
        threshold,
        report,
      });
      return blocked ? [blocked] : [];
    });

    return {
      novelId,
      threshold,
      writtenChapterCount: chapters.length,
      lastPassedOrder,
      resumeOrder: nextBatch[0]?.order ?? chapters[resumeIndex]?.order ?? 1,
      nextBatchStartOrder: nextBatch[0]?.order ?? null,
      nextBatchEndOrder: nextBatch[nextBatch.length - 1]?.order ?? null,
      blockedChapters,
      status: blockedChapters.length > 0 ? "blocked" : lastPassedOrder ? "ready" : "not_started",
    };
  }

  async getQualityReport(novelId: string) {
    const [chapters, reports] = await Promise.all([
      prisma.chapter.findMany({
        where: { novelId },
        select: {
          id: true,
          title: true,
          order: true,
          content: true,
          chapterStatus: true,
          generationState: true,
          updatedAt: true,
        },
        orderBy: { order: "asc" },
      }),
      prisma.qualityReport.findMany({
        where: { novelId },
        orderBy: [
          { chapterId: "asc" },
          { createdAt: "desc" },
        ],
      }),
    ]);
    const writtenChapters = chapters.filter((chapter) => Boolean(chapter.content?.trim()));
    if (writtenChapters.length === 0 && reports.length === 0) {
      return { novelId, summary: normalizeScore({}), chapterReports: [], totalReports: 0 };
    }

    const latestByChapter = new Map<string, (typeof reports)[number]>();
    for (const report of reports) {
      if (report.chapterId && !latestByChapter.has(report.chapterId)) {
        latestByChapter.set(report.chapterId, report);
      }
    }

    const chapterReports = writtenChapters.map((chapter) => {
      const report = latestByChapter.get(chapter.id);
      const isMissing = !report;
      const isStale = report ? isQualityReportExpired({
        chapterUpdatedAt: chapter.updatedAt,
        reportCreatedAt: report.createdAt,
      }) : true;
      return {
        chapterId: chapter.id,
        chapterOrder: chapter.order,
        chapterLabel: formatContinuityChapterLabel(chapter.order, chapter.title),
        chapterStatus: chapter.chapterStatus ?? null,
        generationState: chapter.generationState ?? null,
        coherence: report?.coherence ?? 0,
        repetition: report?.repetition ?? 0,
        pacing: report?.pacing ?? 0,
        voice: report?.voice ?? 0,
        engagement: report?.engagement ?? 0,
        overall: report?.overall ?? 0,
        issues: report?.issues ?? null,
        isMissing,
        isStale,
      };
    });

    const freshReports = chapterReports.filter((report) => !report.isMissing && !report.isStale);
    const fallbackReports = chapterReports.filter((report) => !report.isMissing);
    const source = freshReports.length > 0 ? freshReports : fallbackReports;
    if (source.length === 0) {
      return { novelId, summary: normalizeScore({}), chapterReports, totalReports: reports.length };
    }
    const total = source.length;

    const summary = normalizeScore({
      coherence: source.reduce((sum, item) => sum + item.coherence, 0) / total,
      repetition: source.reduce((sum, item) => sum + item.repetition, 0) / total,
      pacing: source.reduce((sum, item) => sum + item.pacing, 0) / total,
      voice: source.reduce((sum, item) => sum + item.voice, 0) / total,
      engagement: source.reduce((sum, item) => sum + item.engagement, 0) / total,
      overall: source.reduce((sum, item) => sum + item.overall, 0) / total,
    });

    return { novelId, summary, chapterReports, totalReports: reports.length };
  }

  private async reviewChapterContent(
    novelTitle: string,
    chapterTitle: string,
    content: string,
    options: ReviewOptions = {},
    novelId?: string,
  ): Promise<{ score: QualityScore; issues: ReviewIssue[] }> {
    if (!content.trim()) {
      return {
        score: normalizeScore({}),
        issues: [{
          severity: "critical",
          category: "coherence",
          evidence: "章节内容为空",
          fixSuggestion: "先生成或补充正文，再进行审校",
        }],
      };
    }

    try {
      let ragContext = "";
      if (novelId) {
        try {
          ragContext = await ragServices.hybridRetrievalService.buildContextBlock(
            `章节审校 ${novelTitle}\n${chapterTitle}\n${content.slice(0, 1500)}`,
            {
              novelId,
              ownerTypes: ["novel", "chapter", "chapter_summary", "consistency_fact", "character", "bible"],
              finalTopK: 6,
            },
          );
        } catch {
          ragContext = "";
        }
      }

      const result = await runStructuredPrompt({
        asset: chapterReviewPrompt,
        promptInput: {
          novelTitle,
          chapterTitle,
          content,
          ragContext: ragContext || "",
        },
        options: {
          provider: options.provider,
          model: options.model,
          temperature: options.temperature ?? 0.1,
        },
      });
      const parsed = result.output;

      return {
        score: normalizeScore(parsed.score ?? {}),
        issues: Array.isArray(parsed.issues) ? parsed.issues : [],
      };
    } catch {
      return { score: ruleScore(content), issues: [] };
    }
  }

  private async reviewChapterWithAudit(
    novelTitle: string,
    chapterTitle: string,
    content: string,
    options: ReviewOptions = {},
    novelId?: string,
    chapterId?: string,
  ): Promise<{ score: QualityScore; issues: ReviewIssue[]; auditReports?: AuditReport[] }> {
    if (!content.trim()) {
      return {
        score: normalizeScore({}),
        issues: [{
          severity: "critical",
          category: "coherence",
          evidence: "章节内容为空",
          fixSuggestion: "先生成或补全正文，再进行审校",
        }],
        auditReports: [],
      };
    }

    if (novelId && chapterId) {
      let contextPackage: GenerationContextPackage | undefined;
      try {
        contextPackage = await this.assembleAuditContextPackage(novelId, chapterId, options, "review");
      } catch (error) {
        throw error;
      }
      if (!contextPackage) {
        throw new ChapterContextAssemblyError(
          novelId,
          chapterId,
          "review",
          new Error("chapter context package unavailable"),
        );
      }
      return auditService.auditChapter(novelId, chapterId, "full", {
        provider: options.provider,
        model: options.model,
        temperature: options.temperature,
        content,
        contextPackage,
      });
    }

    return this.reviewChapterContent(novelTitle, chapterTitle, content, options, novelId);
  }

  private async assembleAuditContextPackage(
    novelId: string,
    chapterId: string,
    options: ReviewOptions,
    operation: AuditContextOperation,
  ): Promise<GenerationContextPackage> {
    try {
      const assembled = await this.generationContextAssembler.assemble(novelId, chapterId, {
        provider: options.provider,
        model: options.model,
        temperature: options.temperature,
      });
      return assembled.contextPackage;
    } catch (error) {
      logPipelineError("Failed to assemble chapter context package.", {
        novelId,
        chapterId,
        operation,
        provider: options.provider ?? null,
        model: options.model ?? null,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new ChapterContextAssemblyError(novelId, chapterId, operation, error);
    }
  }
}
