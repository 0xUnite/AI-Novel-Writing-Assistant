const test = require("node:test");
const assert = require("node:assert/strict");

const {
  sanitizeGeneratedChapterContent,
  hasGeneratedReasoningLeak,
  compactRunawayRepeatedParagraphs,
} = require("../dist/services/novel/chapterContentSanitizer.js");

test("sanitizeGeneratedChapterContent strips think blocks and preserves chapter prose", () => {
  const input = [
    "<think>",
    "这里是模型的推理，不应该落库。",
    "</think>",
    "",
    "第一段正文。",
    "",
    "第二段正文。",
  ].join("\n");

  assert.equal(
    sanitizeGeneratedChapterContent(input),
    "第一段正文。\n\n第二段正文。",
  );
});

test("sanitizeGeneratedChapterContent normalizes markdown markers, quotes, waves and ellipsis", () => {
  const input = "\"你在做什么...\" *她叹了口气* ～";

  assert.equal(
    sanitizeGeneratedChapterContent(input),
    "“你在做什么……” 她叹了口气",
  );
});

test("sanitizeGeneratedChapterContent fixes reversed short quote pairs", () => {
  const input = "它不是从源点层”经过“，而是从源点层”发出“。最后一点”我“还在。";

  assert.equal(
    sanitizeGeneratedChapterContent(input),
    "它不是从源点层“经过”，而是从源点层“发出”。最后一点“我”还在。",
  );
});

test("sanitizeGeneratedChapterContent converts half-width punctuation to full-width sentence punctuation", () => {
  const input = "他问,你还好吗?我说:还行;就是有点累.";

  assert.equal(
    sanitizeGeneratedChapterContent(input),
    "他问，你还好吗？我说：还行；就是有点累。",
  );
});

test("sanitizeGeneratedChapterContent cleans markdown emphasis, list dividers, time punctuation and ascii quotes", () => {
  const input = [
    "# 第35章：路标与裂隙",
    "",
    "**如果有一天，你必须选择--你会选什么？**",
    "",
    "倒计时: 00:04:37，距离0.3毫米。",
    "",
    "\"过载\"与'错误数据'被写进[系统日志]。",
    "",
    "---",
    "",
    "你在做什么？！不要！！！",
  ].join("\n");

  assert.equal(
    sanitizeGeneratedChapterContent(input),
    [
      "如果有一天，你必须选择——你会选什么？",
      "",
      "倒计时： 00：04：37，距离0点3毫米。",
      "",
      "“过载”与‘错误数据’被写进系统日志。",
      "",
      "——",
      "",
      "你在做什么？不要！",
    ].join("\n"),
  );
});

test("sanitizeGeneratedChapterContent removes chapter headings and outline/meta leaks", () => {
  const input = [
    "第1章 监控下的生存逻辑",
    "",
    "裴言睁开眼，天花板的蓝光像一层冷雾。",
    "",
    "第一卷核心悬念之一：凌晨三点十七分的0点7秒同步紊乱——昆仑系统正在处理什么？",
    "",
    "这个问题的答案，将决定裴言能否找到那扇门的钥匙。",
    "",
    "这支靠契约维系的队伍能撑到第102章的协同作战吗？",
    "",
    "他逃跑了一百零四章，终于来到这里。",
  ].join("\n");

  assert.equal(
    sanitizeGeneratedChapterContent(input),
    "裴言睁开眼，天花板的蓝光像一层冷雾。",
  );
});

test("sanitizeGeneratedChapterContent removes generated chapter end markers", () => {
  const input = [
    "裴言的意识彻底沉入黑暗。",
    "",
    "【第一章 完",
    "",
    "未完待续",
  ].join("\n");

  assert.equal(
    sanitizeGeneratedChapterContent(input),
    "裴言的意识彻底沉入黑暗。",
  );
});

test("sanitizeGeneratedChapterContent removes meta narration about adjacent chapters", () => {
  const input = [
    "裴言靠在墙边，听见青云的脚步声远去。",
    "",
    "下一章，他会需要这个信息。",
  ].join("\n");

  assert.equal(
    sanitizeGeneratedChapterContent(input),
    "裴言靠在墙边，听见青云的脚步声远去。",
  );
});

test("sanitizeGeneratedChapterContent removes emoticons and collapses repeated punctuation", () => {
  const input = "她愣住了!!! 下一秒？？？他忽然停下--然后低声说：「别笑了」 QAQ ❤ [注]";

  assert.equal(
    sanitizeGeneratedChapterContent(input),
    "她愣住了！ 下一秒？他忽然停下——然后低声说：“别笑了” 注",
  );
});

test("hasGeneratedReasoningLeak detects leaked reasoning tags", () => {
  assert.equal(hasGeneratedReasoningLeak("<think>hidden</think>\n正文"), true);
  assert.equal(hasGeneratedReasoningLeak("只有正文。"), false);
});

test("compactRunawayRepeatedParagraphs removes repeated long paragraphs from runaway drafts", () => {
  const uniqueIntro = "陆子野走进批发市场，先把老周交代的几件事在心里过了一遍。";
  const repeated = [
    "老周领着陆子野穿过拥挤的过道，在一处僻静的角落停下脚步，指着不远处一个摊位说那就是张德明。".repeat(2),
    "摊位前的中年男人正和客户谈笑风生，举手投足间透着生意人的精明。".repeat(2),
    "陆子野认真记下这个名字，知道自己手里真正缺的不是胆子，而是把信息变成钱的通道。".repeat(2),
  ].join("\n\n");
  const runaway = [uniqueIntro, ...Array.from({ length: 80 }, () => repeated)].join("\n\n");
  const compacted = compactRunawayRepeatedParagraphs(runaway);

  assert.ok(compacted.length < runaway.length / 10);
  assert.equal((compacted.match(/老周领着陆子野穿过拥挤的过道/g) ?? []).length, 2);
  assert.ok(compacted.includes(uniqueIntro));
});
