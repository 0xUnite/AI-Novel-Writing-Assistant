const test = require("node:test");
const assert = require("node:assert/strict");
const { z } = require("zod");

const factory = require("../dist/llm/factory.js");
const {
  parseStructuredLlmRawContentDetailed,
} = require("../dist/llm/structuredInvoke.js");

test("parseStructuredLlmRawContentDetailed recovers when repair output is truncated but completable", async () => {
  const originalGetLLM = factory.getLLM;

  factory.getLLM = async () => ({
    invoke: async () => ({
      content: "{\"value\":\"fixed\"",
    }),
  });

  try {
    const result = await parseStructuredLlmRawContentDetailed({
      rawContent: "这不是合法 JSON。",
      schema: z.object({
        value: z.string(),
      }),
      provider: "deepseek",
      model: "deepseek-chat",
      label: "structured.invoke.test",
      maxRepairAttempts: 1,
    });

    assert.deepEqual(result.data, { value: "fixed" });
    assert.equal(result.repairUsed, true);
    assert.equal(result.repairAttempts, 1);
  } finally {
    factory.getLLM = originalGetLLM;
  }
});

test("structured invoke parser repairs raw control characters inside JSON strings before schema validation", async () => {
  const result = await parseStructuredLlmRawContentDetailed({
    rawContent: "{\"volumes\":[{\"title\":\"第一卷\",\"summary\":\"第一行\n第二行\",\"openingHook\":\"开局钩子\",\"mainPromise\":\"主承诺\",\"primaryPressureSource\":\"压力源\",\"coreSellingPoint\":\"卖点\",\"escalationMode\":\"升级方式\",\"protagonistChange\":\"主角变化\",\"midVolumeRisk\":\"中段风险\",\"climax\":\"高潮\",\"payoffType\":\"兑现类型\",\"nextVolumeHook\":\"下卷钩子\",\"resetPoint\":\"卷末重置\",\"openPayoffs\":[\"伏笔\"]}]}",
    schema: z.object({
      volumes: z.array(z.object({
        title: z.string().min(1),
        summary: z.string().min(1),
        openingHook: z.string().min(1),
        mainPromise: z.string().min(1),
        primaryPressureSource: z.string().min(1),
        coreSellingPoint: z.string().min(1),
        escalationMode: z.string().min(1),
        protagonistChange: z.string().min(1),
        midVolumeRisk: z.string().min(1),
        climax: z.string().min(1),
        payoffType: z.string().min(1),
        nextVolumeHook: z.string().min(1),
        resetPoint: z.string().min(1),
        openPayoffs: z.array(z.string().min(1)),
      })),
    }),
    label: "test.structured.control_chars",
    maxRepairAttempts: 0,
  });

  assert.equal(result.repairUsed, false);
  assert.equal(result.data.volumes[0].summary, "第一行\n第二行");
});

test("parseStructuredLlmRawContentDetailed repairs missing commas in repaired JSON locally", async () => {
  const originalGetLLM = factory.getLLM;

  factory.getLLM = async () => ({
    invoke: async () => ({
      content: "{\"title\":\"第一章\" \"objective\":\"推进关系\"}",
    }),
  });

  try {
    const result = await parseStructuredLlmRawContentDetailed({
      rawContent: "这不是合法 JSON。",
      schema: z.object({
        title: z.string(),
        objective: z.string(),
      }),
      provider: "deepseek",
      model: "deepseek-chat",
      label: "structured.invoke.test.missing_comma",
      maxRepairAttempts: 1,
    });

    assert.deepEqual(result.data, {
      title: "第一章",
      objective: "推进关系",
    });
    assert.equal(result.repairUsed, true);
    assert.equal(result.repairAttempts, 1);
  } finally {
    factory.getLLM = originalGetLLM;
  }
});

test("parseStructuredLlmRawContentDetailed escapes bare quotes inside string values locally", async () => {
  const result = await parseStructuredLlmRawContentDetailed({
    rawContent: '{"value":"她说"留下来"也许更好"}',
    schema: z.object({
      value: z.string(),
    }),
    label: "structured.invoke.test.bare_quotes",
    maxRepairAttempts: 0,
  });

  assert.equal(result.repairUsed, false);
  assert.equal(result.data.value, '她说"留下来"也许更好');
});

test("parseStructuredLlmRawContentDetailed continues repairing from the previous repaired JSON", async () => {
  const originalGetLLM = factory.getLLM;
  const repairOutputs = [
    "{\"title\":\"第一章\"}",
    "{\"title\":\"第一章\",\"objective\":\"推进关系\"}",
  ];
  let invokeCount = 0;

  factory.getLLM = async () => ({
    invoke: async () => ({
      content: repairOutputs[invokeCount++] ?? repairOutputs[repairOutputs.length - 1],
    }),
  });

  try {
    const result = await parseStructuredLlmRawContentDetailed({
      rawContent: "这不是合法 JSON。",
      schema: z.object({
        title: z.string(),
        objective: z.string(),
      }),
      provider: "deepseek",
      model: "deepseek-chat",
      label: "structured.invoke.test.iterative_repair",
      maxRepairAttempts: 2,
    });

    assert.deepEqual(result.data, {
      title: "第一章",
      objective: "推进关系",
    });
    assert.equal(result.repairUsed, true);
    assert.equal(result.repairAttempts, 2);
    assert.equal(invokeCount, 2);
  } finally {
    factory.getLLM = originalGetLLM;
  }
});

test("parseStructuredLlmRawContentDetailed locally rescues mixed bare quotes and raw newlines in repaired JSON", async () => {
  const originalGetLLM = factory.getLLM;

  factory.getLLM = async () => ({
    invoke: async () => ({
      content: "{\"title\":\"第163章\",\"objective\":\"她说\"现在必须穿过裂缝\"\n否则就来不及了\",\"participants\":[\"裴言\"],\"reveals\":[\"桥另一侧给出回应\"],\"riskNotes\":[\"位衰减继续加重\"],\"hookTarget\":\"桥后的回声\",\"planRole\":\"progress\",\"phaseLabel\":\"裂缝穿越临界期\",\"mustAdvance\":[\"必须穿过裂缝\"],\"mustPreserve\":[\"主角仍处于逃亡线\"],\"scenes\":[{\"title\":\"穿桥\",\"objective\":\"越过裂缝\",\"conflict\":\"桥体不稳定\",\"reveal\":\"代价进一步升级\",\"emotionBeat\":\"紧绷\"}]}",
    }),
  });

  try {
    const result = await parseStructuredLlmRawContentDetailed({
      rawContent: "这不是合法 JSON。",
      schema: z.object({
        title: z.string(),
        objective: z.string(),
        participants: z.array(z.string()),
        reveals: z.array(z.string()),
        riskNotes: z.array(z.string()),
        hookTarget: z.string(),
        planRole: z.string(),
        phaseLabel: z.string(),
        mustAdvance: z.array(z.string()),
        mustPreserve: z.array(z.string()),
        scenes: z.array(z.object({
          title: z.string(),
          objective: z.string(),
          conflict: z.string(),
          reveal: z.string(),
          emotionBeat: z.string(),
        })),
      }),
      provider: "minimax",
      model: "MiniMax-M2.7",
      label: "structured.invoke.test.mixed_quotes_and_newlines",
      maxRepairAttempts: 1,
    });

    assert.equal(result.repairUsed, true);
    assert.equal(result.repairAttempts, 1);
    assert.equal(result.data.phaseLabel, "裂缝穿越临界期");
    assert.equal(result.data.objective, "她说\"现在必须穿过裂缝\"\n否则就来不及了");
  } finally {
    factory.getLLM = originalGetLLM;
  }
});
