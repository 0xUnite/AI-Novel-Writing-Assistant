const test = require("node:test");
const assert = require("node:assert/strict");

const { NovelReviewBatchRuntimeService } = require("../dist/services/novel/NovelReviewBatchRuntimeService.js");

test("recoverStaleReviewBatchJobs finalizes pending cancellations before resuming stale jobs", async () => {
  const calls = [];
  const runtimeService = new NovelReviewBatchRuntimeService({
    async listPendingCancellationReviewBatchJobs() {
      return [{ id: "cancel-1", status: "running" }];
    },
    async listRecoverableReviewBatchJobs() {
      return [];
    },
    async listStaleRecoverableReviewBatchJobs() {
      return [{ id: "stale-1", status: "running" }];
    },
    async markReviewBatchJobCancelled(jobId) {
      calls.push(["cancelled", jobId]);
    },
    async markReviewBatchJobFailed(jobId, message) {
      calls.push(["failed", jobId, message]);
    },
    async resumeReviewBatchJob(jobId) {
      calls.push(["resumed", jobId]);
    },
  });

  await runtimeService.recoverStaleReviewBatchJobs(new Date("2026-04-09T02:00:00+09:00"), 180_000);

  assert.deepEqual(calls, [
    ["cancelled", "cancel-1"],
    ["resumed", "stale-1"],
  ]);
});
