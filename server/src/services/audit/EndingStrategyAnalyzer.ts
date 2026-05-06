const SENTENCE_SPLIT_REGEX = /(?<=[。！？!?])/g;
const ENDING_SIMILARITY_NGRAM = 4;

export type EndingType =
  | "suspense"
  | "decision"
  | "action-continuation"
  | "calm-close"
  | "emotional reflection";

export interface EndingStrategySample {
  chapterOrder?: number | null;
  content?: string | null;
  endingSentence?: string | null;
  endingType?: EndingType | null;
}

export interface EndingStrategyAnalysis {
  endingSentence: string;
  endingType: EndingType;
  repeatedPhraseRisk: boolean;
  repeatedFunctionRisk: boolean;
  needsRewrite: boolean;
  matchedBannedPhrase: string | null;
  maxSimilarity: number;
  recentEndingTypes: EndingType[];
}

export const BANNED_ENDING_PATTERNS = [
  /这只是开始/,
  /才刚刚开始/,
  /转折来了/,
  /即将/,
] as const;

function normalizeText(value: string | null | undefined): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function splitSentences(value: string): string[] {
  return normalizeText(value)
    .split(SENTENCE_SPLIT_REGEX)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeForSimilarity(value: string): string {
  return normalizeText(value)
    .replace(/[，。！？；：、“”‘’（）《》【】\[\]\(\)!?,.:;'"`~\-_/\\|@#$%^&*+=<>]/g, "")
    .replace(/\s+/g, "");
}

function buildNGramSet(source: string, n = ENDING_SIMILARITY_NGRAM): Set<string> {
  const normalized = normalizeForSimilarity(source);
  if (!normalized) {
    return new Set<string>();
  }
  if (normalized.length <= n) {
    return new Set<string>([normalized]);
  }
  const grams = new Set<string>();
  for (let index = 0; index <= normalized.length - n; index += 1) {
    grams.add(normalized.slice(index, index + n));
  }
  return grams;
}

function jaccardSimilarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const item of left) {
    if (right.has(item)) {
      intersection += 1;
    }
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function measureEndingSimilarity(left: string, right: string): number {
  return jaccardSimilarity(buildNGramSet(left), buildNGramSet(right));
}

export function extractEndingSentence(content: string): string {
  const sentences = splitSentences(content);
  return sentences.at(-1) ?? normalizeText(content).slice(-60);
}

export function classifyEndingType(value: string): EndingType {
  const sentence = normalizeText(value);
  if (!sentence) {
    return "calm-close";
  }
  if (/(却|但|然而|只是|忽然|突然|问题是|谁|什么|为什么|手机.*震|短信|电话|敲门|危机|风险|风暴|越来越近|不对劲|来不及)/.test(sentence)) {
    return "suspense";
  }
  if (/(决定|打算|准备|必须|得先|先去|先把|该做|不能再|答应|拒绝)/.test(sentence)) {
    return "decision";
  }
  if (/(走向|迈开|推开|赶往|拨通|朝着|继续|接着|转身|起身|追上|冲向|上车|出门|回去|回到|赶到|来到|联系)/.test(sentence)) {
    return "action-continuation";
  }
  if (/(意识到|明白|想起|忽然觉得|终于懂|后怕|庆幸|心里|心头|鼻尖|发涩|沉甸甸|释然)/.test(sentence)) {
    return "emotional reflection";
  }
  return "calm-close";
}

export function analyzeEndingStrategy(
  content: string,
  recentSamples: EndingStrategySample[] = [],
): EndingStrategyAnalysis {
  const endingSentence = extractEndingSentence(content);
  const endingType = classifyEndingType(endingSentence);
  const recentEndingSentences = recentSamples
    .map((sample) => sample.endingSentence?.trim() || extractEndingSentence(sample.content ?? ""))
    .filter(Boolean)
    .slice(0, 5);
  const recentEndingTypes = recentSamples
    .map((sample) => sample.endingType ?? classifyEndingType(sample.endingSentence?.trim() || extractEndingSentence(sample.content ?? "")))
    .filter(Boolean)
    .slice(0, 5) as EndingType[];
  const matchedBannedPhrase = BANNED_ENDING_PATTERNS
    .map((pattern) => pattern.exec(endingSentence)?.[0] ?? null)
    .find(Boolean) ?? null;
  const maxSimilarity = recentEndingSentences.reduce((max, sentence) => (
    Math.max(max, measureEndingSimilarity(endingSentence, sentence))
  ), 0);
  const repeatedPhraseRisk = Boolean(matchedBannedPhrase) || maxSimilarity > 0.75;
  const recentWindow = recentEndingTypes.slice(0, 4);
  const sameTypeCount = recentWindow.filter((type) => type === endingType).length;
  const recentHead = recentWindow.slice(0, 2);
  const repeatedFunctionRisk = (
    (recentHead.length === 2 && recentHead.every((type) => type === endingType))
    || sameTypeCount >= 3
    || (endingType === "suspense" && recentWindow.filter((type) => type === "suspense").length >= 2)
  );

  return {
    endingSentence,
    endingType,
    repeatedPhraseRisk,
    repeatedFunctionRisk,
    needsRewrite: repeatedPhraseRisk || repeatedFunctionRisk,
    matchedBannedPhrase,
    maxSimilarity,
    recentEndingTypes,
  };
}
