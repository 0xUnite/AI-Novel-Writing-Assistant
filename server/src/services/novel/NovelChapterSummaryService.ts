import type { LLMProvider } from "@ai-novel/shared/types/llm";
import { prisma } from "../../db/prisma";
import { ragServices } from "../rag";
import type { RagOwnerType } from "../rag/types";
import { runStructuredPrompt } from "../../prompting/core/promptRunner";
import { chapterSummaryPrompt } from "../../prompting/prompts/novel/review.prompts";
import {
  buildCharacterStateDigest,
  buildKeyEventDigest,
  sanitizeMemoryText,
} from "./chapterMemorySanitizer";

interface LLMGenerateOptions {
  provider?: LLMProvider;
  model?: string;
  temperature?: number;
}

type FactCategory = "plot" | "character" | "world";

const CHAPTER_SUMMARY_SOURCE_LIMIT = 7000;
const CHAPTER_SUMMARY_HEAD_LIMIT = 2600;
const CHAPTER_SUMMARY_TAIL_LIMIT = 3900;

function normalizeSummary(text: string): string {
  return sanitizeMemoryText(text.replace(/\s+/g, " ").trim(), { maxLength: 180 }) ?? "";
}

export function buildChapterSummarySource(content: string): string {
  const text = content.trim();
  if (text.length <= CHAPTER_SUMMARY_SOURCE_LIMIT) {
    return text;
  }

  return [
    "【章节开头节选】",
    text.slice(0, CHAPTER_SUMMARY_HEAD_LIMIT).trim(),
    "",
    "【章节结尾节选，必须优先捕捉本章最终状态】",
    text.slice(-CHAPTER_SUMMARY_TAIL_LIMIT).trim(),
  ].join("\n");
}

function pickBalancedItems(items: string[], maxItems: number): string[] {
  if (items.length <= maxItems) {
    return items;
  }

  const headCount = Math.max(1, Math.floor(maxItems / 3));
  const tailCount = maxItems - headCount;
  const picked = [...items.slice(0, headCount), ...items.slice(-tailCount)];
  return Array.from(new Set(picked)).slice(0, maxItems);
}

function extractFacts(content: string): Array<{ category: FactCategory; content: string }> {
  const lines = content
    .split(/[\n。！？]/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 8);

  const continuityLines = lines.length <= 8
    ? lines
    : Array.from(new Set([
      lines[Math.floor(lines.length / 2)],
      ...lines.slice(-7),
    ].filter((item): item is string => Boolean(item))));

  return pickBalancedItems(continuityLines, 8).map((line) => {
    if (/世界|地理|宗门|王朝|大陆|规则/.test(line)) {
      return { category: "world" as const, content: line };
    }
    if (/主角|反派|角色|他|她|众人/.test(line)) {
      return { category: "character" as const, content: line };
    }
    return { category: "plot" as const, content: line };
  });
}

function fallbackSummary(content: string): string {
  const sentences = content
    .split(/(?<=[。！？])/g)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (sentences.length === 0) {
    return content.slice(0, 180);
  }
  return pickBalancedItems(sentences, 5).join("").slice(0, 260);
}

function joinFacts(items: string[], max = 3): string {
  const uniqueItems = Array.from(new Set(items));
  return pickBalancedItems(uniqueItems, max).join("；");
}

export class NovelChapterSummaryService {
  async generateChapterSummary(novelId: string, chapterId: string, options: LLMGenerateOptions = {}) {
    const chapter = await prisma.chapter.findFirst({
      where: { id: chapterId, novelId },
      include: { novel: { select: { title: true } } },
    });
    if (!chapter) {
      throw new Error("章节不存在。");
    }

    const content = (chapter.content ?? "").trim();
    const existingExpectation = (chapter.expectation ?? "").trim();
    let summary = "";

    if (content) {
      try {
        const result = await runStructuredPrompt({
          asset: chapterSummaryPrompt,
          promptInput: {
            novelTitle: chapter.novel.title,
            chapterOrder: chapter.order,
            chapterTitle: chapter.title,
            content: buildChapterSummarySource(content),
          },
          options: {
            provider: options.provider,
            model: options.model,
            temperature: options.temperature ?? 0.3,
          },
        });
        const parsed = result.output;
        summary = normalizeSummary(parsed.summary ?? "");
      } catch {
        summary = "";
      }
    }

    if (!summary) {
      if (content) {
        summary = normalizeSummary(fallbackSummary(content));
      } else if (existingExpectation) {
        summary = existingExpectation;
      } else {
        summary = "暂无可总结正文";
      }
    }

    const facts = extractFacts(content || summary);
    const keyEvents = buildKeyEventDigest(facts) || joinFacts(facts.filter((item) => item.category === "plot").map((item) => item.content), 3);
    const characterStates = buildCharacterStateDigest(facts) || joinFacts(facts.filter((item) => item.category === "character").map((item) => item.content), 3);

    await prisma.$transaction(async (tx) => {
      await tx.chapter.update({
        where: { id: chapterId },
        data: { expectation: summary },
      });
      await tx.chapterSummary.upsert({
        where: { chapterId },
        update: {
          summary,
          keyEvents: keyEvents || null,
          characterStates: characterStates || null,
        },
        create: {
          novelId,
          chapterId,
          summary,
          keyEvents: keyEvents || null,
          characterStates: characterStates || null,
        },
      });
    });

    this.queueRagUpsert("chapter", chapterId);
    this.queueRagUpsert("chapter_summary", chapterId);

    return {
      chapterId,
      summary,
      expectation: summary,
    };
  }

  private queueRagUpsert(ownerType: RagOwnerType, ownerId: string): void {
    void ragServices.ragIndexService.enqueueUpsert(ownerType, ownerId).catch(() => {
      // Keep summary generation resilient when RAG queueing fails.
    });
  }
}
