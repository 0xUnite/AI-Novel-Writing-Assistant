const test = require("node:test");
const assert = require("node:assert/strict");

const {
  allocateChapterBudgets,
  deriveChapterBudget,
  inferRequiredChapterCountFromBeatSheet,
  normalizeBeatSheetSpansToChapterBudget,
  resolveTargetVolumeCount,
} = require("../dist/services/novel/volume/volumeStructureBudget.js");
const {
  deriveChapterDetailPolicy,
} = require("../dist/services/novel/volume/volumeChapterDetailPolicy.js");

test("deriveChapterBudget treats explicit user target as the hard chapter contract", () => {
  assert.equal(deriveChapterBudget({
    optionEstimatedChapterCount: 80,
    novelEstimatedChapterCount: 500,
    existingChapterCount: 500,
  }), 80);

  assert.equal(deriveChapterBudget({
    novelEstimatedChapterCount: 36,
    existingChapterCount: 500,
  }), 36);
});

test("resolveTargetVolumeCount is deterministic and allows guidance to lock volume count", () => {
  assert.equal(resolveTargetVolumeCount({
    chapterBudget: 80,
    existingVolumeCount: 7,
    respectExistingVolumeCount: false,
  }), 3);

  assert.equal(resolveTargetVolumeCount({
    chapterBudget: 80,
    guidance: "请分成5卷，每卷节奏紧一点",
  }), 5);

  assert.equal(resolveTargetVolumeCount({
    chapterBudget: 80,
    guidance: "每卷约20章",
  }), 4);
});

test("allocateChapterBudgets keeps the whole-book total exact", () => {
  const budgets = allocateChapterBudgets({
    volumeCount: resolveTargetVolumeCount({ chapterBudget: 500 }),
    chapterBudget: 500,
  });

  assert.equal(budgets.length, 8);
  assert.equal(budgets.reduce((sum, count) => sum + count, 0), 500);
  assert.ok(budgets.every((count) => count > 0));
});

test("normalizeBeatSheetSpansToChapterBudget prevents beat sheets from expanding a volume", () => {
  const beats = normalizeBeatSheetSpansToChapterBudget([
    { label: "开局", chapterSpanHint: "1-20章" },
    { label: "升级", chapterSpanHint: "21-60章" },
    { label: "中转", chapterSpanHint: "61-120章" },
    { label: "高潮", chapterSpanHint: "121-180章" },
    { label: "钩子", chapterSpanHint: "181-220章" },
  ], 21, 10);

  assert.equal(beats[0].chapterSpanHint, "21章");
  assert.match(beats[beats.length - 1].chapterSpanHint, /30章$/);
  assert.equal(inferRequiredChapterCountFromBeatSheet({ beats }), 10);
});

test("deriveChapterDetailPolicy turns event weight into detail level and word budget", () => {
  const brief = deriveChapterDetailPolicy({
    defaultChapterLength: 2500,
    chapterMeta: {
      eventWeight: 2,
      highStakesDialogue: false,
      schemeBeat: false,
      kindOfHook: "suspense_question",
    },
    title: "低压承接",
    summary: "主角换场并接住上一段结算。",
  });
  assert.equal(brief.detailLevel, "brief");
  assert.equal(brief.targetWordCount, 2400);
  assert.match(brief.mustAvoid, /略写承接/);
  assert.match(brief.taskSheet, /目标字数：约 2400 字/);

  const spotlight = deriveChapterDetailPolicy({
    defaultChapterLength: 2500,
    chapterMeta: {
      eventWeight: 5,
      highStakesDialogue: true,
      schemeBeat: true,
      kindOfHook: "information_reversal",
    },
    title: "高光对峙",
    summary: "主角与对手围绕关键证据正面对撞。",
  });
  assert.equal(spotlight.detailLevel, "spotlight");
  assert.equal(spotlight.targetWordCount, 2750);
  assert.ok(spotlight.conflictLevel >= 90);
  assert.match(spotlight.mustAvoid, /详写高光/);
});
