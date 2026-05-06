import type { LLMProvider } from "@ai-novel/shared/types/llm";
import type { ChapterMeta } from "@ai-novel/shared/types/novel";
import { briefSummary, extractFacts } from "../novel/novelP0Utils";
import { runStructuredPrompt } from "../../prompting/core/promptRunner";
import { stateSnapshotPrompt } from "../../prompting/prompts/state/state.prompts";
import { buildProtectedCharacterIdentityBlock } from "../novel/worldbuildingWorldBible";
import {
  sanitizeMemoryList,
  sanitizeMemoryText,
  sanitizeStateText,
} from "../novel/chapterMemorySanitizer";

export interface StateServiceOptions {
  provider?: LLMProvider;
  model?: string;
  temperature?: number;
}

interface CharacterStateOutput {
  characterId?: string;
  characterName?: string;
  currentGoal?: string;
  emotion?: string;
  stressLevel?: number;
  secretExposure?: string;
  knownFacts?: string[];
  misbeliefs?: string[];
  summary?: string;
}

interface RelationStateOutput {
  sourceCharacterId?: string;
  sourceCharacterName?: string;
  targetCharacterId?: string;
  targetCharacterName?: string;
  trustScore?: number;
  intimacyScore?: number;
  conflictScore?: number;
  dependencyScore?: number;
  summary?: string;
}

interface InformationStateOutput {
  holderType?: string;
  holderRefId?: string;
  holderRefName?: string;
  fact?: string;
  status?: string;
  summary?: string;
}

interface ForeshadowStateOutput {
  title?: string;
  summary?: string;
  status?: string;
  setupChapterId?: string;
  payoffChapterId?: string;
}

export interface SnapshotExtractionOutput {
  summary?: string;
  chapter_meta?: Partial<{
    event_weight: number;
    high_stakes_dialogue: boolean;
    scheme_beat: boolean;
    kind_of_hook: ChapterMeta["kindOfHook"];
  }>;
  chapterMeta?: Partial<ChapterMeta>;
  characterStates?: CharacterStateOutput[];
  relationStates?: RelationStateOutput[];
  informationStates?: InformationStateOutput[];
  foreshadowStates?: ForeshadowStateOutput[];
}

export interface StateSnapshotExtractionInput {
  novelId: string;
  chapter: { id: string; title: string; order: number; expectation: string | null };
  content: string;
  characters: Array<{ id: string; name: string; currentGoal: string | null; currentState: string | null; role: string }>;
  summaryRow: { summary: string; keyEvents: string | null; characterStates: string | null; hook: string | null } | null;
  factRows: Array<{ category: string; content: string }>;
  timelineRows: Array<{ characterId: string; content: string }>;
  previousSnapshot: { summary?: string | null } | null;
  options: StateServiceOptions;
}

export async function extractSnapshotWithAI(input: StateSnapshotExtractionInput): Promise<SnapshotExtractionOutput> {
  const chapterFacts = buildFactsText(input);
  const timelineBlock = input.timelineRows
    .map((item) => {
      const character = input.characters.find((entry) => entry.id === item.characterId);
      return `${character?.name ?? item.characterId}: ${item.content}`;
    })
    .join("\n");
  const previousSummary = input.previousSnapshot?.summary
    ? `上一状态快照：${input.previousSnapshot.summary}`
    : "上一状态快照：无";
  try {
    const result = await runStructuredPrompt({
      asset: stateSnapshotPrompt,
      promptInput: {
        novelId: input.novelId,
        chapterOrder: input.chapter.order,
        chapterTitle: input.chapter.title,
        chapterGoal: input.chapter.expectation ?? "无",
        charactersText: input.characters.map((item) => `- ${item.id} | ${item.name} | ${item.role} | goal=${item.currentGoal ?? ""} | state=${item.currentState ?? ""}`).join("\n"),
        protectedIdentityText: buildProtectedCharacterIdentityBlock(input.novelId),
        summaryText: buildSummaryText(input.content, input.summaryRow?.summary),
        factsText: chapterFacts || "无",
        timelineText: timelineBlock || "无",
        previousSummary,
        content: input.content,
      },
      options: {
        provider: input.options.provider,
        model: input.options.model,
        temperature: input.options.temperature ?? 0.2,
      },
    });
    const parsed = result.output;
    return parsed as SnapshotExtractionOutput;
  } catch {
    return buildFallbackSnapshot(input);
  }
}

function buildSummaryText(content: string, summary: string | null | undefined): string {
  const storedSummary = summary?.trim() ?? "";
  const contentSummary = briefSummary(content).trim();
  if (storedSummary && contentSummary && storedSummary !== contentSummary) {
    return `章节摘要记录：${storedSummary}\n正文头尾校验：${contentSummary}`;
  }
  return storedSummary || contentSummary;
}

function buildFactsText(input: Pick<StateSnapshotExtractionInput, "content" | "factRows">): string {
  const rows = [
    ...input.factRows.map((item) => ({ category: item.category, content: item.content })),
    ...extractFacts(input.content),
  ];
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const content = row.content.trim();
    if (!content || seen.has(content)) {
      continue;
    }
    seen.add(content);
    lines.push(`${row.category}: ${content}`);
    if (lines.length >= 16) {
      break;
    }
  }
  return lines.join("\n");
}

function buildFallbackSnapshot(input: Pick<
  StateSnapshotExtractionInput,
  "chapter" | "content" | "characters" | "summaryRow" | "factRows" | "timelineRows"
>): SnapshotExtractionOutput {
  const summary = briefSummary(input.content) || input.summaryRow?.summary;
  const factMap = new Map<string, { category: string; content: string }>();
  for (const item of [...input.factRows, ...extractFacts(input.content)]) {
    const content = item.content.trim();
    if (content) {
      factMap.set(content, { category: item.category, content });
    }
  }
  const facts = [...factMap.values()];
  const characterStates = input.characters.map((character) => {
    const timeline = input.timelineRows.filter((item) => item.characterId === character.id).map((item) => item.content);
    const relevantFacts = facts.filter((item) => item.content.includes(character.name)).map((item) => item.content);
    return {
      characterId: character.id,
      currentGoal: character.currentGoal ?? undefined,
        emotion: sanitizeStateText(relevantFacts[0] ?? character.currentState ?? undefined) ?? undefined,
        stressLevel: relevantFacts.length > 0 ? 60 : 40,
        secretExposure: "unknown",
        knownFacts: sanitizeMemoryList(relevantFacts, { maxItems: 3, maxLength: 72 }),
        misbeliefs: [],
        summary: sanitizeMemoryText(
          [timeline[0], relevantFacts[0], character.currentState].filter(Boolean).join("；"),
          { maxLength: 90, preferStateLabel: true },
        ) || `${character.name}在第${input.chapter.order}章继续推进主线。`,
    };
  });
  const relationStates = input.characters.slice(0, 4).flatMap((source) => {
    return input.characters
      .filter((target) => target.id !== source.id && input.content.includes(source.name) && input.content.includes(target.name))
      .slice(0, 2)
      .map((target) => ({
        sourceCharacterId: source.id,
        targetCharacterId: target.id,
        trustScore: 50,
        intimacyScore: 40,
        conflictScore: 50,
        dependencyScore: 35,
        summary: `${source.name}与${target.name}在本章发生直接互动。`,
      }));
  });
  const informationStates = facts.slice(0, 6).map((item) => ({
    holderType: "reader",
    fact: sanitizeMemoryText(item.content, { maxLength: 90 }) ?? item.content.slice(0, 90),
    status: "known",
    summary: item.category,
  }));
  const foreshadowStates = input.summaryRow?.hook?.trim()
    ? [{
        title: input.summaryRow.hook,
        summary: input.summaryRow.hook,
        status: "setup",
      }]
    : [];
  return {
    summary,
    chapter_meta: {
      event_weight: 3,
      high_stakes_dialogue: relationStates.length > 0,
      scheme_beat: false,
      kind_of_hook: "suspense_question",
    },
    characterStates,
    relationStates,
    informationStates,
    foreshadowStates,
  };
}
