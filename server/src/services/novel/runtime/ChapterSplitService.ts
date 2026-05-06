export interface ChapterSplitPlanInput {
  content?: string | null;
  actualLength?: number | null;
}

export interface ChapterSplitPoint {
  afterParagraph: number;
  anchor: string;
  reason: "scene-shift" | "time-shift" | "emotional-turn";
}

export interface ChapterSplitPlan {
  shouldSplit: boolean;
  partCount: number;
  mode: "no-split" | "split" | "compress-then-split";
  reason: string;
  splitPoints: ChapterSplitPoint[];
}

const TIME_SHIFT_REGEX = /(次日|翌日|第二天|随后|接着|十分钟后|半小时后|一小时后|当天晚上|清晨|凌晨|早上|上午|中午|下午|傍晚|晚上|深夜)/;
const SCENE_SHIFT_REGEX = /(来到|回到|离开|走进|进入|赶到|到了|回宿舍|回病房|到了门口|出了门)/;
const EMOTIONAL_TURN_REGEX = /(他忽然意识到|她忽然意识到|心里一沉|松了口气|怒火一下窜起来|终于明白|情绪一下绷紧|心口发紧|沉默了几秒)/;
const AVOID_SPLIT_REGEX = /(拳|刀|枪|搏|厮打|谈判|讨价|对峙|爆炸|决战|绝杀|巅峰|高潮|最后一击|勒住|掐住|逼问)/;

function normalizeText(value: string | null | undefined): string {
  return String(value ?? "").replace(/\r\n/g, "\n").trim();
}

function splitParagraphs(value: string): string[] {
  const paragraphs = normalizeText(value)
    .split(/\n{2,}/g)
    .map((item) => item.trim())
    .filter(Boolean);
  if (paragraphs.length > 1) {
    return paragraphs;
  }
  return normalizeText(value)
    .split(/(?<=[。！？])/g)
    .map((item) => item.trim())
    .filter(Boolean)
    .reduce<string[]>((items, sentence, index) => {
      const bucket = Math.floor(index / 2);
      items[bucket] = items[bucket] ? `${items[bucket]}${sentence}` : sentence;
      return items;
    }, []);
}

function resolveLength(input: ChapterSplitPlanInput): number {
  if (typeof input.actualLength === "number" && Number.isFinite(input.actualLength)) {
    return input.actualLength;
  }
  return normalizeText(input.content).length;
}

function desiredPartCount(length: number): { partCount: number; mode: ChapterSplitPlan["mode"]; reason: string } {
  if (length < 6000) {
    return {
      partCount: 1,
      mode: "no-split",
      reason: "正文长度低于 6000，无需拆分。",
    };
  }
  if (length <= 8000) {
    return {
      partCount: 2,
      mode: "split",
      reason: "正文长度位于 6000-8000，建议拆成 2 段。",
    };
  }
  if (length <= 12000) {
    return {
      partCount: 3,
      mode: "split",
      reason: "正文长度位于 8000-12000，建议拆成 3 段。",
    };
  }
  return {
    partCount: 3,
    mode: "compress-then-split",
    reason: "正文长度超过 12000，先压缩冗余，再按 3 段拆分。",
  };
}

function scoreParagraphBoundary(paragraph: string): { score: number; reason: ChapterSplitPoint["reason"] | null } {
  if (TIME_SHIFT_REGEX.test(paragraph)) {
    return { score: 3, reason: "time-shift" };
  }
  if (SCENE_SHIFT_REGEX.test(paragraph)) {
    return { score: 2, reason: "scene-shift" };
  }
  if (EMOTIONAL_TURN_REGEX.test(paragraph)) {
    return { score: 1, reason: "emotional-turn" };
  }
  return { score: 0, reason: null };
}

export function createSplitPlan(input: ChapterSplitPlanInput): ChapterSplitPlan {
  const length = resolveLength(input);
  const target = desiredPartCount(length);
  if (target.partCount === 1) {
    return {
      shouldSplit: false,
      partCount: 1,
      mode: "no-split",
      reason: target.reason,
      splitPoints: [],
    };
  }

  const paragraphs = splitParagraphs(input.content ?? "");
  if (paragraphs.length <= 1) {
    return {
      shouldSplit: true,
      partCount: target.partCount,
      mode: target.mode,
      reason: target.reason,
      splitPoints: [],
    };
  }

  const candidates = paragraphs
    .map((paragraph, index) => ({
      index,
      paragraph,
      nextParagraph: paragraphs[index + 1] ?? "",
      ...scoreParagraphBoundary(paragraph),
    }))
    .filter((candidate) => (
      candidate.index > 0
      && candidate.index < paragraphs.length - 1
      && candidate.reason
      && !AVOID_SPLIT_REGEX.test(candidate.paragraph)
      && !AVOID_SPLIT_REGEX.test(candidate.nextParagraph)
    ));

  const picks: ChapterSplitPoint[] = [];
  for (let segmentIndex = 1; segmentIndex < target.partCount; segmentIndex += 1) {
    const idealIndex = Math.round((paragraphs.length / target.partCount) * segmentIndex);
    const bestCandidate = candidates
      .filter((candidate) => !picks.some((pick) => pick.afterParagraph === candidate.index + 1))
      .sort((left, right) => {
        if (left.score !== right.score) {
          return right.score - left.score;
        }
        return Math.abs(left.index - idealIndex) - Math.abs(right.index - idealIndex);
      })[0];
    if (!bestCandidate || !bestCandidate.reason) {
      continue;
    }
    picks.push({
      afterParagraph: bestCandidate.index + 1,
      anchor: bestCandidate.paragraph.slice(0, 48),
      reason: bestCandidate.reason,
    });
  }

  return {
    shouldSplit: true,
    partCount: target.partCount,
    mode: target.mode,
    reason: target.reason,
    splitPoints: picks.sort((left, right) => left.afterParagraph - right.afterParagraph),
  };
}

export const chapterSplitService = {
  createSplitPlan,
};
