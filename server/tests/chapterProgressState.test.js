const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildContentEditProgress,
  buildReviewedChapterProgress,
  reconcileChapterProgress,
} = require("../dist/services/novel/chapterProgressState.js");

test("buildContentEditProgress resets cleared chapters to planned + pending_generation", () => {
  assert.deepEqual(
    buildContentEditProgress({
      content: "",
      chapterStatus: "pending_generation",
    }),
    {
      generationState: "planned",
      chapterStatus: "pending_generation",
    },
  );
});

test("buildContentEditProgress downgrades edited content to drafted + pending_review", () => {
  assert.deepEqual(
    buildContentEditProgress({
      content: "新的正文内容",
    }),
    {
      generationState: "drafted",
      chapterStatus: "pending_review",
    },
  );
});

test("buildReviewedChapterProgress marks failed reviews for repair", () => {
  assert.deepEqual(
    buildReviewedChapterProgress({ hasIssues: true }),
    {
      generationState: "reviewed",
      chapterStatus: "needs_repair",
    },
  );
});

test("reconcileChapterProgress repairs stale drafted chapters that still show pending_generation", () => {
  assert.deepEqual(
    reconcileChapterProgress({
      content: "已有正文",
      generationState: "drafted",
      chapterStatus: "pending_generation",
    }),
    {
      generationState: "drafted",
      chapterStatus: "pending_review",
    },
  );
});

test("reconcileChapterProgress repairs stale approved chapters that still show pending_generation", () => {
  assert.deepEqual(
    reconcileChapterProgress({
      content: "已有正文",
      generationState: "approved",
      chapterStatus: "pending_generation",
    }),
    {
      generationState: "approved",
      chapterStatus: "completed",
    },
  );
});
