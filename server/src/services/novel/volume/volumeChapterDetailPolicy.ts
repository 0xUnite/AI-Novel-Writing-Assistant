import type { ChapterHookKind, ChapterMeta } from "@ai-novel/shared/types/novel";

export type ChapterDetailLevel = "brief" | "standard" | "spotlight";

export interface ChapterDetailPolicy {
  detailLevel: ChapterDetailLevel;
  detailLabel: string;
  targetWordCount: number;
  conflictLevel: number;
  revealLevel: number;
  mustAvoid: string;
  taskSheet: string;
}

const DEFAULT_CHAPTER_LENGTH = 2800;

function clampInteger(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function roundToNearest(value: number, step: number): number {
  return Math.max(step, Math.round(value / step) * step);
}

export function normalizeDefaultChapterLength(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_CHAPTER_LENGTH;
  }
  return clampInteger(value, 800, 10000);
}

export function resolveChapterDetailLevel(meta: ChapterMeta | null | undefined): ChapterDetailLevel {
  const eventWeight = clampInteger(meta?.eventWeight ?? 3, 1, 5);
  if (eventWeight <= 2) {
    return "brief";
  }
  if (eventWeight >= 4 || meta?.highStakesDialogue || meta?.schemeBeat) {
    return "spotlight";
  }
  return "standard";
}

function resolveTargetWordCount(defaultChapterLength: number, meta: ChapterMeta | null | undefined): number {
  const base = normalizeDefaultChapterLength(defaultChapterLength);
  const eventWeight = clampInteger(meta?.eventWeight ?? 3, 1, 5);
  // Keep multipliers extremely tight so word count doesn't blow up to 5000 or 6000
  const multiplier = eventWeight <= 1
    ? 0.9
    : eventWeight === 2
      ? 0.95
      : eventWeight === 4
        ? 1.05
        : eventWeight >= 5
          ? 1.1
          : 1;
  return clampInteger(roundToNearest(base * multiplier, 50), 800, 12000);
}

function resolveConflictLevel(meta: ChapterMeta | null | undefined): number {
  const eventWeight = clampInteger(meta?.eventWeight ?? 3, 1, 5);
  const base = [0, 22, 38, 58, 76, 90][eventWeight] ?? 58;
  const bonus = meta?.schemeBeat ? 6 : meta?.highStakesDialogue ? 4 : 0;
  return clampInteger(base + bonus, 0, 100);
}

function hookRevealBase(kind: ChapterHookKind | undefined): number {
  switch (kind) {
    case "information_reversal":
      return 76;
    case "decision_reversal":
      return 64;
    case "threat_approaches":
      return 48;
    case "suspense_question":
    default:
      return 56;
  }
}

function resolveRevealLevel(meta: ChapterMeta | null | undefined): number {
  const eventWeight = clampInteger(meta?.eventWeight ?? 3, 1, 5);
  return clampInteger(hookRevealBase(meta?.kindOfHook) + ((eventWeight - 3) * 6), 0, 100);
}

function detailLabel(level: ChapterDetailLevel): string {
  if (level === "brief") {
    return "略写承接";
  }
  if (level === "spotlight") {
    return "详写高光";
  }
  return "标准推进";
}

function coreExpansionRule(level: ChapterDetailLevel): string {
  if (level === "brief") {
    return "只展开本章必需的新信息、结算反馈、关系微变或下一段钩子；路程、寒暄、支线交代一到三段内完成。";
  }
  if (level === "spotlight") {
    return "把篇幅集中给核心场景：目标对撞、不可退让理由、关键对话、即时心理、代价或阶段兑现；支线只保留能抬高主线压力的部分。";
  }
  return "保持推进和情绪均衡：核心事件写完整，必要对白和反应写到位，普通衔接快速带过。";
}

function avoidRule(level: ChapterDetailLevel, targetWordCount: number): string {
  const shared = `目标约 ${targetWordCount} 字，必须贴近该字数，不得因为支线、路程、重复心理或解释性设定而扩写。`;
  if (level === "brief") {
    return `详略策略：略写承接。${shared} 禁止把低权重章节写成长铺垫；禁止连续写等待、移动、寒暄、复盘。`;
  }
  if (level === "spotlight") {
    return `详略策略：详写高光。${shared} 禁止把篇幅浪费在无关支线；应把字数用在核心冲突、选择代价、对话交锋和结果余波。`;
  }
  return `详略策略：标准推进。${shared} 禁止平均用力；重要动作和关系变化写清，普通交接快速压缩。`;
}

export function deriveChapterDetailPolicy(input: {
  defaultChapterLength?: number | null;
  chapterMeta?: ChapterMeta | null;
  title: string;
  summary: string;
}): ChapterDetailPolicy {
  const defaultChapterLength = normalizeDefaultChapterLength(input.defaultChapterLength);
  const detailLevel = resolveChapterDetailLevel(input.chapterMeta);
  const targetWordCount = resolveTargetWordCount(defaultChapterLength, input.chapterMeta);
  const conflictLevel = resolveConflictLevel(input.chapterMeta);
  const revealLevel = resolveRevealLevel(input.chapterMeta);
  const label = detailLabel(detailLevel);
  const expansionRule = coreExpansionRule(detailLevel);
  const mustAvoid = avoidRule(detailLevel, targetWordCount);
  const meta = input.chapterMeta;

  return {
    detailLevel,
    detailLabel: label,
    targetWordCount,
    conflictLevel,
    revealLevel,
    mustAvoid,
    taskSheet: [
      `详略层级：${label}`,
      `目标字数：约 ${targetWordCount} 字`,
      `本章核心：${input.summary}`,
      `展开规则：${expansionRule}`,
      meta
        ? `chapter_meta：event_weight=${meta.eventWeight}；high_stakes_dialogue=${meta.highStakesDialogue}；scheme_beat=${meta.schemeBeat}；kind_of_hook=${meta.kindOfHook}`
        : "",
      "收束要求：用具体动作、信息差、决定、物件、人物状态或风险变化承接下一章。",
    ].filter(Boolean).join("；"),
  };
}
