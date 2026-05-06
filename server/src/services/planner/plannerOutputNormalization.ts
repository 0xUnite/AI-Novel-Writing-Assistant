type PlannerChapterMeta = {
  eventWeight: number;
  highStakesDialogue: boolean;
  schemeBeat: boolean;
  kindOfHook: "information_reversal" | "decision_reversal" | "threat_approaches" | "suspense_question";
};

export interface PlannerOutput {
  title?: string;
  objective?: string;
  participants?: string[];
  reveals?: string[];
  riskNotes?: string[];
  hookTarget?: string;
  planRole?: string | null;
  phaseLabel?: string;
  mustAdvance?: string[];
  mustPreserve?: string[];
  chapterMeta?: PlannerChapterMeta;
  scenes?: Array<{
    title?: string;
    objective?: string;
    conflict?: string;
    reveal?: string;
    emotionBeat?: string;
  }>;
}

function collectPlannerTextFragments(value: unknown): string[] {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized ? [normalized] : [];
  }
  if (typeof value === "number") {
    return [String(value)];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectPlannerTextFragments(item));
  }
  if (value && typeof value === "object") {
    return Object.values(value).flatMap((item) => collectPlannerTextFragments(item));
  }
  return [];
}

function toPlannerOptionalText(value: unknown, separator = "；"): string | null {
  const parts = Array.from(new Set(collectPlannerTextFragments(value)));
  return parts.length > 0 ? parts.join(separator) : null;
}

function toPlannerStringArray(value: unknown): string[] {
  return Array.from(new Set(collectPlannerTextFragments(value)));
}

function normalizePlannerScenes(value: unknown): NonNullable<PlannerOutput["scenes"]> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((scene: unknown, index: number) => {
    if (!scene || typeof scene !== "object") {
      return {
        title: toPlannerOptionalText(scene) ?? `Scene ${index + 1}`,
      };
    }
    const record = scene as Record<string, unknown>;
    return {
      title: toPlannerOptionalText(record.title) ?? `Scene ${index + 1}`,
      objective: toPlannerOptionalText(record.objective) ?? undefined,
      conflict: toPlannerOptionalText(record.conflict) ?? undefined,
      reveal: toPlannerOptionalText(record.reveal) ?? undefined,
      emotionBeat: toPlannerOptionalText(record.emotionBeat) ?? undefined,
    };
  });
}

function normalizePlannerBoolean(value: unknown, fallback = false): boolean {
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
  return fallback;
}

function normalizePlannerHookKind(value: unknown): PlannerChapterMeta["kindOfHook"] {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
    if (
      normalized === "information_reversal"
      || normalized === "decision_reversal"
      || normalized === "threat_approaches"
      || normalized === "suspense_question"
    ) {
      return normalized;
    }
  }
  return "suspense_question";
}

function normalizePlannerChapterMeta(value: unknown): PlannerChapterMeta | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const rawWeight = Number(toPlannerOptionalText(record.eventWeight ?? record.event_weight) ?? 3);
  const eventWeight = Number.isFinite(rawWeight) ? Math.max(1, Math.min(5, Math.round(rawWeight))) : 3;
  return {
    eventWeight,
    highStakesDialogue: normalizePlannerBoolean(record.highStakesDialogue ?? record.high_stakes_dialogue, eventWeight >= 4),
    schemeBeat: normalizePlannerBoolean(record.schemeBeat ?? record.scheme_beat, false),
    kindOfHook: normalizePlannerHookKind(record.kindOfHook ?? record.kind_of_hook),
  };
}

export function normalizePlannerOutput(output: unknown): PlannerOutput {
  const record = output && typeof output === "object" ? output as Record<string, unknown> : {};
  return {
    title: toPlannerOptionalText(record.title) ?? undefined,
    objective: toPlannerOptionalText(record.objective) ?? undefined,
    participants: toPlannerStringArray(record.participants),
    reveals: toPlannerStringArray(record.reveals),
    riskNotes: toPlannerStringArray(record.riskNotes),
    hookTarget: toPlannerOptionalText(record.hookTarget) ?? undefined,
    planRole: typeof record.planRole === "string" ? record.planRole : undefined,
    phaseLabel: toPlannerOptionalText(record.phaseLabel) ?? undefined,
    mustAdvance: toPlannerStringArray(record.mustAdvance),
    mustPreserve: toPlannerStringArray(record.mustPreserve),
    chapterMeta: normalizePlannerChapterMeta(record.chapterMeta ?? record.chapter_meta),
    scenes: normalizePlannerScenes(record.scenes),
  };
}
