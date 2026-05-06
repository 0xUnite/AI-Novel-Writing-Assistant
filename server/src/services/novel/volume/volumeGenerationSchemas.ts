import { z } from "zod";

function normalizeObjectAlias(raw: unknown, aliasMap: Record<string, string[]>): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return raw;
  }
  const record = raw as Record<string, unknown>;
  const normalized: Record<string, unknown> = { ...record };

  for (const [targetKey, aliases] of Object.entries(aliasMap)) {
    if (normalized[targetKey] !== undefined && normalized[targetKey] !== null) {
      continue;
    }
    const matchedAlias = aliases.find((alias) => record[alias] !== undefined && record[alias] !== null);
    if (matchedAlias) {
      normalized[targetKey] = record[matchedAlias];
    }
  }

  return normalized;
}

function normalizeInteger(value: unknown): unknown {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value);
  }
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) {
      return Math.round(parsed);
    }
  }
  return value;
}

function normalizeStringArray(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "string") {
    return value
      .split(/[\n,，;；、|]/g)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return value;
}

const CHAPTER_HOOK_KIND_VALUES = [
  "information_reversal",
  "decision_reversal",
  "threat_approaches",
  "suspense_question",
] as const;

function normalizeBoolean(value: unknown): unknown {
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

function normalizeHookKind(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if ((CHAPTER_HOOK_KIND_VALUES as readonly string[]).includes(normalized)) {
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

function normalizeChapterMetaPayload(raw: unknown): unknown {
  const normalized = normalizeObjectAlias(raw, {
    eventWeight: ["event_weight", "weight", "事件权重"],
    highStakesDialogue: ["high_stakes_dialogue", "dialogueHighStakes", "高价值对话"],
    schemeBeat: ["scheme_beat", "scheme", "算计节拍"],
    kindOfHook: ["kind_of_hook", "hookKind", "钩子类型"],
  });
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
    return normalized;
  }
  const record = normalized as Record<string, unknown>;
  return {
    ...record,
    eventWeight: normalizeInteger(record.eventWeight),
    highStakesDialogue: normalizeBoolean(record.highStakesDialogue),
    schemeBeat: normalizeBoolean(record.schemeBeat),
    kindOfHook: normalizeHookKind(record.kindOfHook),
  };
}

function normalizeChapterListItemPayload(raw: unknown): unknown {
  const normalized = normalizeObjectAlias(raw, {
    title: ["chapterTitle", "name", "标题"],
    summary: ["outline", "description", "摘要"],
    chapterMeta: ["chapter_meta", "meta", "章节元信息"],
  });
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
    return normalized;
  }
  const record = normalized as Record<string, unknown>;
  return {
    ...record,
    chapterMeta: normalizeChapterMetaPayload(record.chapterMeta),
  };
}

const TASK_SHEET_FIELD_LABELS: Record<string, string> = {
  emotionalTone: "情绪基调",
  emotionTone: "情绪基调",
  tone: "情绪基调",
  mood: "情绪基调",
  "情绪基调": "情绪基调",
  coreConflict: "核心冲突",
  conflict: "核心冲突",
  "核心冲突": "核心冲突",
  keyAdvancement: "关键推进",
  keyProgression: "关键推进",
  progression: "关键推进",
  "关键推进": "关键推进",
  "关键推进点": "关键推进",
  endingRequirement: "收尾要求",
  endingHook: "收尾要求",
  hook: "收尾要求",
  "收尾要求": "收尾要求",
  "结尾钩子": "收尾要求",
};

function normalizeTaskSheetText(value: unknown): unknown {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => normalizeTaskSheetSegment(item))
      .filter((item): item is string => Boolean(item));
    return parts.length > 0 ? parts.join("；") : value;
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const parts = Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => {
      const text = normalizeTaskSheetSegment(item);
      if (!text) {
        return null;
      }
      if (["taskSheet", "task_sheet", "任务单", "writingTask", "执行任务单"].includes(key)) {
        return text;
      }
      return `${TASK_SHEET_FIELD_LABELS[key] ?? key}：${text}`;
    })
    .filter((item): item is string => Boolean(item));

  return parts.length > 0 ? parts.join("；") : value;
}

function normalizeTaskSheetSegment(value: unknown): string | null {
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => normalizeTaskSheetSegment(item))
      .filter((item): item is string => Boolean(item));
    return parts.length > 0 ? parts.join("、") : null;
  }
  const normalized = normalizeTaskSheetText(value);
  return typeof normalized === "string" && normalized.trim() ? normalized.trim() : null;
}

function normalizeTextValue(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.round(value));
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeVolumeReference(value: unknown): unknown {
  const normalized = normalizeTextValue(value);
  if (!normalized) {
    return value;
  }
  const volumeMatch = normalized.match(/(?:volume|卷|第)?\s*(\d+)(?:\s*卷)?$/i);
  return volumeMatch?.[1] ?? normalized;
}

function normalizeRebalanceSeverity(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (normalized === "high" || normalized === "medium" || normalized === "low") {
    return normalized;
  }
  if (normalized === "urgent" || normalized === "critical") {
    return "high";
  }
  if (normalized === "mid") {
    return "medium";
  }
  if (normalized === "minor") {
    return "low";
  }
  return value;
}

function normalizeRebalanceDirection(value: unknown, actions?: unknown): unknown {
  const normalizedActions = normalizeStringArray(actions);
  const normalizedActionList = Array.isArray(normalizedActions)
    ? normalizedActions.map((item) => String(item).trim().toLowerCase()).filter(Boolean)
    : [];

  if (normalizedActionList.length === 1 && normalizedActionList[0] === "hold") {
    return "hold";
  }

  if (typeof value !== "string") {
    return value;
  }

  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  switch (normalized) {
    case "pull_forward":
    case "pullforward":
    case "backward":
    case "back":
      return "pull_forward";
    case "push_back":
    case "pushback":
    case "forward":
    case "next":
      return "push_back";
    case "tighten_current":
    case "tighten":
    case "compress_current":
      return "tighten_current";
    case "expand_adjacent":
    case "expand":
    case "expand_neighbor":
    case "expand_neighbour":
    case "adjacent":
      return "expand_adjacent";
    case "hold":
    case "no_change":
    case "none":
    case "stable":
      return "hold";
    default:
      return value;
  }
}

function normalizeBeatPayload(raw: unknown): unknown {
  const normalized = normalizeObjectAlias(raw, {
    key: ["beatKey", "stageKey", "id"],
    label: ["beatLabel", "stageLabel", "name", "title"],
    summary: ["beatSummary", "description", "detail", "content", "摘要", "概要", "说明"],
    chapterSpanHint: [
      "chapterSpan",
      "chapterRange",
      "chapterWindow",
      "chapterHint",
      "spanHint",
      "chapter_span_hint",
      "章节范围",
      "章数范围",
    ],
    mustDeliver: [
      "deliverables",
      "mustHit",
      "mustLand",
      "requiredPayoffs",
      "requiredPoints",
      "payoffs",
      "deliver",
      "must_deliver",
      "关键兑现",
      "必要兑现",
    ],
    eventWeight: ["event_weight", "weight", "事件权重"],
    highStakesDialogue: ["high_stakes_dialogue", "dialogueHighStakes", "高价值对话"],
    schemeBeat: ["scheme_beat", "scheme", "算计节拍"],
    kindOfHook: ["kind_of_hook", "hookKind", "钩子类型"],
  });

  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
    return normalized;
  }

  const record = normalized as Record<string, unknown>;
  return {
    ...record,
    mustDeliver: normalizeStringArray(record.mustDeliver),
    eventWeight: normalizeInteger(record.eventWeight),
    highStakesDialogue: normalizeBoolean(record.highStakesDialogue),
    schemeBeat: normalizeBoolean(record.schemeBeat),
    kindOfHook: normalizeHookKind(record.kindOfHook),
  };
}

function normalizeBeatSheetPayload(raw: unknown): unknown {
  if (Array.isArray(raw)) {
    return { beats: raw };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return raw;
  }

  const record = raw as Record<string, unknown>;
  const candidates = [
    record.beats,
    record.items,
    record.stages,
    record.outline,
    record.beatSheet,
  ];

  let beats = record.beats;
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      beats = candidate;
      break;
    }
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      const nestedBeats = (candidate as { beats?: unknown }).beats;
      if (Array.isArray(nestedBeats)) {
        beats = nestedBeats;
        break;
      }
    }
  }

  return {
    ...record,
    beats,
  };
}

function normalizeRebalanceDecisionPayload(raw: unknown): unknown {
  const normalized = normalizeObjectAlias(raw, {
    anchorVolumeId: ["anchorVolume", "anchorVolumeOrder", "anchorVolumeRef", "sourceVolumeId", "sourceVolumeOrder"],
    affectedVolumeId: ["affectedVolume", "affectedVolumeOrder", "affectedVolumeRef", "adjacentVolumeId", "adjacentVolumeOrder", "targetVolumeId", "targetVolumeOrder", "neighborVolumeId", "neighborVolumeOrder"],
    direction: ["rebalanceDirection", "adjustDirection", "moveDirection"],
    severity: ["impactLevel", "priority", "risk"],
    summary: ["reason", "detail", "explanation"],
    actions: ["recommendedActions", "actionItems", "suggestedActions", "recommendations"],
  });

  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
    return normalized;
  }

  const record = normalized as Record<string, unknown>;
  const normalizedDirection = normalizeRebalanceDirection(record.direction, record.actions);
  const normalizedActions = normalizeStringArray(record.actions);
  const fallbackActions = Array.isArray(normalizedActions) && normalizedActions.length > 0
    ? normalizedActions
    : normalizedDirection === "hold"
      ? ["hold"]
      : normalizedActions;
  return {
    ...record,
    anchorVolumeId: normalizeVolumeReference(record.anchorVolumeId),
    affectedVolumeId: normalizeVolumeReference(record.affectedVolumeId),
    direction: normalizedDirection,
    severity: normalizeRebalanceSeverity(record.severity),
    actions: fallbackActions,
  };
}

function normalizeRebalancePayload(raw: unknown): unknown {
  if (Array.isArray(raw)) {
    return { decisions: raw };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return raw;
  }

  const record = raw as Record<string, unknown>;
  const candidates = [
    record.decisions,
    record.items,
    record.recommendations,
    record.rebalanceDecisions,
  ];

  let decisions = record.decisions;
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      decisions = candidate;
      break;
    }
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      const nestedDecisions = (candidate as { decisions?: unknown }).decisions;
      if (Array.isArray(nestedDecisions)) {
        decisions = nestedDecisions;
        break;
      }
    }
  }

  return {
    ...record,
    decisions,
  };
}

function normalizeStrategyUncertaintyLevel(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "low" || normalized === "medium" || normalized === "high") {
    return normalized;
  }
  if (/(^|[^a-z])(stable|certain|clear|locked)([^a-z]|$)/.test(normalized) || /低|稳|明确|清晰/.test(value)) {
    return "low";
  }
  if (/(^|[^a-z])(open|unknown|uncertain|flexible|high)([^a-z]|$)/.test(normalized) || /高|未知|不确定|开放|弹性/.test(value)) {
    return "high";
  }
  if (/(^|[^a-z])(mid|middle|medium|adjustable)([^a-z]|$)/.test(normalized) || /中|适中|可调/.test(value)) {
    return "medium";
  }
  return "medium";
}

function normalizeStrategyVolumePayload(raw: unknown): unknown {
  const normalized = normalizeObjectAlias(raw, {
    sortOrder: ["order", "volumeOrder", "volume", "卷序", "卷号"],
    planningMode: ["mode", "planMode", "planning", "规划模式"],
    roleLabel: ["role", "volumeRole", "positioning", "定位", "卷定位"],
    coreReward: [
      "readerReward",
      "reward",
      "mainPromise",
      "promise",
      "coreSellingPoint",
      "sellingPoint",
      "summary",
      "core_reward",
      "核心回报",
      "主承诺",
      "核心卖点",
      "摘要",
    ],
    escalationFocus: [
      "escalation",
      "escalationMode",
      "primaryPressure",
      "primaryPressureSource",
      "pressure",
      "pressureSource",
      "focus",
      "升级方式",
      "升级焦点",
      "主压迫源",
    ],
    uncertaintyLevel: [
      "uncertainty",
      "riskLevel",
      "risk",
      "certainty",
      "uncertainty_level",
      "不确定性",
      "风险等级",
    ],
  });

  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
    return normalized;
  }

  const record = normalized as Record<string, unknown>;
  return {
    ...record,
    sortOrder: normalizeInteger(record.sortOrder),
    uncertaintyLevel: normalizeStrategyUncertaintyLevel(record.uncertaintyLevel),
  };
}

function normalizeStrategyUncertaintyPayload(raw: unknown): unknown {
  const normalized = normalizeObjectAlias(raw, {
    targetType: ["scope", "uncertaintyType", "type"],
    targetRef: ["target", "volumeRef", "ref", "对象", "目标"],
    level: ["riskLevel", "uncertaintyLevel", "severity", "风险等级"],
    reason: ["detail", "summary", "explanation", "说明"],
  });
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
    return normalized;
  }
  const record = normalized as Record<string, unknown>;
  return {
    ...record,
    level: normalizeStrategyUncertaintyLevel(record.level),
  };
}

function normalizeStrategyPayload(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return raw;
  }
  const normalized = normalizeObjectAlias(raw, {
    recommendedVolumeCount: ["volumeCount", "recommendedVolumes", "卷数", "推荐卷数"],
    hardPlannedVolumeCount: ["hardVolumeCount", "hardPlanVolumeCount", "硬规划卷数", "硬卷数"],
    readerRewardLadder: ["rewardLadder", "readerRewards", "读者回报梯度"],
    escalationLadder: ["escalationPath", "pressureLadder", "升级梯度"],
    midpointShift: ["midpointTurn", "midShift", "中盘转向"],
    notes: ["strategyNotes", "备注", "说明"],
    volumes: ["strategyVolumes", "volumePlans", "volumesStrategy"],
    uncertainties: ["risks", "uncertaintyMarkers", "uncertaintyList"],
  });
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
    return normalized;
  }
  const record = normalized as Record<string, unknown>;
  const volumes = Array.isArray(record.volumes)
    ? record.volumes
    : record.volumes && typeof record.volumes === "object" && !Array.isArray(record.volumes)
      ? [record.volumes]
      : record.volumes;
  const uncertainties = Array.isArray(record.uncertainties)
    ? record.uncertainties
    : record.uncertainties && typeof record.uncertainties === "object" && !Array.isArray(record.uncertainties)
      ? [record.uncertainties]
      : record.uncertainties;
  return {
    ...record,
    recommendedVolumeCount: normalizeInteger(record.recommendedVolumeCount),
    hardPlannedVolumeCount: normalizeInteger(record.hardPlannedVolumeCount),
    volumes,
    uncertainties,
  };
}

function normalizeSkeletonPayload(raw: unknown): unknown {
  const normalized = normalizeObjectAlias(raw, {
    title: ["volumeTitle", "name", "卷名"],
    summary: ["volumeSummary", "outline", "简介", "摘要"],
    openingHook: ["hook", "opening", "开卷抓手"],
    mainPromise: ["promise", "主承诺"],
    primaryPressureSource: ["primaryPressure", "pressureSource", "主压迫源"],
    coreSellingPoint: ["sellingPoint", "coreReward", "核心卖点"],
    escalationMode: ["escalation", "upshift", "升级方式"],
    protagonistChange: ["growth", "change", "主角变化"],
    midVolumeRisk: ["midRisk", "risk", "中段风险"],
    climax: ["finalClimax", "高潮"],
    payoffType: ["payoff", "兑现类型"],
    nextVolumeHook: ["nextHook", "下卷钩子"],
    resetPoint: ["reset", "resetStatus", "重置点"],
    openPayoffs: ["openThreads", "pendingPayoffs", "悬而未决", "未兑现项"],
  });

  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
    return normalized;
  }

  const record = normalized as Record<string, unknown>;
  return {
    ...record,
    openPayoffs: normalizeStringArray(record.openPayoffs) ?? [],
  };
}

const generatedVolumeSkeletonSchema = z.preprocess(normalizeSkeletonPayload, z.object({
  title: z.string().trim().min(1),
  summary: z.string().trim().optional().nullable(),
  openingHook: z.string().trim().min(1),
  mainPromise: z.string().trim().min(1),
  primaryPressureSource: z.string().trim().min(1),
  coreSellingPoint: z.string().trim().min(1),
  escalationMode: z.string().trim().min(1),
  protagonistChange: z.string().trim().min(1),
  midVolumeRisk: z.string().trim().min(1),
  climax: z.string().trim().min(1),
  payoffType: z.string().trim().min(1),
  nextVolumeHook: z.string().trim().min(1),
  resetPoint: z.string().trim().optional().nullable(),
  openPayoffs: z.array(z.string().trim().min(1)).default([]),
}));

const generatedChapterMetaSchema = z.preprocess(normalizeChapterMetaPayload, z.object({
  eventWeight: z.number().int().min(1).max(5).default(3),
  highStakesDialogue: z.boolean().default(false),
  schemeBeat: z.boolean().default(false),
  kindOfHook: z.enum(CHAPTER_HOOK_KIND_VALUES).default("suspense_question"),
}));

const generatedChapterListItemSchema = z.preprocess(normalizeChapterListItemPayload, z.object({
  title: z.string().trim().min(1),
  summary: z.string().trim().min(1),
  chapterMeta: generatedChapterMetaSchema.default({
    eventWeight: 3,
    highStakesDialogue: false,
    schemeBeat: false,
    kindOfHook: "suspense_question",
  }),
}));

const generatedVolumeStrategyVolumeSchema = z.preprocess(normalizeStrategyVolumePayload, z.object({
  sortOrder: z.number().int().min(1),
  planningMode: z.enum(["hard", "soft"]),
  roleLabel: z.string().trim().min(1),
  coreReward: z.string().trim().min(1),
  escalationFocus: z.string().trim().min(1),
  uncertaintyLevel: z.enum(["low", "medium", "high"]),
}));

const generatedVolumeUncertaintySchema = z.preprocess(normalizeStrategyUncertaintyPayload, z.object({
  targetType: z.enum(["book", "volume", "beat_sheet", "chapter_list"]),
  targetRef: z.string().trim().min(1),
  level: z.enum(["low", "medium", "high"]),
  reason: z.string().trim().min(1),
}));

const generatedVolumeBeatSchema = z.preprocess(normalizeBeatPayload, z.object({
  key: z.string().trim().min(1),
  label: z.string().trim().min(1),
  summary: z.string().trim().min(1),
  chapterSpanHint: z.string().trim().min(1),
  mustDeliver: z.array(z.string().trim().min(1)).min(1).max(6),
  eventWeight: z.number().int().min(1).max(5).default(3),
  highStakesDialogue: z.boolean().default(false),
  schemeBeat: z.boolean().default(false),
  kindOfHook: z.enum(CHAPTER_HOOK_KIND_VALUES).default("suspense_question"),
}));

const generatedVolumeCritiqueIssueSchema = z.object({
  targetRef: z.string().trim().min(1),
  severity: z.enum(["low", "medium", "high"]),
  title: z.string().trim().min(1),
  detail: z.string().trim().min(1),
});

const generatedVolumeRebalanceDecisionSchema = z.preprocess(normalizeRebalanceDecisionPayload, z.object({
  anchorVolumeId: z.string().trim().min(1),
  affectedVolumeId: z.string().trim().min(1),
  direction: z.enum(["pull_forward", "push_back", "tighten_current", "expand_adjacent", "hold"]),
  severity: z.enum(["low", "medium", "high"]),
  summary: z.string().trim().min(1),
  actions: z.array(z.string().trim().min(1)).min(1).max(5),
}));

export function createBookVolumeSkeletonSchema(exactVolumeCount?: number) {
  return z.object({
    volumes: typeof exactVolumeCount === "number"
      ? z.array(generatedVolumeSkeletonSchema).length(exactVolumeCount)
      : z.array(generatedVolumeSkeletonSchema).min(1).max(12),
  });
}

export function createVolumeChapterListSchema(exactChapterCount?: number) {
  const maxChapterCount = typeof exactChapterCount === "number"
    ? Math.max(exactChapterCount, 80)
    : 80;
  return z.object({
    chapters: z.array(generatedChapterListItemSchema).min(1).max(maxChapterCount),
  });
}

export function createVolumeStrategySchema(maxVolumeCount = 12) {
  return z.preprocess(normalizeStrategyPayload, z.object({
    recommendedVolumeCount: z.number().int().min(1).max(maxVolumeCount),
    hardPlannedVolumeCount: z.number().int().min(1).max(maxVolumeCount),
    readerRewardLadder: z.string().trim().min(1),
    escalationLadder: z.string().trim().min(1),
    midpointShift: z.string().trim().min(1),
    notes: z.string().trim().min(1),
    volumes: z.array(generatedVolumeStrategyVolumeSchema).min(1).max(maxVolumeCount),
    uncertainties: z.array(generatedVolumeUncertaintySchema).max(maxVolumeCount).default([]),
  }).superRefine((value, ctx) => {
    if (value.hardPlannedVolumeCount > value.recommendedVolumeCount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["hardPlannedVolumeCount"],
        message: "hardPlannedVolumeCount 不能大于 recommendedVolumeCount。",
      });
    }

    if (value.volumes.length !== value.recommendedVolumeCount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["volumes"],
        message: "volumes 数量必须与 recommendedVolumeCount 完全一致。",
      });
    }

    value.volumes.forEach((volume, index) => {
      const expectedSortOrder = index + 1;
      if (volume.sortOrder !== expectedSortOrder) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["volumes", index, "sortOrder"],
          message: `volumes[${index}].sortOrder 必须按 1..N 连续递增，当前应为 ${expectedSortOrder}。`,
        });
      }

      const expectedPlanningMode = index < value.hardPlannedVolumeCount ? "hard" : "soft";
      if (volume.planningMode !== expectedPlanningMode) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["volumes", index, "planningMode"],
          message: `前 ${value.hardPlannedVolumeCount} 卷必须为 ${index < value.hardPlannedVolumeCount ? "\"hard\"" : "\"soft\""} 规划模式。`,
        });
      }
    });
  }));
}

export function createVolumeStrategyCritiqueSchema() {
  return z.object({
    overallRisk: z.enum(["low", "medium", "high"]),
    summary: z.string().trim().min(1),
    issues: z.array(generatedVolumeCritiqueIssueSchema).max(12).default([]),
    recommendedActions: z.array(z.string().trim().min(1)).max(8).default([]),
  });
}

export function createVolumeBeatSheetSchema() {
  return z.preprocess(normalizeBeatSheetPayload, z.object({
    beats: z.array(generatedVolumeBeatSchema).min(5).max(8),
  }));
}

export function createVolumeRebalanceSchema() {
  return z.preprocess(normalizeRebalancePayload, z.object({
    decisions: z.array(generatedVolumeRebalanceDecisionSchema).max(4).default([]),
  }));
}

export function createChapterPurposeSchema() {
  return z.preprocess(
    (raw) => normalizeObjectAlias(raw, {
      purpose: ["章节目标", "chapterGoal", "goal", "objective"],
    }),
    z.object({
      purpose: z.string().trim().min(1),
    }),
  );
}

export function createChapterBoundarySchema() {
  return z.preprocess((raw) => {
    const normalized = normalizeObjectAlias(raw, {
      conflictLevel: ["冲突等级", "conflict_level", "conflict"],
      revealLevel: ["揭露等级", "reveal_level", "reveal"],
      targetWordCount: ["目标字数", "target_word_count", "wordCount", "字数"],
      mustAvoid: ["禁止事项", "避免事项", "must_avoid"],
      payoffRefs: ["兑现关联", "payoff_refs", "payoffs", "关联兑现"],
    });
    if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
      return normalized;
    }
    const record = normalized as Record<string, unknown>;
    return {
      ...record,
      conflictLevel: normalizeInteger(record.conflictLevel),
      revealLevel: normalizeInteger(record.revealLevel),
      targetWordCount: normalizeInteger(record.targetWordCount),
      mustAvoid: normalizeTaskSheetText(record.mustAvoid),
      payoffRefs: normalizeStringArray(record.payoffRefs),
    };
  }, z.object({
    conflictLevel: z.number().int().min(0).max(100),
    revealLevel: z.number().int().min(0).max(100),
    targetWordCount: z.number().int().min(200).max(20000),
    mustAvoid: z.string().trim().min(1),
    payoffRefs: z.array(z.string().trim().min(1)).default([]),
  }));
}

export function createChapterTaskSheetSchema() {
  return z.preprocess(
    (raw) => {
      const normalized = normalizeObjectAlias(raw, {
        taskSheet: ["任务单", "task_sheet", "writingTask", "执行任务单"],
      });
      if (typeof normalized === "string" || Array.isArray(normalized)) {
        return { taskSheet: normalizeTaskSheetText(normalized) };
      }
      if (!normalized || typeof normalized !== "object") {
        return normalized;
      }

      const record = normalized as Record<string, unknown>;
      const taskSheet = normalizeTaskSheetText(record.taskSheet);
      const shouldUseWholeRecord = record.taskSheet === undefined
        || record.taskSheet === null
        || (typeof taskSheet === "string" && taskSheet.trim().length === 0);

      return {
        ...record,
        taskSheet: shouldUseWholeRecord ? normalizeTaskSheetText(record) : taskSheet,
      };
    },
    z.object({
      taskSheet: z.string().trim().min(1),
    }),
  );
}
