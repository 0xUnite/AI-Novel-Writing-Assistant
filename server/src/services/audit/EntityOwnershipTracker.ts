const DEFAULT_TRACKED_ITEMS = ["名片", "文件", "手机", "钥匙", "信封"];
const SENTENCE_SPLIT_REGEX = /(?<=[。！？!?])/g;
const ITEM_ALIAS_MAP: Record<string, string[]> = {
  手机: ["手机", "新机", "展示机", "机子", "同款手机"],
  文件: ["文件", "资料", "合同", "方案"],
  名片: ["名片"],
  钥匙: ["钥匙"],
  信封: ["信封"],
};
const SINGULAR_OWNER_PRONOUN_REGEX = /(?:^|[^一-龥])(他|她|对方)(?!们)(?:[^一-龥]|$)/;
const NAME_STOPWORDS = new Set([
  "自己",
  "对方",
  "有人",
  "男人",
  "女人",
  "男生",
  "女生",
  "买家",
  "顾客",
  "客人",
  "店员",
  "摊主",
  "老师",
  "同学",
  "老板",
  "他们",
  "她们",
  "我们",
  "你们",
  "这个",
  "那个",
  "事情",
  "时候",
  "现在",
  "今天",
  "明天",
]);

export interface OwnershipTransferEvent {
  item: string;
  from: string | null;
  to: string | null;
  evidence: string;
}

export interface OwnershipAmbiguity {
  item: string;
  owners: string[];
  evidence: string;
}

export interface EntityOwnershipAnalysis {
  trackedItems: string[];
  transfers: OwnershipTransferEvent[];
  ambiguities: OwnershipAmbiguity[];
}

function normalizeText(value: string | null | undefined): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function splitSentences(value: string): string[] {
  return normalizeText(value)
    .split(SENTENCE_SPLIT_REGEX)
    .map((item) => item.trim())
    .filter(Boolean);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getItemTerms(item: string): string[] {
  return Array.from(new Set([item, ...(ITEM_ALIAS_MAP[item] ?? [])]))
    .map((entry) => entry.trim())
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
}

function buildItemPattern(item: string): string {
  return `(?:${getItemTerms(item).map(escapeRegExp).join("|")})`;
}

function sanitizeName(value: string | null | undefined): string | null {
  const name = String(value ?? "").trim();
  if (!name || NAME_STOPWORDS.has(name) || /[的了着是把跟往将先后里外口眼手脚心没还随]/.test(name)) {
    return null;
  }
  return name;
}

function splitClauses(sentence: string): string[] {
  return normalizeText(sentence)
    .split(/[，；]/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function detectClauseSubject(clause: string, previousSubject: string | null): string | null {
  const direct = clause.match(/^([一-龥]{2,4})(?=(?:把|将|从|接过|拿过|收回|收起|拿起|取出|拿出|握住|握着|举起|放下|放回|搁到|搁回|拿着|攥着|收好|递给|交给|塞给|还给|交到|递到|递向|递来|递过来|端着|看着|盯着))/);
  if (direct) {
    return sanitizeName(direct[1]);
  }
  if (/^(从|随后|接着|又|再|然后)/.test(clause)) {
    return previousSubject;
  }
  return previousSubject;
}

function collectSentenceOwners(sentence: string, item: string): string[] {
  const owners = new Set<string>();
  const itemPattern = buildItemPattern(item);
  for (const match of sentence.matchAll(new RegExp(`(?:^|[，；。、“”\\s])([一-龥]{2,4})的${itemPattern}`, "g"))) {
    const owner = sanitizeName(match[1]);
    if (owner) {
      owners.add(owner);
    }
  }
  for (const match of sentence.matchAll(new RegExp(`${itemPattern}[^。！？]{0,12}(?:在|落在|回到)([一-龥]{2,4})手里`, "g"))) {
    const owner = sanitizeName(match[1]);
    if (owner) {
      owners.add(owner);
    }
  }

  let subject: string | null = null;
  for (const clause of splitClauses(sentence)) {
    subject = detectClauseSubject(clause, subject);
    if (!subject || !new RegExp(itemPattern).test(clause)) {
      continue;
    }
    if (/(把|将|拿着|攥着|收好|接过|拿过|收回|收起|拿起|取出|拿出|握住|握着|举起|放下|放回|搁到|搁回|递给|交给|塞给|还给|交到|递到|递向|递来|递过来|装进|揣进|塞进)/.test(clause)) {
      owners.add(subject);
    }
  }
  return [...owners];
}

function detectTransfer(sentence: string, item: string): OwnershipTransferEvent | null {
  const itemPattern = buildItemPattern(item);
  let subject: string | null = null;
  for (const clause of splitClauses(sentence)) {
    subject = detectClauseSubject(clause, subject);
    const giveMatch = clause.match(new RegExp(`(?:把|将)?${itemPattern}[^。！？]{0,8}(?:递给|交给|塞给|还给|交到)([一-龥]{2,4})`));
    if (giveMatch && subject) {
      return {
        item,
        from: subject,
        to: sanitizeName(giveMatch[1]),
        evidence: sentence,
      };
    }

    const reclaimMatch = clause.match(new RegExp(`从([一-龥]{2,4})手中把${itemPattern}(?:收回|拿回)`));
    if (reclaimMatch && subject) {
      return {
        item,
        from: sanitizeName(reclaimMatch[1]),
        to: subject,
        evidence: sentence,
      };
    }

    const receivedFromMatch = clause.match(new RegExp(`接过([一-龥]{2,4})递来的${itemPattern}`));
    if (receivedFromMatch && subject) {
      return {
        item,
        from: sanitizeName(receivedFromMatch[1]),
        to: subject,
        evidence: sentence,
      };
    }

    if (subject && new RegExp(`(?:接过|拿走|收下)[^。！？]{0,10}${itemPattern}`).test(clause)) {
      return {
        item,
        from: null,
        to: subject,
        evidence: sentence,
      };
    }
  }
  return null;
}

function hasOwnershipCue(sentence: string, item: string): boolean {
  const itemPattern = buildItemPattern(item);
  return new RegExp(`${itemPattern}[^。！？]{0,18}(手里|手中|口袋|书包|包里|桌上|桌角|托盘|柜台|掌心|保管|递|交|塞|拿|取|接|收|放|搁|揣|装|按亮|核对|拆开|撕开|查看)`).test(sentence)
    || new RegExp(`(递|交|塞|拿|取|接|收|放|搁|揣|装|保管)[^。！？]{0,12}${itemPattern}`).test(sentence);
}

export function trackEntityOwnership(content: string, trackedItems: string[] = DEFAULT_TRACKED_ITEMS): EntityOwnershipAnalysis {
  const sentences = splitSentences(content);
  const normalizedItems = Array.from(new Set(trackedItems.map((item) => item.trim()).filter(Boolean)));
  const transfers: OwnershipTransferEvent[] = [];
  const ambiguities: OwnershipAmbiguity[] = [];
  const knownOwners = new Map<string, Set<string>>();
  const currentOwners = new Map<string, string | null>();

  for (const item of normalizedItems) {
    knownOwners.set(item, new Set<string>());
    currentOwners.set(item, null);
  }

  for (const sentence of sentences) {
    for (const item of normalizedItems) {
      const itemTerms = getItemTerms(item);
      if (!itemTerms.some((term) => sentence.includes(term))) {
        continue;
      }
      const owners = collectSentenceOwners(sentence, item);
      const transfer = detectTransfer(sentence, item);
      const ownerSet = knownOwners.get(item) ?? new Set<string>();
      let currentOwner = currentOwners.get(item) ?? null;

      if (transfer) {
        transfers.push(transfer);
        if (transfer.from) {
          ownerSet.add(transfer.from);
        }
        if (transfer.to) {
          ownerSet.add(transfer.to);
          currentOwner = transfer.to;
        } else if (transfer.from) {
          currentOwner = transfer.from;
        }
      }

      for (const owner of owners) {
        ownerSet.add(owner);
      }
      if (transfer?.to) {
        currentOwner = transfer.to;
      } else if (transfer?.from && !transfer.to) {
        currentOwner = transfer.from;
      } else if (owners.length === 1) {
        currentOwner = owners[0];
      } else if (owners.length > 1) {
        currentOwner = null;
      }

      if (owners.length > 1) {
        ambiguities.push({
          item,
          owners,
          evidence: sentence,
        });
      } else if (owners.length === 0 && SINGULAR_OWNER_PRONOUN_REGEX.test(sentence) && ownerSet.size > 1) {
        ambiguities.push({
          item,
          owners: [...ownerSet],
          evidence: sentence,
        });
      } else if (owners.length === 0 && !currentOwner && ownerSet.size > 1 && hasOwnershipCue(sentence, item)) {
        ambiguities.push({
          item,
          owners: [...ownerSet],
          evidence: sentence,
        });
      }

      knownOwners.set(item, ownerSet);
      currentOwners.set(item, currentOwner);
    }
  }

  const uniqueAmbiguities = ambiguities.filter((item, index) => (
    ambiguities.findIndex((entry) => entry.item === item.item && entry.evidence === item.evidence) === index
  ));

  return {
    trackedItems: normalizedItems,
    transfers,
    ambiguities: uniqueAmbiguities,
  };
}
