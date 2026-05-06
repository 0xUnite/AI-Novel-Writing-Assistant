const test = require("node:test");
const assert = require("node:assert/strict");

const {
  runPipelineChapterWithRuntime,
} = require("../dist/services/novel/runtime/chapterRuntimePipeline.js");

const LONG_TEXT = "正".repeat(1200);

function createRuntimePackage(scoreOverrides = {}) {
  return {
    novelId: "novel-1",
    chapterId: "chapter-1",
    context: {
      openConflicts: [],
      chapterRepairContext: null,
    },
    draft: {
      content: LONG_TEXT,
      wordCount: LONG_TEXT.length,
      generationState: "drafted",
    },
    audit: {
      score: {
        coherence: 88,
        repetition: 10,
        pacing: 82,
        voice: 81,
        engagement: 86,
        overall: 84,
        ...scoreOverrides,
      },
      reports: [],
      openIssues: [],
      hasBlockingIssues: false,
    },
    replanRecommendation: {
      recommended: false,
      reason: "No blocking audit issues were detected.",
      blockingIssueIds: [],
    },
    styleReview: {
      report: null,
      autoRewritten: false,
      originalContent: null,
    },
    meta: {
      generatedAt: new Date("2026-04-06T10:00:00+09:00").toISOString(),
    },
  };
}

test("runPipelineChapterWithRuntime skips open conflict lookup during batch finalization", async () => {
  const finalizedInputs = [];
  const generationStates = [];

  const result = await runPipelineChapterWithRuntime(
    {
      validateRequest: (input) => input,
      ensureNovelCharacters: async () => {},
      assemble: async () => ({
        novel: { id: "novel-1", title: "测试小说" },
        chapter: { id: "chapter-1", title: "第一章", order: 1, content: null, expectation: null, targetWordCount: 1200 },
        contextPackage: { chapter: { id: "chapter-1", order: 1 } },
      }),
      generateDraftFromWriter: async () => LONG_TEXT,
      saveDraftAndArtifacts: async () => {},
      finalizeChapterContent: async (input) => {
        finalizedInputs.push(input);
        return {
          finalContent: input.content,
          runtimePackage: createRuntimePackage(),
        };
      },
      markChapterGenerationState: async (_chapterId, state) => {
        generationStates.push(state);
      },
    },
    "novel-1",
    "chapter-1",
    { maxRetries: 0, autoRepair: true, qualityThreshold: 75 },
  );

  assert.equal(finalizedInputs.length, 1);
  assert.equal(finalizedInputs[0].includeOpenConflicts, false);
  assert.equal(result.pass, true);
  assert.deepEqual(generationStates, ["reviewed", "approved"]);
});

test("runPipelineChapterWithRuntime retries writer failures before reviewing", async () => {
  const generatedDrafts = [];
  const finalizedInputs = [];

  const result = await runPipelineChapterWithRuntime(
    {
      validateRequest: (input) => input,
      ensureNovelCharacters: async () => {},
      assemble: async () => ({
        novel: { id: "novel-1", title: "测试小说" },
        chapter: { id: "chapter-1", title: "第一章", order: 1, content: null, expectation: null, targetWordCount: 1200 },
        contextPackage: { chapter: { id: "chapter-1", order: 1 } },
      }),
      generateDraftFromWriter: async () => {
        generatedDrafts.push(Date.now());
        if (generatedDrafts.length === 1) {
          throw new Error("第1章生成正文异常过长");
        }
        return LONG_TEXT;
      },
      saveDraftAndArtifacts: async () => {},
      finalizeChapterContent: async (input) => {
        finalizedInputs.push(input);
        return {
          finalContent: input.content,
          runtimePackage: createRuntimePackage(),
        };
      },
      markChapterGenerationState: async () => {},
    },
    "novel-1",
    "chapter-1",
    { maxRetries: 2, autoRepair: true, qualityThreshold: 75 },
  );

  assert.equal(generatedDrafts.length, 2);
  assert.equal(finalizedInputs.length, 1);
  assert.equal(finalizedInputs[0].content, LONG_TEXT);
  assert.equal(result.retryCountUsed, 1);
  assert.equal(result.pass, true);
});

test("runPipelineChapterWithRuntime retries repair failures before failing the chapter", async () => {
  const finalizedInputs = [];
  const repairInputs = [];
  const savedDrafts = [];
  const chapterStatuses = [];

  const result = await runPipelineChapterWithRuntime(
    {
      validateRequest: (input) => input,
      ensureNovelCharacters: async () => {},
      assemble: async () => ({
        novel: { id: "novel-1", title: "测试小说" },
        chapter: { id: "chapter-1", title: "第一章", order: 1, content: null, expectation: null, targetWordCount: 1200 },
        contextPackage: { chapter: { id: "chapter-1", order: 1 } },
      }),
      generateDraftFromWriter: async () => "需要修复的正文",
      saveDraftAndArtifacts: async (_novelId, _chapterId, content, state) => {
        savedDrafts.push({ content, state });
      },
      finalizeChapterContent: async (input) => {
        finalizedInputs.push(input);
        return {
          finalContent: input.content,
          runtimePackage: input.content === LONG_TEXT
            ? createRuntimePackage()
            : createRuntimePackage({ coherence: 76, engagement: 70, overall: 72 }),
        };
      },
      markChapterGenerationState: async () => {},
      markChapterStatus: async (_chapterId, state) => {
        chapterStatuses.push(state);
      },
      repairDraftContent: async (input) => {
        repairInputs.push(input);
        if (repairInputs.length === 1) {
          throw new Error("overloaded_error");
        }
        return LONG_TEXT;
      },
    },
    "novel-1",
    "chapter-1",
    { maxRetries: 3, autoRepair: true, qualityThreshold: 75 },
  );

  assert.equal(finalizedInputs.length, 3);
  assert.equal(repairInputs.length, 2);
  assert.deepEqual(savedDrafts, [{ content: LONG_TEXT, state: "repaired" }]);
  assert.deepEqual(chapterStatuses, ["generating"]);
  assert.equal(result.retryCountUsed, 2);
  assert.equal(result.pass, true);
});

test("runPipelineChapterWithRuntime marks chapters for repair when retries end without pass", async () => {
  const chapterStatuses = [];

  const result = await runPipelineChapterWithRuntime(
    {
      validateRequest: (input) => input,
      ensureNovelCharacters: async () => {},
      assemble: async () => ({
        novel: { id: "novel-1", title: "测试小说" },
        chapter: { id: "chapter-1", title: "第一章", order: 1, content: null, expectation: null, targetWordCount: 1200 },
        contextPackage: { chapter: { id: "chapter-1", order: 1 } },
      }),
      generateDraftFromWriter: async () => "始终不过线的正文",
      saveDraftAndArtifacts: async () => {},
      finalizeChapterContent: async (input) => ({
        finalContent: input.content,
        runtimePackage: createRuntimePackage({ coherence: 71, engagement: 68, overall: 70 }),
      }),
      markChapterGenerationState: async () => {},
      markChapterStatus: async (_chapterId, state) => {
        chapterStatuses.push(state);
      },
      repairDraftContent: async () => "修了还是不过线",
    },
    "novel-1",
    "chapter-1",
    { maxRetries: 0, autoRepair: false, qualityThreshold: 75 },
  );

  assert.equal(result.pass, false);
  assert.deepEqual(chapterStatuses, ["generating", "needs_repair"]);
});
