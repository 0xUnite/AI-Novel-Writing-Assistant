import { prisma } from "../../db/prisma";
import { ensureChapterTitle } from "./chapterTitle";

interface ChapterWriteInput {
  title?: string;
  content?: string;
  order?: number;
}

export class ChapterService {
  async listChapters(novelId: string) {
    return prisma.chapter.findMany({
      where: { novelId },
      orderBy: { order: "asc" },
    });
  }

  async createChapter(novelId: string, input: Required<Pick<ChapterWriteInput, "title" | "order">> & ChapterWriteInput) {
    const chapterTitle = ensureChapterTitle({
      order: input.order,
      title: input.title,
      content: input.content ?? "",
    });
    return prisma.chapter.create({
      data: {
        novelId,
        title: chapterTitle,
        order: input.order,
        content: input.content ?? "",
      },
    });
  }

  async updateChapter(novelId: string, chapterId: string, input: ChapterWriteInput) {
    const exists = await prisma.chapter.findFirst({
      where: { id: chapterId, novelId },
      select: { id: true, title: true, order: true, content: true },
    });
    if (!exists) {
      throw new Error("章节不存在。");
    }
    const nextOrder = input.order ?? exists.order;
    const nextTitle = ensureChapterTitle({
      order: nextOrder,
      title: input.title ?? exists.title,
      content: input.content ?? exists.content,
    });
    return prisma.chapter.update({
      where: { id: chapterId },
      data: {
        ...input,
        title: nextTitle,
      },
    });
  }

  async deleteChapter(novelId: string, chapterId: string) {
    const deleted = await prisma.chapter.deleteMany({
      where: { id: chapterId, novelId },
    });
    if (deleted.count === 0) {
      throw new Error("章节不存在。");
    }
  }
}
