type FactCategory = "plot" | "character" | "world";

const STATE_KEYWORDS = /目标|决定|准备|必须|不能|知道|发现|确认|怀疑|误以为|受伤|中毒|失去|获得|暴露|隐藏|信任|敌意|合作|依赖|背叛|风险|代价|身份|关系|承诺|掌握|警惕|虚弱|疲惫|压力|追杀|威胁|安全|机会|资源|时间|窗口/u;
const RAW_PROSE_MARKERS = /的瞬间|的时候|已经|本能地|脚步|呼吸|回响|抬头|低头|回头|风声|雨声|门缝|矿道|走廊|窗外|竹篓|麻袋|每一步/u;

function compactText(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/\b(?:Plot|Character|World)\s*:\s*/gi, "")
    .replace(/[“”"']/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function splitClauses(value: string): string[] {
  return compactText(value)
    .split(/[\n。！？!?；;，,：:]/g)
    .map((item) => item.trim())
    .filter((item) => item.length >= 3);
}

function takeUnique(items: string[], limit: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    const normalized = compactText(item);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= limit) {
      break;
    }
  }
  return result;
}

function looksLikeRawProse(value: string): boolean {
  const text = compactText(value);
  if (text.length <= 36) {
    return false;
  }
  const punctuationCount = (text.match(/[，。！？；：]/g) ?? []).length;
  return punctuationCount >= 2 || RAW_PROSE_MARKERS.test(text);
}

function deriveStateLabel(value: string): string | null {
  const text = compactText(value);
  const labels: string[] = [];
  if (/伤|血|疼|痛|中毒|耗尽|虚弱|疲惫|灵力|体力/u.test(text)) {
    labels.push("身体或资源出现消耗");
  }
  if (/杀|追|围|逼|压|威胁|盯|暴露|危险|危机|怀疑/u.test(text)) {
    labels.push("处境受压并保持警惕");
  }
  if (/发现|知道|明白|看出|确认|意识到|听见|看见|掌握/u.test(text)) {
    labels.push("掌握新的关键线索");
  }
  if (/信任|合作|背叛|敌意|依赖|保护|救|试探|关系/u.test(text)) {
    labels.push("关系或立场发生变化");
  }
  if (/决定|必须|不能|准备|打算|承诺|代价|机会|时间/u.test(text)) {
    labels.push("形成下一步行动压力");
  }
  return labels.length > 0 ? takeUnique(labels, 3).join("，") : null;
}

export function sanitizeMemoryText(
  value: string | null | undefined,
  options: { maxLength?: number; preferStateLabel?: boolean } = {},
): string | null {
  const maxLength = options.maxLength ?? 80;
  const text = compactText(value);
  if (!text) {
    return null;
  }

  const stateLabel = options.preferStateLabel ? deriveStateLabel(text) : null;
  if (stateLabel) {
    return stateLabel.length > maxLength ? stateLabel.slice(0, maxLength) : stateLabel;
  }

  if (text.length <= maxLength && !looksLikeRawProse(text)) {
    return text;
  }

  const clauses = splitClauses(text);
  const meaningful = clauses.filter((clause) => STATE_KEYWORDS.test(clause));
  const picked = takeUnique(meaningful.length > 0 ? meaningful : clauses, 3)
    .map((clause) => clause.length > Math.min(42, maxLength) ? clause.slice(0, Math.min(42, maxLength)) : clause);
  const compacted = picked.join("；").slice(0, maxLength).trim();
  return compacted || null;
}

export function sanitizeStateText(value: string | null | undefined, maxLength = 72): string | null {
  return sanitizeMemoryText(value, { maxLength, preferStateLabel: true });
}

export function sanitizeMemoryList(
  values: Array<string | null | undefined> | null | undefined,
  options: { maxItems?: number; maxLength?: number; preferStateLabel?: boolean } = {},
): string[] {
  const maxItems = options.maxItems ?? 4;
  return takeUnique(
    (values ?? [])
      .map((value) => sanitizeMemoryText(value, {
        maxLength: options.maxLength ?? 80,
        preferStateLabel: options.preferStateLabel,
      }) ?? "")
      .filter(Boolean),
    maxItems,
  );
}

export function buildContinuitySummaryFromFacts(
  facts: Array<{ category: FactCategory; content: string }>,
  fallback?: string | null,
): string {
  const plot = sanitizeMemoryList(
    facts.filter((item) => item.category === "plot").map((item) => item.content).reverse(),
    { maxItems: 2, maxLength: 56 },
  );
  const character = sanitizeMemoryList(
    facts.filter((item) => item.category === "character").map((item) => item.content).reverse(),
    { maxItems: 2, maxLength: 56 },
  );
  const world = sanitizeMemoryList(
    facts.filter((item) => item.category === "world").map((item) => item.content).reverse(),
    { maxItems: 1, maxLength: 56 },
  );
  const blocks = [
    plot.length > 0 ? `剧情状态：${plot.join("；")}` : "",
    character.length > 0 ? `角色状态：${character.join("；")}` : "",
    world.length > 0 ? `规则线索：${world.join("；")}` : "",
  ].filter(Boolean);
  if (blocks.length > 0) {
    return blocks.join("\n");
  }
  return sanitizeMemoryText(fallback, { maxLength: 180 }) ?? "";
}

export function buildCharacterStateDigest(
  facts: Array<{ category: FactCategory; content: string }>,
  maxItems = 3,
): string {
  return sanitizeMemoryList(
    facts.filter((item) => item.category === "character").map((item) => item.content),
    { maxItems, maxLength: 64, preferStateLabel: true },
  ).join("；");
}

export function buildKeyEventDigest(
  facts: Array<{ category: FactCategory; content: string }>,
  maxItems = 3,
): string {
  return sanitizeMemoryList(
    facts.filter((item) => item.category !== "character").map((item) => item.content),
    { maxItems, maxLength: 64 },
  ).join("；");
}
