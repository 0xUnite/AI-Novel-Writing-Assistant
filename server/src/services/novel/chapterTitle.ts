function normalizeText(input: string | null | undefined): string {
  return (input ?? "").replace(/\r\n?/g, "\n").trim();
}

function normalizeTitle(input: string | null | undefined): string {
  return normalizeText(input).replace(/\s+/g, " ").trim();
}

const WORKFLOW_TITLE_LABELS = [
  "开卷抓手",
  "第一信号",
  "中段转向",
  "压力锁定",
  "高压挤压",
  "卷高潮",
  "卷尾钩子",
  "当前节奏",
];

const workflowTitleLabelSource = WORKFLOW_TITLE_LABELS.join("|");
const workflowTitleLabelPrefixPattern = new RegExp(
  `^(?:承接)?[「“"']?(${workflowTitleLabelSource})(?:[：:]\\s*|[」”"']?\\s+)(.+)$`,
  "u",
);
const workflowTitleLabelOnlyPattern = new RegExp(`^(${workflowTitleLabelSource})(?:[：:\\s]|$)`, "u");
const workflowQuotedTitlePattern = new RegExp(
  `(?:承接)?[「“"'](${workflowTitleLabelSource})[：:]([^」”"'\n。！？；]+)[」”"']`,
  "u",
);

function stripWorkflowTitleLabelPrefix(title: string): string {
  const normalized = normalizeTitle(title);
  const match = normalized.match(workflowTitleLabelPrefixPattern);
  if (!match) {
    return normalized;
  }

  const suffix = normalizeTitle(
    match[2]
      .replace(/[」”"'].*$/u, "")
      .replace(/^[:：\s]+/u, ""),
  );
  return suffix || normalized;
}

function hasWorkflowTitleLabel(title: string): boolean {
  const normalized = normalizeTitle(title);
  return workflowTitleLabelOnlyPattern.test(normalized) || /^当前节奏/u.test(normalized);
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
  return match ? normalizeTitle(match[1]) : null;
}

function stripChapterOrderPrefix(title: string, order: number): string {
  const normalized = normalizeTitle(title);
  if (!normalized) {
    return "";
  }

  const match = normalized.match(/^第\s*(\d+)\s*章(?:\s*[:：\-—]\s*|\s+)?(.*)$/);
  if (!match) {
    return normalized;
  }

  if (Number(match[1]) !== order) {
    return normalized;
  }

  const suffix = normalizeTitle(match[2]);
  return suffix || `第${order}章`;
}

function isPlaceholderText(value: string): boolean {
  return /^(string|title|chapter\s*title|untitled|null|undefined|n\/a|none|todo)$/i.test(value.trim());
}

function isGenericChapterTitle(title: string, order: number): boolean {
  if (!title || isPlaceholderText(title) || hasWorkflowTitleLabel(title)) {
    return true;
  }

  if (new RegExp(`^第\\s*${order}\\s*章$`).test(title)) {
    return true;
  }

  return /^(第\s*\d+\s*章|new chapter\s*\d+|chapter\s*\d+)$/i.test(title);
}

function deriveTitleFromText(text: string | null | undefined): string {
  const normalized = normalizeText(text);
  if (!normalized) {
    return "";
  }

  const quotedWorkflowTitle = normalized.match(workflowQuotedTitlePattern);
  if (quotedWorkflowTitle?.[2]) {
    const unwrappedTitle = stripWorkflowTitleLabelPrefix(quotedWorkflowTitle[2]);
    if (unwrappedTitle && !hasWorkflowTitleLabel(unwrappedTitle)) {
      return unwrappedTitle.slice(0, 18).trim();
    }
  }

  const segments = normalized
    .split(/[\n。！？；]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .flatMap((item) => item.split(/[，、：]/).map((segment) => segment.trim()))
    .map((item) => item.replace(/^[#*`"'“”‘’\-—:：\s]+|[#*`"'“”‘’\-—:：\s]+$/g, ""))
    .map((item) => stripWorkflowTitleLabelPrefix(item))
    .filter(Boolean)
    .filter((item) => !isPlaceholderText(item))
    .filter((item) => !hasWorkflowTitleLabel(item))
    .filter((item) => !/^(第\s*\d+\s*章|new chapter\s*\d+|chapter\s*\d+)$/i.test(item));

  const preferred = segments.find((segment) => segment.length >= 4 && segment.length <= 18);
  if (preferred) {
    return preferred;
  }

  const firstSegment = segments[0] ?? "";
  if (!firstSegment) {
    return "";
  }

  return firstSegment.slice(0, 18).trim();
}

export function ensureChapterTitle(input: {
  order: number;
  title?: string | null;
  content?: string | null;
  expectation?: string | null;
}): string {
  const normalizedTitle = stripWorkflowTitleLabelPrefix(stripChapterOrderPrefix(input.title ?? "", input.order));
  if (normalizedTitle && !isGenericChapterTitle(normalizedTitle, input.order)) {
    return normalizedTitle;
  }

  const contentHeading = extractLeadingMarkdownHeading(input.content);
  const normalizedContentHeading = contentHeading
    ? stripWorkflowTitleLabelPrefix(stripChapterOrderPrefix(contentHeading, input.order))
    : "";
  if (normalizedContentHeading && !isGenericChapterTitle(normalizedContentHeading, input.order)) {
    return normalizedContentHeading;
  }

  const derivedExpectationTitle = deriveTitleFromText(input.expectation);
  if (derivedExpectationTitle && !isGenericChapterTitle(derivedExpectationTitle, input.order)) {
    return derivedExpectationTitle;
  }

  const derivedContentTitle = deriveTitleFromText(input.content);
  if (derivedContentTitle && !isGenericChapterTitle(derivedContentTitle, input.order)) {
    return derivedContentTitle;
  }

  return `第${input.order}章`;
}
