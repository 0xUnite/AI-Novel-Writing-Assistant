import type { BaseMessageChunk } from "@langchain/core/messages";
import type { GenerationContextPackage } from "@ai-novel/shared/types/chapterRuntime";
import type { LLMProvider } from "@ai-novel/shared/types/llm";
import type { TaskType } from "../../llm/modelRouter";
import { createContextBlock } from "../../prompting/core/contextBudget";
import { runTextPrompt, streamTextPrompt } from "../../prompting/core/promptRunner";
import {
  buildChapterWriterContextBlocks,
  resolveTargetWordRange,
  sanitizeWriterContextBlocks,
} from "../../prompting/prompts/novel/chapterLayeredContext";
import { chapterWriterPrompt } from "../../prompting/prompts/novel/chapterWriter.prompts";
import { chapterRepairPrompt } from "../../prompting/prompts/novel/review.prompts";
import { NovelContinuationService } from "./NovelContinuationService";
import { hasGeneratedReasoningLeak, sanitizeGeneratedChapterContent } from "./chapterContentSanitizer";

export interface ChapterGraphLLMOptions {
  provider?: LLMProvider;
  model?: string;
  temperature?: number;
  taskType?: TaskType;
}

export interface ChapterGraphGenerateOptions extends ChapterGraphLLMOptions {
  previousChaptersSummary?: string[];
}

interface ChapterRef {
  id: string;
  title: string;
  order: number;
  content?: string | null;
  expectation?: string | null;
  targetWordCount?: number | null;
  taskSheet?: string | null;
}

type ContinuationPack = Awaited<ReturnType<NovelContinuationService["buildChapterContextPack"]>>;

interface ChapterGraphDeps {
  enforceOpeningDiversity: (
    novelId: string,
    chapterOrder: number,
    chapterTitle: string,
    content: string,
    options: ChapterGraphLLMOptions,
  ) => Promise<{ content: string; rewritten: boolean; maxSimilarity: number }>;
  saveDraftAndArtifacts: (
    novelId: string,
    chapterId: string,
    content: string,
    generationState: "drafted" | "repaired",
  ) => Promise<void>;
  logInfo: (message: string, meta?: Record<string, unknown>) => void;
  logWarn: (message: string, meta?: Record<string, unknown>) => void;
}

export interface ChapterStreamInput {
  novelId: string;
  novelTitle: string;
  chapter: ChapterRef;
  contextPackage?: GenerationContextPackage;
  options: ChapterGraphGenerateOptions;
}

const continuationService = new NovelContinuationService();
const DEFAULT_WRITER_MAX_TOKENS = 9000;
const MIN_WRITER_MAX_TOKENS = 3600;
const WRITER_POSTPROCESS_TIMEOUT_MS = 4 * 60 * 1000;

function withPostprocessTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: () => T): Promise<T> {
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

function countChapterCharacters(content: string): number {
  return content.replace(/\s+/g, "").trim().length;
}

function resolveWriterMaxTokens(maxWordCount?: number | null): number {
  if (maxWordCount == null) {
    return DEFAULT_WRITER_MAX_TOKENS;
  }
  return Math.max(MIN_WRITER_MAX_TOKENS, Math.min(10000, Math.ceil(maxWordCount * 1.1)));
}

function buildLengthInstruction(targetWordCount?: number | null): {
  targetWordCount: number | null;
  minWordCount: number | null;
  maxWordCount: number | null;
  softWordCountLimit: number | null;
  hardWordCountLimit: number | null;
  instruction: string;
} {
  const range = resolveTargetWordRange(targetWordCount);
  if (range.targetWordCount == null) {
    return {
      ...range,
      instruction: "Write a complete readable chapter with enough concrete events and scene substance; do not end abruptly or obviously too short.",
    };
  }
  return {
    ...range,
    instruction: `Write about ${range.targetWordCount} Chinese characters. Target range: ${range.minWordCount}-${range.maxWordCount}. Start wrapping near ${range.softWordCountLimit}, never exceed ${range.hardWordCountLimit}, and do not end clearly below the minimum.`,
  };
}

function buildDraftContinuationBlock(content: string, targetWordCount: number, minWordCount: number): string {
  const trimmed = content.trim();
  const excerpt = trimmed.length > 1400 ? trimmed.slice(-1400) : trimmed;
  return [
    `Current saved draft length: ${countChapterCharacters(trimmed)} Chinese characters.`,
    `Target length: about ${targetWordCount} Chinese characters. Minimum acceptable length: ${minWordCount}.`,
    "Continue from the existing ending. Do not restart the chapter. Do not repeat already written events.",
    "Current draft tail (continue after this):",
    excerpt || "none",
  ].join("\n");
}

export class ChapterWritingGraph {
  constructor(private readonly deps: ChapterGraphDeps) {}

  private async continuityNode(
    novelId: string,
    chapter: ChapterRef,
    content: string,
    options: ChapterGraphLLMOptions,
    continuationPack: ContinuationPack,
  ): Promise<string> {
    const openingGuard = await this.deps.enforceOpeningDiversity(
      novelId,
      chapter.order,
      chapter.title,
      content,
      options,
    );
    if (openingGuard.rewritten) {
      this.deps.logInfo("Opening diversity rewrite applied", {
        chapterOrder: chapter.order,
        maxSimilarity: Number(openingGuard.maxSimilarity.toFixed(4)),
      });
    }

    const continuationGuard = await continuationService.rewriteIfTooSimilar({
      chapterTitle: chapter.title,
      content: openingGuard.content,
      continuationPack,
      provider: options.provider,
      model: options.model,
      temperature: options.temperature,
    });
    if (continuationGuard.rewritten) {
      this.deps.logInfo("Continuation anti-copy rewrite applied", {
        chapterOrder: chapter.order,
        maxSimilarity: Number(continuationGuard.maxSimilarity.toFixed(4)),
      });
    }
    return continuationGuard.content;
  }

  private async enforceTargetLength(input: {
    novelId: string;
    novelTitle: string;
    chapter: ChapterRef;
    content: string;
    contextPackage: GenerationContextPackage;
    options: ChapterGraphLLMOptions;
  }): Promise<string> {
    const writeContext = input.contextPackage.chapterWriteContext;
    const lengthGoal = buildLengthInstruction(
      writeContext?.chapterMission.targetWordCount
      ?? input.contextPackage.chapter.targetWordCount
      ?? input.chapter.targetWordCount
      ?? null,
    );
    if (!writeContext || lengthGoal.targetWordCount == null || lengthGoal.minWordCount == null) {
      return input.content;
    }

    const currentLength = countChapterCharacters(input.content);
    if (currentLength >= lengthGoal.minWordCount) {
      return input.content;
    }

    const missingWordGap = Math.max(
      lengthGoal.targetWordCount - currentLength,
      lengthGoal.minWordCount - currentLength,
    );
    const builtBlocks = buildChapterWriterContextBlocks(writeContext);
    const sanitized = sanitizeWriterContextBlocks([
      createContextBlock({
        id: "current_draft_excerpt",
        group: "current_draft_excerpt",
        priority: 99,
        required: true,
        content: buildDraftContinuationBlock(
          input.content,
          lengthGoal.targetWordCount,
          lengthGoal.minWordCount,
        ),
      }),
      ...builtBlocks,
    ]);
    if (sanitized.removedBlockIds.length > 0) {
      this.deps.logWarn("Writer continuation blocks removed by guard", {
        chapterOrder: input.chapter.order,
        removedBlockIds: sanitized.removedBlockIds,
      });
    }

    const completion = await runTextPrompt({
      asset: chapterWriterPrompt,
      promptInput: {
        novelTitle: input.novelTitle,
        chapterOrder: input.chapter.order,
        chapterTitle: input.chapter.title,
        mode: "continue",
        targetWordCount: lengthGoal.targetWordCount,
        minWordCount: lengthGoal.minWordCount,
        maxWordCount: lengthGoal.maxWordCount,
        missingWordGap,
      },
      contextBlocks: sanitized.allowedBlocks,
      options: {
        provider: input.options.provider,
        model: input.options.model,
        temperature: input.options.temperature ?? 0.8,
        maxTokens: resolveWriterMaxTokens(lengthGoal.maxWordCount),
      },
    });
    const appended = sanitizeGeneratedChapterContent(completion.output.trim());
    if (!appended) {
      return input.content;
    }

    const merged = `${input.content.trim()}\n\n${appended}`.trim();
    this.deps.logInfo("Chapter draft auto-extended for target length", {
      chapterOrder: input.chapter.order,
      beforeLength: currentLength,
      afterLength: countChapterCharacters(merged),
      targetWordCount: lengthGoal.targetWordCount,
      minWordCount: lengthGoal.minWordCount,
    });
    return merged;
  }

  private async compressDraftToUpperBound(input: {
    novelTitle: string;
    chapter: ChapterRef;
    content: string;
    contextPackage: GenerationContextPackage;
    options: ChapterGraphLLMOptions;
    targetWordCount: number | null;
    minWordCount: number | null;
    maxWordCount: number | null;
  }): Promise<string> {
    if (input.maxWordCount == null) {
      return input.content;
    }

    const currentLength = countChapterCharacters(input.content);
    if (currentLength <= input.maxWordCount) {
      return input.content;
    }

    const writeContext = input.contextPackage.chapterWriteContext;
    if (!writeContext) {
      this.deps.logWarn("Chapter draft exceeded hard word limit without write context; saving draft for repair", {
        chapterOrder: input.chapter.order,
        currentLength,
        maxWordCount: input.maxWordCount,
      });
      return input.content;
    }

    const targetAfterCompression = input.targetWordCount ?? input.maxWordCount;
    const minAfterCompression = Math.min(
      input.maxWordCount,
      Math.max(input.minWordCount ?? 0, Math.floor(targetAfterCompression * 0.82)),
    );
    const sanitized = sanitizeWriterContextBlocks(buildChapterWriterContextBlocks(writeContext));
    let workingContent = input.content;
    let workingLength = currentLength;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const repaired = await runTextPrompt({
        asset: chapterRepairPrompt,
        promptInput: {
          novelTitle: input.novelTitle,
          bibleContent: [
            `本章目标字数：约 ${targetAfterCompression} 字。`,
            `压缩后可接受下限：${minAfterCompression} 字。`,
            `压缩后绝对上限：${input.maxWordCount} 字。`,
          ].join("\n"),
          chapterTitle: `第${input.chapter.order}章 ${input.chapter.title}`,
          chapterContent: workingContent,
          issuesJson: JSON.stringify([
            {
              severity: "high",
              category: "pacing",
              evidence: `当前生成正文 ${workingLength} 字，超过目标上限 ${input.maxWordCount} 字。`,
              fixSuggestion: `在不改变本章核心事件、人物状态和章末钩子的前提下，压缩重复回顾、空泛心理、冗余动作和低信息描写，把完整正文压缩到 ${input.maxWordCount} 字以内，且尽量不低于 ${minAfterCompression} 字。`,
            },
          ], null, 2),
          ragContext: "",
          modeHint: [
            "只做压缩去冗余，不要重写成新剧情。",
            `必须输出完整章节正文，目标 ${targetAfterCompression} 字左右。`,
            `压缩后不得超过 ${input.maxWordCount} 字；不要低于 ${minAfterCompression} 字。`,
            "优先删减重复说明、低信息环境描写、重复心理判断和可合并的动作段。",
          ].join(" "),
        },
        contextBlocks: sanitized.allowedBlocks,
        options: {
          provider: input.options.provider,
          model: input.options.model,
          temperature: Math.min(input.options.temperature ?? 0.55, 0.65),
          maxTokens: resolveWriterMaxTokens(input.maxWordCount),
        },
      });
      const compressed = sanitizeGeneratedChapterContent(repaired.output.trim());
      const compressedLength = countChapterCharacters(compressed);
      if (compressed && compressedLength <= input.maxWordCount && compressedLength >= minAfterCompression) {
        this.deps.logInfo("Chapter draft auto-compressed for hard word limit", {
          chapterOrder: input.chapter.order,
          beforeLength: currentLength,
          afterLength: compressedLength,
          maxWordCount: input.maxWordCount,
          attempt,
        });
        return compressed;
      }
      if (compressed && compressedLength > 0 && compressedLength < workingLength) {
        workingContent = compressed;
        workingLength = compressedLength;
      }
    }

    if (workingLength < currentLength) {
      this.deps.logWarn("Chapter draft compressed but still exceeds hard word limit; saving shorter draft for review", {
        chapterOrder: input.chapter.order,
        beforeLength: currentLength,
        afterLength: workingLength,
        maxWordCount: input.maxWordCount,
      });
      return workingContent;
    }

    this.deps.logWarn("Chapter draft exceeded hard word limit; saving original draft instead of discarding generated content", {
      chapterOrder: input.chapter.order,
      currentLength,
      maxWordCount: input.maxWordCount,
    });
    return input.content;
  }

  async createChapterStream(input: ChapterStreamInput): Promise<{
    stream: AsyncIterable<BaseMessageChunk>;
    onDone: (fullContent: string) => Promise<{ finalContent: string } | void>;
  }> {
    const continuationPack = (input.contextPackage?.continuation as ContinuationPack | undefined)
      ?? await continuationService.buildChapterContextPack(input.novelId);
    const chapterWriteContext = input.contextPackage?.chapterWriteContext;
    if (!input.contextPackage || !chapterWriteContext) {
      throw new Error("Chapter runtime context is required before chapter generation.");
    }
    const contextPackage = input.contextPackage;

    const targetRange = resolveTargetWordRange(chapterWriteContext.chapterMission.targetWordCount);
    const builtBlocks = buildChapterWriterContextBlocks(chapterWriteContext);
    const sanitized = sanitizeWriterContextBlocks(builtBlocks);
    if (sanitized.removedBlockIds.length > 0) {
      this.deps.logWarn("Writer context blocks removed by guard", {
        chapterOrder: input.chapter.order,
        removedBlockIds: sanitized.removedBlockIds,
      });
    }

    const streamed = await streamTextPrompt({
      asset: chapterWriterPrompt,
      promptInput: {
        novelTitle: input.novelTitle,
        chapterOrder: input.chapter.order,
        chapterTitle: input.chapter.title,
        mode: "draft",
        targetWordCount: chapterWriteContext.chapterMission.targetWordCount ?? null,
        minWordCount: targetRange.minWordCount,
        maxWordCount: targetRange.maxWordCount,
        softWordCountLimit: targetRange.softWordCountLimit,
        hardWordCountLimit: targetRange.hardWordCountLimit,
      },
      contextBlocks: sanitized.allowedBlocks,
      options: {
        provider: input.options.provider,
        model: input.options.model,
        temperature: input.options.temperature ?? 0.8,
        maxTokens: resolveWriterMaxTokens(targetRange.maxWordCount),
      },
    });

    return {
      stream: streamed.stream as AsyncIterable<BaseMessageChunk>,
      onDone: async (fullContent: string) => {
        const completed = await streamed.complete.catch(() => null);
        const rawContent = completed?.output ?? fullContent;
        const sanitizedRawContent = sanitizeGeneratedChapterContent(rawContent);
        if (hasGeneratedReasoningLeak(rawContent)) {
          this.deps.logWarn("Writer reasoning block removed from chapter draft", {
            chapterOrder: input.chapter.order,
          });
        }
        const normalized = await withPostprocessTimeout(
          this.continuityNode(
            input.novelId,
            input.chapter,
            sanitizedRawContent,
            input.options,
            continuationPack,
          ),
          WRITER_POSTPROCESS_TIMEOUT_MS,
          () => {
            this.deps.logWarn("Writer postprocess timeout: continuityNode fallback applied", {
              chapterOrder: input.chapter.order,
              timeoutMs: WRITER_POSTPROCESS_TIMEOUT_MS,
            });
            return sanitizedRawContent;
          },
        );
        const lengthAdjusted = await withPostprocessTimeout(
          this.enforceTargetLength({
            novelId: input.novelId,
            novelTitle: input.novelTitle,
            chapter: input.chapter,
            content: normalized,
            contextPackage,
            options: input.options,
          }),
          WRITER_POSTPROCESS_TIMEOUT_MS,
          () => {
            this.deps.logWarn("Writer postprocess timeout: enforceTargetLength fallback applied", {
              chapterOrder: input.chapter.order,
              timeoutMs: WRITER_POSTPROCESS_TIMEOUT_MS,
            });
            return normalized;
          },
        );
        const bounded = await withPostprocessTimeout(
          this.compressDraftToUpperBound({
            novelTitle: input.novelTitle,
            chapter: input.chapter,
            content: lengthAdjusted,
            contextPackage,
            options: input.options,
            targetWordCount: targetRange.targetWordCount,
            minWordCount: targetRange.minWordCount,
            maxWordCount: targetRange.hardWordCountLimit,
          }),
          WRITER_POSTPROCESS_TIMEOUT_MS,
          () => {
            this.deps.logWarn("Writer postprocess timeout: compressDraftToUpperBound fallback applied", {
              chapterOrder: input.chapter.order,
              timeoutMs: WRITER_POSTPROCESS_TIMEOUT_MS,
            });
            return lengthAdjusted;
          },
        );
        await this.deps.saveDraftAndArtifacts(
          input.novelId,
          input.chapter.id,
          bounded,
          "drafted",
        );
        return { finalContent: bounded };
      },
    };
  }
}
