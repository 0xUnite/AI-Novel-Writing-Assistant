const SENTENCE_SPLIT_REGEX = /(?<=[。！？!?])/g;
const ITEM_KEYWORDS = [
  "名片",
  "文件",
  "手机",
  "钥匙",
  "信封",
  "纸条",
  "合同",
  "录音笔",
  "U盘",
  "账本",
  "资料",
  "药丸",
  "门卡",
  "证件",
];
const CHARACTER_STOPWORDS = new Set([
  "自己",
  "对方",
  "有人",
  "少年",
  "少女",
  "男人",
  "女人",
  "老师",
  "同学",
  "老板",
  "众人",
  "事情",
  "时候",
  "现在",
  "今天",
  "明天",
  "刚才",
  "这里",
  "那里",
  "他们",
  "她们",
  "我们",
  "你们",
  "这个",
  "那个",
  "什么",
  "一下",
  "一步",
  "地方",
  "问题",
]);
const SCENE_PATTERNS = [
  /(在|来到|回到|走进|进入|留在|赶到|站在|坐在|停在|守在)([^，。！？\n]{2,20}(?:里|内|外|上|中|旁|边|前|后|间|处|口|道|室|厅|楼|街|巷|门|宿舍|病房|校园|办公室|教室|走廊|仓库|车站|操场|天台|通道))/g,
  /([^，。！？\n]{2,20}(?:宿舍|病房|校园|办公室|教室|走廊|仓库|车站|操场|天台|通道|楼道|食堂|寝室|门口|楼下))/g,
];
const TIME_PATTERNS = [
  /(次日|翌日|第二天(?:一早|早上|早晨)?|明天(?:一早|早上|早晨)?|今天(?:晚上|夜里|傍晚)?|今晚|今早|当天(?:晚上|夜里|傍晚)?|当晚|清晨|凌晨|早上|上午|中午|下午|傍晚|晚上|深夜|半夜|一夜之后|十分钟后|半小时后|一小时后|几小时后)/g,
  /(随后|接着|片刻后|过了一会儿|不久后)/g,
];
const CHARACTER_PATTERNS = [
  /(?:^|[，。！？\n])([一-龥]{2,4})(?=(?:把|跟|往|决定|抱|看|想|盯|抬|点|摇|笑|站|坐|走|拿|接|回|皱|沉默|开口|低声|转身|停下|追上|点头|摆手|望向))/g,
  /(?:对|朝)([一-龥]{2,4})(?=[^。！？\n]{0,6}(?:说|问|点头|摆手))/g,
  /([一-龥]{2,4})的(?:(?:手机|钥匙|名片|文件|信封|手|目光|声音|脚步))/g,
];
const IMAGERY_PATTERNS = [
  /像是/, /仿佛/, /如同/, /犹如/, /好似/, /如同一?/, /某种/, /某物/,
  /这是/, /这就是/, /那是/, /仿佛是/, /像是某种/, /某种东西/,
  /不是[\s\S]{0,20}而是/, /而是一种/, /而是一種/,
];
const PHYSICAL_ACTION_VERBS = [
  '走', '跑', '爬', '跳', '站', '坐', '躺', '握', '拿', '抓', '推', '拉', '抬', '按',
  '说', '问', '答', '喊', '叫', '笑', '哭', '皱眉', '点头', '摇头',
  '看', '盯', '望', '瞥', '瞅', '观察', '扫视',
  '伸', '缩', '退', '进', '停', '回头', '转身',
  '触', '碰', '按', '压', '贴', '抬', '放', '塞',
  '吃', '喝', '吞', '咽', '吐', '咳',
  '呼吸', '心跳', '睁眼', '闭眼', '眨眼',
];

const IS_IMAGERY_SENTENCE = /这是|这就是|那是|仿佛|如同|犹如|像是某种|某种东西|不是[\s\S]{0,15}而是|而是一种/;
const CONTAINS_IMAGERY_KEYWORD = /像是|仿佛|如同|犹如|好似|某[种物]|不是[\s\S]{0,20}而是/;
const IS_DECLARATIVE_JUDGMENT = /^[^，。！？]{0,30}[的是有能让给在就才把被会要用]\.$/;

function isImagerySentence(s: string): boolean {
  return IS_IMAGERY_SENTENCE.test(s) || (CONTAINS_IMAGERY_KEYWORD.test(s) && s.length < 50);
}

function hasPhysicalAction(text: string): boolean {
  return PHYSICAL_ACTION_VERBS.some((v) => text.includes(v));
}

function detectImageryEnding(last200Chars: string): boolean {
  const sentences = last200Chars.split(/(?<=[。！？!?])/g).filter(Boolean);
  if (sentences.length < 2) return false;
  const imageryCount = sentences.filter((s) => IS_IMAGERY_SENTENCE.test(s)).length;
  const hasPhysical = hasPhysicalAction(last200Chars);
  const judgmentCount = sentences.filter((s) => IS_DECLARATIVE_JUDGMENT.test(s)).length;
  // Trigger if: imagery sentences >= 60% of total, OR (imagery >= 40% AND no physical action)
  if (imageryCount / sentences.length >= 0.6) return true;
  if (imageryCount / sentences.length >= 0.4 && !hasPhysical) return true;
  if (judgmentCount >= sentences.length * 0.7 && imageryCount >= 2) return true;
  return false;
}

function filterPendingActions(pending: string[]): string[] {
  const IMAGERY_PENDING_FILTER = /^(等待|[^，；：]{0,10}着|仿佛|像是|某种|某物)/;
  return pending.filter((item) => {
    if (IMAGERY_PENDING_FILTER.test(item)) return false;
    if (item.includes('着') && !hasPhysicalAction(item)) return false;
    return true;
  });
}

function sentencesSimilar(a: string, b: string): boolean {
  if (!a || !b) return false;
  const normA = a.replace(/\s+/g, '').slice(0, 100);
  const normB = b.replace(/\s+/g, '').slice(0, 100);
  if (normA === normB) return true;
  // Check if one is a prefix/substring of the other (80%+ overlap)
  const minLen = Math.min(normA.length, normB.length);
  if (minLen < 10) return false;
  const common = normA.slice(0, minLen) === normB.slice(0, minLen);
  if (common) return true;
  // Check edit-distance-like similarity
  let match = 0;
  for (let i = 0; i < minLen; i++) {
    if (normA[i] === normB[i]) match++;
  }
  return match / minLen >= 0.85;
}

export interface BridgeStateExtraction {
  tailExcerpt: string;
  imageryWarning: boolean;
  carryOverFacts: string[];
  lastTenSentences: string[];
  lastScene: string;
  lastTime: string;
  lastCharacters: string[];
  lastCharacterStates: string[];
  pendingActions: string[];
  keyItems: string[];
  lastSentence: string;
}

function normalizeText(value: string | null | undefined): string {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function compactText(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}...`;
}

function splitSentences(value: string): string[] {
  return normalizeText(value)
    .split(SENTENCE_SPLIT_REGEX)
    .flatMap((item) => item.split(/\n+/g))
    .map((item) => item.trim())
    .filter(Boolean);
}

function splitParagraphs(value: string): string[] {
  return normalizeText(value)
    .split(/\n{2,}/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function takeLastMatches(patterns: RegExp[], source: string): string | null {
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    const matches = Array.from(source.matchAll(pattern));
    const lastMatch = matches.at(-1);
    if (!lastMatch) {
      continue;
    }
    const fragment = (lastMatch[2] ?? lastMatch[1] ?? lastMatch[0] ?? "").trim();
    if (fragment) {
      return fragment;
    }
  }
  return null;
}

function cleanSceneCandidate(value: string): string {
  return value
    .replace(/^(?:先|又|再|还|便|就|想|记住|盯着|望向|走向|走到|赶到|来到|回到|留在|停在)+/, "")
    .trim();
}

function dedupe(items: string[], limit = items.length): string[] {
  const seen = new Set<string>();
  const results: string[] = [];
  for (const item of items) {
    const normalized = item.replace(/\s+/g, " ").trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    results.push(normalized);
    if (results.length >= limit) {
      break;
    }
  }
  return results;
}

function isLikelyCharacterName(value: string): boolean {
  if (!value || CHARACTER_STOPWORDS.has(value)) {
    return false;
  }
  if (/^(没有|还是|随后|然后|夜风|两人|一个|这个|那个|明天|今天|现在|刚才|片刻)/.test(value)) {
    return false;
  }
  if (/[的了着是把跟往将先后里外口眼手脚心没还随风]/.test(value)) {
    return false;
  }
  return true;
}

function extractCharacters(sentences: string[]): string[] {
  const candidates: string[] = [];
  for (const sentence of sentences) {
    for (const pattern of CHARACTER_PATTERNS) {
      for (const match of sentence.matchAll(pattern)) {
        const name = String(match[1] ?? "").trim();
        if (!isLikelyCharacterName(name)) {
          continue;
        }
        candidates.push(name);
      }
    }
  }
  return dedupe(candidates, 6);
}

function extractCharacterStates(sentences: string[], characters: string[]): string[] {
  const states: string[] = [];
  for (const character of characters) {
    const sentence = [...sentences].reverse().find((item) => item.includes(character));
    if (!sentence) {
      continue;
    }
    const stateText = sanitizeStateText(sentence, 42) ?? compactText(sentence, 42);
    states.push(`${character}：${stateText}`);
  }
  return dedupe(states, 4);
}

function extractPendingActions(sentences: string[]): string[] {
  const clauses = sentences
    .flatMap((sentence) => sentence.split(/[，；：]/g))
    .map((item) => item.trim())
    .filter((item) => item.length >= 4 && item.length <= 30);
  return filterPendingActions(dedupe(clauses, 5));
}

function extractKeyItems(sentences: string[]): string[] {
  const found = ITEM_KEYWORDS.filter((keyword) => sentences.some((sentence) => sentence.includes(keyword)));
  return dedupe(found, 6);
}

function extractCarryOverFacts(sentences: string[]): string[] {
  return dedupe(
    sentences
      .flatMap((sentence) => sentence.split(/[\n，。！？；：]/g))
      .map((item) => item.trim())
      .filter((item) => item.length >= 2 && item.length <= 24),
    6,
  );
}

export function extractBridgeState(content: string): BridgeStateExtraction {
  const normalized = normalizeText(content);
  if (!normalized) {
    return {
      tailExcerpt: "",
      imageryWarning: false,
      carryOverFacts: [],
      lastTenSentences: [],
      lastScene: "未明确，默认延续上一场景。",
      lastTime: "未明确，默认紧接上一时间点。",
      lastCharacters: [],
      lastCharacterStates: [],
      pendingActions: [],
      keyItems: [],
      lastSentence: "",
    };
  }

  const sentences = splitSentences(normalized);
  const paragraphs = splitParagraphs(normalized);
  const lastTenSentences = sentences.slice(-10);
  const lastThreeSentences = lastTenSentences.slice(-3);
  const lastSentence = lastTenSentences.at(-1) ?? "";
  const sceneSource = [...paragraphs.slice(-2), ...lastThreeSentences].join(" ");
  const timeSource = lastThreeSentences.join(" ");
  const lastCharacters = extractCharacters(lastTenSentences);
  const last200Chars = normalized.slice(-200);
  const imageryWarning = detectImageryEnding(last200Chars);

  return {
    tailExcerpt: compactText(lastThreeSentences.join(""), 220),
    imageryWarning,
    carryOverFacts: extractCarryOverFacts(lastThreeSentences),
    lastTenSentences,
    lastScene: cleanSceneCandidate(takeLastMatches(SCENE_PATTERNS, sceneSource) ?? "") || "未明确，默认延续上一场景。",
    lastTime: takeLastMatches(TIME_PATTERNS, timeSource) ?? "未明确，默认紧接上一时间点。",
    lastCharacters,
    lastCharacterStates: extractCharacterStates(lastThreeSentences, lastCharacters),
    pendingActions: filterPendingActions(extractPendingActions(lastThreeSentences)),
    keyItems: extractKeyItems(lastTenSentences),
    lastSentence,
  };
}
import { sanitizeStateText } from "../../chapterMemorySanitizer";
