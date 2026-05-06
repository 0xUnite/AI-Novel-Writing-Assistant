import { z } from "zod";
import { MAX_VOLUME_CHAPTER_TARGET } from "../volume/volumeStructureBudget";

const nonEmptyString = z.string().trim().min(1);
const titleStyleSchema = z.enum(["literary", "conflict", "suspense", "high_concept"]);

const keywordArraySchema = z.union([
  z.array(nonEmptyString),
  nonEmptyString,
]).transform((value) => {
  const list = Array.isArray(value)
    ? value
    : value.split(/[,，、/|]/g).map((item) => item.trim()).filter(Boolean);
  return Array.from(new Set(list)).slice(0, 4);
}).pipe(z.array(nonEmptyString).min(2).max(4));

function splitAbsoluteRedLines(value: string): string[] {
  const withLineBreaks = value
    .replace(/\r\n?/g, "\n")
    .replace(/([。！？；;])\s*(?=(?:\d+|[一二三四五六七八九十]+)[.．、）)]\s*)/g, "$1\n")
    .replace(/(?:^|\n)\s*(?:\d+|[一二三四五六七八九十]+)[.．、）)]\s*/g, "\n");

  const lineItems = withLineBreaks
    .split(/\n+/g)
    .map((item) => item.trim())
    .filter(Boolean);

  if (lineItems.length >= 2) {
    return lineItems;
  }

  return value
    .split(/[；;|]/g)
    .map((item) => item.replace(/^\s*(?:\d+|[一二三四五六七八九十]+)[.．、）)]\s*/, "").trim())
    .filter(Boolean);
}

const absoluteRedLinesSchema = z.union([
  z.array(nonEmptyString),
  nonEmptyString,
]).transform((value) => {
  const list = Array.isArray(value)
    ? value
    : splitAbsoluteRedLines(value);
  return Array.from(new Set(list.map((item) => item.trim()).filter(Boolean))).slice(0, 6);
}).pipe(z.array(nonEmptyString).min(2).max(6));

export const directorCandidateSchema = z.object({
  workingTitle: nonEmptyString,
  titleOptions: z.array(z.object({
    title: nonEmptyString,
    clickRate: z.coerce.number().int().min(35).max(99),
    style: titleStyleSchema,
    angle: z.string().trim().max(20).nullable().optional(),
    reason: z.string().trim().max(72).nullable().optional(),
  })).max(4).optional().default([]),
  logline: nonEmptyString,
  positioning: nonEmptyString,
  sellingPoint: nonEmptyString,
  coreConflict: nonEmptyString,
  protagonistPath: nonEmptyString,
  endingDirection: nonEmptyString,
  hookStrategy: nonEmptyString,
  progressionLoop: nonEmptyString,
  whyItFits: nonEmptyString,
  toneKeywords: keywordArraySchema,
  targetChapterCount: z.coerce.number().int().min(1).max(MAX_VOLUME_CHAPTER_TARGET),
});

export const directorCandidateResponseSchema = z.object({
  candidates: z.array(directorCandidateSchema).length(2),
});

export const directorBookContractSchema = z.object({
  readingPromise: nonEmptyString,
  protagonistFantasy: nonEmptyString,
  coreSellingPoint: nonEmptyString,
  chapter3Payoff: nonEmptyString,
  chapter10Payoff: nonEmptyString,
  chapter30Payoff: nonEmptyString,
  escalationLadder: nonEmptyString,
  relationshipMainline: nonEmptyString,
  absoluteRedLines: absoluteRedLinesSchema,
});

export const directorPlanBlueprintSchema = z.object({
  bookPlan: z.object({
    title: nonEmptyString,
    objective: nonEmptyString,
    hookTarget: z.string().trim().optional().default(""),
    participants: z.array(nonEmptyString).max(8).default([]),
    reveals: z.array(nonEmptyString).max(8).default([]),
    riskNotes: z.array(nonEmptyString).max(8).default([]),
  }),
  arcs: z.array(z.object({
    title: nonEmptyString,
    objective: nonEmptyString,
    summary: nonEmptyString,
    phaseLabel: nonEmptyString,
    hookTarget: z.string().trim().optional().default(""),
    participants: z.array(nonEmptyString).max(8).default([]),
    reveals: z.array(nonEmptyString).max(8).default([]),
    riskNotes: z.array(nonEmptyString).max(8).default([]),
    chapters: z.array(z.object({
      title: nonEmptyString,
      objective: nonEmptyString,
      expectation: nonEmptyString,
      planRole: z.enum(["setup", "progress", "pressure", "turn", "payoff", "cooldown"]),
      hookTarget: z.string().trim().optional().default(""),
      participants: z.array(nonEmptyString).max(8).default([]),
      reveals: z.array(nonEmptyString).max(8).default([]),
      riskNotes: z.array(nonEmptyString).max(8).default([]),
      mustAdvance: z.array(nonEmptyString).max(8).default([]),
      mustPreserve: z.array(nonEmptyString).max(8).default([]),
      scenes: z.array(z.object({
        title: nonEmptyString,
        objective: nonEmptyString,
        conflict: z.string().trim().optional().default(""),
        reveal: z.string().trim().optional().default(""),
        emotionBeat: z.string().trim().optional().default(""),
      })).max(6).default([]),
    })).min(2).max(20),
  })).min(2).max(6),
});

export type DirectorCandidateResponse = z.infer<typeof directorCandidateResponseSchema>;
export type DirectorBookContractParsed = z.infer<typeof directorBookContractSchema>;
export type DirectorPlanBlueprintParsed = z.infer<typeof directorPlanBlueprintSchema>;
