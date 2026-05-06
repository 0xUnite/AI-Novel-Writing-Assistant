const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizePlannerOutput } = require("../dist/services/planner/PlannerService.js");
const { plannerOutputSchema } = require("../dist/services/planner/plannerSchemas.js");

test("normalizePlannerOutput coerces object-like planner fields into safe strings", () => {
  const normalized = normalizePlannerOutput({
    title: { main: "章节规划" },
    objective: ["推进主线", "强化冲突"],
    participants: ["主角", { alias: "同伴" }],
    reveals: { first: "隐藏线索" },
    riskNotes: [{ item: "避免重复开场" }],
    hookTarget: { summary: "结尾留下悬念" },
    scenes: [
      {
        title: { text: "冲突爆发" },
        objective: { detail: "逼主角做选择" },
        conflict: ["误解升级", "利益对撞"],
        reveal: { fact: "真相露出一角" },
        emotionBeat: 7,
      },
    ],
  });

  assert.equal(normalized.title, "章节规划");
  assert.equal(normalized.objective, "推进主线；强化冲突");
  assert.deepEqual(normalized.participants, ["主角", "同伴"]);
  assert.deepEqual(normalized.reveals, ["隐藏线索"]);
  assert.deepEqual(normalized.riskNotes, ["避免重复开场"]);
  assert.equal(normalized.hookTarget, "结尾留下悬念");
  assert.equal(normalized.scenes[0].title, "冲突爆发");
  assert.equal(normalized.scenes[0].objective, "逼主角做选择");
  assert.equal(normalized.scenes[0].conflict, "误解升级；利益对撞");
  assert.equal(normalized.scenes[0].reveal, "真相露出一角");
  assert.equal(normalized.scenes[0].emotionBeat, "7");
});

test("plannerOutputSchema normalizes blank and aliased planRole values", () => {
  const blankPlan = plannerOutputSchema.parse({
    title: "全书规划",
    objective: "锁定主线",
    planRole: "",
  });
  const aliasPlan = plannerOutputSchema.parse({
    title: "章节规划",
    objective: "推进冲突",
    planRole: "climax",
  });

  assert.equal(blankPlan.planRole, null);
  assert.equal(aliasPlan.planRole, "payoff");
});

test("plannerOutputSchema normalizes chapter_meta aliases", () => {
  const parsed = plannerOutputSchema.parse({
    title: "药谷试探",
    objective: "让主角通过药价异常发现有人布局。",
    planRole: "turn",
    chapter_meta: {
      event_weight: "5",
      high_stakes_dialogue: "是",
      scheme_beat: "否",
      kind_of_hook: "信息反转",
    },
  });
  const normalized = normalizePlannerOutput(parsed);

  assert.equal(normalized.chapterMeta.eventWeight, 5);
  assert.equal(normalized.chapterMeta.highStakesDialogue, true);
  assert.equal(normalized.chapterMeta.schemeBeat, false);
  assert.equal(normalized.chapterMeta.kindOfHook, "information_reversal");
});

test("plannerOutputSchema wraps non-empty root scene arrays into chapter plan objects", () => {
  assert.equal(plannerOutputSchema.safeParse([]).success, false);

  const parsed = plannerOutputSchema.parse([
    {
      "场景标题": "宿舍试探",
      "场景目标": "李志强用闲聊试探陆子野的动向",
      "冲突": "表面关心与暗中套话之间的拉扯",
      "信息揭露": "李志强已经注意到陆子野的进货路线",
      "情绪节拍": "日常感转为警觉",
    },
    {
      title: "警觉升级",
      objective: "陆子野表面敷衍，内心确认需要隐藏行动",
      conflict: "不能暴露货源，又不能让室友察觉自己已经警惕",
      reveal: "主角判断李志强有空手套白狼动机",
      emotionBeat: "暗流涌动",
    },
  ]);

  assert.equal(parsed.title, "宿舍试探");
  assert.equal(parsed.objective, "李志强用闲聊试探陆子野的动向；陆子野表面敷衍，内心确认需要隐藏行动");
  assert.equal(parsed.planRole, "progress");
  assert.equal(parsed.phaseLabel, "章节推进");
  assert.deepEqual(parsed.mustAdvance, [
    "李志强用闲聊试探陆子野的动向",
    "陆子野表面敷衍，内心确认需要隐藏行动",
  ]);
  assert.deepEqual(parsed.mustPreserve, ["保持既有章节任务单、人物状态与上下文连续。"]);
  assert.equal(parsed.scenes.length, 2);
  assert.equal(parsed.scenes[0].title, "宿舍试探");
  assert.equal(parsed.scenes[0].objective, "李志强用闲聊试探陆子野的动向");
  assert.equal(parsed.scenes[1].emotionBeat, "暗流涌动");
});
