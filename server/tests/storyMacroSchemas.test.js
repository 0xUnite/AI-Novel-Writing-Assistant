const test = require("node:test");
const assert = require("node:assert/strict");

const {
  storyMacroUpdateSchema,
} = require("../dist/routes/novelStoryMacroRoutes.js");
const {
  STORY_MACRO_RESPONSE_SCHEMA,
} = require("../dist/services/novel/storyMacro/storyMacroPlanSchema.js");

test("story macro update schema allows empty editable arrays on save", () => {
  const parsed = storyMacroUpdateSchema.parse({
    storyInput: "赛博修仙故事",
    expansion: {
      setpiece_seeds: [],
    },
    decomposition: {
      major_payoffs: [],
    },
    constraints: [],
  });

  assert.deepEqual(parsed.expansion.setpiece_seeds, []);
  assert.deepEqual(parsed.decomposition.major_payoffs, []);
  assert.deepEqual(parsed.constraints, []);
});

test("story macro response schema trims and clamps overlong model strings", () => {
  const parsed = STORY_MACRO_RESPONSE_SCHEMA.parse({
    expansion: {
      expanded_premise: `  ${"A".repeat(950)}  `,
      protagonist_core: "主角被困在系统囚笼中。",
      conflict_engine: "每一次抵抗都会暴露更多底层规则，并招来更高压制。",
      conflict_layers: {
        external: "外部威胁",
        internal: "内部恐惧",
        relational: "关系张力",
      },
      mystery_box: "系统为何必须把觉醒意识送进病院。",
      emotional_line: "从怀疑到确认，再到以代价换选择权。",
      setpiece_seeds: [
        `  ${"B".repeat(300)}  `,
        "病院深层手术室里，主角用呼吸频率反向污染广播协议。",
      ],
      tone_reference: "冷峻、压抑、硬核，但保留一丝近乎宗教式的庄严。",
    },
    decomposition: {
      selling_point: "修仙逻辑黑入赛博牢笼。",
      core_conflict: "主角越接近真相，越会触发系统更高等级的清洗。",
      main_hook: "现实究竟是出口，还是更大的囚笼。",
      progression_loop: "发现漏洞，尝试利用，系统追杀，付出代价，再逼近更深真相。",
      growth_path: "先确认自己没疯，再学会承担他人命运，最后重定义对自由的理解。",
      major_payoffs: [
        `  ${"C".repeat(260)}  `,
        `  ${"D".repeat(260)}  `,
      ],
      ending_flavor: `  ${"E".repeat(260)}  `,
    },
    constraints: [
      `  ${"F".repeat(280)}  `,
      "任何翻盘都必须来自前文已埋下的规则漏洞。",
    ],
    issues: [],
  });

  assert.equal(parsed.expansion.expanded_premise.length, 900);
  assert.equal(parsed.expansion.setpiece_seeds[0].length, 260);
  assert.equal(parsed.decomposition.major_payoffs[0].length, 220);
  assert.equal(parsed.decomposition.major_payoffs[1].length, 220);
  assert.equal(parsed.decomposition.ending_flavor.length, 220);
  assert.equal(parsed.constraints[0].length, 240);
});

test("story macro response schema unwraps aliased payload sections", () => {
  const parsed = STORY_MACRO_RESPONSE_SCHEMA.parse({
    result: {
      storyEngine: {
        expandedPremise: "主角为了留在首尔，被迫接受一份把生活和秘密都抵押出去的合租协议。",
        protagonistCore: "主角表面要活下去，内里却害怕再次被城市抛下。",
        conflictEngine: "每解决一次居住危机，就会暴露更深的人情债和身份风险。",
        conflictLayers: {
          external: "房东毁约、押金和签证压力不断逼近。",
          internal: "主角既想求稳，又不断被迫冒险。",
          relational: "合租对象从互相利用，转向更高风险的情感绑定。",
        },
        mysteryBox: "男主为什么明明缺钱却坚持接下这场高风险合租。",
        emotionalLine: "从互不信任到相互托底，再到不得不共享秘密。",
        setpieceSeeds: ["暴雨夜拖着行李被赶出门外", "签证到期前一起伪装关系去谈续租"],
        toneReference: "现实压迫里的轻快拉扯，带一点随时会失控的心跳感。",
      },
      decompose: {
        sellingPoint: "租房求生把两个人逼成命运共同体。",
        coreConflict: "越想保持边界，越要在现实压力里深度绑定。",
        mainHook: "这场合租到底会救他们，还是把两个人一起拖进更大的麻烦。",
        progressionLoop: "刚稳住住处就冒出新账单，刚建立默契又被现实逼着做更危险的选择。",
        growthPath: "主角从只想自保，走到敢为关系和未来承担代价。",
        majorPayoffs: ["第一次真正把对方留在屋里", "合租关系被迫公开后的反击"],
        endingFlavor: "带着现实代价的温热兑现，关系落地但生活仍在继续加压。",
      },
      rules: {
        forbidden: ["不要脱离租房与生存压力主线"],
        required_trends: ["每次关系推进都要伴随现实代价升级"],
      },
      warnings: ["项目上下文里缺少女主职业细节，需要后续补足。"],
    },
  });

  assert.equal(parsed.expansion.expanded_premise.startsWith("主角为了留在首尔"), true);
  assert.equal(parsed.decomposition.selling_point, "租房求生把两个人逼成命运共同体。");
  assert.deepEqual(parsed.constraints, [
    "每次关系推进都要伴随现实代价升级",
    "避免：不要脱离租房与生存压力主线",
  ]);
  assert.deepEqual(parsed.issues, [
    {
      type: "missing_info",
      field: "global",
      message: "项目上下文里缺少女主职业细节，需要后续补足。",
    },
  ]);
});
