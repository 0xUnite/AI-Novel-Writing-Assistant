import type { ChapterRuntimePackage, GenerationContextPackage } from "@ai-novel/shared/types/chapterRuntime";
import type { LLMProvider } from "@ai-novel/shared/types/llm";
import type { QualityScore, ReviewIssue } from "@ai-novel/shared/types/novel";
import { runTextPrompt } from "../../../prompting/core/promptRunner";
import {
  buildChapterRepairContextBlocks,
  resolveTargetWordRange,
} from "../../../prompting/prompts/novel/chapterLayeredContext";
import { chapterRepairPrompt } from "../../../prompting/prompts/novel/review.prompts";
import type { ChapterRuntimeRequestInput } from "./chapterRuntimeSchema";
import { sanitizeGeneratedChapterContent } from "../chapterContentSanitizer";

const PIPELINE_REPAIR_TIMEOUT_MS = 300_000;

function withRepairTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: () => T): Promise<T> {
  let timeout: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<T>((resolve) => {
    timeout = setTimeout(() => resolve(fallback()), timeoutMs);
    timeout.unref?.();
  });
  promise.catch(() => null);
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) {
      clearTimeout(timeout);
    }
  });
}

export interface PipelineRuntimeHooks {
  onCheckCancelled?: () => Promise<void>;
  onStageChange?: (stage: "generating_chapters" | "reviewing" | "repairing") => Promise<void>;
}

export interface PipelineRuntimeInput extends ChapterRuntimeRequestInput {
  maxRetries?: number;
  autoRepair?: boolean;
  qualityThreshold?: number;
  repairMode?: "detect_only" | "light_repair" | "heavy_repair" | "continuity_only" | "character_only" | "ending_only";
}

export interface PipelineRuntimeResult {
  pass: boolean;
  score: QualityScore;
  issues: ReviewIssue[];
  runtimePackage: ChapterRuntimePackage;
  retryCountUsed: number;
}

export interface FinalizedRuntimeResult {
  finalContent: string;
  runtimePackage: ChapterRuntimePackage;
}

export interface AssembledRuntimeChapter {
  novel: { id: string; title: string };
  chapter: {
    id: string;
    title: string;
    order: number;
    content: string | null;
    expectation: string | null;
    targetWordCount?: number | null;
    taskSheet?: string | null;
  };
  contextPackage: GenerationContextPackage;
}

interface RepairDraftContentInput {
  novelTitle: string;
  chapterTitle: string;
  content: string;
  issues: ReviewIssue[];
  runtimePackage: ChapterRuntimePackage;
  options: {
    provider?: LLMProvider;
    model?: string;
    temperature?: number;
    repairMode?: "detect_only" | "light_repair" | "heavy_repair" | "continuity_only" | "character_only" | "ending_only";
  };
}

interface RunPipelineChapterDeps {
  validateRequest: (input: ChapterRuntimeRequestInput) => ChapterRuntimeRequestInput;
  ensureNovelCharacters: (novelId: string, actionName: string, minCount?: number) => Promise<void>;
  assemble: (novelId: string, chapterId: string, request: ChapterRuntimeRequestInput) => Promise<AssembledRuntimeChapter>;
  generateDraftFromWriter: (input: {
    novelId: string;
    chapterId: string;
    request: ChapterRuntimeRequestInput;
    assembled: AssembledRuntimeChapter;
  }) => Promise<string>;
  saveDraftAndArtifacts: (
    novelId: string,
    chapterId: string,
    content: string,
    generationState: "drafted" | "repaired",
  ) => Promise<void>;
  finalizeChapterContent: (input: {
    novelId: string;
    chapterId: string;
    request: ChapterRuntimeRequestInput;
    contextPackage: GenerationContextPackage;
    content: string;
    runId: string | null;
    startMs: number | null;
    includeOpenConflicts?: boolean;
  }) => Promise<FinalizedRuntimeResult>;
  markChapterGenerationState: (
    chapterId: string,
    generationState: "reviewed" | "approved",
  ) => Promise<void>;
  markChapterStatus?: (
    chapterId: string,
    chapterStatus: "generating" | "needs_repair",
  ) => Promise<void>;
  repairDraftContent?: (input: RepairDraftContentInput) => Promise<string>;
}

const QUALITY_THRESHOLD = { coherence: 80, repetition: 20, engagement: 75 };

const AUDIT_CATEGORY_MAP: Record<"continuity" | "character" | "plot" | "mode_fit", ReviewIssue["category"]> = {
  continuity: "coherence",
  character: "logic",
  plot: "pacing",
  mode_fit: "coherence",
};

export async function runPipelineChapterWithRuntime(
  deps: RunPipelineChapterDeps,
  novelId: string,
  chapterId: string,
  options: PipelineRuntimeInput = {},
  hooks: PipelineRuntimeHooks = {},
): Promise<PipelineRuntimeResult> {
  const {
    maxRetries = 2,
    autoRepair = true,
    qualityThreshold = 75,
    repairMode = "light_repair",
    ...requestInput
  } = options;
  const request = deps.validateRequest(requestInput);
  await deps.ensureNovelCharacters(novelId, "run chapter pipeline");

  const assembled = await deps.assemble(novelId, chapterId, request);
  let content = assembled.chapter.content?.trim() ? assembled.chapter.content : "";
  let retryCountUsed = 0;
  let latestResult: FinalizedRuntimeResult | null = null;
  let latestIssues: ReviewIssue[] = [];
  let pass = false;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    await hooks.onCheckCancelled?.();
    if (!content.trim()) {
      await hooks.onStageChange?.("generating_chapters");
      await deps.markChapterStatus?.(chapterId, "generating");
      try {
        content = await deps.generateDraftFromWriter({
          novelId,
          chapterId,
          request,
          assembled,
        });
      } catch (error) {
        if (error instanceof Error && error.message === "PIPELINE_CANCELLED") {
          throw error;
        }
        retryCountUsed += 1;
        content = "";
        if (attempt >= maxRetries) {
          throw error;
        }
        continue;
      }
    } else if (attempt === 0) {
      await deps.saveDraftAndArtifacts(novelId, chapterId, content, "drafted");
    }

    await hooks.onStageChange?.("reviewing");
    latestResult = await deps.finalizeChapterContent({
      novelId,
      chapterId,
      request,
      contextPackage: assembled.contextPackage,
      content,
      runId: null,
      startMs: null,
      includeOpenConflicts: false,
    });
    content = latestResult.finalContent;
    const lengthIssue = buildLengthIssue(content, assembled.chapter.targetWordCount);
    latestIssues = [
      ...(lengthIssue ? [lengthIssue] : []),
      ...toReviewIssues(latestResult.runtimePackage),
    ];
    await deps.markChapterGenerationState(chapterId, "reviewed");

    pass = isQualityPass(latestResult.runtimePackage.audit.score, qualityThreshold)
      && !lengthIssue
      && !latestResult.runtimePackage.audit.hasBlockingIssues;
    if (pass) {
      await deps.markChapterGenerationState(chapterId, "approved");
      break;
    }

    if (!autoRepair || repairMode === "detect_only" || attempt >= maxRetries) {
      break;
    }

    await hooks.onStageChange?.("repairing");
    try {
      const repairContent = deps.repairDraftContent ?? repairDraftContent;
      content = await repairContent({
        novelTitle: assembled.novel.title,
        chapterTitle: assembled.chapter.title,
        content,
        issues: latestIssues,
        runtimePackage: latestResult.runtimePackage,
        options: {
          provider: request.provider,
          model: request.model,
          temperature: request.temperature,
          repairMode,
        },
      });
    } catch (error) {
      if (error instanceof Error && error.message === "PIPELINE_CANCELLED") {
        throw error;
      }
      retryCountUsed += 1;
      if (attempt >= maxRetries) {
        throw error;
      }
      continue;
    }
    retryCountUsed += 1;
    await deps.saveDraftAndArtifacts(novelId, chapterId, content, "repaired");
  }

  if (!latestResult) {
    throw new Error("Pipeline chapter runtime did not produce a result.");
  }
  if (!pass) {
    await deps.markChapterStatus?.(chapterId, "needs_repair");
  }

  return {
    pass,
    score: latestResult.runtimePackage.audit.score,
    issues: latestIssues,
    runtimePackage: latestResult.runtimePackage,
    retryCountUsed,
  };
}

function isQualityPass(score: QualityScore, qualityThreshold: number): boolean {
  return score.coherence >= QUALITY_THRESHOLD.coherence
    && score.repetition <= QUALITY_THRESHOLD.repetition
    && score.engagement >= QUALITY_THRESHOLD.engagement
    && score.overall >= qualityThreshold;
}

function countChapterCharacters(content: string): number {
  return content.replace(/\s+/g, "").trim().length;
}

function buildLengthIssue(content: string, targetWordCount: number | null | undefined): ReviewIssue | null {
  const range = resolveTargetWordRange(targetWordCount ?? 5000);
  if (range.minWordCount == null) {
    return null;
  }
  const actualLength = countChapterCharacters(content);
  if (range.hardWordCountLimit != null && actualLength > range.hardWordCountLimit) {
    return {
      severity: "high",
      category: "pacing",
      evidence: `章节正文长度 ${actualLength} 字，超过任务目标上限 ${range.hardWordCountLimit} 字。`,
      fixSuggestion: `压缩正文到 ${range.hardWordCountLimit} 字以内，保留本章核心事件、关键冲突、人物状态变化和章末钩子，优先删减重复回顾、低信息描写、空泛心理和可合并动作。`,
    };
  }
  if (actualLength >= range.minWordCount) {
    return null;
  }
  return {
    severity: "high",
    category: "pacing",
    evidence: `章节正文长度 ${actualLength} 字，低于任务目标下限 ${range.minWordCount} 字。`,
    fixSuggestion: `扩写正文到至少 ${range.minWordCount} 字，保留当前场景、人物动作和章末钩子，用具体行动、环境反应、心理推演和系统压迫补足，不要改写成摘要或提纲。`,
  };
}

function toReviewIssues(runtimePackage: ChapterRuntimePackage): ReviewIssue[] {
  const issues = runtimePackage.audit.openIssues.map((issue) => ({
    severity: issue.severity,
    category: AUDIT_CATEGORY_MAP[issue.auditType],
    evidence: issue.evidence,
    fixSuggestion: issue.fixSuggestion,
  }));
  return issues.length > 0
    ? issues
    : runtimePackage.audit.reports.flatMap((report) => report.issues.map((issue) => ({
      severity: issue.severity,
      category: AUDIT_CATEGORY_MAP[report.auditType],
      evidence: issue.evidence,
      fixSuggestion: issue.fixSuggestion,
    })));
}

async function repairDraftContent(input: RepairDraftContentInput): Promise<string> {
  const issues = input.issues.length > 0
    ? input.issues
    : [{
        severity: "medium" as const,
        category: "coherence" as const,
        evidence: "Pipeline quality threshold not met.",
        fixSuggestion: "Tighten continuity, sharpen conflict progression, and improve readability.",
      }];
  const modeHint = getRepairModeHint(input.options.repairMode, issues);
  const minRequiredLength = resolveRepairMinimumLength(input.runtimePackage);
  const repairContextBlocks = input.runtimePackage.context.chapterRepairContext
    ? buildChapterRepairContextBlocks(input.runtimePackage.context.chapterRepairContext)
    : undefined;
  const repairedOutput = await withRepairTimeout(
    runTextPrompt({
      asset: chapterRepairPrompt,
      promptInput: {
        novelTitle: input.novelTitle,
        bibleContent: buildRepairBibleFallback(input.runtimePackage),
        chapterTitle: input.chapterTitle,
        chapterContent: input.content,
        issuesJson: JSON.stringify(issues, null, 2),
        ragContext: "",
        modeHint,
      },
      contextBlocks: repairContextBlocks,
      options: {
        provider: input.options.provider,
        model: input.options.model,
        temperature: Math.min(input.options.temperature ?? 0.55, 0.65),
        maxTokens: Math.max(8000, Math.min(16000, Math.ceil(input.content.length * 2.2))),
      },
    }).then((repaired) => repaired.output),
    PIPELINE_REPAIR_TIMEOUT_MS,
    () => input.content,
  );
  const nextContent = sanitizeGeneratedChapterContent(repairedOutput.trim());
  const currentLength = input.content.trim().length;
  const nextLength = nextContent.trim().length;
  if (
    minRequiredLength > 0
    && currentLength >= minRequiredLength
    && nextLength > 0
    && nextLength < minRequiredLength
  ) {
    return input.content;
  }
  return nextContent || input.content;
}

function resolveRepairMinimumLength(runtimePackage: ChapterRuntimePackage): number {
  const targetWordCount = runtimePackage.context.chapterRepairContext?.writeContext.chapterMission.targetWordCount
    ?? runtimePackage.context.chapterMission?.targetWordCount
    ?? 5000;
  return resolveTargetWordRange(targetWordCount).minWordCount ?? 0;
}

function buildRepairBibleFallback(runtimePackage: ChapterRuntimePackage): string {
  const context = runtimePackage.context;
  const fragments = [
    context.bookContract?.sellingPoint ? `核心卖点：${context.bookContract.sellingPoint}` : "",
    context.bookContract?.first30ChapterPromise ? `前30章承诺：${context.bookContract.first30ChapterPromise}` : "",
    context.macroConstraints?.coreConflict ? `核心冲突：${context.macroConstraints.coreConflict}` : "",
    context.macroConstraints?.progressionLoop ? `推进回路：${context.macroConstraints.progressionLoop}` : "",
    context.volumeWindow?.missionSummary ? `当前卷使命：${context.volumeWindow.missionSummary}` : "",
  ].filter(Boolean);
  return fragments.join("\n") || "none";
}

function getRepairModeHint(
  repairMode: "detect_only" | "light_repair" | "heavy_repair" | "continuity_only" | "character_only" | "ending_only" | undefined,
  issueContext: Array<{ evidence?: string | null; fixSuggestion?: string | null }> = [],
): string {
  let baseHint = "";
  switch (repairMode) {
    case "continuity_only":
      baseHint = "优先修连续性、时间线和事件承接，不做大幅风格重写。";
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
    default:
      baseHint = "以轻修为主，优先保持原有内容框架和事件顺序。";
      break;
  }

  const issueText = issueContext
    .map((item) => `${item.evidence ?? ""}\n${item.fixSuggestion ?? ""}`)
    .join("\n");
  if (/(归属|谁手里|何时转手|递给|接过|持有)/.test(issueText)) {
    return `${baseHint} 若涉及物品或道具归属，必须把谁拿着物品、何时递交、谁接过、转手后谁继续持有写成明确动作，不要用模糊代词带过。`;
  }

  return baseHint;
}
