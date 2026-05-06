import type { ChapterMeta, ChapterHookKind } from "@ai-novel/shared/types/novel";

export const CHAPTER_HOOK_KINDS = [
  "information_reversal",
  "decision_reversal",
  "threat_approaches",
  "suspense_question",
] as const satisfies readonly ChapterHookKind[];

const CHAPTER_HOOK_KIND_SET = new Set<string>(CHAPTER_HOOK_KINDS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value);
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 0;
  }
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (["true", "yes", "y", "1", "是", "需要", "高"].includes(normalized)) {
    return true;
  }
  if (["false", "no", "n", "0", "否", "不需要", "低"].includes(normalized)) {
    return false;
  }
  return null;
}

function normalizeHookKind(value: unknown): ChapterHookKind | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (CHAPTER_HOOK_KIND_SET.has(normalized)) {
    return normalized as ChapterHookKind;
  }
  if (/信息|反转|reveal/.test(value)) {
    return "information_reversal";
  }
  if (/决策|抉择|选择|decision/.test(value)) {
    return "decision_reversal";
  }
  if (/威胁|逼近|追杀|threat/.test(value)) {
    return "threat_approaches";
  }
  if (/悬念|疑问|问题|suspense|question/.test(value)) {
    return "suspense_question";
  }
  return null;
}

function firstDefined(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) {
      return record[key];
    }
  }
  return undefined;
}

export function normalizeChapterMeta(raw: unknown, fallback: Partial<ChapterMeta> = {}): ChapterMeta {
  const record = isRecord(raw) ? raw : {};
  const nested = firstDefined(record, ["chapter_meta", "chapterMeta", "chapterMetaJson", "meta", "章节元信息"]);
  const source = isRecord(nested) ? nested : record;
  const eventWeight = normalizeInteger(firstDefined(source, ["event_weight", "eventWeight", "事件权重"]))
    ?? fallback.eventWeight
    ?? 3;
  const kindOfHook = normalizeHookKind(firstDefined(source, ["kind_of_hook", "kindOfHook", "hookKind", "钩子类型"]))
    ?? fallback.kindOfHook
    ?? "suspense_question";
  const highStakesDialogue = normalizeBoolean(firstDefined(source, ["high_stakes_dialogue", "highStakesDialogue", "高价值对话"]))
    ?? fallback.highStakesDialogue
    ?? eventWeight >= 4;
  const schemeBeat = normalizeBoolean(firstDefined(source, ["scheme_beat", "schemeBeat", "算计节拍"]))
    ?? fallback.schemeBeat
    ?? false;
  return {
    eventWeight: Math.max(1, Math.min(5, eventWeight)),
    highStakesDialogue,
    schemeBeat,
    kindOfHook,
  };
}

export function parseChapterMetaFromJson(rawJson: string | null | undefined, fallback: Partial<ChapterMeta> = {}): ChapterMeta {
  if (!rawJson?.trim()) {
    return normalizeChapterMeta({}, fallback);
  }
  try {
    return normalizeChapterMeta(JSON.parse(rawJson), fallback);
  } catch {
    return normalizeChapterMeta({}, fallback);
  }
}

export function serializeChapterMetaForPrompt(meta: ChapterMeta): string {
  return [
    `event_weight=${meta.eventWeight}`,
    `high_stakes_dialogue=${meta.highStakesDialogue}`,
    `scheme_beat=${meta.schemeBeat}`,
    `kind_of_hook=${meta.kindOfHook}`,
  ].join(" | ");
}

export function toStoredChapterMeta(meta: ChapterMeta): {
  event_weight: number;
  high_stakes_dialogue: boolean;
  scheme_beat: boolean;
  kind_of_hook: ChapterHookKind;
} {
  return {
    event_weight: meta.eventWeight,
    high_stakes_dialogue: meta.highStakesDialogue,
    scheme_beat: meta.schemeBeat,
    kind_of_hook: meta.kindOfHook,
  };
}
