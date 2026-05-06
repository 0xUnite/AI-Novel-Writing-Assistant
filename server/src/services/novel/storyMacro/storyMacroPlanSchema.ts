import type {
  StoryConflictLayers,
  StoryDecomposition,
  StoryExpansion,
  StoryMacroField,
  StoryMacroIssue,
  StoryMacroLocks,
  StoryMacroState,
} from "@ai-novel/shared/types/storyMacro";
import { z } from "zod";

const STORY_MACRO_FIELD_SET = new Set<string>([
  "expanded_premise",
  "protagonist_core",
  "conflict_engine",
  "conflict_layers",
  "mystery_box",
  "emotional_line",
  "setpiece_seeds",
  "tone_reference",
  "selling_point",
  "core_conflict",
  "main_hook",
  "progression_loop",
  "growth_path",
  "major_payoffs",
  "ending_flavor",
  "constraints",
  "global",
]);

export const STORY_MACRO_FIELDS = [
  "expanded_premise",
  "protagonist_core",
  "conflict_engine",
  "conflict_layers",
  "mystery_box",
  "emotional_line",
  "setpiece_seeds",
  "tone_reference",
  "selling_point",
  "core_conflict",
  "main_hook",
  "progression_loop",
  "growth_path",
  "major_payoffs",
  "ending_flavor",
  "constraints",
] as const satisfies StoryMacroField[];

export const EMPTY_STATE: StoryMacroState = {
  currentPhase: 0,
  progress: 0,
  protagonistState: "",
};

export const EMPTY_CONFLICT_LAYERS: StoryConflictLayers = {
  external: "",
  internal: "",
  relational: "",
};

export const EMPTY_EXPANSION: StoryExpansion = {
  expanded_premise: "",
  protagonist_core: "",
  conflict_engine: "",
  conflict_layers: EMPTY_CONFLICT_LAYERS,
  mystery_box: "",
  emotional_line: "",
  setpiece_seeds: [],
  tone_reference: "",
};

export const EMPTY_DECOMPOSITION: StoryDecomposition = {
  selling_point: "",
  core_conflict: "",
  main_hook: "",
  progression_loop: "",
  growth_path: "",
  major_payoffs: [],
  ending_flavor: "",
};

const boundedString = (maxLength: number) => z.string()
  .transform((value) => value.trim().slice(0, maxLength))
  .pipe(z.string().min(1).max(maxLength));

const conflictLayersSchema = z.object({
  external: boundedString(280),
  internal: boundedString(280),
  relational: boundedString(280),
});

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

function containsStoryMacroShape(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return [
    "expansion",
    "decomposition",
    "constraints",
    "storyEngine",
    "story_engine",
    "selling_point",
    "core_conflict",
    "main_hook",
    "progression_loop",
    "growth_path",
    "major_payoffs",
    "ending_flavor",
  ].some((key) => key in value);
}

function pickNestedStoryMacroPayload(record: Record<string, unknown>): Record<string, unknown> {
  const candidates = [
    record.data,
    record.result,
    record.output,
    record.payload,
    record.storyMacro,
    record.story_macro,
    record.storyEngine,
    record.story_engine,
  ];

  for (const candidate of candidates) {
    if (containsStoryMacroShape(candidate)) {
      return candidate as Record<string, unknown>;
    }
  }

  return record;
}

function pickFirstPresent(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) {
      return record[key];
    }
  }
  return undefined;
}

function normalizeIssuesForSchema(value: unknown): unknown {
  if (!value) {
    return [];
  }
  if (typeof value === "string") {
    const message = value.trim();
    return message ? [{ type: "missing_info", field: "global", message }] : [];
  }
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (typeof item === "string") {
        const message = item.trim();
        return message ? { type: "missing_info", field: "global", message } : null;
      }
      if (!isRecord(item)) {
        return null;
      }
      const type = normalizeText(pickFirstPresent(item, ["type", "issueType", "kind"])) || "missing_info";
      const field = normalizeText(pickFirstPresent(item, ["field", "path", "target"])) || "global";
      const message = normalizeText(pickFirstPresent(item, ["message", "detail", "reason", "summary"]));
      if (!message) {
        return null;
      }
      return { type, field, message };
    })
    .filter(Boolean)
    .slice(0, 8);
}

function normalizeStoryMacroResponsePayload(raw: unknown): unknown {
  if (!isRecord(raw)) {
    return raw;
  }

  const root = pickNestedStoryMacroPayload(raw);
  const expansionSource = pickFirstPresent(root, [
    "expansion",
    "storyEngine",
    "story_engine",
    "macroExpansion",
    "storyExpansion",
  ]);
  const decompositionSource = pickFirstPresent(root, [
    "decomposition",
    "decompose",
    "storyDecomposition",
    "story_decomposition",
    "decompositionPlan",
    "storyCore",
  ]);
  const constraintsSource = pickFirstPresent(root, [
    "constraints",
    "constraintEngine",
    "constraint_engine",
    "rules",
    "hardConstraints",
    "narrativeConstraints",
    "writingConstraints",
  ]);
  const issuesSource = pickFirstPresent(root, [
    "issues",
    "warnings",
    "issueList",
    "problems",
  ]);

  return {
    expansion: normalizeObjectAlias(expansionSource ?? root, {
      expanded_premise: ["expandedPremise", "premise", "expandedPremiseText"],
      protagonist_core: ["protagonistCore", "protagonist", "heroCore"],
      conflict_engine: ["conflictEngine", "engine", "coreEngine"],
      conflict_layers: ["conflictLayers", "pressureLayers", "layeredConflicts"],
      mystery_box: ["mysteryBox", "coreMystery"],
      emotional_line: ["emotionalLine", "emotionLine"],
      setpiece_seeds: ["setpieceSeeds", "setpieces", "sceneSeeds"],
      tone_reference: ["toneReference", "tone", "toneGuide"],
    }),
    decomposition: normalizeObjectAlias(decompositionSource ?? root, {
      selling_point: ["sellingPoint", "hookSellingPoint", "marketHook"],
      core_conflict: ["coreConflict", "mainConflict"],
      main_hook: ["mainHook", "hook"],
      progression_loop: ["progressionLoop", "storyLoop"],
      growth_path: ["growthPath", "arcPath", "protagonistGrowth"],
      major_payoffs: ["majorPayoffs", "payoffs", "keyPayoffs"],
      ending_flavor: ["endingFlavor", "endingTone", "endingVibe"],
    }),
    constraints: normalizeConstraints(constraintsSource),
    issues: normalizeIssuesForSchema(issuesSource),
  };
}

const storyMacroResponseCoreSchema = z.object({
  expansion: z.object({
    expanded_premise: boundedString(900),
    protagonist_core: boundedString(500),
    conflict_engine: boundedString(500),
    conflict_layers: conflictLayersSchema,
    mystery_box: boundedString(320),
    emotional_line: boundedString(400),
    setpiece_seeds: z.array(boundedString(260)).min(2).max(3),
    tone_reference: boundedString(320),
  }),
  decomposition: z.object({
    selling_point: boundedString(200),
    core_conflict: boundedString(320),
    main_hook: boundedString(320),
    progression_loop: boundedString(400),
    growth_path: boundedString(400),
    major_payoffs: z.array(boundedString(220)).min(2).max(5),
    ending_flavor: boundedString(220),
  }),
  constraints: z.array(boundedString(240)).min(2).max(8),
  issues: z.array(z.object({
    type: boundedString(40),
    field: boundedString(60),
    message: boundedString(300),
  })).max(8).default([]),
});

export const STORY_MACRO_RESPONSE_SCHEMA = z.preprocess(
  normalizeStoryMacroResponsePayload,
  storyMacroResponseCoreSchema,
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeStringArray(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean)
    .slice(0, maxItems);
}

function mergeUnique(items: string[], maxItems: number): string[] {
  return Array.from(new Set(items.map((item) => item.trim()).filter(Boolean))).slice(0, maxItems);
}

export function toText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (typeof item === "string") {
        return item;
      }
      if (item && typeof item === "object" && "text" in item && typeof item.text === "string") {
        return item.text;
      }
      return "";
    }).join("");
  }
  return JSON.stringify(content ?? "");
}

export function normalizeConflictLayers(value: unknown): StoryConflictLayers {
  if (isRecord(value)) {
    return {
      external: normalizeText(value.external),
      internal: normalizeText(value.internal),
      relational: normalizeText(value.relational),
    };
  }
  const legacy = normalizeStringArray(value, 3);
  return {
    external: legacy[0] ?? "",
    internal: legacy[1] ?? "",
    relational: legacy[2] ?? "",
  };
}

export function normalizeExpansion(
  value: (Partial<Omit<StoryExpansion, "conflict_layers">> & { conflict_layers?: unknown }) | null | undefined,
): StoryExpansion {
  const nextValue = value;
  return {
    expanded_premise: normalizeText(nextValue?.expanded_premise),
    protagonist_core: normalizeText(nextValue?.protagonist_core),
    conflict_engine: normalizeText(nextValue?.conflict_engine),
    conflict_layers: normalizeConflictLayers(nextValue?.conflict_layers),
    mystery_box: normalizeText(nextValue?.mystery_box),
    emotional_line: normalizeText(nextValue?.emotional_line),
    setpiece_seeds: normalizeStringArray(nextValue?.setpiece_seeds, 3),
    tone_reference: normalizeText(nextValue?.tone_reference),
  };
}

export function normalizeDecomposition(value: Partial<StoryDecomposition> | null | undefined): StoryDecomposition {
  return {
    selling_point: normalizeText(value?.selling_point),
    core_conflict: normalizeText(value?.core_conflict),
    main_hook: normalizeText(value?.main_hook),
    progression_loop: normalizeText(value?.progression_loop),
    growth_path: normalizeText(value?.growth_path),
    major_payoffs: normalizeStringArray(value?.major_payoffs, 5),
    ending_flavor: normalizeText(value?.ending_flavor),
  };
}

export function normalizeConstraints(value: unknown): string[] {
  if (Array.isArray(value)) {
    return mergeUnique(value.map((item) => (typeof item === "string" ? item : "")), 8);
  }
  if (isRecord(value)) {
    const forbidden = normalizeStringArray(value.forbidden, 4);
    const requiredTrends = normalizeStringArray(value.required_trends, 4);
    return mergeUnique([...requiredTrends, ...forbidden.map((item) => `避免：${item}`)], 8);
  }
  return [];
}

export function normalizeLockedFields(value: unknown): StoryMacroLocks {
  if (!isRecord(value)) {
    return {};
  }
  return STORY_MACRO_FIELDS.reduce<StoryMacroLocks>((acc, field) => {
    if (typeof value[field] === "boolean") {
      acc[field] = value[field] as boolean;
    }
    return acc;
  }, {});
}

export function hasMeaningfulExpansion(value: StoryExpansion | null | undefined): value is StoryExpansion {
  if (!value) {
    return false;
  }
  return Boolean(
    value.expanded_premise
    || value.protagonist_core
    || value.conflict_engine
    || value.conflict_layers.external
    || value.conflict_layers.internal
    || value.conflict_layers.relational
    || value.mystery_box
    || value.emotional_line
    || value.setpiece_seeds.length > 0
    || value.tone_reference,
  );
}

export function hasMeaningfulDecomposition(value: StoryDecomposition | null | undefined): value is StoryDecomposition {
  if (!value) {
    return false;
  }
  return Boolean(
    value.selling_point
    || value.core_conflict
    || value.main_hook
    || value.progression_loop
    || value.growth_path
    || value.major_payoffs.length > 0
    || value.ending_flavor,
  );
}

export function isDecompositionComplete(value: Partial<StoryDecomposition> | null | undefined): value is StoryDecomposition {
  return Boolean(
    value
    && typeof value.selling_point === "string"
    && value.selling_point.trim()
    && typeof value.core_conflict === "string"
    && value.core_conflict.trim()
    && typeof value.main_hook === "string"
    && value.main_hook.trim()
    && typeof value.progression_loop === "string"
    && value.progression_loop.trim()
    && typeof value.growth_path === "string"
    && value.growth_path.trim()
    && Array.isArray(value.major_payoffs)
    && value.major_payoffs.length > 0
    && value.major_payoffs.every((item) => typeof item === "string" && item.trim())
    && typeof value.ending_flavor === "string"
    && value.ending_flavor.trim(),
  );
}

export function normalizeIssues(value: Array<{ type: string; field: string; message: string }>): StoryMacroIssue[] {
  return value.slice(0, 8).map((item) => ({
    type: item.type === "conflict" ? "conflict" : "missing_info",
    field: STORY_MACRO_FIELD_SET.has(item.field) ? (item.field as StoryMacroIssue["field"]) : "global",
    message: item.message.trim(),
  }));
}
