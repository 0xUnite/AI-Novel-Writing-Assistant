import type { Chapter } from "@ai-novel/shared/types/novel";

type ChapterExportSource = Pick<Chapter, "order" | "title" | "content">;

function normalizeText(input: string | null | undefined): string {
  return (input ?? "").replace(/\r\n?/g, "\n").trim();
}

function safeFileNamePart(input: string): string {
  const cleaned = input
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "chapter";
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

export function buildChapterHeading(chapter: ChapterExportSource): string {
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

export function getChapterPlainBody(chapter: ChapterExportSource): string {
  const chapterHeading = buildChapterHeading(chapter);
  return stripDuplicatedLeadingHeading(chapter.content, chapterHeading);
}

export function buildChapterTxtExport(
  chapter: ChapterExportSource,
  novelTitle?: string | null,
): { blob: Blob; fileName: string } {
  const chapterHeading = buildChapterHeading(chapter);
  const chapterBody = getChapterPlainBody(chapter) || "（本章暂无内容）";
  const fileStem = [normalizeText(novelTitle), chapterHeading]
    .filter((item) => item.length > 0)
    .map((item) => safeFileNamePart(item))
    .join("-");

  return {
    blob: new Blob([`${chapterHeading}\n\n${chapterBody}\n`], {
      type: "text/plain;charset=utf-8",
    }),
    fileName: `${fileStem || safeFileNamePart(chapterHeading)}.txt`,
  };
}

export function buildNovelPlainTextExport(
  chapters: ChapterExportSource[],
  novelTitle?: string | null,
): string {
  const title = normalizeText(novelTitle);
  const sortedChapters = [...chapters]
    .filter((chapter) => Boolean(chapter))
    .sort((left, right) => left.order - right.order);
  const parts: string[] = [];

  if (title) {
    parts.push(`《${title}》`);
  }

  for (const chapter of sortedChapters) {
    const chapterHeading = buildChapterHeading(chapter);
    const chapterBody = getChapterPlainBody(chapter) || "（本章暂无内容）";
    parts.push(`${chapterHeading}\n\n${chapterBody}`);
  }

  return `${parts.join("\n\n")}\n`;
}

export async function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) {
    throw new Error("浏览器不支持自动复制，请使用下载导出。");
  }
}

export function createDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
