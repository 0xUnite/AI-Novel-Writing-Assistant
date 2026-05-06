const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createSplitPlan,
} = require("../dist/services/novel/runtime/ChapterSplitService.js");

test("createSplitPlan keeps short chapters unsplit", () => {
  const plan = createSplitPlan({
    actualLength: 5200,
    content: "短章内容",
  });

  assert.equal(plan.shouldSplit, false);
  assert.equal(plan.partCount, 1);
  assert.equal(plan.mode, "no-split");
});

test("createSplitPlan prefers time or scene shifts for split anchors", () => {
  const plan = createSplitPlan({
    actualLength: 7600,
    content: [
      "第一段，主角在宿舍里整理账本。\n\n",
      "第二段，主角和导师把话摊开。\n\n",
      "次日一早，他来到供货商办公室门口，准备把名片上的电话拨通。\n\n",
      "第四段，新场景正式展开。",
    ].join(""),
  });

  assert.equal(plan.shouldSplit, true);
  assert.equal(plan.partCount, 2);
  assert.ok(plan.splitPoints.some((point) => point.reason === "time-shift" || point.reason === "scene-shift"));
});

test("createSplitPlan asks for compression before splitting extreme overflows", () => {
  const plan = createSplitPlan({
    actualLength: 13200,
    content: "超长章节",
  });

  assert.equal(plan.mode, "compress-then-split");
  assert.equal(plan.partCount, 3);
});
