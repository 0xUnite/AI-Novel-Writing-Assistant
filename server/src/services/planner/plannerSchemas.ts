import { z } from "zod";
import type { PlannerOutput } from "./plannerOutputNormalization";

// Planner 输出需要尽量宽容：不同模型可能在字段类型上有差异（字符串/数组等）。
// top-level 仍要求对象；但对模型偶尔把 chapter scenes 直接作为根数组输出做兼容兜底。

const PLAN_WRAPPER_KEYS = ["plan", "chapterPlan", "chapter_plan", "result", "output", "data", "规划", "章节规划"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function firstDefined(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) {
      return record[key];
    }
  }
  return undefined;
}

function collectTextFragments(value: unknown): string[] {
  if (typeof value === "string") {
    const text = value.trim();
    return text ? [text] : [];
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return [String(value)];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectTextFragments(item));
  }
  if (isRecord(value)) {
    return Object.values(value).flatMap((item) => collectTextFragments(item));
  }
  return [];
}

function normalizeOptionalText(value: unknown): unknown {
  if (value === undefined || value === null) {
    return value;
  }
  const fragments = collectTextFragments(value);
  return fragments.length > 0 ? Array.from(new Set(fragments)).join("；") : value;
}

function normalizeStringArray(value: unknown): unknown {
  if (value === undefined || value === null) {
    return value;
  }
  const fragments = collectTextFragments(value);
  return fragments.length > 0 ? Array.from(new Set(fragments)) : value;
}

function normalizePlannerBoolean(value: unknown): unknown {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "yes", "1", "是", "需要", "高"].includes(normalized)) {
      return true;
    }
    if (["false", "no", "0", "否", "不需要", "低"].includes(normalized)) {
      return false;
    }
  }
  return value;
}

function normalizePlannerHookKind(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (
    normalized === "information_reversal"
    || normalized === "decision_reversal"
    || normalized === "threat_approaches"
    || normalized === "suspense_question"
  ) {
    return normalized;
  }
  if (/信息|反转|reveal/.test(value)) {
    return "information_reversal";
  }
  if (/决策|抉择|选择|decision/.test(value)) {
    return "decision_reversal";
  }
  if (/威胁|逼近|threat/.test(value)) {
    return "threat_approaches";
  }
  if (/悬念|疑问|问题|suspense|question/.test(value)) {
    return "suspense_question";
  }
  return value;
}

function normalizePlannerChapterMetaPayload(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  return {
    eventWeight: firstDefined(value, ["eventWeight", "event_weight", "事件权重"]),
    highStakesDialogue: firstDefined(value, ["highStakesDialogue", "high_stakes_dialogue", "高价值对话"]),
    schemeBeat: firstDefined(value, ["schemeBeat", "scheme_beat", "算计节拍"]),
    kindOfHook: firstDefined(value, ["kindOfHook", "kind_of_hook", "钩子类型"]),
  };
}

function normalizePlannerScenePayload(value: unknown, index = 0): unknown {
  if (!isRecord(value)) {
    const text = normalizeOptionalText(value);
    return typeof text === "string" && text.trim()
      ? {
          title: text,
          objective: text,
          conflict: text,
          reveal: text,
          emotionBeat: text,
        }
      : value;
  }

  return {
    ...value,
    title: firstDefined(value, ["title", "sceneTitle", "name", "标题", "场景标题"]) ?? `Scene ${index + 1}`,
    objective: firstDefined(value, ["objective", "goal", "purpose", "目标", "场景目标"]),
    conflict: firstDefined(value, ["conflict", "tension", "obstacle", "冲突", "矛盾"]),
    reveal: firstDefined(value, ["reveal", "reveals", "discovery", "信息揭露", "揭露", "变化"]),
    emotionBeat: firstDefined(value, ["emotionBeat", "emotion", "mood", "情绪节拍", "情绪"]),
  };
}

function normalizePlannerScenes(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return value;
  }
  return value.map((scene, index) => normalizePlannerScenePayload(scene, index));
}

function hasPlanLevelKeys(record: Record<string, unknown>): boolean {
  return [
    "scenes",
    "mustAdvance",
    "mustPreserve",
    "planRole",
    "phaseLabel",
    "hookTarget",
    "riskNotes",
    "chapterMeta",
    "chapter_meta",
  ].some((key) => record[key] !== undefined && record[key] !== null);
}

function buildPlanFromSceneArray(value: unknown[]): unknown {
  if (value.length === 0) {
    return value;
  }
  if (value.length === 1 && isRecord(value[0]) && hasPlanLevelKeys(value[0])) {
    return normalizePlannerRootPayload(value[0]);
  }

  const scenes = normalizePlannerScenes(value);
  const sceneRecords = Array.isArray(scenes) ? scenes.filter(isRecord) : [];
  const title = collectTextFragments(firstDefined(sceneRecords[0] ?? {}, ["title"])).join("；") || "章节规划";
  const objectives = sceneRecords.flatMap((scene) => collectTextFragments(firstDefined(scene, ["objective", "title"])));
  const reveals = sceneRecords.flatMap((scene) => collectTextFragments(firstDefined(scene, ["reveal"])));
  const emotionBeats = sceneRecords.flatMap((scene) => collectTextFragments(firstDefined(scene, ["emotionBeat"])));
  const objective = Array.from(new Set(objectives)).join("；") || "按场景顺序推进本章任务。";

  return {
    title,
    objective,
    participants: [],
    reveals: Array.from(new Set(reveals)),
    riskNotes: ["避免场景之间缺少因果衔接。"],
    hookTarget: Array.from(new Set([...reveals, ...emotionBeats])).slice(-1)[0] ?? objective,
    planRole: "progress",
    phaseLabel: "章节推进",
    mustAdvance: Array.from(new Set(objectives)).length > 0
      ? Array.from(new Set(objectives))
      : ["按场景顺序推进本章任务。"],
    mustPreserve: ["保持既有章节任务单、人物状态与上下文连续。"],
    chapterMeta: {
      eventWeight: 3,
      highStakesDialogue: false,
      schemeBeat: false,
      kindOfHook: "suspense_question",
    },
    scenes,
  };
}

function normalizePlannerRootPayload(raw: unknown): unknown {
  if (Array.isArray(raw)) {
    return buildPlanFromSceneArray(raw);
  }
  if (!isRecord(raw)) {
    return raw;
  }

  if (!hasPlanLevelKeys(raw)) {
    for (const key of PLAN_WRAPPER_KEYS) {
      const wrapped = raw[key];
      if (isRecord(wrapped) || (Array.isArray(wrapped) && wrapped.length > 0)) {
        return normalizePlannerRootPayload(wrapped);
      }
    }
  }

  const scenes = firstDefined(raw, ["scenes", "sceneList", "scene_plan", "scenePlan", "场景", "场景列表"]);
  return {
    ...raw,
    title: firstDefined(raw, ["title", "name", "标题"]),
    objective: firstDefined(raw, ["objective", "goal", "purpose", "目标", "章节目标"]),
    participants: firstDefined(raw, ["participants", "characters", "actors", "参与者", "人物"]),
    reveals: firstDefined(raw, ["reveals", "reveal", "discoveries", "揭露", "信息揭露"]),
    riskNotes: firstDefined(raw, ["riskNotes", "risks", "risk", "风险", "风险提示"]),
    hookTarget: firstDefined(raw, ["hookTarget", "hook", "悬念", "钩子", "收尾钩子"]),
    planRole: firstDefined(raw, ["planRole", "role", "结构职责"]),
    phaseLabel: firstDefined(raw, ["phaseLabel", "phase", "阶段", "阶段标签"]),
    mustAdvance: firstDefined(raw, ["mustAdvance", "advance", "推进项", "必须推进"]),
    mustPreserve: firstDefined(raw, ["mustPreserve", "preserve", "保留项", "必须保持"]),
    chapterMeta: firstDefined(raw, ["chapterMeta", "chapter_meta", "章节元信息"]),
    scenes: normalizePlannerScenes(scenes),
  };
}

const plannerSceneSchema = z.preprocess((value) => normalizePlannerScenePayload(value), z.object({
  title: z.preprocess(normalizeOptionalText, z.string().trim().optional()),
  objective: z.preprocess(normalizeOptionalText, z.string().trim().optional()),
  conflict: z.preprocess(normalizeOptionalText, z.string().trim().optional()),
  reveal: z.preprocess(normalizeOptionalText, z.string().trim().optional()),
  emotionBeat: z.preprocess(normalizeOptionalText, z.string().trim().optional()),
}));

const plannerChapterMetaSchema = z.preprocess(normalizePlannerChapterMetaPayload, z.object({
  eventWeight: z.preprocess(normalizeOptionalText, z.coerce.number().int().min(1).max(5)).default(3),
  highStakesDialogue: z.preprocess(normalizePlannerBoolean, z.boolean()).default(false),
  schemeBeat: z.preprocess(normalizePlannerBoolean, z.boolean()).default(false),
  kindOfHook: z.preprocess(
    normalizePlannerHookKind,
    z.enum(["information_reversal", "decision_reversal", "threat_approaches", "suspense_question"]),
  ).default("suspense_question"),
}));

const plannerOutputObjectSchema = z.object({
  title: z.preprocess(normalizeOptionalText, z.string().trim().optional()),
  objective: z.preprocess(normalizeOptionalText, z.string().trim().optional()),
  participants: z.preprocess(normalizeStringArray, z.array(z.string().trim()).optional()),
  reveals: z.preprocess(normalizeStringArray, z.array(z.string().trim()).optional()),
  riskNotes: z.preprocess(normalizeStringArray, z.array(z.string().trim()).optional()),
  hookTarget: z.preprocess(normalizeOptionalText, z.string().trim().optional()),
  planRole: z.preprocess(
    normalizePlannerPlanRole,
    z.string().trim().min(1).nullable().optional(),
  ),
  phaseLabel: z.preprocess(normalizeOptionalText, z.string().trim().optional()),
  mustAdvance: z.preprocess(normalizeStringArray, z.array(z.string().trim()).optional()),
  mustPreserve: z.preprocess(normalizeStringArray, z.array(z.string().trim()).optional()),
  chapterMeta: plannerChapterMetaSchema.optional(),
  scenes: z.preprocess(normalizePlannerScenes, z.array(plannerSceneSchema).optional()),
});

function normalizePlannerPlanRole(value: unknown): unknown {
  if (value == null) {
    return null;
  }
  if (typeof value !== "string") {
    return value;
  }

  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!normalized || normalized === "book" || normalized === "arc" || normalized === "overview") {
    return null;
  }
  if (normalized === "setup" || normalized === "opening" || normalized === "start") {
    return "setup";
  }
  if (normalized === "progress" || normalized === "development" || normalized === "advance") {
    return "progress";
  }
  if (normalized === "pressure" || normalized === "escalation" || normalized === "pressure_up") {
    return "pressure";
  }
  if (normalized === "turn" || normalized === "pivot" || normalized === "reversal" || normalized === "twist") {
    return "turn";
  }
  if (normalized === "payoff" || normalized === "climax" || normalized === "resolution") {
    return "payoff";
  }
  if (normalized === "cooldown" || normalized === "ending" || normalized === "landing" || normalized === "aftermath") {
    return "cooldown";
  }
  return value;
}

export const plannerOutputSchema = z.preprocess(normalizePlannerRootPayload, plannerOutputObjectSchema);

export type PlannerOutputSchema = z.infer<typeof plannerOutputSchema> & Partial<PlannerOutput>;
