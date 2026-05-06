const REASONING_BLOCK_PATTERNS = [
  /<think\b[^>]*>[\s\S]*?<\/think>/gi,
  /<analysis\b[^>]*>[\s\S]*?<\/analysis>/gi,
  /<reasoning\b[^>]*>[\s\S]*?<\/reasoning>/gi,
];

const STRAY_REASONING_TAG_PATTERN = /<\/?(?:think|analysis|reasoning)\b[^>]*>/gi;
const LEADING_REASONING_PATTERN = /^\s*(?:Let me\s+(?:analy[sz]e|think|write)|I\s+need\s+to|We\s+need\s+to|The\s+chapter\s+must|Opening\s*:|好的|收到|让我|开始分析|首先|接下来|综上所述|根据(?:上下文|要求)|修复(?:要求|策略|思路)|思考[：:]|分析[：:]|思路[：:]|问题\d+|——)/i;
const NARRATIVE_PARAGRAPH_START_PATTERN = /^[“‘「『【（\u3400-\u9fff]/u;
const ASCII_PUNCTUATION_MAP: Record<string, string> = {
  ",": "，",
  "?": "？",
  "!": "！",
  ":": "：",
  ";": "；",
};
const ASCII_EMOTICON_PATTERNS = [
  /\^[_-]?\^/g,
  />_</g,
  /T_T/gi,
  /QAQ/gi,
  /TOT/gi,
  /OwO/gi,
  /UwU/gi,
  /orz/gi,
  /=_=/g,
  /:\)+/g,
  /:\(+/g,
  /:-D/gi,
  /XD/gi,
];
const EMOJI_AND_SYMBOL_PATTERN = /[\p{Extended_Pictographic}\uFE0F❤♥♡❥❣]/gu;
const RUNAWAY_DEDUPE_MIN_LENGTH = 5000;
const RUNAWAY_DEDUPE_MIN_DUPLICATES = 3;
const RUNAWAY_DEDUPE_MIN_FINGERPRINT_LENGTH = 24;
const SHORT_LOOP_MIN_REPEATS = 3;
const CHAPTER_HEADING_PATTERN = /^(?:第\s*[0-9一二三四五六七八九十百千万]+\s*章|chapter\s*\d+)(?:\s*[：:、\-.——]?\s*[\s\S]{0,40})?$/i;
const BARE_TITLE_HEADING_PATTERN = /^[\u3400-\u9fff0-9０-９一二三四五六七八九十百千万·]{4,30}$/u;
const CHAPTER_END_MARKER_PATTERN = /^(?:【\s*)?(?:第?\s*[0-9一二三四五六七八九十百千万]+\s*章\s*)?(?:完|完结|结束|未完待续|to be continued)(?:\s*】)?$/i;
const GENERATED_META_MARKER_PATTERN = /(上一章|下一章|本章|这一章|本卷|第一卷|第二卷|核心悬念|章节|剧情|读者|作者|故事到这里|悬念终于)/;
const GENERATED_META_CONTEXT_PATTERN = /(悬念|剧情|故事|章节|任务|承接|推进|铺垫|伏笔|答案|节奏|收尾|钩子|核心|读者|作者|卷)/;
const GENERATED_META_STANDALONE_PATTERN = /^(?:第一卷|第二卷|本卷|上一章|下一章|本章|这一章|第\s*[0-9零一二三四五六七八九十百千万]+\s*章|核心悬念)/;
const GENERATED_META_FOLLOWUP_PATTERN = /^这个问题的答案，将决定/;
const GENERATED_META_NARRATION_PATTERN = /^(?:上一章|下一章|本章|这一章)[，,、。！？\s]/;
const GENERATED_CHAPTER_REFERENCE_PATTERN = /第\s*[0-9０-９零一二三四五六七八九十百千万]+\s*章/u;
const GENERATED_CHAPTER_REFERENCE_CONTEXT_PATTERN = /(能撑到|撑到|等到|直到|后续|之后|下一|协同作战|剧情|章节|铺垫|伏笔|钩子|收尾)/;
const GENERATED_CHAPTER_COUNT_META_PATTERN = /(逃跑了|用了|走过了|撑到|等到|直到|将近)\s*[0-9０-９零一二三四五六七八九十百千万]+\s*章/u;

function stripMarkdownMarkers(content: string): string {
  return content
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]*-{3,}[ \t]*$/gm, "——")
    .replace(/`{1,3}/g, "")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/\*/g, "");
}

function stripLeadingReasoningLeak(content: string): string {
  const trimmed = content.trimStart();
  if (!LEADING_REASONING_PATTERN.test(trimmed)) {
    return content;
  }

  const paragraphs = trimmed.split(/\n{2,}/);
  const narrativeStartIndex = paragraphs.findIndex((paragraph, index) => {
    if (index === 0) {
      return false;
    }
    const normalized = paragraph.trim();
    if (!NARRATIVE_PARAGRAPH_START_PATTERN.test(normalized)) {
      return false;
    }
    // Heuristic: narrative paragraphs usually don't have English reasoning prefixes and aren't purely markdown structural
    if (LEADING_REASONING_PATTERN.test(normalized)) {
      return false;
    }
    return !/[A-Za-z]/.test(normalized.slice(0, 160));
  });

  if (narrativeStartIndex <= 0) {
    return content;
  }

  return paragraphs.slice(narrativeStartIndex).join("\n\n");
}

function normalizeAlternatingQuotes(content: string, rawChars: Set<string>, openQuote: string, closeQuote: string): string {
  let expectingOpen = true;
  let normalized = "";
  for (const char of content) {
    if (rawChars.has(char)) {
      normalized += expectingOpen ? openQuote : closeQuote;
      expectingOpen = !expectingOpen;
      continue;
    }
    normalized += char;
  }
  return normalized;
}

function normalizeQuotes(content: string): string {
  const withDoubleQuotes = normalizeAlternatingQuotes(
    content,
    new Set(["\"", "“", "”", "「", "」", "＂"]),
    "“",
    "”",
  );
  return normalizeAlternatingQuotes(
    withDoubleQuotes,
    new Set(["'", "‘", "’", "『", "』"]),
    "‘",
    "’",
  );
}

function fixReversedShortChineseQuotes(content: string): string {
  return content.replace(/”([^“”\n，。！？：；]{1,16})“/g, "“$1”");
}

function normalizePeriods(content: string): string {
  return content
    .replace(/(?<=\d)\.(?=\d)/g, "点")
    .replace(/(?<=[\u3400-\u9fff”’」』）】])\.(?=$|[\s\u3400-\u9fff“”‘’「」『』，。！？：；])/gu, "。")
    .replace(/(?<![A-Za-z0-9])\.(?=[”’」』\s\n]|$)/gu, "。")
    .replace(/(?<![A-Za-z0-9])\.(?=[\u3400-\u9fff“”‘’「」『』])/gu, "。")
    .replace(/\./g, "。");
}

function collapsePunctuationRuns(content: string): string {
  return content
    .replace(/[！？]{2,}/g, (match) => (match.includes("？") ? "？" : "！"))
    .replace(/，{2,}/g, "，")
    .replace(/。{2,}/g, "。")
    .replace(/；{2,}/g, "；")
    .replace(/：{2,}/g, "：");
}

function removeAsciiEmoticons(content: string): string {
  let cleaned = content;
  for (const pattern of ASCII_EMOTICON_PATTERNS) {
    cleaned = cleaned.replace(pattern, "");
  }
  return cleaned;
}

function normalizeParagraphFingerprint(paragraph: string): string {
  return paragraph.replace(/\s+/g, "").trim();
}

function stripGeneratedStructureLeaks(content: string): string {
  const paragraphs = content.split(/\n{2,}/);
  let removedPreviousMeta = false;
  return paragraphs
    .filter((paragraph, index) => {
      const normalized = paragraph.replace(/\s+/g, " ").trim();
      if (!normalized) {
        return false;
      }
      if (index <= 3 && CHAPTER_HEADING_PATTERN.test(normalized)) {
        removedPreviousMeta = true;
        return false;
      }
      if (index === 0 && BARE_TITLE_HEADING_PATTERN.test(normalized)) {
        removedPreviousMeta = true;
        return false;
      }
      if (CHAPTER_END_MARKER_PATTERN.test(normalized)) {
        removedPreviousMeta = true;
        return false;
      }
      const looksLikeMeta = (
        (GENERATED_META_MARKER_PATTERN.test(normalized) && GENERATED_META_CONTEXT_PATTERN.test(normalized))
        || (GENERATED_META_STANDALONE_PATTERN.test(normalized) && GENERATED_META_CONTEXT_PATTERN.test(normalized))
        || (GENERATED_CHAPTER_REFERENCE_PATTERN.test(normalized) && GENERATED_CHAPTER_REFERENCE_CONTEXT_PATTERN.test(normalized))
        || GENERATED_CHAPTER_COUNT_META_PATTERN.test(normalized)
      );
      if (looksLikeMeta) {
        removedPreviousMeta = true;
        return false;
      }
      if (GENERATED_META_NARRATION_PATTERN.test(normalized)) {
        removedPreviousMeta = true;
        return false;
      }
      if (removedPreviousMeta && GENERATED_META_FOLLOWUP_PATTERN.test(normalized)) {
        removedPreviousMeta = true;
        return false;
      }
      removedPreviousMeta = false;
      return true;
    })
    .join("\n\n");
}

export function compactRunawayRepeatedParagraphs(content: string): string {
  if (content.length < RUNAWAY_DEDUPE_MIN_LENGTH) {
    return content;
  }

  const paragraphs = content.split(/\n{2,}/);
  if (paragraphs.length < 8) {
    return content;
  }

  const seen = new Set<string>();
  let duplicateCount = 0;
  for (const paragraph of paragraphs) {
    const fingerprint = normalizeParagraphFingerprint(paragraph);
    if (fingerprint.length < RUNAWAY_DEDUPE_MIN_FINGERPRINT_LENGTH) {
      continue;
    }
    if (seen.has(fingerprint)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(fingerprint);
  }

  if (duplicateCount < RUNAWAY_DEDUPE_MIN_DUPLICATES) {
    return content;
  }

  const kept = new Set<string>();
  return paragraphs
    .filter((paragraph) => {
      const fingerprint = normalizeParagraphFingerprint(paragraph);
      if (fingerprint.length < RUNAWAY_DEDUPE_MIN_FINGERPRINT_LENGTH) {
        return true;
      }
      if (kept.has(fingerprint)) {
        return false;
      }
      kept.add(fingerprint);
      return true;
    })
    .join("\n\n");
}

function compactShortParagraphLoops(content: string): string {
  const paragraphs = content.split(/\n{2,}/);
  if (paragraphs.length < SHORT_LOOP_MIN_REPEATS * 2) {
    return content;
  }

  const output: string[] = [];
  let index = 0;
  while (index < paragraphs.length) {
    const first = normalizeParagraphFingerprint(paragraphs[index] ?? "");
    const second = normalizeParagraphFingerprint(paragraphs[index + 1] ?? "");
    if (first.length >= 4 && second.length >= 4 && first !== second) {
      let repeats = 1;
      while (
        index + repeats * 2 + 1 < paragraphs.length
        && normalizeParagraphFingerprint(paragraphs[index + repeats * 2] ?? "") === first
        && normalizeParagraphFingerprint(paragraphs[index + repeats * 2 + 1] ?? "") === second
      ) {
        repeats += 1;
      }
      if (repeats >= SHORT_LOOP_MIN_REPEATS) {
        output.push(paragraphs[index], paragraphs[index + 1]);
        index += repeats * 2;
        continue;
      }
    }
    output.push(paragraphs[index]);
    index += 1;
  }

  return output.join("\n\n");
}

export function sanitizeGeneratedChapterContent(content: string): string {
  if (!content.trim()) {
    return "";
  }

  let cleaned = content.replace(/\r\n/g, "\n");
  for (const pattern of REASONING_BLOCK_PATTERNS) {
    cleaned = cleaned.replace(pattern, "\n");
  }
  cleaned = cleaned.replace(STRAY_REASONING_TAG_PATTERN, "");
  cleaned = stripLeadingReasoningLeak(cleaned);
  cleaned = stripMarkdownMarkers(cleaned);
  cleaned = cleaned.replace(/[~～]/g, "");
  cleaned = normalizeQuotes(cleaned);
  cleaned = fixReversedShortChineseQuotes(cleaned);
  cleaned = cleaned.replace(/(?:\.{3,}|。{3,}|…{2,})/g, "……");
  cleaned = cleaned.replace(/(?:--+|—{1,}|―{1,}|–{1,}|—{2,}|——+)/g, "——");
  cleaned = cleaned.replace(/(?<=[\u3400-\u9fff，。！？：；、“”‘’【】《》〈〉（）\s])-+(?=[\u3400-\u9fff，。！？：；、“”‘’【】《》〈〉（）\s])/gu, "——");
  cleaned = cleaned.replace(/-/g, "——");
  cleaned = cleaned.replace(/[,\?!:;]/g, (punctuation) => ASCII_PUNCTUATION_MAP[punctuation] ?? punctuation);
  cleaned = normalizePeriods(cleaned);
  cleaned = cleaned.replace(/[\[\]\{\}<>]/g, "");
  cleaned = cleaned.replace(EMOJI_AND_SYMBOL_PATTERN, "");
  cleaned = removeAsciiEmoticons(cleaned);
  cleaned = collapsePunctuationRuns(cleaned);
  cleaned = cleaned.replace(/[ \t]{2,}/g, " ");
  cleaned = cleaned.replace(/[ \t]+\n/g, "\n");
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");
  cleaned = stripGeneratedStructureLeaks(cleaned);
  cleaned = compactShortParagraphLoops(cleaned);
  cleaned = compactRunawayRepeatedParagraphs(cleaned);
  return cleaned.trim();
}

export function hasGeneratedReasoningLeak(content: string): boolean {
  if (!content.trim()) {
    return false;
  }
  const matchedReasoningBlock = REASONING_BLOCK_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(content);
  });
  STRAY_REASONING_TAG_PATTERN.lastIndex = 0;
  return matchedReasoningBlock
    || STRAY_REASONING_TAG_PATTERN.test(content)
    || LEADING_REASONING_PATTERN.test(content.trimStart());
}

// Detects if the first sentence of the new chapter is suspiciously similar to
// the last sentence of the previous chapter (LLM generation bug pattern)
export function detectCrossChapterSentenceRepeat(
  currentContent: string,
  previousContent: string | null,
): string | null {
  if (!currentContent.trim() || !previousContent?.trim()) return null;

  const normalizedPrev = previousContent.replace(/\r\n/g, "\n").trim();
  const prevSentences = normalizedPrev.split(/(?<=[。！？!?])/g).filter(Boolean);
  if (prevSentences.length === 0) return null;

  const lastPrev = prevSentences[prevSentences.length - 1].replace(/\s+/g, "").slice(0, 100);
  if (lastPrev.length < 8) return null;

  const currSentences = currentContent.trim().split(/(?<=[。！？!?])/g).filter(Boolean);
  if (currSentences.length === 0) return null;

  const first = currSentences[0].replace(/\s+/g, "").slice(0, 100);
  if (first.length < 8) return null;

  // Exact repeat
  if (first === lastPrev) return currSentences[0];

  // 85%+ char-level similarity
  const minLen = Math.min(first.length, lastPrev.length);
  if (minLen >= 10) {
    let match = 0;
    for (let i = 0; i < minLen; i++) {
      if (first[i] === lastPrev[i]) match++;
    }
    if (match / minLen >= 0.85) return currSentences[0];
  }

  // Also check second-last sentence (edge case where LLM reads last sentence wrongly)
  if (prevSentences.length >= 2) {
    const secondLast = prevSentences[prevSentences.length - 2].replace(/\s+/g, "").slice(0, 100);
    if (secondLast.length >= 8) {
      const min2 = Math.min(first.length, secondLast.length);
      let match2 = 0;
      for (let i = 0; i < min2; i++) {
        if (first[i] === secondLast[i]) match2++;
      }
      if (match2 / min2 >= 0.85) return currSentences[0];
    }
  }

  return null;
}
