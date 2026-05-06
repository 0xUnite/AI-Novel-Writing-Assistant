import fs from "node:fs";
import path from "node:path";
import type { RetrievedChunk } from "../rag/types";
import { computeChunkHash, normalizeRagText, splitRagChunks, toKeywordTerms } from "../rag/utils";

export const WORLDBUILDING_NOVEL_ID = "cmo4g0x8w0003938okwij1zvx";
export const WORLDBUILDING_WORLD_ID = "world_gaitian_huntian_xuanye";

export const WORLDBUILDING_DOCS_DIR = path.resolve(__dirname, "../../../../docs/worldbuilding");

export const WORLDBUILDING_BIBLE_FILES = [
  { fileName: "00_worldbuilding_master.md", title: "世界圣经总索引", priority: 100 },
  { fileName: "01_geography_and_factions.md", title: "地理与势力骨架", priority: 90 },
  { fileName: "02_cultivation_system.md", title: "修炼体系细节", priority: 90 },
  { fileName: "03_core_characters.md", title: "核心配角卡片", priority: 95 },
  { fileName: "04_foreshadowing_and_plan.md", title: "伏笔清单与 11-30 章规划", priority: 95 },
] as const;

const ANCHOR_TERMS = [
  "药谷",
  "药鼎宗",
  "季寒庐",
  "季家",
  "孟家",
  "周阿禾",
  "阿禾",
  "宁见微",
  "裴照庭",
  "闻人星阑",
  "星相仪",
  "玄铁",
  "天盖",
  "天痕",
  "灵枢",
  "命骨",
  "道业",
  "死人账",
  "矿沟",
  "废炉区",
  "地窖",
  "筑宫丹",
  "筑基丹",
];

export interface WorldbuildingBibleDocument {
  fileName: string;
  title: string;
  priority: number;
  content: string;
}

export interface ProtectedCharacterIdentity {
  characterName: string;
  trueIdentity: string;
  sourceFile: string;
  protected: true;
}

export const PROTECTED_CHARACTER_IDENTITIES: ProtectedCharacterIdentity[] = [
  {
    characterName: "周阿禾",
    trueIdentity: "药谷本地弱灵枢承压者；天痕压损灵枢在普通人身上的提前显影，不是星族血脉或转世者。",
    sourceFile: "03_core_characters.md",
    protected: true,
  },
  {
    characterName: "宁见微",
    trueIdentity: "黑市账路枢纽的低位掌柜，掌握税契、暗路、验货口和旧井货流，但不是黑市真正主人。",
    sourceFile: "03_core_characters.md",
    protected: true,
  },
  {
    characterName: "裴照庭",
    trueIdentity: "浑天星海裴系掌权者，正用闻人星阑、祖地坐标和星相仪补全更高层星族名分合法性。",
    sourceFile: "03_core_characters.md",
    protected: true,
  },
  {
    characterName: "闻人星阑",
    trueIdentity: "浑天星海没落远古星族传人，掌握通往内核祖地的旧坐标和能改变星海秩序的祖地钥匙。",
    sourceFile: "03_core_characters.md",
    protected: true,
  },
];

export function isWorldbuildingBibleTarget(input: { novelId?: string | null; worldId?: string | null }): boolean {
  return input.novelId === WORLDBUILDING_NOVEL_ID || input.worldId === WORLDBUILDING_WORLD_ID;
}

export function loadWorldbuildingBibleDocuments(): WorldbuildingBibleDocument[] {
  return WORLDBUILDING_BIBLE_FILES.flatMap((entry) => {
    const filePath = path.join(WORLDBUILDING_DOCS_DIR, entry.fileName);
    if (!fs.existsSync(filePath)) {
      return [];
    }
    const content = normalizeRagText(fs.readFileSync(filePath, "utf8"));
    if (!content) {
      return [];
    }
    return [{
      fileName: entry.fileName,
      title: entry.title,
      priority: entry.priority,
      content,
    }];
  });
}

function scoreChunk(query: string, terms: string[], chunkText: string, priority: number): number {
  const queryHitBonus = terms.reduce((score, term) => (
    chunkText.includes(term) ? score + 10 : score
  ), 0);
  const anchorBonus = ANCHOR_TERMS.reduce((score, term) => (
    query.includes(term) && chunkText.includes(term) ? score + 5 : score
  ), 0);
  return priority + queryHitBonus + anchorBonus;
}

function buildWorldbuildingChunks(query: string, options: {
  novelId?: string;
  worldId?: string;
  finalTopK: number;
}): RetrievedChunk[] {
  if (!isWorldbuildingBibleTarget(options)) {
    return [];
  }
  const documents = loadWorldbuildingBibleDocuments();
  if (documents.length === 0) {
    return [];
  }
  const terms = Array.from(new Set([
    ...toKeywordTerms(query),
    ...ANCHOR_TERMS.filter((term) => query.includes(term)),
  ]));
  const chunks = documents.flatMap((document) => {
    const pieces = splitRagChunks(document.content, 900, 120);
    return pieces.map((chunkText, index) => {
      const hash = computeChunkHash(`${document.fileName}:${index}:${chunkText}`).slice(0, 12);
      return {
        id: `worldbuilding:${document.fileName}:${index}:${hash}`,
        ownerType: "knowledge_document" as const,
        ownerId: `worldbuilding:${document.fileName}`,
        score: scoreChunk(query, terms, chunkText, document.priority),
        title: `世界圣经 / ${document.title}`,
        chunkText,
        chunkOrder: index,
        novelId: WORLDBUILDING_NOVEL_ID,
        worldId: WORLDBUILDING_WORLD_ID,
        metadataJson: JSON.stringify({
          source: "worldbuilding_bible",
          fileName: document.fileName,
          priority: document.priority,
        }),
        source: "keyword" as const,
      };
    });
  });
  return chunks
    .sort((left, right) => right.score - left.score || left.chunkOrder - right.chunkOrder)
    .slice(0, Math.max(1, Math.min(options.finalTopK, 4)));
}

export function retrieveWorldbuildingBibleChunks(query: string, options: {
  novelId?: string;
  worldId?: string;
  finalTopK?: number;
}): RetrievedChunk[] {
  const normalizedQuery = normalizeRagText(query);
  if (!normalizedQuery) {
    return [];
  }
  return buildWorldbuildingChunks(normalizedQuery, {
    novelId: options.novelId,
    worldId: options.worldId,
    finalTopK: options.finalTopK ?? 4,
  });
}

export function getProtectedCharacterIdentities(novelId?: string | null): ProtectedCharacterIdentity[] {
  if (novelId !== WORLDBUILDING_NOVEL_ID) {
    return [];
  }
  return PROTECTED_CHARACTER_IDENTITIES;
}

export function buildProtectedCharacterIdentityBlock(novelId?: string | null): string {
  const identities = getProtectedCharacterIdentities(novelId);
  if (identities.length === 0) {
    return "";
  }
  return [
    "受保护真实身份字段（禁止后续生成或状态提取临时改写）：",
    ...identities.map((item) => `- ${item.characterName}: ${item.trueIdentity}`),
  ].join("\n");
}
