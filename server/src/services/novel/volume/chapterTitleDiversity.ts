export type ChapterTitleSurfaceFrame =
  | "of_phrase"
  | "colon_split"
  | "comma_split"
  | "question_hook"
  | "plain_statement";

type ChapterTitleTemplateSkeleton =
  | "blood_wound"
  | "behind_secret"
  | "found_inside"
  | "trade_for"
  | "backlash_to"
  | "bite_through"
  | "speak_for"
  | "step_into_gate"
  | "bleed_for_pair"
  | "hidden_card";

const CHAPTER_TITLE_OF_PHRASE_PATTERN = /^[^，,：:？?的\s]{1,18}的[^，,：:？?的\s]{1,18}$/u;
const TEMPLATE_SKELETON_PATTERNS: Array<{ skeleton: ChapterTitleTemplateSkeleton; pattern: RegExp; label: string }> = [
  { skeleton: "blood_wound", pattern: /起血口/u, label: "“X起血口”" },
  { skeleton: "behind_secret", pattern: /背后的/u, label: "“X背后的Y”" },
  { skeleton: "found_inside", pattern: /里摸到/u, label: "“X里摸到Y”" },
  { skeleton: "trade_for", pattern: /^拿.{1,18}换.{1,18}$/u, label: "“拿X换Y”" },
  { skeleton: "backlash_to", pattern: /反噬到/u, label: "“X反噬到Y”" },
  { skeleton: "bite_through", pattern: /^借.{1,18}咬穿/u, label: "“借X咬穿Y”" },
  { skeleton: "speak_for", pattern: /替.{1,18}开口/u, label: "“X替Y开口”" },
  { skeleton: "step_into_gate", pattern: /^踏进.{1,24}门/u, label: "“踏进X门”" },
  { skeleton: "bleed_for_pair", pattern: /^为.{1,18}和.{1,18}见血/u, label: "“为X和Y见血”" },
  { skeleton: "hidden_card", pattern: /后面那张.{1,18}牌/u, label: "“X后面那张Y牌”" },
];

function normalizeChapterTitle(title: string): string {
  return title
    .replace(/^["'“”‘’《》〈〉「」『』【】]+|["'“”‘’《》〈〉「」『』【】]+$/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/,/g, "，")
    .replace(/:/g, "：")
    .replace(/\?/g, "？");
}

export function detectChapterTitleSurfaceFrame(title: string): ChapterTitleSurfaceFrame {
  const normalized = normalizeChapterTitle(title);
  if (!normalized) {
    return "plain_statement";
  }
  if (normalized.includes("：")) {
    return "colon_split";
  }
  if (normalized.includes("，")) {
    return "comma_split";
  }
  if (normalized.includes("？")) {
    return "question_hook";
  }
  if (CHAPTER_TITLE_OF_PHRASE_PATTERN.test(normalized)) {
    return "of_phrase";
  }
  return "plain_statement";
}

function maximumOfPhraseCount(titleCount: number): number {
  return Math.max(2, Math.ceil(Math.max(titleCount, 1) * 0.5));
}

function maximumSingleFrameCount(titleCount: number): number {
  return Math.max(2, Math.ceil(Math.max(titleCount, 1) * 0.5));
}

function formatFrameLabel(frame: ChapterTitleSurfaceFrame): string {
  if (frame === "of_phrase") {
    return "“X的Y / X中的Y”";
  }
  if (frame === "comma_split") {
    return "“A，B / 四字动作，四字结果”";
  }
  if (frame === "colon_split") {
    return "“A：B”";
  }
  if (frame === "question_hook") {
    return "“问题钩子型”";
  }
  return "“平铺直述型”";
}

function detectChapterTitleTemplateSkeleton(title: string): ChapterTitleTemplateSkeleton | null {
  const normalized = normalizeChapterTitle(title);
  for (const item of TEMPLATE_SKELETON_PATTERNS) {
    if (item.pattern.test(normalized)) {
      return item.skeleton;
    }
  }
  return null;
}

function formatTemplateSkeletonLabel(skeleton: ChapterTitleTemplateSkeleton): string {
  return TEMPLATE_SKELETON_PATTERNS.find((item) => item.skeleton === skeleton)?.label ?? "模板骨架";
}

function maximumTemplateSkeletonCount(titleCount: number): number {
  return Math.max(2, Math.ceil(Math.max(titleCount, 1) * 0.2));
}

function maximumMechanicalTemplateCount(titleCount: number): number {
  return Math.max(3, Math.ceil(Math.max(titleCount, 1) * 0.35));
}

export function getChapterTitleDiversityIssue(titles: string[]): string | null {
  const normalizedTitles = titles.map(normalizeChapterTitle).filter(Boolean);
  if (normalizedTitles.length <= 1) {
    return null;
  }

  const seenTitles = new Set<string>();
  const ofPhraseExamples: string[] = [];
  const frameCounts = new Map<ChapterTitleSurfaceFrame, number>();
  const frameExamples = new Map<ChapterTitleSurfaceFrame, string[]>();
  const templateCounts = new Map<ChapterTitleTemplateSkeleton, number>();
  const templateExamples = new Map<ChapterTitleTemplateSkeleton, string[]>();
  let previousFrame: ChapterTitleSurfaceFrame | null = null;
  let currentFrameClusterCount = 0;
  let maxFrameClusterCount = 0;
  let dominantClusterFrame: ChapterTitleSurfaceFrame | null = null;
  let mechanicalTemplateCount = 0;

  for (const title of normalizedTitles) {
    if (seenTitles.has(title)) {
      return `章节标题出现重复：${title}。请确保每章标题唯一。`;
    }
    seenTitles.add(title);

    const frame = detectChapterTitleSurfaceFrame(title);
    const templateSkeleton = detectChapterTitleTemplateSkeleton(title);
    if (templateSkeleton) {
      mechanicalTemplateCount += 1;
      templateCounts.set(templateSkeleton, (templateCounts.get(templateSkeleton) ?? 0) + 1);
      const examples = templateExamples.get(templateSkeleton) ?? [];
      if (examples.length < 3) {
        examples.push(title);
        templateExamples.set(templateSkeleton, examples);
      }
    }
    frameCounts.set(frame, (frameCounts.get(frame) ?? 0) + 1);
    const examples = frameExamples.get(frame) ?? [];
    if (examples.length < 3) {
      examples.push(title);
      frameExamples.set(frame, examples);
    }

    if (frame === "of_phrase") {
      if (ofPhraseExamples.length < 3) {
        ofPhraseExamples.push(title);
      }
    }

    if (frame === previousFrame) {
      currentFrameClusterCount += 1;
    } else {
      currentFrameClusterCount = 1;
      previousFrame = frame;
    }
    if (currentFrameClusterCount > maxFrameClusterCount) {
      maxFrameClusterCount = currentFrameClusterCount;
      dominantClusterFrame = frame;
    }
  }

  const ofPhraseCount = frameCounts.get("of_phrase") ?? 0;
  const maxAllowedOfPhraseCount = maximumOfPhraseCount(normalizedTitles.length);
  if (ofPhraseCount > maxAllowedOfPhraseCount) {
    return [
      `章节标题结构过于集中：${ofPhraseCount}/${normalizedTitles.length} 个标题使用了“X的Y / X中的Y”式结构。`,
      ofPhraseExamples.length > 0 ? `重复骨架示例：${ofPhraseExamples.join("、")}。` : "",
      "请降低这类标题占比，改用动作推进型、冲突压迫型、异常发现型、结果兑现型等不同章名。",
    ].filter(Boolean).join("");
  }

  const maxAllowedMechanicalCount = maximumMechanicalTemplateCount(normalizedTitles.length);
  if (mechanicalTemplateCount > maxAllowedMechanicalCount) {
    const examples = Array.from(templateExamples.values()).flat().slice(0, 4);
    return [
      `章节标题模板味过重：${mechanicalTemplateCount}/${normalizedTitles.length} 个标题命中了机械标题骨架。`,
      examples.length > 0 ? `模板示例：${examples.join("、")}。` : "",
      "请改成从具体行动、局面变化、人物选择、阶段兑现自然长出来的章名，不要套“起血口/背后的/里摸到/拿X换Y/反噬到/借X咬穿”等固定模板。",
    ].filter(Boolean).join("");
  }

  const maxAllowedTemplateSkeletonCount = maximumTemplateSkeletonCount(normalizedTitles.length);
  for (const [skeleton, count] of templateCounts.entries()) {
    if (count > maxAllowedTemplateSkeletonCount) {
      const examples = templateExamples.get(skeleton) ?? [];
      return [
        `章节标题内部骨架过于重复：${count}/${normalizedTitles.length} 个标题使用了 ${formatTemplateSkeletonLabel(skeleton)} 模板。`,
        examples.length > 0 ? `重复骨架示例：${examples.join("、")}。` : "",
        "请重写这批章名，降低固定动词和固定结尾词的复用。",
      ].filter(Boolean).join("");
    }
  }

  let dominantFrame: ChapterTitleSurfaceFrame = "plain_statement";
  let dominantFrameCount = 0;
  for (const [frame, count] of frameCounts.entries()) {
    if (count > dominantFrameCount) {
      dominantFrame = frame;
      dominantFrameCount = count;
    }
  }

  const maxAllowedSingleFrameCount = maximumSingleFrameCount(normalizedTitles.length);
  if (dominantFrame !== "plain_statement" && dominantFrameCount > maxAllowedSingleFrameCount) {
    const examples = frameExamples.get(dominantFrame) ?? [];
    return [
      `章节标题结构过于集中：${dominantFrameCount}/${normalizedTitles.length} 个标题都落在 ${formatFrameLabel(dominantFrame)} 骨架上。`,
      examples.length > 0 ? `重复骨架示例：${examples.join("、")}。` : "",
      "请把标题改得更分散，混用动作推进型、冲突压迫型、异常发现型、结果兑现型、决断转向型等不同句法。",
    ].filter(Boolean).join("");
  }

  if (maxFrameClusterCount > 3 && dominantClusterFrame && dominantClusterFrame !== "plain_statement") {
    return `相邻章节标题结构过于重复：连续 ${maxFrameClusterCount} 个标题都在使用 ${formatFrameLabel(dominantClusterFrame)} 骨架。请把相邻章名改成不同句法。`;
  }

  return null;
}

export function assertChapterTitleDiversity(titles: string[]): void {
  const issue = getChapterTitleDiversityIssue(titles);
  if (issue) {
    throw new Error(issue);
  }
}
