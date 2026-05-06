import { prisma } from "../../db/prisma";
import { stringifyStringArray } from "../novel/novelP0Utils";
import { openConflictService } from "./OpenConflictService";
import {
  extractSnapshotWithAI,
  type SnapshotExtractionOutput,
  type StateServiceOptions,
} from "./stateSnapshotExtraction";
import { detectStateDiffConflicts } from "./stateConflictDetection";
import { normalizeChapterMeta, serializeChapterMetaForPrompt, toStoredChapterMeta } from "../novel/chapterMeta";
import {
  sanitizeMemoryList,
  sanitizeMemoryText,
  sanitizeStateText,
} from "../novel/chapterMemorySanitizer";
import {
  buildProtectedCharacterIdentityBlock,
  getProtectedCharacterIdentities,
} from "../novel/worldbuildingWorldBible";

function clampStateScore(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.min(100, Math.round(value)));
}

function normalizeStatus(value: unknown, fallback: string): string {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function normalizeChapterReference(
  value: unknown,
  chapterLookup: {
    byId: Set<string>;
    byOrder: Map<number, string>;
    byTitle: Map<string, string>;
  },
  fallback: string | null,
): string | null {
  const text = String(value ?? "").trim();
  if (!text) {
    return fallback;
  }
  if (chapterLookup.byId.has(text)) {
    return text;
  }
  const match = text.match(/^第\s*(\d+)\s*章$/);
  if (match) {
    return chapterLookup.byOrder.get(Number.parseInt(match[1] ?? "", 10)) ?? fallback;
  }
  const normalizedTitle = text.replace(/^《|》$/g, "");
  return chapterLookup.byTitle.get(normalizedTitle) ?? fallback;
}

function parseSnapshotChapterMeta(rawStateJson: string | null | undefined) {
  if (!rawStateJson?.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(rawStateJson) as Record<string, unknown>;
    return normalizeChapterMeta(parsed.chapter_meta ?? parsed.chapterMeta ?? parsed);
  } catch {
    return null;
  }
}

export class StateService {
  async getNovelState(novelId: string) {
    return this.getLatestSnapshot(novelId);
  }

  async getLatestSnapshot(novelId: string) {
    return prisma.storyStateSnapshot.findFirst({
      where: { novelId },
      include: {
        characterStates: true,
        relationStates: true,
        informationStates: true,
        foreshadowStates: true,
      },
      orderBy: { createdAt: "desc" },
    });
  }

  async getChapterSnapshot(novelId: string, chapterId: string) {
    return prisma.storyStateSnapshot.findFirst({
      where: { novelId, sourceChapterId: chapterId },
      include: {
        characterStates: true,
        relationStates: true,
        informationStates: true,
        foreshadowStates: true,
      },
    });
  }

  async getLatestSnapshotBeforeChapter(novelId: string, chapterOrder: number) {
    const snapshots = await prisma.storyStateSnapshot.findMany({
      where: { novelId },
      include: {
        sourceChapter: {
          select: {
            order: true,
          },
        },
        characterStates: true,
        relationStates: true,
        informationStates: true,
        foreshadowStates: true,
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return snapshots.find((item) => (item.sourceChapter?.order ?? Number.MAX_SAFE_INTEGER) < chapterOrder) ?? null;
  }

  async buildStateContextBlock(novelId: string, chapterOrder: number): Promise<string> {
    const protectedIdentityBlock = buildProtectedCharacterIdentityBlock(novelId);
    const snapshot = await this.getLatestSnapshotBeforeChapter(novelId, chapterOrder);
    if (!snapshot) {
      return protectedIdentityBlock;
    }
    const characterLines = snapshot.characterStates
      .map((item) => item.summary?.trim())
      .filter((item): item is string => Boolean(item))
      .slice(0, 4);
    const relationLines = snapshot.relationStates
      .map((item) => item.summary?.trim())
      .filter((item): item is string => Boolean(item))
      .slice(0, 3);
    const infoLines = snapshot.informationStates
      .map((item) => `${item.holderType}:${item.fact}`)
      .slice(0, 4);
    const foreshadowLines = snapshot.foreshadowStates
      .map((item) => `${item.title}(${item.status})`)
      .slice(0, 4);
    const chapterMeta = parseSnapshotChapterMeta(snapshot.rawStateJson);
    return [
      protectedIdentityBlock,
      `State snapshot summary: ${snapshot.summary ?? "暂无摘要"}`,
      chapterMeta ? `Chapter meta: ${serializeChapterMetaForPrompt(chapterMeta)}` : "",
      characterLines.length > 0 ? `Character states:\n- ${characterLines.join("\n- ")}` : "",
      relationLines.length > 0 ? `Relations:\n- ${relationLines.join("\n- ")}` : "",
      infoLines.length > 0 ? `Knowledge:\n- ${infoLines.join("\n- ")}` : "",
      foreshadowLines.length > 0 ? `Foreshadowing:\n- ${foreshadowLines.join("\n- ")}` : "",
    ].filter(Boolean).join("\n\n");
  }

  async syncChapterState(novelId: string, chapterId: string, content: string, options: StateServiceOptions = {}) {
    const [chapter, characters, summaryRow, factRows, timelineRows] = await Promise.all([
      prisma.chapter.findFirst({
        where: { id: chapterId, novelId },
        select: { id: true, title: true, order: true, expectation: true },
      }),
      prisma.character.findMany({
        where: { novelId },
        select: { id: true, name: true, currentGoal: true, currentState: true, role: true },
      }),
      prisma.chapterSummary.findUnique({
        where: { chapterId },
        select: { summary: true, keyEvents: true, characterStates: true, hook: true },
      }),
      prisma.consistencyFact.findMany({
        where: { novelId, chapterId },
        select: { category: true, content: true },
      }),
      prisma.characterTimeline.findMany({
        where: { novelId, chapterId, source: "chapter_extract" },
        select: { characterId: true, content: true },
      }),
    ]);
    if (!chapter) {
      throw new Error("章节不存在。");
    }
    const previousSnapshot = await this.getLatestSnapshotBeforeChapter(novelId, chapter.order);
    const extracted = await extractSnapshotWithAI({
      novelId,
      chapter,
      content,
      characters,
      summaryRow,
      factRows,
      timelineRows,
      previousSnapshot,
      options,
    });
    return this.persistSnapshot({
      novelId,
      chapterId,
      chapterOrder: chapter.order,
      characters,
      previousSnapshot,
      extracted,
    });
  }

  async rebuildState(novelId: string, options: StateServiceOptions = {}) {
    const chapters = await prisma.chapter.findMany({
      where: { novelId },
      select: { id: true, content: true, order: true },
      orderBy: { order: "asc" },
    });
    await prisma.storyStateSnapshot.deleteMany({ where: { novelId } });
    const rebuilt = [];
    for (const chapter of chapters) {
      if (!chapter.content?.trim()) {
        continue;
      }
      const snapshot = await this.syncChapterState(novelId, chapter.id, chapter.content, options);
      rebuilt.push(snapshot);
    }
    return rebuilt;
  }

  private async persistSnapshot(input: {
    novelId: string;
    chapterId: string;
    chapterOrder: number;
    characters: Array<{ id: string; name: string }>;
    previousSnapshot: Awaited<ReturnType<StateService["getLatestSnapshotBeforeChapter"]>>;
    extracted: SnapshotExtractionOutput;
  }) {
    const chapters = await prisma.chapter.findMany({
      where: { novelId: input.novelId },
      select: { id: true, order: true, title: true },
    });
    const chapterLookup = {
      byId: new Set(chapters.map((item) => item.id)),
      byOrder: new Map(chapters.map((item) => [item.order, item.id])),
      byTitle: new Map(chapters.map((item) => [item.title.trim(), item.id])),
    };
    const characterMap = new Map<string, string>();
    for (const character of input.characters) {
      characterMap.set(character.id, character.id);
      characterMap.set(character.name, character.id);
    }

    const normalizedCharacterStates = (input.extracted.characterStates ?? [])
      .map((item) => {
        const characterId = characterMap.get(item.characterId ?? "") ?? characterMap.get(item.characterName ?? "");
        if (!characterId) {
          return null;
        }
        return {
          characterId,
          currentGoal: sanitizeMemoryText(item.currentGoal, { maxLength: 72 }) || null,
          emotion: sanitizeStateText(item.emotion, 72) || null,
          stressLevel: clampStateScore(item.stressLevel),
          secretExposure: sanitizeMemoryText(item.secretExposure, { maxLength: 72 }) || null,
          knownFactsJson: stringifyStringArray(sanitizeMemoryList(item.knownFacts, { maxItems: 4, maxLength: 80 })),
          misbeliefsJson: stringifyStringArray(sanitizeMemoryList(item.misbeliefs, { maxItems: 3, maxLength: 80 })),
          summary: sanitizeMemoryText(item.summary, { maxLength: 96, preferStateLabel: true }) || null,
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item));

    const normalizedRelationStates = (input.extracted.relationStates ?? [])
      .map((item) => {
        const sourceCharacterId = characterMap.get(item.sourceCharacterId ?? "") ?? characterMap.get(item.sourceCharacterName ?? "");
        const targetCharacterId = characterMap.get(item.targetCharacterId ?? "") ?? characterMap.get(item.targetCharacterName ?? "");
        if (!sourceCharacterId || !targetCharacterId || sourceCharacterId === targetCharacterId) {
          return null;
        }
        return {
          sourceCharacterId,
          targetCharacterId,
          trustScore: clampStateScore(item.trustScore),
          intimacyScore: clampStateScore(item.intimacyScore),
          conflictScore: clampStateScore(item.conflictScore),
          dependencyScore: clampStateScore(item.dependencyScore),
          summary: sanitizeMemoryText(item.summary, { maxLength: 96 }) || null,
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item));

    const normalizedInformationStates = (input.extracted.informationStates ?? [])
      .map((item) => {
        const holderType = item.holderType === "character" ? "character" : "reader";
        const holderRefId = holderType === "character"
          ? characterMap.get(item.holderRefId ?? "") ?? characterMap.get(item.holderRefName ?? "")
          : null;
        if (!item.fact?.trim()) {
          return null;
        }
        return {
          holderType,
          holderRefId,
          fact: sanitizeMemoryText(item.fact, { maxLength: 120 }) ?? item.fact.trim().slice(0, 120),
          status: normalizeStatus(item.status, "known"),
          summary: sanitizeMemoryText(item.summary, { maxLength: 80 }) || null,
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
    const protectedInformationStates = getProtectedCharacterIdentities(input.novelId).map((item) => ({
      holderType: "reader",
      holderRefId: null,
      fact: `受保护真实身份｜${item.characterName}: ${item.trueIdentity}`,
      status: "known",
      summary: `protected_identity:${item.sourceFile}`,
    }));
    const protectedFactSet = new Set<string>();
    const allInformationStates = [...protectedInformationStates, ...normalizedInformationStates]
      .filter((item) => {
        if (protectedFactSet.has(item.fact)) {
          return false;
        }
        protectedFactSet.add(item.fact);
        return true;
      });

    const normalizedForeshadowStates = (input.extracted.foreshadowStates ?? [])
      .map((item) => {
        if (!item.title?.trim()) {
          return null;
        }
        return {
          title: sanitizeMemoryText(item.title, { maxLength: 80 }) ?? item.title.trim().slice(0, 80),
          summary: sanitizeMemoryText(item.summary, { maxLength: 120 }) || null,
          status: normalizeStatus(item.status, "setup"),
          setupChapterId: normalizeChapterReference(item.setupChapterId, chapterLookup, input.chapterId),
          payoffChapterId: normalizeChapterReference(item.payoffChapterId, chapterLookup, null),
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
    const normalizedChapterMeta = normalizeChapterMeta(input.extracted.chapter_meta ?? input.extracted.chapterMeta);

    const summary = sanitizeMemoryText(input.extracted.summary, { maxLength: 180 }) || `第${input.chapterOrder}章状态快照`;
    const rawStateJson = JSON.stringify({
      summary,
      chapter_meta: toStoredChapterMeta(normalizedChapterMeta),
      characterStates: normalizedCharacterStates,
      relationStates: normalizedRelationStates,
      informationStates: allInformationStates,
      foreshadowStates: normalizedForeshadowStates,
    });
    const existing = await prisma.storyStateSnapshot.findFirst({
      where: { novelId: input.novelId, sourceChapterId: input.chapterId },
      select: { id: true },
    });

    const snapshotId = await prisma.$transaction(async (tx) => {
      const snapshot = existing
        ? await tx.storyStateSnapshot.update({
            where: { id: existing.id },
            data: {
              summary,
              rawStateJson,
            },
            select: { id: true },
          })
        : await tx.storyStateSnapshot.create({
            data: {
              novelId: input.novelId,
              sourceChapterId: input.chapterId,
              summary,
              rawStateJson,
            },
            select: { id: true },
          });

      await Promise.all([
        tx.characterState.deleteMany({ where: { snapshotId: snapshot.id } }),
        tx.relationState.deleteMany({ where: { snapshotId: snapshot.id } }),
        tx.informationState.deleteMany({ where: { snapshotId: snapshot.id } }),
        tx.foreshadowState.deleteMany({ where: { snapshotId: snapshot.id } }),
      ]);

      if (normalizedCharacterStates.length > 0) {
        await tx.characterState.createMany({
          data: normalizedCharacterStates.map((item) => ({
            snapshotId: snapshot.id,
            ...item,
          })),
        });
      }
      if (normalizedRelationStates.length > 0) {
        await tx.relationState.createMany({
          data: normalizedRelationStates.map((item) => ({
            snapshotId: snapshot.id,
            ...item,
          })),
        });
      }
      if (allInformationStates.length > 0) {
        await tx.informationState.createMany({
          data: allInformationStates.map((item) => ({
            snapshotId: snapshot.id,
            ...item,
          })),
        });
      }
      if (normalizedForeshadowStates.length > 0) {
        await tx.foreshadowState.createMany({
          data: normalizedForeshadowStates.map((item) => ({
            snapshotId: snapshot.id,
            ...item,
          })),
        });
      }
      return snapshot.id;
    });

    const persistedSnapshot = await prisma.storyStateSnapshot.findUnique({
      where: { id: snapshotId },
      include: {
        characterStates: true,
        relationStates: true,
        informationStates: true,
        foreshadowStates: true,
      },
    });

    if (persistedSnapshot) {
      const detected = detectStateDiffConflicts({
        characters: input.characters,
        previousSnapshot: input.previousSnapshot,
        currentSnapshot: persistedSnapshot,
      });
      await openConflictService.syncFromStateDiff({
        novelId: input.novelId,
        chapterId: input.chapterId,
        chapterOrder: input.chapterOrder,
        sourceSnapshotId: persistedSnapshot.id,
        trackedConflictKeys: detected.trackedConflictKeys,
        conflicts: detected.conflicts,
      }).catch(() => null);
    }

    return persistedSnapshot;
  }
}

export const stateService = new StateService();
