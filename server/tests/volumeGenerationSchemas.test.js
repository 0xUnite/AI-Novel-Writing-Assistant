const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createChapterBoundarySchema,
  createChapterTaskSheetSchema,
  createVolumeBeatSheetSchema,
  createVolumeChapterListSchema,
} = require("../dist/services/novel/volume/volumeGenerationSchemas.js");

test("chapter boundary schema accepts array mustAvoid payloads", () => {
  const parsed = createChapterBoundarySchema().parse({
    conflictLevel: 70,
    revealLevel: 30,
    targetWordCount: 3200,
    mustAvoid: ["避免提前揭露身世伏笔", "避免把商业判断写成单纯记股票代码"],
    payoffRefs: "白月光信任铺垫、第一桶金线索",
  });

  assert.equal(parsed.mustAvoid, "避免提前揭露身世伏笔；避免把商业判断写成单纯记股票代码");
  assert.deepEqual(parsed.payoffRefs, ["白月光信任铺垫", "第一桶金线索"]);
});

test("chapter task sheet schema accepts object taskSheet payloads", () => {
  const parsed = createChapterTaskSheetSchema().parse({
    taskSheet: {
      emotionalTone: "压迫转反击",
      coreConflict: "陆子野与旧同学在第一桶金机会上的暗中抢位。",
      keyAdvancement: ["锁定批发渠道", "看清对手试探"],
      endingRequirement: "结尾留下更大的资金缺口钩子。",
    },
  });

  assert.match(parsed.taskSheet, /情绪基调：压迫转反击/);
  assert.match(parsed.taskSheet, /核心冲突：陆子野与旧同学/);
  assert.match(parsed.taskSheet, /关键推进：锁定批发渠道、看清对手试探/);
  assert.match(parsed.taskSheet, /收尾要求：结尾留下更大的资金缺口钩子/);
});

test("chapter task sheet schema accepts direct multi-field task sheet objects", () => {
  const parsed = createChapterTaskSheetSchema().parse({
    "情绪基调": "试探",
    "核心冲突": "主角与市场摊主围绕低价货源互相试探。",
    "关键推进点": "主角确认第一笔倒卖路线可行。",
    "收尾要求": "以新的竞争者出现收尾。",
  });

  assert.match(parsed.taskSheet, /情绪基调：试探/);
  assert.match(parsed.taskSheet, /核心冲突：主角与市场摊主/);
  assert.match(parsed.taskSheet, /关键推进：主角确认第一笔倒卖路线可行/);
  assert.match(parsed.taskSheet, /收尾要求：以新的竞争者出现收尾/);
});

test("volume chapter list schema accepts short lists for backend completion", () => {
  const parsed = createVolumeChapterListSchema(30).parse({
    chapters: [
      { title: "信息差再次亮起", summary: "主角确认第二卷的核心机会窗口。" },
      { title: "老周递来第一条线", summary: "老周提供实战视角，帮助主角筛选机会。" },
      { title: "赵老板开始试探", summary: "外部商业压力初次显形。" },
    ],
  });

  assert.equal(parsed.chapters.length, 3);
});

test("volume beat sheet schema carries chapter meta hints", () => {
  const parsed = createVolumeBeatSheetSchema().parse({
    beats: [
      {
        key: "open_hook",
        label: "开卷抓手",
        summary: "药谷账房突然改价，主角察觉异常。",
        chapterSpanHint: "1-2章",
        mustDeliver: ["异常药价", "被迫换路"],
        event_weight: 4,
        high_stakes_dialogue: true,
        scheme_beat: true,
        kind_of_hook: "威胁逼近",
      },
      {
        key: "first_escalation",
        label: "第一次升级",
        summary: "反制失败后获得残页。",
        chapterSpanHint: "3章",
        mustDeliver: ["反制失效"],
      },
      {
        key: "midpoint_turn",
        label: "中段转向",
        summary: "残页指向黑市。",
        chapterSpanHint: "4章",
        mustDeliver: ["黑市入口"],
      },
      {
        key: "pressure_lock",
        label: "压力锁定",
        summary: "药童身份被卡死。",
        chapterSpanHint: "5章",
        mustDeliver: ["身份风险"],
      },
      {
        key: "climax",
        label: "卷高潮",
        summary: "主角落子夺回筹码。",
        chapterSpanHint: "6章",
        mustDeliver: ["夺回筹码"],
      },
    ],
  });

  assert.equal(parsed.beats[0].eventWeight, 4);
  assert.equal(parsed.beats[0].highStakesDialogue, true);
  assert.equal(parsed.beats[0].schemeBeat, true);
  assert.equal(parsed.beats[0].kindOfHook, "threat_approaches");
  assert.equal(parsed.beats[1].eventWeight, 3);
});

test("volume chapter list schema accepts snake_case chapter_meta", () => {
  const parsed = createVolumeChapterListSchema(2).parse({
    chapters: [
      {
        title: "药价先变",
        summary: "主角从米价和药价同时跳涨里察觉局面不对。",
        chapter_meta: {
          event_weight: 4,
          high_stakes_dialogue: true,
          scheme_beat: false,
          kind_of_hook: "information_reversal",
        },
      },
      {
        title: "黑市要价",
        summary: "黑市掌柜压价，主角表面退让，暗中换筹码。",
      },
    ],
  });

  assert.equal(parsed.chapters[0].chapterMeta.eventWeight, 4);
  assert.equal(parsed.chapters[0].chapterMeta.kindOfHook, "information_reversal");
  assert.equal(parsed.chapters[1].chapterMeta.eventWeight, 3);
});
