const test = require("node:test");
const assert = require("node:assert/strict");

const {
  chapterDynamicExtractionSchema,
} = require("../dist/services/novel/dynamics/characterDynamicsSchemas.js");

test("chapterDynamicExtractionSchema accepts keyed objects for list fields", () => {
  const parsed = chapterDynamicExtractionSchema.parse({
    candidates: {
      first: {
        proposedName: "青云",
        proposedRole: "守望者",
        evidence: ["青云开始记录常量坐标。"],
        confidence: 0.8,
      },
    },
    factionUpdates: {
      qingyun: {
        characterName: "青云",
        factionLabel: "规则执行者",
        stanceLabel: "见证",
      },
    },
    relationStages: {
      qingyun_baize: {
        sourceCharacterName: "青云",
        targetCharacterName: "白泽",
        stageLabel: "共同观测",
        stageSummary: "青云与白泽共同记录常量坐标变化。",
      },
    },
  });

  assert.equal(parsed.candidates.length, 1);
  assert.equal(parsed.candidates[0].proposedName, "青云");
  assert.equal(parsed.factionUpdates.length, 1);
  assert.equal(parsed.relationStages.length, 1);
});

test("chapterDynamicExtractionSchema drops scalar noise inside list fields", () => {
  const parsed = chapterDynamicExtractionSchema.parse({
    candidates: ["没有新角色"],
    factionUpdates: [
      "常量坐标不是角色",
      {
        characterName: "青云",
        factionLabel: "守望者",
      },
    ],
    relationStages: ["无变化"],
  });

  assert.deepEqual(parsed.candidates, []);
  assert.equal(parsed.factionUpdates.length, 1);
  assert.equal(parsed.factionUpdates[0].characterName, "青云");
  assert.deepEqual(parsed.relationStages, []);
});
