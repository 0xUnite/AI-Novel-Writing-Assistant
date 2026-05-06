import { novelEventBus } from "../../events";
import { prisma } from "../../db/prisma";
import { stateService } from "../state/StateService";
import { briefSummary, extractCharacterEventLines, extractFacts } from "./novelCoreShared";
import { queueRagUpsert } from "./novelCoreSupport";
import { sanitizeGeneratedChapterContent } from "./chapterContentSanitizer";
import {
  buildCharacterStateDigest,
  buildKeyEventDigest,
} from "./chapterMemorySanitizer";

export async function syncCharacterTimelineForChapter(novelId: string, chapterId: string, content: string) {
  const [chapter, characters] = await Promise.all([
    prisma.chapter.findFirst({
      where: { id: chapterId, novelId },
      select: { order: true, title: true },
    }),
    prisma.character.findMany({
      where: { novelId },
      select: { id: true, name: true },
    }),
  ]);

  if (!chapter || characters.length === 0) {
    return;
  }

  const events: Array<{
    novelId: string;
    characterId: string;
    chapterId: string;
    chapterOrder: number;
    title: string;
    content: string;
    source: string;
  }> = [];

  for (const character of characters) {
    const lines = extractCharacterEventLines(content, character.name, 3);
    for (const line of lines) {
      events.push({
        novelId,
        characterId: character.id,
        chapterId,
        chapterOrder: chapter.order,
        title: `${chapter.order} · ${chapter.title}`,
        content: line,
        source: "chapter_extract",
      });
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.characterTimeline.deleteMany({
      where: {
        novelId,
        chapterId,
        source: "chapter_extract",
      },
    });
    if (events.length > 0) {
      await tx.characterTimeline.createMany({ data: events });
    }
  });

  const timelines = await prisma.characterTimeline.findMany({
    where: {
      novelId,
      chapterId,
      source: "chapter_extract",
    },
    select: { id: true },
  });

  for (const timeline of timelines) {
    queueRagUpsert("character_timeline", timeline.id);
  }
}

export async function syncChapterArtifacts(novelId: string, chapterId: string, content: string) {
  const sanitizedContent = sanitizeGeneratedChapterContent(content);
  const facts = extractFacts(sanitizedContent);
  const summary = briefSummary(sanitizedContent, facts);

  await prisma.$transaction(async (tx) => {
      await tx.chapterSummary.upsert({
        where: { chapterId },
        update: {
          summary,
          keyEvents: buildKeyEventDigest(facts) || null,
          characterStates: buildCharacterStateDigest(facts) || null,
        },
        create: {
          novelId,
          chapterId,
          summary,
          keyEvents: buildKeyEventDigest(facts) || null,
          characterStates: buildCharacterStateDigest(facts) || null,
        },
      });

    await tx.consistencyFact.deleteMany({ where: { novelId, chapterId } });
    if (facts.length > 0) {
      await tx.consistencyFact.createMany({
        data: facts.map((item) => ({
          novelId,
          chapterId,
          category: item.category,
          content: item.content,
          source: "chapter_auto_extract",
        })),
      });
    }
  });

  await syncCharacterTimelineForChapter(novelId, chapterId, sanitizedContent);
  void stateService.syncChapterState(novelId, chapterId, sanitizedContent).catch(() => null);

  queueRagUpsert("chapter", chapterId);
  queueRagUpsert("chapter_summary", chapterId);
  queueRagUpsert("novel", novelId);

  const factRows = await prisma.consistencyFact.findMany({
    where: { novelId, chapterId },
    select: { id: true },
  });
  for (const fact of factRows) {
    queueRagUpsert("consistency_fact", fact.id);
  }

  const chapterRow = await prisma.chapter.findFirst({
    where: { id: chapterId, novelId },
    select: { order: true },
  });
  if (chapterRow) {
    void novelEventBus.emit({
      type: "chapter:drafted",
      payload: { novelId, chapterId, chapterOrder: chapterRow.order },
    }).catch(() => {});
  }
}
