import type { NovelContentForm } from "@ai-novel/shared/types/novel";

export const NOVEL_CONTENT_FORM_LABELS: Record<NovelContentForm, string> = {
  novel: "长篇小说",
  short_story: "短故事",
};

export function normalizeNovelContentForm(value: unknown): NovelContentForm {
  return value === "short_story" ? "short_story" : "novel";
}

export function getNovelContentBasePath(contentForm: NovelContentForm): string {
  return contentForm === "short_story" ? "/short-stories" : "/novels";
}

export function getNovelContentItemLabel(contentForm: NovelContentForm): string {
  return contentForm === "short_story" ? "短故事" : "小说";
}

export function decorateNovelTitleWithContentForm(input: {
  title: string;
  contentForm?: NovelContentForm | null;
}): string {
  const contentForm = normalizeNovelContentForm(input.contentForm);
  return `${input.title} [${NOVEL_CONTENT_FORM_LABELS[contentForm]}]`;
}
