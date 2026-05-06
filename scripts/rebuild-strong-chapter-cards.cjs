#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const process = require("node:process");

const { getLLM } = require("../server/dist/llm/factory.js");
const { prisma } = require("../server/dist/db/prisma.js");
const { NovelVolumeService } = require("../server/dist/services/novel/volume/NovelVolumeService.js");
const { buildTaskSheetFromVolumeChapter } = require("../server/dist/services/novel/volume/volumePlanUtils.js");

const DEFAULT_PROVIDER = "minimax";
const DEFAULT_MODEL = process.env.MINIMAX_MODEL || "MiniMax-M2.7";
const DEFAULT_GROUP_SIZE = 10;
const DEFAULT_TEMPERATURE = 0.45;
const DEFAULT_MAX_TOKENS = 2000;
const TEMPLATE_MARKERS = [
  "在《",
  "本章重点是",
  "围绕“",
  "围绕\"",
  "这一段",
  "阶段回报",
  "向前掀开一层",
  "让《",
];
const VOLUME_BASE_BANKS = {
  1: ["药谷", "黑矿", "祠堂", "祖宅", "矿票", "灵芝", "尸灯", "禁井", "山门", "外门", "秘库", "地脉", "天盖", "路引", "矿册", "灵玉", "封井", "祭坛", "赌棚", "城门"],
  2: ["星舟", "重水", "边荒", "星港", "航图", "军帐", "界海", "风暴", "祖舰", "城塞", "烽火", "骨舟", "界核", "荒港", "斥候", "血旗", "王旗", "虚空", "舷窗", "裂星"],
  3: ["真骨", "骨文", "命骨", "祖地", "骨桥", "剥骨台", "熔骨池", "脊印", "内星界", "祖骨", "王庭", "猎场", "角斗", "血冠", "祭骨坛", "兽巢", "骨鼎", "裂原", "天坑", "古巢"],
  4: ["书院", "愿力", "香火", "县城", "驿路", "旧案", "茶肆", "匾额", "官印", "王朝", "祠庙", "纸灯", "城隍", "学舍", "旧律", "河埠", "夜市", "渡口", "田册", "学说"],
  5: ["积气", "天机", "归墟", "旧帝", "道祖", "太虚", "斩源", "天幕", "法则", "愿海", "苍生", "棋盘", "神座", "无极", "道规", "旧天", "黑祸", "裂界", "空庭", "源门"],
};
const STAGE_KEYWORD_BANKS = {
  坠星: ["星纹", "残阵", "星骸", "血契", "试炼", "星门", "禁芝", "药鼎", "黑井", "星图"],
  宗门: ["功牌", "戒律堂", "考核台", "执事房", "藏经阶", "秘库", "山门", "外门", "药案", "地脉图"],
  九城: ["税契", "暗市", "坊巷", "城票", "河闸", "坊牌", "商路", "巷战", "牙行", "仓券"],
  地脉: ["阵眼", "裂谷", "灵核", "火口", "山腹", "界桩", "古碑", "地火", "矿河", "断脉"],
  天盖: ["穹顶", "雷孔", "天门", "断碑", "界壁", "祭阵", "古图", "裂缝", "封纹", "天锁"],
  星海: ["重水", "风暴", "虚空", "祖舰", "航图", "星港", "边荒", "界海", "舷窗", "裂星"],
  边荒: ["城塞", "军令", "烽火", "界墙", "斥候", "骨舟", "荒港", "军帐", "血旗", "星炮"],
  万族: ["王庭", "祖坛", "血裔", "猎场", "界核", "王旗", "兽潮", "角斗", "祖骨", "战域"],
  真骨: ["骨文", "剥骨台", "熔骨池", "脊印", "内星界", "祖骨", "骨鼎", "命骨", "骨桥", "骨冠"],
  化凡: ["驿路", "县衙", "香案", "学舍", "夜市", "田册", "旧案", "纸灯", "城隍", "茶肆"],
  红尘: ["匾额", "官印", "愿力", "王朝", "渡口", "旧律", "学说", "河埠", "民船", "祠庙"],
  无极: ["源门", "积气", "天机", "归墟", "旧帝", "法则", "苍生", "无极", "道规", "太虚"],
};
const DEFAULT_VOLUME_ENEMIES = {
  1: ["严承岳", "顾长庚", "季寒庐", "宋九枯"],
  2: ["裴照庭", "澹台灭尘", "司天烬"],
  3: ["裴照庭", "罗刹骨母", "司天烬"],
  4: ["玄阙子", "厉无咎", "旧帝系"],
  5: ["归墟黑祸", "旧日大帝", "诸天道祖"],
};
const PURPOSE_TEMPLATES = [
  (ctx) => `把${ctx.stageShort}的公开危机立起来，让“${ctx.objectiveShort}”从私下筹划变成见血的明牌。`,
  (ctx) => `补足${ctx.stageShort}的行动路径，让主角在挨压之外真正摸到一条可执行的缝隙。`,
  (ctx) => `交付这轮冲突第一次实打实的线索收益，让后续反制不再只是空想。`,
  (ctx) => `让主角把旧筹码换成新位置，完成一次局面转向。`,
  (ctx) => `制造一次代价明确的失手，逼主角承认旧办法已经撑不住眼前的压迫。`,
  (ctx) => `兑现${ctx.stageShort}里的第一次有效反击，把主动权从敌手那边撕回来一截。`,
  (ctx) => `掀开最值钱的真相，让世界观或人物底牌真正改写接下来的行动顺序。`,
  (ctx) => `把战线抬高一个层级，让当前冲突从试探正式转入硬碰硬。`,
  (ctx) => `完成这一组最狠的一次碰撞，把代价和收益都推到卷内高点。`,
  (ctx) => `收住本组短回报，同时把下一段更大的任务和危险提前钉死。`,
];

function parseArgs(argv) {
  const result = {};
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      result[key] = true;
      continue;
    }
    result[key] = next;
    index += 1;
  }
  return result;
}

function toInt(value, fallback) {
  if (value == null) {
    return fallback;
  }
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toFloat(value, fallback) {
  if (value == null) {
    return fallback;
  }
  const parsed = Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stripThink(text) {
  return String(text || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function stripCodeFence(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }
  return trimmed
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
}

function extractJson(text) {
  const cleaned = stripCodeFence(stripThink(text));
  const firstBrace = cleaned.indexOf("{");
  const firstBracket = cleaned.indexOf("[");
  let start = -1;
  if (firstBrace === -1) {
    start = firstBracket;
  } else if (firstBracket === -1) {
    start = firstBrace;
  } else {
    start = Math.min(firstBrace, firstBracket);
  }
  if (start === -1) {
    throw new Error("模型输出中未找到 JSON 起始字符。");
  }

  const openChar = cleaned[start];
  const closeChar = openChar === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < cleaned.length; index += 1) {
    const char = cleaned[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === openChar) {
      depth += 1;
      continue;
    }
    if (char === closeChar) {
      depth -= 1;
      if (depth === 0) {
        return cleaned.slice(start, index + 1);
      }
    }
  }

  throw new Error("模型输出中的 JSON 未完整闭合。");
}

function compactText(text, limit) {
  const normalized = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, limit - 1))}…`;
}

function cleanTitle(value) {
  return String(value || "")
    .replace(/[《》"'`]/g, "")
    .replace(/\s+/g, "")
    .trim();
}

function normalizeChapterValue(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeLooseText(text) {
  return String(text || "")
    .replace(/[“”"'`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function safeSliceWords(text, limit = 12) {
  const normalized = normalizeLooseText(text);
  if (!normalized) {
    return "";
  }
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit)}…`;
}

function countLeadingPrefix(values, size) {
  const map = new Map();
  for (const value of values) {
    const title = cleanTitle(value);
    const prefix = title.slice(0, Math.min(size, title.length));
    if (!prefix) {
      continue;
    }
    map.set(prefix, (map.get(prefix) || 0) + 1);
  }
  return map;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function buildCharacterBriefs(characters) {
  return characters.map((item) => {
    const parts = [
      item.name,
      item.role,
      item.storyFunction,
      item.relationToProtagonist ? `关系:${item.relationToProtagonist}` : "",
      item.currentGoal ? `当前目标:${item.currentGoal}` : "",
    ].filter(Boolean);
    return parts.join(" | ");
  });
}

function buildNovelContext(novel) {
  return {
    title: novel.title,
    description: novel.description,
    targetAudience: novel.targetAudience,
    sellingPoint: novel.bookSellingPoint,
    first30ChapterPromise: novel.first30ChapterPromise,
    narrativePov: novel.narrativePov,
    styleTone: novel.styleTone,
    estimatedChapterCount: novel.estimatedChapterCount,
    genre: novel.genre?.name || "",
    world: novel.world?.name || "",
    characters: buildCharacterBriefs(novel.characters || []).slice(0, 12),
  };
}

function formatChapterSeed(chapter) {
  return [
    `${chapter.chapterOrder} | 旧标题:${compactText(chapter.title, 18)}`,
    `原摘要:${compactText(chapter.summary, 110)}`,
    `原功能:${compactText(chapter.purpose, 70)}`,
    chapter.payoffRefs?.length ? `旧兑现:${chapter.payoffRefs.join("、")}` : "",
  ].filter(Boolean).join(" | ");
}

function formatTailSeed(chapter) {
  return [
    `${chapter.chapterOrder}.${compactText(chapter.title, 18)}`,
    compactText(chapter.summary, 100),
    chapter.payoffRefs?.length ? `兑现:${chapter.payoffRefs.join("、")}` : "",
  ].filter(Boolean).join(" | ");
}

function buildPrompt({ novelContext, volume, currentGroup, previousTail, nextBridge, retryNotes }) {
  const lines = [
    "你是长篇原创仙侠小说的卷规划编辑，要把一组 10 章的模板骨架改写成能稳定驱动正文生成的强章卡。",
    "",
    "硬性要求：",
    "1. 必须保留既有的卷方向、境界位置、世界法则和角色关系，不得跳卷，不得改世界观，不得把配角或反派大幅换人。",
    "2. 每一章都必须有唯一且具体的推进事件，不能写成“这一阶段推进什么”的概述。",
    "3. 同一组标题必须去模板化：",
    "   - 不允许出现批量同前缀，如“家门XX / 坠星XX / 化凡XX / 骨海XX”。",
    "   - 同一组 10 章里，标题首字相同的数量不能超过 3 个；标题前两字相同的数量不能超过 2 个。",
    "   - 标题要有画面、有动作、有对象，但不要堆砌辞藻。",
    "4. summary 必须明确写清：谁发难、主角或关键角色做了什么、得到或失去什么、章末如何把人推向下一章。",
    "5. purpose 只写这一章在本卷中的功能，不能复读 summary，也不能出现空话。",
    "6. payoffRefs 写 3 到 5 个短词，必须具体，不能写“推进主线/升级/冲突加深”这种空词。",
    "7. 禁止出现模板化提示语，例如：在《、本章重点是、围绕、这一段、阶段回报、向前掀开一层。",
    "8. 保持中文输出，只输出 JSON，不要解释，不要 markdown，不要补充说明。",
    "",
    "输出格式：",
    "{",
    '  "chapters": [',
    "    {",
    '      "chapterOrder": 31,',
    '      "title": "...",',
    '      "summary": "90到160字，具体到事件与结果",',
    '      "purpose": "30到60字，只写卷内功能",',
    '      "payoffRefs": ["...", "...", "..."]',
    "    }",
    "  ]",
    "}",
    "",
    `小说上下文：${JSON.stringify(novelContext, null, 2)}`,
    `当前卷信息：${JSON.stringify({ title: volume.title, summary: volume.summary }, null, 2)}`,
    previousTail.length
      ? `上一组已定内容（用于承接）：\n${previousTail.map(formatTailSeed).join("\n")}`
      : "上一组已定内容：无",
    nextBridge.length
      ? `下一组原骨架桥接（只用于避免本组越界）：\n${nextBridge.map(formatTailSeed).join("\n")}`
      : "下一组原骨架桥接：无",
    `待改写原骨架：\n${currentGroup.map(formatChapterSeed).join("\n")}`,
  ];

  if (retryNotes.length > 0) {
    lines.push("", `上一次输出失败原因：${retryNotes.join("；")}`);
  }

  return lines.join("\n");
}

function chapterLooksStrong(chapter) {
  const summary = normalizeChapterValue(chapter.summary);
  const purpose = normalizeChapterValue(chapter.purpose);
  const hasTemplateMarker = TEMPLATE_MARKERS.some((marker) => summary.includes(marker) || purpose.includes(marker));
  return !hasTemplateMarker && summary.length >= 80 && purpose.length >= 28;
}

function validateGroupResult(result, group, usedTitleSet) {
  assert(result && Array.isArray(result.chapters), "模型没有返回 chapters 数组。");
  assert(result.chapters.length === group.length, `模型返回 ${result.chapters.length} 章，期望 ${group.length} 章。`);

  const seenTitles = new Set();
  const normalized = result.chapters.map((item, index) => {
    const expectedOrder = group[index].chapterOrder;
    assert(Number(item.chapterOrder) === expectedOrder, `章节顺序错误，期望 ${expectedOrder}，实际 ${item.chapterOrder}。`);
    const title = cleanTitle(item.title);
    const summary = normalizeChapterValue(item.summary);
    const purpose = normalizeChapterValue(item.purpose);
    const payoffRefs = Array.isArray(item.payoffRefs)
      ? item.payoffRefs.map((entry) => compactText(String(entry || "").trim(), 18)).filter(Boolean)
      : [];

    assert(title.length >= 4, `第 ${expectedOrder} 章标题过短。`);
    assert(summary.length >= 80, `第 ${expectedOrder} 章摘要过短。`);
    assert(purpose.length >= 28, `第 ${expectedOrder} 章功能说明过短。`);
    assert(payoffRefs.length >= 3 && payoffRefs.length <= 5, `第 ${expectedOrder} 章 payoffRefs 数量不合规。`);

    for (const marker of TEMPLATE_MARKERS) {
      assert(!summary.includes(marker), `第 ${expectedOrder} 章摘要仍含模板词：${marker}`);
      assert(!purpose.includes(marker), `第 ${expectedOrder} 章功能仍含模板词：${marker}`);
    }

    assert(!seenTitles.has(title), `同组内标题重复：${title}`);
    seenTitles.add(title);
    assert(!usedTitleSet.has(title), `全书标题重复：${title}`);

    return {
      chapterOrder: expectedOrder,
      title,
      summary,
      purpose,
      payoffRefs,
    };
  });

  const titles = normalized.map((item) => item.title);
  const firstCharCounts = countLeadingPrefix(titles, 1);
  const firstTwoCounts = countLeadingPrefix(titles, 2);
  const maxFirstCharRepeat = Math.max(0, ...firstCharCounts.values());
  const maxFirstTwoRepeat = Math.max(0, ...firstTwoCounts.values());
  assert(maxFirstCharRepeat <= 3, `同组标题首字重复过多，最大重复 ${maxFirstCharRepeat}。`);
  assert(maxFirstTwoRepeat <= 2, `同组标题前两字重复过多，最大重复 ${maxFirstTwoRepeat}。`);

  return normalized;
}

function parseTemplateContext(group, volumeOrder) {
  const source = group.find((chapter) => TEMPLATE_MARKERS.some((marker) => String(chapter.summary || "").includes(marker)))
    || group[0];
  const summary = String(source.summary || "");
  const stage = summary.match(/的「(.+?)」阶段/)?.[1] || safeSliceWords(source.title || "", 8) || `第${volumeOrder}卷支线`;
  const objective = summary.match(/周衍为(.+?)被迫/)?.[1]
    || summary.match(/为(.+?)被迫/)?.[1]
    || safeSliceWords(source.purpose || source.summary, 16);
  const pressure = summary.match(/正面撞上(.+?)。/)?.[1] || "";
  const reveal = summary.match(/并把“(.+?)”/)?.[1] || "";
  const antagonists = summary.match(/同时让(.+?)相关压力/)?.[1] || "";
  return {
    stage: normalizeLooseText(stage),
    objective: normalizeLooseText(objective),
    pressure: normalizeLooseText(pressure),
    reveal: normalizeLooseText(reveal),
    antagonists: normalizeLooseText(antagonists),
  };
}

function extractNames(text) {
  const banned = new Set(["周衍", "闻人星阑", "本章重点", "这一段", "阶段回报", "浑天星海", "盖天法界", "宣夜无极界"]);
  return Array.from(new Set(
    String(text || "")
      .split(/[与和、，,\s]+/)
      .map((item) => item.trim())
      .filter((item) => /^[\u4e00-\u9fa5]{2,4}$/.test(item))
      .filter((item) => !banned.has(item)),
  ));
}

function pickPoolForGroup(ctx, volumeOrder, startOrder) {
  const pool = [];
  const seen = new Set();
  const pushWord = (word) => {
    const next = normalizeLooseText(word);
    if (!next || seen.has(next)) {
      return;
    }
    seen.add(next);
    pool.push(next);
  };

  const combinedText = `${ctx.stage} ${ctx.objective} ${ctx.pressure} ${ctx.reveal}`;
  const matchedStageWords = [];
  for (const [keyword, words] of Object.entries(STAGE_KEYWORD_BANKS)) {
    if (combinedText.includes(keyword)) {
      for (const word of words) {
        matchedStageWords.push(word);
      }
    }
  }

  for (const word of matchedStageWords) {
    pushWord(word);
  }
  for (const word of VOLUME_BASE_BANKS[volumeOrder] || []) {
    pushWord(word);
  }

  const rotated = [];
  const headCount = Math.min(10, pool.length);
  const stableHead = pool.slice(0, headCount);
  const tail = pool.slice(headCount);
  const offset = tail.length > 0 ? startOrder % tail.length : 0;
  for (const word of stableHead) {
    rotated.push(word);
  }
  for (let index = 0; index < tail.length; index += 1) {
    rotated.push(tail[(offset + index) % tail.length]);
  }
  return rotated.slice(0, 20);
}

function beatSuffix(chapter, index) {
  const known = ["起祸", "探缝", "得线", "换筹", "失手", "反咬", "见秘", "破门", "死斗", "埋钩"];
  const title = String(chapter.title || "");
  const hit = known.find((item) => title.endsWith(item));
  return hit || known[index % known.length];
}

function shortEnemyList(ctx, volumeOrder) {
  const parsed = extractNames(ctx.antagonists);
  if (parsed.length > 0) {
    return parsed;
  }
  return DEFAULT_VOLUME_ENEMIES[volumeOrder] || ["敌手"];
}

function makeTitleByBeat(nounA, nounB, beat) {
  switch (beat) {
    case "起祸":
      return `${nounA}${nounB}起血口`;
    case "探缝":
      return `${nounA}背后的${nounB}`;
    case "得线":
      return `${nounA}里摸到${nounB}`;
    case "换筹":
      return `拿${nounA}换${nounB}`;
    case "失手":
      return `${nounA}反噬到${nounB}`;
    case "反咬":
      return `借${nounA}咬穿${nounB}`;
    case "见秘":
      return `${nounA}替${nounB}开口`;
    case "破门":
      return `踏进${nounA}${nounB}门`;
    case "死斗":
      return `为${nounA}和${nounB}见血`;
    case "埋钩":
      return `${nounA}后面那张${nounB}牌`;
    default:
      return `${nounA}撞上${nounB}`;
  }
}

function buildSummaryByBeat({ beat, ctx, nounA, nounB, enemyA, enemyB, nextHint }) {
  const objectiveShort = ctx.objective || "抢先活下去";
  const pressureShort = ctx.pressure || "旧势力都盯上这件事";
  const revealShort = ctx.reveal || `${ctx.stage}背后的真相`;
  const nextText = nextHint ? `章末${nextHint}` : `章末${enemyB || enemyA}顺着痕迹逼近`;
  switch (beat) {
    case "起祸":
      return `${enemyA}先借“${pressureShort}”发难，把${ctx.stage}牵出的风险推到台前。周衍为了${objectiveShort}，只能抢先在${nounA}上动手，用星相仪找出${nounB}的薄弱处并抢下一笔急用筹码。他虽然暂时稳住场面，却也让${revealShort}第一次露给外人，${nextText}，事情被直接推向下一章。`;
    case "探缝":
      return `周衍顺着上一章留下的窟窿去摸${nounA}里的暗路，想为“${objectiveShort}”找一条能落脚的办法。${enemyA}的人在外头封路，${enemyB || enemyA}又在暗处盯着他失手，他只好边躲边算，靠星相仪从${nounB}里抠出一条缝。他拿到第一条可执行的路径，却也确认${pressureShort}远比想象更早合围，${nextText}。`;
    case "得线":
      return `为了不被${pressureShort}彻底压死，周衍冒险切进${nounA}最深处，终于从${nounB}里摸到一条硬线索。线索不只指向${objectiveShort}的解法，也把${revealShort}往前推了一步。可他刚把东西攥住，${enemyA}便顺势补了一刀，让这份收益立刻变成新的风险，${nextText}。`;
    case "换筹":
      return `周衍把手里旧有的${nounA}抬上桌面，逼自己用最不愿意动的筹码去换位置。${enemyA}想借此把他榨干，${enemyB || enemyA}则等着看他空手而归，他却反过来把${nounB}扣成交易条件，勉强换来一步喘息。代价是他不得不让${revealShort}的部分线头继续外露，${nextText}。`;
    case "失手":
      return `局面被越推越险后，周衍在${nounA}上第一次真正失手。${enemyA}顺势放大${pressureShort}，逼得他原本准备好的退路一口气全废，连带着${nounB}也被反噬拖进来。他虽然勉强捞回半条命，却明白旧办法已经兜不住眼前的压迫，${nextText}，更狠的碰撞被逼到了眼前。`;
    case "反咬":
      return `周衍不再只想着挨过去，而是借${nounA}里的破绽狠狠干回一口。${enemyA}本以为他会继续后撤，没想到他反过来把${nounB}扣成套子，让对方先吃下一记闷亏。这一口反咬没能彻底翻盘，却把主动权重新撕回一截，也让${revealShort}的价值被更多人看见，${nextText}。`;
    case "见秘":
      return `逼到这一步后，藏在${nounA}里的秘密终于松口。周衍顺着${nounB}掀开了${ctx.stage}最值钱的一层底牌，不但确认了${revealShort}，也看见${objectiveShort}背后真正要付出的代价。可秘密一旦见光，${enemyA}就不可能再慢慢下棋，${nextText}，下一章只能往更硬的地方闯。`;
    case "破门":
      return `线索、代价和敌手都堆到一起后，周衍只能硬着头皮踏进${nounA}那道门。门后不止有${objectiveShort}必须要的东西，也有${enemyA}提前埋好的杀机。他靠星相仪和一记险招从${nounB}上撕出活口，终于把战线从局部试探抬到了正面冲撞，可这一步迈过去，退路也跟着烧掉了，${nextText}。`;
    case "死斗":
      return `${enemyA}把压迫推到最狠，周衍也被逼到只能为${nounA}拼一次见血的硬仗。双方围着${nounB}狠狠干了一场，失去和得到都在同一章里见真章。周衍虽然咬着牙换掉了最关键的阻碍，却也因此背上新的伤和新的账，${nextText}，这一组的代价在此刻彻底坐实。`;
    case "埋钩":
      return `这一组短线收益终于落袋，周衍把${nounA}和${nounB}捏在手里，勉强收住了眼前这口气。可他越是把账目算清，越能看见${revealShort}背后那只更大的手没有离开。${enemyA}暂时退开不代表事情结束，反而说明下一段会围着“${objectiveShort}”开更大的局，${nextText}，钩子被直接抛到后面。`;
    default:
      return `周衍围着${nounA}和${nounB}继续推进“${objectiveShort}”，同时承受${pressureShort}带来的新一轮挤压。局面虽然没有当场崩盘，却被${enemyA}顺势推到了更危险的位置，${nextText}。`;
  }
}

function buildFallbackGroup(currentGroup, volume, previousTail, nextBridge) {
  const ctx = parseTemplateContext(currentGroup, volume.sortOrder);
  const nouns = pickPoolForGroup(ctx, volume.sortOrder, currentGroup[0].chapterOrder);
  const enemies = shortEnemyList(ctx, volume.sortOrder);
  const nextHint = nextBridge[0]
    ? `${safeSliceWords(nextBridge[0].title, 10)}的局顺势压了过来`
    : "";
  const stageShort = safeSliceWords(ctx.stage || volume.title, 8) || safeSliceWords(volume.title, 8);
  const objectiveShort = safeSliceWords(ctx.objective || "活下去并抢到解法", 14);
  const revealShort = safeSliceWords(ctx.reveal || `${stageShort}的真相`, 14);

  return currentGroup.map((chapter, index) => {
    const beat = beatSuffix(chapter, index);
    const nounA = nouns[index % nouns.length] || `旧局${index + 1}`;
    const nounB = nouns[(index + 7) % nouns.length] || `暗口${index + 1}`;
    const title = makeTitleByBeat(nounA, nounB, beat);
    const summary = buildSummaryByBeat({
      beat,
      ctx,
      nounA,
      nounB,
      enemyA: enemies[0] || "旧敌",
      enemyB: enemies[1] || enemies[0] || "追兵",
      nextHint,
    });
    const purpose = (PURPOSE_TEMPLATES[index] || PURPOSE_TEMPLATES[0])({
      stageShort,
      objectiveShort,
      revealShort,
    });
    const payoffRefs = [
      nounA,
      objectiveShort.replace(/[…。，“”]/g, ""),
      revealShort.replace(/[…。，“”]/g, ""),
      enemies[0] || "旧敌追压",
    ].map((item) => compactText(item, 18)).filter(Boolean).slice(0, 4);

    return {
      chapterOrder: chapter.chapterOrder,
      title,
      summary,
      purpose,
      payoffRefs,
    };
  });
}

function isTitleOnlyError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /标题|首字|前两字/.test(message);
}

async function repairTitles({ llm, chapters, usedTitleSet, retryNotes }) {
  const prompt = [
    "你是网络小说章节标题编辑，只负责改标题，不改剧情内容。",
    "请根据下面 10 章的 chapterOrder 与 summary，重写标题并满足规则：",
    "1. 标题必须各不相同，且不能与已使用标题重复。",
    "2. 同一组里标题首字相同的数量不能超过 3 个；前两字相同的数量不能超过 2 个。",
    "3. 标题要具体、有画面，不要空泛，不要写成同前缀模板。",
    "4. 只输出 JSON，不要解释。",
    "",
    "输出格式：",
    "{",
    '  "titles": [',
    '    { "chapterOrder": 31, "title": "..." }',
    "  ]",
    "}",
    "",
    retryNotes.length ? `上次失败原因：${retryNotes.join("；")}` : "",
    usedTitleSet.size
      ? `已使用标题（禁止重复）：${Array.from(usedTitleSet).slice(-40).join("、")}`
      : "",
    `待改标题章节：${JSON.stringify(chapters.map((item) => ({
      chapterOrder: item.chapterOrder,
      summary: compactText(item.summary, 120),
    })), null, 2)}`,
  ].filter(Boolean).join("\n");

  const response = await llm.invoke(prompt);
  const parsed = JSON.parse(extractJson(String(response.content || "")));
  assert(parsed && Array.isArray(parsed.titles), "标题修复没有返回 titles 数组。");
  assert(parsed.titles.length === chapters.length, "标题修复返回数量不对。");

  const titleMap = new Map();
  for (const item of parsed.titles) {
    titleMap.set(Number(item.chapterOrder), cleanTitle(item.title));
  }

  return chapters.map((chapter) => ({
    ...chapter,
    title: titleMap.get(chapter.chapterOrder) || chapter.title,
  }));
}

function simplifyWorkingVolumes(volumes) {
  return volumes.map((volume) => ({
    id: volume.id,
    title: volume.title,
    summary: volume.summary,
    sortOrder: volume.sortOrder,
    status: volume.status,
    openingHook: volume.openingHook,
    escalationMode: volume.escalationMode,
    climax: volume.climax,
    nextVolumeHook: volume.nextVolumeHook,
    protagonistChange: volume.protagonistChange,
    primaryPressureSource: volume.primaryPressureSource,
    coreSellingPoint: volume.coreSellingPoint,
    payoffType: volume.payoffType,
    mainPromise: volume.mainPromise,
    midVolumeRisk: volume.midVolumeRisk,
    resetPoint: volume.resetPoint,
    openPayoffs: Array.isArray(volume.openPayoffs) ? volume.openPayoffs : [],
    chapters: volume.chapters.map((chapter) => ({
      id: chapter.id,
      chapterOrder: chapter.chapterOrder,
      title: chapter.title,
      summary: chapter.summary,
      purpose: chapter.purpose,
      targetWordCount: chapter.targetWordCount,
      conflictLevel: chapter.conflictLevel,
      revealLevel: chapter.revealLevel,
      mustAvoid: chapter.mustAvoid,
      payoffRefs: Array.isArray(chapter.payoffRefs) ? chapter.payoffRefs : [],
      taskSheet: chapter.taskSheet,
    })),
  }));
}

function cloneVolumes(volumes) {
  return JSON.parse(JSON.stringify(simplifyWorkingVolumes(volumes)));
}

function flattenWorkingChapters(volumes) {
  return volumes.flatMap((volume) => volume.chapters.map((chapter) => ({
    volumeId: volume.id,
    volumeOrder: volume.sortOrder,
    volumeTitle: volume.title,
    ...chapter,
  })));
}

function flattenChapterRefs(volumes) {
  return volumes.flatMap((volume) => volume.chapters.map((chapter) => ({
    volume,
    chapter,
  })));
}

function findGroupRange(flattened, startOrder, groupSize) {
  return flattened.filter((chapter) => chapter.chapterOrder >= startOrder && chapter.chapterOrder < startOrder + groupSize);
}

function replaceGroupInVolumes(workingVolumes, generatedGroup) {
  const chapterByOrder = new Map(generatedGroup.map((item) => [item.chapterOrder, item]));
  for (const volume of workingVolumes) {
    volume.chapters = volume.chapters.map((chapter) => {
      const generated = chapterByOrder.get(chapter.chapterOrder);
      if (!generated) {
        return chapter;
      }
      const nextChapter = {
        ...chapter,
        title: generated.title,
        summary: generated.summary,
        purpose: generated.purpose,
        payoffRefs: generated.payoffRefs,
      };
      nextChapter.taskSheet = buildTaskSheetFromVolumeChapter(nextChapter);
      return nextChapter;
    });
  }
}

function saveProgress(progressFile, payload) {
  fs.mkdirSync(path.dirname(progressFile), { recursive: true });
  fs.writeFileSync(progressFile, JSON.stringify(payload, null, 2));
}

function loadProgress(progressFile) {
  if (!fs.existsSync(progressFile)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(progressFile, "utf8"));
}

async function generateGroup({
  llm,
  novelContext,
  volume,
  currentGroup,
  previousTail,
  nextBridge,
  usedTitleSet,
}) {
  const retryNotes = [];
  let lastRaw = "";
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const prompt = buildPrompt({
      novelContext,
      volume,
      currentGroup,
      previousTail,
      nextBridge,
      retryNotes,
    });
    const response = await llm.invoke(prompt);
    lastRaw = String(response.content || "");
    try {
      const parsed = JSON.parse(extractJson(lastRaw));
      try {
        return validateGroupResult(parsed, currentGroup, usedTitleSet);
      } catch (error) {
        if (!isTitleOnlyError(error)) {
          throw error;
        }
        const fixedChapters = await repairTitles({
          llm,
          chapters: parsed.chapters.map((item) => ({
            chapterOrder: Number(item.chapterOrder),
            title: cleanTitle(item.title),
            summary: normalizeChapterValue(item.summary),
            purpose: normalizeChapterValue(item.purpose),
            payoffRefs: Array.isArray(item.payoffRefs) ? item.payoffRefs : [],
          })),
          usedTitleSet,
          retryNotes: [error instanceof Error ? error.message : String(error)],
        });
        return validateGroupResult({ chapters: fixedChapters }, currentGroup, usedTitleSet);
      }
    } catch (error) {
      retryNotes.push(`第 ${attempt} 次失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return buildFallbackGroup(currentGroup, volume, previousTail, nextBridge);
}

function collectExactDuplicateTitles(volumes) {
  const map = new Map();
  for (const chapter of flattenWorkingChapters(volumes)) {
    const title = cleanTitle(chapter.title);
    if (!map.has(title)) {
      map.set(title, []);
    }
    map.get(title).push(chapter.chapterOrder);
  }
  return Array.from(map.entries())
    .filter(([, orders]) => orders.length > 1)
    .map(([title, orders]) => ({ title, orders }));
}

function resolveDuplicateTitlesInRange(volumes, startOrder, endOrder) {
  const flat = flattenChapterRefs(volumes)
    .filter(({ chapter }) => chapter.chapterOrder >= startOrder && chapter.chapterOrder <= endOrder)
    .sort((a, b) => a.chapter.chapterOrder - b.chapter.chapterOrder);
  const titleMap = new Map();
  for (const entry of flat) {
    const title = cleanTitle(entry.chapter.title);
    if (!titleMap.has(title)) {
      titleMap.set(title, []);
    }
    titleMap.get(title).push(entry.chapter);
  }

  const used = new Set(flat.map(({ chapter }) => cleanTitle(chapter.title)));
  for (const [title, chapters] of titleMap.entries()) {
    if (chapters.length <= 1) {
      continue;
    }
    chapters.slice(1).forEach((chapter, index) => {
      used.delete(title);
      const suffixA = normalizeLooseText(chapter.payoffRefs?.[0] || "").slice(0, 4);
      const suffixB = normalizeLooseText(chapter.payoffRefs?.[1] || "").slice(0, 4);
      const candidates = [
        `${title}${suffixA}`,
        `${title}${suffixB}`,
        `${title}${chapter.chapterOrder}`,
        `${title}${index + 2}`,
      ].map((item) => cleanTitle(item));
      const nextTitle = candidates.find((item) => item && !used.has(item)) || `${title}${chapter.chapterOrder}`;
      used.add(nextTitle);
      chapter.title = nextTitle;
    });
  }
}

function collectTemplateLeaks(volumes) {
  const leaks = [];
  for (const chapter of flattenWorkingChapters(volumes)) {
    for (const marker of TEMPLATE_MARKERS) {
      if (chapter.summary.includes(marker) || chapter.purpose.includes(marker)) {
        leaks.push({ chapterOrder: chapter.chapterOrder, marker });
        break;
      }
    }
  }
  return leaks;
}

function filterFlatByRange(flat, startOrder, endOrder) {
  return flat.filter((chapter) => chapter.chapterOrder >= startOrder && chapter.chapterOrder <= endOrder);
}

async function syncExecutionChapters(novelId, volumes) {
  const flat = flattenWorkingChapters(volumes);
  for (const chapter of flat) {
    await prisma.chapter.updateMany({
      where: { novelId, order: chapter.chapterOrder },
      data: {
        title: chapter.title,
        expectation: chapter.summary,
        taskSheet: chapter.taskSheet,
      },
    });
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const novelId = String(args["novel-id"] || "").trim();
  if (!novelId) {
    throw new Error("必须提供 --novel-id。");
  }

  const provider = String(args.provider || DEFAULT_PROVIDER).trim();
  const model = String(args.model || DEFAULT_MODEL).trim();
  const groupSize = toInt(args["group-size"], DEFAULT_GROUP_SIZE);
  const temperature = toFloat(args.temperature, DEFAULT_TEMPERATURE);
  const maxTokens = toInt(args["max-tokens"], DEFAULT_MAX_TOKENS);
  const startOrder = toInt(args["start-order"], 1);
  const endOrder = toInt(args["end-order"], Number.MAX_SAFE_INTEGER);
  const maxGroups = args["max-groups"] ? toInt(args["max-groups"], 0) : 0;
  const dryRun = Boolean(args["dry-run"]);
  const progressFile = String(
    args["progress-file"]
      || path.join(process.cwd(), ".tmp", `rebuild-strong-chapter-cards-${novelId}.json`),
  );
  const fallbackOnly = Boolean(args["fallback-only"]);

  const novel = await prisma.novel.findUnique({
    where: { id: novelId },
    select: {
      id: true,
      title: true,
      description: true,
      targetAudience: true,
      bookSellingPoint: true,
      first30ChapterPromise: true,
      narrativePov: true,
      styleTone: true,
      estimatedChapterCount: true,
      genre: { select: { name: true } },
      world: { select: { name: true } },
      characters: {
        select: {
          name: true,
          role: true,
          storyFunction: true,
          relationToProtagonist: true,
          currentGoal: true,
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  assert(novel, "小说不存在。");

  const service = new NovelVolumeService();
  const doc = await service.getVolumes(novelId);
  const novelContext = buildNovelContext(novel);

  const progress = loadProgress(progressFile);
  const workingVolumes = progress?.workingVolumes
    ? JSON.parse(JSON.stringify(progress.workingVolumes))
    : cloneVolumes(doc.volumes);

  const originalFlat = flattenWorkingChapters(cloneVolumes(doc.volumes));
  const allGroups = [];
  for (const volume of doc.volumes) {
    for (let index = 0; index < volume.chapters.length; index += groupSize) {
      const group = volume.chapters.slice(index, index + groupSize);
      if (!group.length) {
        continue;
      }
      const firstOrder = group[0].chapterOrder;
      const lastOrder = group[group.length - 1].chapterOrder;
      if (lastOrder < startOrder || firstOrder > endOrder) {
        continue;
      }
      allGroups.push({
        volumeId: volume.id,
        volumeTitle: volume.title,
        volumeSummary: volume.summary,
        startOrder: firstOrder,
        endOrder: lastOrder,
      });
    }
  }

  const pendingGroups = maxGroups > 0 ? allGroups.slice(0, maxGroups) : allGroups;
  const completedStarts = new Set(Array.isArray(progress?.completedStarts) ? progress.completedStarts : []);
  const llm = fallbackOnly
    ? null
    : await getLLM(provider, {
      model,
      temperature,
      maxTokens,
      taskType: "brainstorm",
    });

  for (const [groupIndex, meta] of pendingGroups.entries()) {
    const rangeKey = `${meta.startOrder}-${meta.endOrder}`;
    if (completedStarts.has(meta.startOrder)) {
      console.log(`[resume] skip ${rangeKey}`);
      continue;
    }

    const workingFlat = flattenWorkingChapters(workingVolumes);
    const currentGroup = findGroupRange(originalFlat, meta.startOrder, groupSize);
    const previousTail = workingFlat
      .filter((chapter) => chapter.chapterOrder < meta.startOrder)
      .slice(-2);
    const nextBridge = originalFlat
      .filter((chapter) => chapter.chapterOrder > meta.endOrder)
      .slice(0, 2);
    const volume = workingVolumes.find((item) => item.id === meta.volumeId);
    assert(volume, `未找到卷 ${meta.volumeTitle}。`);

    const usedTitleSet = new Set(
      workingFlat
        .filter((chapter) => chapter.chapterOrder < meta.startOrder || chapter.chapterOrder > meta.endOrder)
        .map((chapter) => cleanTitle(chapter.title)),
    );

    if (currentGroup.every(chapterLooksStrong) && !fallbackOnly) {
      console.log(`[group ${groupIndex + 1}/${pendingGroups.length}] keep ${rangeKey} ${meta.volumeTitle}`);
      completedStarts.add(meta.startOrder);
      saveProgress(progressFile, {
        novelId,
        provider,
        model,
        completedStarts: Array.from(completedStarts).sort((a, b) => a - b),
        workingVolumes,
        updatedAt: new Date().toISOString(),
      });
      continue;
    }

    console.log(`[group ${groupIndex + 1}/${pendingGroups.length}] regenerate ${rangeKey} ${meta.volumeTitle}${fallbackOnly ? " (fallback)" : ""}`);
    const generatedGroup = fallbackOnly
      ? buildFallbackGroup(currentGroup, volume, previousTail, nextBridge)
      : await generateGroup({
        llm,
        novelContext,
        volume,
        currentGroup,
        previousTail,
        nextBridge,
        usedTitleSet,
      });
    replaceGroupInVolumes(workingVolumes, generatedGroup);
    completedStarts.add(meta.startOrder);
    saveProgress(progressFile, {
      novelId,
      provider,
      model,
      completedStarts: Array.from(completedStarts).sort((a, b) => a - b),
      workingVolumes,
      updatedAt: new Date().toISOString(),
    });
  }

  const validationStart = startOrder;
  const validationEnd = endOrder === Number.MAX_SAFE_INTEGER
    ? flattenWorkingChapters(workingVolumes).slice(-1)[0]?.chapterOrder ?? Number.MAX_SAFE_INTEGER
    : endOrder;
  resolveDuplicateTitlesInRange(workingVolumes, validationStart, validationEnd);
  const validationFlat = filterFlatByRange(flattenWorkingChapters(workingVolumes), validationStart, validationEnd);
  const duplicates = collectExactDuplicateTitles([{
    id: "validation",
    title: "validation",
    summary: "",
    sortOrder: 0,
    status: "active",
    openingHook: "",
    escalationMode: "",
    climax: "",
    nextVolumeHook: "",
    protagonistChange: "",
    primaryPressureSource: "",
    coreSellingPoint: "",
    payoffType: "",
    mainPromise: "",
    midVolumeRisk: "",
    resetPoint: "",
    openPayoffs: [],
    chapters: validationFlat,
  }]);
  const leaks = validationFlat.flatMap((chapter) => {
    for (const marker of TEMPLATE_MARKERS) {
      if (chapter.summary.includes(marker) || chapter.purpose.includes(marker)) {
        return [{ chapterOrder: chapter.chapterOrder, marker }];
      }
    }
    return [];
  });
  assert(duplicates.length === 0, `仍有重复标题：${JSON.stringify(duplicates.slice(0, 5))}`);
  assert(leaks.length === 0, `仍有模板泄漏：${JSON.stringify(leaks.slice(0, 5))}`);

  if (!dryRun) {
    await service.updateVolumes(novelId, { volumes: workingVolumes });
    await syncExecutionChapters(novelId, workingVolumes);
  }

  const finalFlat = flattenWorkingChapters(workingVolumes);
  const output = {
    dryRun,
    novelId,
    provider,
    model,
    regeneratedGroupCount: pendingGroups.length,
    chapterCount: finalFlat.length,
    sampleHead: finalFlat.slice(0, 5).map((chapter) => ({ order: chapter.chapterOrder, title: chapter.title })),
    sampleTail: finalFlat.slice(-5).map((chapter) => ({ order: chapter.chapterOrder, title: chapter.title })),
    progressFile,
  };
  console.log(JSON.stringify(output, null, 2));
}

main()
  .catch((error) => {
    console.error(error && error.stack ? error.stack : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });
