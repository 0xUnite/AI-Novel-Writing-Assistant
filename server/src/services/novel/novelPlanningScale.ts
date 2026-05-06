import type { NovelContentForm } from "@ai-novel/shared/types/novel";

export const SHORT_STORY_TARGET_WORD_MIN = 20_000;
export const SHORT_STORY_TARGET_WORD_MAX = 80_000;
export const SHORT_STORY_TARGET_WORD_DEFAULT = 20_000;
export const SHORT_STORY_DEFAULT_CHAPTER_LENGTH = 2_500;
export const SHORT_STORY_MAX_CHAPTER_COUNT = 32;
export const SHORT_STORY_DEFAULT_CHAPTER_COUNT = 8;

function normalizePositiveInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(1, Math.round(value));
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) {
      return Math.max(1, parsed);
    }
  }
  return null;
}

function normalizeNullableNonNegativeInteger(value: unknown): number | null {
  if (value == null) {
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.round(value));
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) {
      return Math.max(0, parsed);
    }
  }
  return null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

export function deriveShortStoryChapterCount(params: {
  targetTotalWordCount?: number | null;
  defaultChapterLength?: number | null;
  fallbackChapterCount?: number | null;
}): number {
  const defaultChapterLength = normalizePositiveInteger(params.defaultChapterLength)
    ?? SHORT_STORY_DEFAULT_CHAPTER_LENGTH;
  const fallbackTotal = normalizePositiveInteger(params.fallbackChapterCount)
    ? normalizePositiveInteger(params.fallbackChapterCount)! * defaultChapterLength
    : SHORT_STORY_TARGET_WORD_DEFAULT;
  const targetTotal = clamp(
    normalizePositiveInteger(params.targetTotalWordCount) ?? fallbackTotal,
    SHORT_STORY_TARGET_WORD_MIN,
    SHORT_STORY_TARGET_WORD_MAX,
  );
  return clamp(
    Math.max(1, Math.round(targetTotal / defaultChapterLength)),
    1,
    SHORT_STORY_MAX_CHAPTER_COUNT,
  );
}

export function normalizeNovelPlanningScale(input: {
  contentForm?: NovelContentForm | null;
  defaultChapterLength?: number | null;
  estimatedChapterCount?: number | null;
  targetTotalWordCount?: number | null;
}, fallback?: {
  contentForm?: string | null;
  defaultChapterLength?: number | null;
  estimatedChapterCount?: number | null;
  targetTotalWordCount?: number | null;
}): {
  contentForm: NovelContentForm;
  defaultChapterLength: number | null;
  estimatedChapterCount: number | null;
  targetTotalWordCount: number | null;
} {
  const contentForm = (input.contentForm ?? fallback?.contentForm) === "short_story" ? "short_story" : "novel";
  const defaultChapterLength = normalizePositiveInteger(input.defaultChapterLength ?? fallback?.defaultChapterLength);
  const estimatedChapterCount = normalizeNullableNonNegativeInteger(
    input.estimatedChapterCount ?? fallback?.estimatedChapterCount,
  );
  const targetTotalWordCount = normalizeNullableNonNegativeInteger(
    input.targetTotalWordCount ?? fallback?.targetTotalWordCount,
  );

  if (contentForm !== "short_story") {
    return {
      contentForm,
      defaultChapterLength,
      estimatedChapterCount,
      targetTotalWordCount,
    };
  }

  const resolvedChapterLength = defaultChapterLength ?? SHORT_STORY_DEFAULT_CHAPTER_LENGTH;
  const resolvedTotalWordCount = clamp(
    targetTotalWordCount
      ?? (estimatedChapterCount && estimatedChapterCount > 0
        ? estimatedChapterCount * resolvedChapterLength
        : SHORT_STORY_TARGET_WORD_DEFAULT),
    SHORT_STORY_TARGET_WORD_MIN,
    SHORT_STORY_TARGET_WORD_MAX,
  );
  const resolvedChapterCount = deriveShortStoryChapterCount({
    targetTotalWordCount: resolvedTotalWordCount,
    defaultChapterLength: resolvedChapterLength,
    fallbackChapterCount: estimatedChapterCount && estimatedChapterCount > 0
      ? estimatedChapterCount
      : SHORT_STORY_DEFAULT_CHAPTER_COUNT,
  });

  return {
    contentForm,
    defaultChapterLength: resolvedChapterLength,
    estimatedChapterCount: resolvedChapterCount,
    targetTotalWordCount: resolvedTotalWordCount,
  };
}
