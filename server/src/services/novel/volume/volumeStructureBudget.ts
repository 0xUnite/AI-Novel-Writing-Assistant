import type { VolumeBeatSheet, VolumePlan } from "@ai-novel/shared/types/novel";

export const DEFAULT_VOLUME_CHAPTER_TARGET = 12;
export const MAX_VOLUME_CHAPTER_TARGET = 500;
export const MAX_VOLUME_COUNT = 12;

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

export function clampStructureChapterCount(value: unknown, fallback = DEFAULT_VOLUME_CHAPTER_TARGET): number {
  const normalized = normalizePositiveInteger(value) ?? normalizePositiveInteger(fallback) ?? DEFAULT_VOLUME_CHAPTER_TARGET;
  return Math.max(1, Math.min(MAX_VOLUME_CHAPTER_TARGET, normalized));
}

export function deriveChapterBudget(params: {
  optionEstimatedChapterCount?: number | null;
  novelEstimatedChapterCount?: number | null;
  existingChapterCount?: number | null;
  fallbackChapterCount?: number;
}): number {
  return clampStructureChapterCount(
    params.optionEstimatedChapterCount
      ?? params.novelEstimatedChapterCount
      ?? (params.existingChapterCount && params.existingChapterCount > 0 ? params.existingChapterCount : undefined)
      ?? params.fallbackChapterCount
      ?? DEFAULT_VOLUME_CHAPTER_TARGET,
  );
}

function parseTargetVolumeCountFromGuidance(guidance?: string | null): number | null {
  const normalized = guidance?.trim();
  if (!normalized) {
    return null;
  }
  const directMatch = normalized.match(/(?:分成|拆成|切成|规划为|共|总共|一共)\s*(\d{1,2})\s*卷/u);
  if (directMatch) {
    return normalizePositiveInteger(directMatch[1]);
  }
  const perVolumeMatch = normalized.match(/(?:每卷|单卷)\s*(?:约|大约|左右)?\s*(\d{1,3})\s*章/u);
  const perVolumeChapterCount = normalizePositiveInteger(perVolumeMatch?.[1]);
  return perVolumeChapterCount ? -perVolumeChapterCount : null;
}

export function suggestVolumeCount(chapterBudget: number): number {
  const safeBudget = clampStructureChapterCount(chapterBudget);
  if (safeBudget <= 24) {
    return 1;
  }
  if (safeBudget <= 60) {
    return 2;
  }
  if (safeBudget <= 120) {
    return 3;
  }
  if (safeBudget <= 240) {
    return 5;
  }
  return 8;
}

export function resolveTargetVolumeCount(params: {
  chapterBudget: number;
  existingVolumeCount?: number | null;
  respectExistingVolumeCount?: boolean;
  targetVolumeCount?: number | null;
  guidance?: string | null;
}): number {
  const chapterBudget = clampStructureChapterCount(params.chapterBudget);
  const guidanceVolumeSignal = parseTargetVolumeCountFromGuidance(params.guidance);
  const explicitVolumeCount = normalizePositiveInteger(params.targetVolumeCount)
    ?? (
      guidanceVolumeSignal && guidanceVolumeSignal < 0
        ? Math.ceil(chapterBudget / Math.abs(guidanceVolumeSignal))
        : guidanceVolumeSignal
    );
  const rawVolumeCount = explicitVolumeCount
    ?? (
      params.respectExistingVolumeCount !== false && (params.existingVolumeCount ?? 0) > 0
        ? params.existingVolumeCount
        : suggestVolumeCount(chapterBudget)
    )
    ?? 1;
  return Math.max(1, Math.min(MAX_VOLUME_COUNT, chapterBudget, Math.round(rawVolumeCount)));
}

export function allocateChapterBudgets(params: {
  volumeCount: number;
  chapterBudget: number;
  existingVolumes?: VolumePlan[];
}): number[] {
  const safeVolumeCount = resolveTargetVolumeCount({
    chapterBudget: params.chapterBudget,
    targetVolumeCount: params.volumeCount,
  });
  const totalBudget = clampStructureChapterCount(params.chapterBudget);
  const existingCounts = Array.from(
    { length: safeVolumeCount },
    (_, index) => Math.max(params.existingVolumes?.[index]?.chapters.length ?? 0, 0),
  );
  const hasUsefulWeights = existingCounts.some((count) => count > 0);
  const weights = hasUsefulWeights
    ? existingCounts.map((count) => Math.max(count, 1))
    : Array.from({ length: safeVolumeCount }, () => 1);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const budgets = weights.map((weight) => Math.max(1, Math.round((totalBudget * weight) / totalWeight)));
  let delta = totalBudget - budgets.reduce((sum, budget) => sum + budget, 0);

  while (delta !== 0) {
    const direction = delta > 0 ? 1 : -1;
    for (let index = 0; index < budgets.length && delta !== 0; index += 1) {
      if (direction < 0 && budgets[index] <= 1) {
        continue;
      }
      budgets[index] += direction;
      delta -= direction;
    }
  }

  return budgets;
}

export function resolveVolumeChapterBudget(params: {
  volumes: VolumePlan[];
  targetVolume: VolumePlan;
  chapterBudget: number;
}): {
  targetChapterCount: number;
  targetChapterStartOrder: number;
  targetChapterEndOrder: number;
  chapterBudgets: number[];
  targetVolumeIndex: number;
} {
  const sortedVolumes = params.volumes.slice().sort((left, right) => left.sortOrder - right.sortOrder);
  const targetVolumeIndex = Math.max(0, sortedVolumes.findIndex((volume) => volume.id === params.targetVolume.id));
  const chapterBudgets = allocateChapterBudgets({
    volumeCount: Math.max(sortedVolumes.length, 1),
    chapterBudget: params.chapterBudget,
    existingVolumes: sortedVolumes,
  });
  const targetChapterCount = chapterBudgets[targetVolumeIndex]
    ?? Math.max(1, Math.round(params.chapterBudget / Math.max(sortedVolumes.length, 1)));
  const targetChapterStartOrder = chapterBudgets
    .slice(0, targetVolumeIndex)
    .reduce((sum, count) => sum + count, 0) + 1;
  return {
    targetChapterCount,
    targetChapterStartOrder,
    targetChapterEndOrder: targetChapterStartOrder + targetChapterCount - 1,
    chapterBudgets,
    targetVolumeIndex,
  };
}

function parseBeatSpan(chapterSpanHint: string): { start: number; end: number } | null {
  const values = Array.from(chapterSpanHint.matchAll(/\d+/g), (match) => Number(match[0]))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (values.length === 0) {
    return null;
  }
  const first = values[0] ?? 1;
  const last = values[values.length - 1] ?? first;
  return {
    start: Math.min(first, last),
    end: Math.max(first, last),
  };
}

function formatBeatSpan(start: number, end: number): string {
  return start === end ? `${start}章` : `${start}-${end}章`;
}

function fitWidthsToTotal(rawWidths: number[], total: number): number[] {
  if (rawWidths.length === 0) {
    return [];
  }
  const safeTotal = Math.max(rawWidths.length, total);
  const rawTotal = rawWidths.reduce((sum, width) => sum + Math.max(1, width), 0);
  const widths = rawWidths.map((width) => Math.max(1, Math.round((Math.max(1, width) * safeTotal) / rawTotal)));
  let delta = safeTotal - widths.reduce((sum, width) => sum + width, 0);

  while (delta !== 0) {
    const direction = delta > 0 ? 1 : -1;
    const order = widths
      .map((width, index) => ({ width, index }))
      .sort((left, right) => direction > 0 ? right.width - left.width : left.width - right.width);
    for (const item of order) {
      if (delta === 0) {
        break;
      }
      if (direction < 0 && widths[item.index] <= 1) {
        continue;
      }
      widths[item.index] += direction;
      delta -= direction;
    }
  }

  return widths;
}

export function normalizeBeatSheetSpansToChapterBudget<TBeat extends { chapterSpanHint: string }>(
  beats: TBeat[],
  targetChapterStartOrder: number,
  targetChapterCount: number,
): TBeat[] {
  if (beats.length === 0) {
    return beats;
  }
  const safeStart = Math.max(1, Math.round(targetChapterStartOrder));
  const safeCount = Math.max(1, Math.round(targetChapterCount));
  if (safeCount < beats.length) {
    return beats.map((beat, index) => {
      const chapterOffset = Math.min(safeCount - 1, Math.floor((index * safeCount) / beats.length));
      const chapterOrder = safeStart + chapterOffset;
      return {
        ...beat,
        chapterSpanHint: formatBeatSpan(chapterOrder, chapterOrder),
      };
    });
  }
  const spans = beats.map((beat) => parseBeatSpan(beat.chapterSpanHint));
  const rawWidths = spans.map((span) => span ? Math.max(1, span.end - span.start + 1) : 1);
  const widths = fitWidthsToTotal(rawWidths, safeCount);
  let cursor = safeStart;

  return beats.map((beat, index) => {
    const width = widths[index] ?? 1;
    const start = cursor;
    const end = index === beats.length - 1
      ? safeStart + safeCount - 1
      : Math.min(safeStart + safeCount - 1, cursor + width - 1);
    cursor = end + 1;
    return {
      ...beat,
      chapterSpanHint: formatBeatSpan(start, end),
    };
  });
}

export function inferRequiredChapterCountFromBeatSheet(
  beatSheet: Pick<VolumeBeatSheet, "beats"> | null | undefined,
): number {
  if (!beatSheet || !Array.isArray(beatSheet.beats)) {
    return 0;
  }
  const spans = beatSheet.beats
    .map((beat) => parseBeatSpan(beat.chapterSpanHint))
    .filter((span): span is { start: number; end: number } => Boolean(span));
  if (spans.length === 0) {
    return 0;
  }
  const firstStart = Math.min(...spans.map((span) => span.start));
  const lastEnd = Math.max(...spans.map((span) => span.end));
  return firstStart > 1 ? Math.max(1, lastEnd - firstStart + 1) : lastEnd;
}
