import { prisma } from "../../db/prisma";
import { AppError } from "../../middleware/errorHandler";

type ExportFormat = "txt" | "markdown";

interface NovelChapterRecord {
  order: number;
  title: string;
  content: string | null;
}

interface NovelRecord {
  title: string;
  description: string | null;
  chapters: NovelChapterRecord[];
}

interface NovelExportResult {
  fileName: string;
  contentType: string;
  content: string;
}

function normalizeText(input: string | null | undefined): string {
  return (input ?? "").replace(/\r\n?/g, "\n").trim();
}

function safeFileNamePart(input: string): string {
  const cleaned = input
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "novel";
}

function normalizeChapterTitle(title: string | null | undefined): string {
  return normalizeText(title).replace(/\s+/g, " ").trim();
}

function extractLeadingMarkdownHeading(content: string | null | undefined): string | null {
  const normalizedContent = normalizeText(content);
  if (!normalizedContent) {
    return null;
  }

  const firstNonEmptyLine = normalizedContent
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  if (!firstNonEmptyLine) {
    return null;
  }

  const match = firstNonEmptyLine.match(/^#{1,6}\s+(.+?)\s*$/);
  return match ? normalizeChapterTitle(match[1]) : null;
}

function isGenericChapterTitle(title: string, order: number): boolean {
  if (!title) {
    return true;
  }

  if (new RegExp(`^第\\s*${order}\\s*章$`).test(title)) {
    return true;
  }

  return /^(第\s*\d+\s*章|new chapter\s*\d+|chapter\s*\d+)$/i.test(title);
}

function buildChapterHeading(chapter: NovelChapterRecord): string {
  const normalizedTitle = normalizeChapterTitle(chapter.title);
  const contentHeading = extractLeadingMarkdownHeading(chapter.content);

  if (contentHeading && (isGenericChapterTitle(normalizedTitle, chapter.order) || contentHeading.length > normalizedTitle.length)) {
    return contentHeading;
  }

  if (!normalizedTitle) {
    return `第${chapter.order}章`;
  }

  if (/^第\s*\d+\s*章(?:\s|[:：\-—]|$)/.test(normalizedTitle)) {
    return normalizedTitle;
  }

  return `第${chapter.order}章 ${normalizedTitle}`;
}

function stripDuplicatedLeadingHeading(content: string | null | undefined, heading: string): string {
  const normalizedContent = normalizeText(content);
  if (!normalizedContent) {
    return "";
  }

  const lines = normalizedContent.split("\n");
  let firstContentLineIndex = 0;
  while (firstContentLineIndex < lines.length && lines[firstContentLineIndex].trim().length === 0) {
    firstContentLineIndex += 1;
  }

  const firstContentLine = lines[firstContentLineIndex];
  const match = firstContentLine?.match(/^#{1,6}\s+(.+?)\s*$/);
  if (!match) {
    return normalizedContent;
  }

  const markdownHeading = normalizeChapterTitle(match[1]);
  const normalizedHeading = normalizeChapterTitle(heading);
  const markdownPrefix = markdownHeading.match(/^第\s*(\d+)\s*章/);
  const headingPrefix = normalizedHeading.match(/^第\s*(\d+)\s*章/);
  const sameChapterPrefix = Boolean(markdownPrefix && headingPrefix && markdownPrefix[1] === headingPrefix[1]);

  if (markdownHeading !== normalizedHeading && !sameChapterPrefix) {
    return normalizedContent;
  }

  let bodyStartIndex = firstContentLineIndex + 1;
  while (bodyStartIndex < lines.length && lines[bodyStartIndex].trim().length === 0) {
    bodyStartIndex += 1;
  }

  return lines.slice(bodyStartIndex).join("\n").trim();
}

function buildTxtContent(novel: NovelRecord): string {
  const lines: string[] = [];
  lines.push(`《${novel.title}》`);
  lines.push("");

  const description = normalizeText(novel.description);
  if (description) {
    lines.push("【简介】");
    lines.push(description);
    lines.push("");
  }

  if (novel.chapters.length === 0) {
    lines.push("（暂无章节内容）");
    return lines.join("\n");
  }

  for (const chapter of novel.chapters) {
    const chapterHeading = buildChapterHeading(chapter);
    lines.push("=".repeat(48));
    lines.push(chapterHeading);
    lines.push("-".repeat(48));
    lines.push(stripDuplicatedLeadingHeading(chapter.content, chapterHeading) || "（本章暂无内容）");
    lines.push("");
  }

  return lines.join("\n");
}

function buildMarkdownContent(novel: NovelRecord): string {
  const lines: string[] = [];
  lines.push(`# ${novel.title}`);
  lines.push("");

  const description = normalizeText(novel.description);
  if (description) {
    lines.push("## 简介");
    lines.push(description);
    lines.push("");
  }

  if (novel.chapters.length === 0) {
    lines.push("（暂无章节内容）");
    return lines.join("\n");
  }

  for (const chapter of novel.chapters) {
    const chapterHeading = buildChapterHeading(chapter);
    lines.push(`## ${chapterHeading}`);
    lines.push("");
    lines.push(stripDuplicatedLeadingHeading(chapter.content, chapterHeading) || "（本章暂无内容）");
    lines.push("");
  }

  return lines.join("\n");
}

export class NovelExportService {
  async buildExportContent(novelId: string, format: ExportFormat): Promise<NovelExportResult> {
    const novel = await prisma.novel.findUnique({
      where: { id: novelId },
      select: {
        title: true,
        description: true,
        chapters: {
          select: {
            order: true,
            title: true,
            content: true,
          },
          orderBy: {
            order: "asc",
          },
        },
      },
    });

    if (!novel) {
      throw new AppError("小说不存在。", 404);
    }

    const fileTitle = safeFileNamePart(novel.title);
    if (format === "markdown") {
      return {
        fileName: `${fileTitle}.md`,
        contentType: "text/markdown; charset=utf-8",
        content: buildMarkdownContent(novel),
      };
    }

    return {
      fileName: `${fileTitle}.txt`,
      contentType: "text/plain; charset=utf-8",
      content: buildTxtContent(novel),
    };
  }
}

export const novelExportService = new NovelExportService();
