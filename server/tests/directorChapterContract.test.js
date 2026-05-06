const test = require("node:test");
const assert = require("node:assert/strict");

const { directorCandidateSchema } = require("../dist/services/novel/director/novelDirectorSchemas.js");
const { toBookSpec } = require("../dist/services/novel/director/novelDirectorHelpers.js");
const { resolveFullNovelPipelineEndOrder } = require("../dist/services/novel/NovelProductionService.js");

function createCandidate(targetChapterCount) {
  return {
    id: "candidate-1",
    workingTitle: "测试方案",
    logline: "一句话梗概",
    positioning: "项目定位",
    sellingPoint: "核心卖点",
    coreConflict: "核心冲突",
    protagonistPath: "主角路径",
    endingDirection: "结局方向",
    hookStrategy: "开篇钩子",
    progressionLoop: "推进循环",
    whyItFits: "匹配原因",
    toneKeywords: ["爽感", "悬念"],
    targetChapterCount,
  };
}

test("director candidate schema accepts 500 chapter projects", () => {
  const parsed = directorCandidateSchema.parse(createCandidate(500));
  assert.equal(parsed.targetChapterCount, 500);
});

test("toBookSpec keeps the confirmed chapter target instead of clamping to 120", () => {
  const bookSpec = toBookSpec(createCandidate(120), "测试灵感", 500);
  assert.equal(bookSpec.targetChapterCount, 500);
});

test("full novel pipeline respects explicit targetChapterCount as an upper bound", () => {
  assert.equal(resolveFullNovelPipelineEndOrder({
    chapterCount: 500,
    startOrder: 1,
    targetChapterCount: 80,
  }), 80);

  assert.equal(resolveFullNovelPipelineEndOrder({
    chapterCount: 20,
    startOrder: 1,
    targetChapterCount: 80,
  }), 80);
});
