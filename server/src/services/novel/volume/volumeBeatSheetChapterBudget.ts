import type { VolumeBeatSheet } from "@ai-novel/shared/types/novel";

type ChapterSpanBounds = {
  start: number;
  end: number;
};

export function parseBeatSheetChapterSpan(chapterSpanHint: string): ChapterSpanBounds | null {
  const matches = Array.from(chapterSpanHint.matchAll(/\d+/g), (match) => Number(match[0])).filter(
    (value) => Number.isFinite(value),
  );
  if (matches.length === 0) {
    return null;
  }
  const first = matches[0] ?? 0;
  const last = matches[matches.length - 1] ?? first;
  const start = Math.min(first, last);
  const end = Math.max(first, last);
  if (start < 1 || end < 1) {
    return null;
  }
  return { start, end };
}

export function formatBeatSheetChapterSpan(start: number, end: number): string {
  const normalizedStart = Math.max(1, Math.round(start));
  const normalizedEnd = Math.max(normalizedStart, Math.round(end));
  return normalizedStart === normalizedEnd ? `${normalizedStart}章` : `${normalizedStart}-${normalizedEnd}章`;
}

export function getBeatSheetChapterSpanUpperBound(chapterSpanHint: string): number {
  return parseBeatSheetChapterSpan(chapterSpanHint)?.end ?? 0;
}

export function inferRequiredChapterCountFromBeatSheet(
  beatSheet: Pick<VolumeBeatSheet, "beats"> | null | undefined,
): number {
  if (!beatSheet || !Array.isArray(beatSheet.beats)) {
    return 0;
  }
  const spans = beatSheet.beats
    .map((beat) => parseBeatSheetChapterSpan(beat.chapterSpanHint))
    .filter((span): span is ChapterSpanBounds => Boolean(span));
  if (spans.length === 0) {
    return 0;
  }
  const firstStart = Math.min(...spans.map((span) => span.start));
  const lastEnd = Math.max(...spans.map((span) => span.end));
  return firstStart > 1 ? Math.max(1, lastEnd - firstStart + 1) : lastEnd;
}

export function normalizeBeatSheetChapterSpans<TBeat extends { chapterSpanHint: string }>(
  beats: TBeat[],
  expectedStartOrder: number,
): TBeat[] {
  if (expectedStartOrder < 1 || beats.length === 0) {
    return beats;
  }

  const spans = beats.map((beat) => parseBeatSheetChapterSpan(beat.chapterSpanHint));
  const firstSpan = spans.find((span): span is ChapterSpanBounds => Boolean(span));
  if (!firstSpan || firstSpan.start === expectedStartOrder) {
    return beats;
  }

  const offset = expectedStartOrder - firstSpan.start;
  return beats.map((beat, beatIndex) => {
    const span = spans[beatIndex];
    if (!span) {
      return beat;
    }
    return {
      ...beat,
      chapterSpanHint: formatBeatSheetChapterSpan(span.start + offset, span.end + offset),
    };
  });
}
