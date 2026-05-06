const test = require("node:test");
const assert = require("node:assert/strict");

const { NovelCoreReviewBatchService } = require("../dist/services/novel/novelCoreReviewBatchService.js");
const { prisma } = require("../dist/db/prisma.js");

function createChapter(id, order, title) {
  return {
    id,
    order,
    title,
    content: `第${order}章正文`,
    generationState: "reviewed",
    chapterStatus: "needs_repair",
    updatedAt: new Date("2026-04-09T10:00:00+09:00"),
  };
}

function createAuditResult(coherence, issues = []) {
  return {
    score: { coherence },
    auditReports: [{ issues }],
  };
}

function createDummyTimer() {
  const timer = setInterval(() => {}, 60_000);
  timer.unref?.();
  return timer;
}

test("executeContinuityAudit auto-repairs blocked chapters and continues to completion", async () => {
  const service = new NovelCoreReviewBatchService();
  const chapters = [
    createChapter("chapter-1", 1, "第一章"),
    createChapter("chapter-2", 2, "第二章"),
  ];
  const updates = [];
  const repairCalls = [];
  const resolvedIssueCalls = [];
  const auditCalls = [];

  service.loadOrderedChapters = async () => chapters;
  service.ensureNotCancelled = async () => {};
  service.startHeartbeat = () => createDummyTimer();
  service.updateJobSafe = async (_jobId, data) => {
    updates.push(data);
  };
  service.runRepair = async (_novelId, chapterId, options) => {
    repairCalls.push({ chapterId, options });
  };
  service.reviewService.resolveAuditIssues = async (_novelId, issueIds) => {
    resolvedIssueCalls.push(issueIds);
  };
  service.reviewService.auditChapter = async (_novelId, chapterId) => {
    auditCalls.push(chapterId);
    if (chapterId === "chapter-1" && repairCalls.length === 0) {
      return createAuditResult(62, [{ id: "issue-1", status: "open", severity: "high" }]);
    }
    return createAuditResult(88, []);
  };

  const row = {
    id: "job-1",
    novelId: "novel-1",
    totalCount: 2,
    completedCount: 0,
    retryCount: 0,
    maxRetries: 2,
    currentStage: null,
    currentItemKey: null,
    currentItemLabel: null,
  };
  const payload = {
    chapterIds: chapters.map((chapter) => chapter.id),
    threshold: 75,
    autoRepairBlocked: true,
    blockedChapters: [],
    issueIdsByChapter: {},
  };

  await service.executeContinuityAudit(row, payload);

  assert.deepEqual(auditCalls, ["chapter-1", "chapter-2", "chapter-1"]);
  assert.equal(repairCalls.length, 1);
  assert.equal(repairCalls[0].chapterId, "chapter-1");
  assert.deepEqual(repairCalls[0].options.auditIssueIds, ["issue-1"]);
  assert.deepEqual(resolvedIssueCalls, [["issue-1"]]);

  const finalUpdate = updates.at(-1);
  const finalPayload = JSON.parse(finalUpdate.payload);
  assert.equal(finalUpdate.status, "succeeded");
  assert.equal(finalUpdate.completedCount, 2);
  assert.equal(finalUpdate.retryCount, 1);
  assert.equal(finalPayload.passedCount, 2);
  assert.equal(finalPayload.repairedCount, 1);
  assert.deepEqual(finalPayload.blockedChapters, []);
});

test("executeContinuityAudit preserves the legacy blocked stop when auto repair is disabled", async () => {
  const service = new NovelCoreReviewBatchService();
  const chapters = [
    createChapter("chapter-1", 1, "第一章"),
    createChapter("chapter-2", 2, "第二章"),
  ];
  const updates = [];
  let repairTriggered = false;

  service.loadOrderedChapters = async () => chapters;
  service.ensureNotCancelled = async () => {};
  service.startHeartbeat = () => createDummyTimer();
  service.updateJobSafe = async (_jobId, data) => {
    updates.push(data);
  };
  service.runRepair = async () => {
    repairTriggered = true;
  };
  service.reviewService.auditChapter = async (_novelId, chapterId) => {
    if (chapterId === "chapter-1") {
      return createAuditResult(60, [{ id: "issue-1", status: "open", severity: "high" }]);
    }
    return createAuditResult(84, []);
  };

  const row = {
    id: "job-2",
    novelId: "novel-1",
    totalCount: 2,
    completedCount: 0,
    retryCount: 0,
    maxRetries: 2,
    currentStage: null,
    currentItemKey: null,
    currentItemLabel: null,
  };
  const payload = {
    chapterIds: chapters.map((chapter) => chapter.id),
    threshold: 75,
    autoRepairBlocked: false,
    blockedChapters: [],
    issueIdsByChapter: {},
  };

  await service.executeContinuityAudit(row, payload);

  assert.equal(repairTriggered, false);
  const finalUpdate = updates.at(-1);
  const finalPayload = JSON.parse(finalUpdate.payload);
  assert.equal(finalUpdate.status, "succeeded");
  assert.match(finalPayload.message, /请先修复后再继续/);
  assert.equal(finalPayload.blockedChapters.length, 1);
  assert.equal(finalPayload.blockedChapters[0].chapterId, "chapter-1");
});

test("executeContinuityRepair preserves blockers after a recoverable repair timeout", async () => {
  const service = new NovelCoreReviewBatchService();
  const chapter = createChapter("chapter-timeout", 1, "超时章");
  const updates = [];
  const repairCalls = [];

  service.loadOrderedChapters = async () => [chapter];
  service.ensureNotCancelled = async () => {};
  service.startHeartbeat = () => createDummyTimer();
  service.loadLatestContinuityAuditSnapshot = async () => null;
  service.updateJobSafe = async (_jobId, data) => {
    updates.push(data);
  };
  service.runRepair = async (_novelId, chapterId) => {
    repairCalls.push(chapterId);
    throw new Error("Timeout after 300000ms: Repair chapter 1");
  };
  service.reviewService.auditChapter = async () => {
    throw new Error("should not re-audit after repair timeout");
  };

  const row = {
    id: "job-timeout",
    novelId: "novel-1",
    totalCount: 1,
    completedCount: 0,
    retryCount: 0,
    maxRetries: 3,
    currentStage: null,
    currentItemKey: null,
    currentItemLabel: null,
  };
  const payload = {
    chapterIds: [chapter.id],
    threshold: 75,
    passedCount: 0,
    repairedCount: 0,
    blockedChapters: [{
      chapterId: chapter.id,
      chapterOrder: chapter.order,
      chapterLabel: "第1章 - 超时章",
      coherence: 52,
      issueIds: ["issue-timeout"],
    }],
    issueIdsByChapter: {
      [chapter.id]: ["issue-timeout"],
    },
  };

  await service.executeContinuityRepair(row, payload);

  assert.deepEqual(repairCalls, [chapter.id]);
  assert.ok(updates.some((update) => JSON.parse(update.payload).message.includes("本轮修复超时或临时失败")));
  const finalUpdate = updates.at(-1);
  const finalPayload = JSON.parse(finalUpdate.payload);
  assert.equal(finalUpdate.status, "succeeded");
  assert.equal(finalUpdate.completedCount, 0);
  assert.equal(finalUpdate.progress, 0);
  assert.equal(finalPayload.blockedChapters.length, 1);
  assert.equal(finalPayload.blockedChapters[0].chapterId, chapter.id);
  assert.match(finalPayload.message, /仍有 1 章暂未通过/);
});

test("executeContinuityRepair re-audits stale blockers before rewriting chapters", async () => {
  const service = new NovelCoreReviewBatchService();
  const chapter = createChapter("chapter-stale", 1, "旧报告章");
  const updates = [];
  let repairCallCount = 0;
  let auditCallCount = 0;

  service.loadOrderedChapters = async () => [chapter];
  service.ensureNotCancelled = async () => {};
  service.startHeartbeat = () => createDummyTimer();
  service.loadLatestContinuityAuditSnapshot = async () => null;
  service.updateJobSafe = async (_jobId, data) => {
    updates.push(data);
  };
  service.runRepair = async () => {
    repairCallCount += 1;
  };
  service.reviewService.auditChapter = async () => {
    auditCallCount += 1;
    return createAuditResult(86, []);
  };

  const row = {
    id: "job-stale",
    novelId: "novel-1",
    totalCount: 1,
    completedCount: 0,
    retryCount: 0,
    maxRetries: 3,
    currentStage: null,
    currentItemKey: null,
    currentItemLabel: null,
  };
  const payload = {
    chapterIds: [chapter.id],
    threshold: 75,
    passedCount: 0,
    repairedCount: 0,
    blockedChapters: [{
      chapterId: chapter.id,
      chapterOrder: chapter.order,
      chapterLabel: "第1章 - 旧报告章",
      coherence: 68,
      issueIds: [],
      isExpired: true,
    }],
    issueIdsByChapter: {
      [chapter.id]: [],
    },
  };

  await service.executeContinuityRepair(row, payload);

  const finalUpdate = updates.at(-1);
  const finalPayload = JSON.parse(finalUpdate.payload);
  assert.equal(auditCallCount, 1);
  assert.equal(repairCallCount, 0);
  assert.equal(finalUpdate.status, "succeeded");
  assert.equal(finalUpdate.completedCount, 1);
  assert.equal(finalPayload.blockedChapters.length, 0);
  assert.match(finalPayload.message, /已全部修复|可继续/);
});

test("executeQualityReviewAll keeps recoverable review timeouts as deferred chapters", async () => {
  const service = new NovelCoreReviewBatchService();
  const chapter = createChapter("chapter-review-timeout", 1, "审校超时章");
  const updates = [];
  const markedQualityResults = [];

  service.loadOrderedChapters = async () => [chapter];
  service.ensureNotCancelled = async () => {};
  service.startHeartbeat = () => createDummyTimer();
  service.updateJobSafe = async (_jobId, data) => {
    updates.push(data);
  };
  service.markChapterQualityResult = async (markedChapter, qualified) => {
    markedQualityResults.push({ chapterId: markedChapter.id, qualified });
  };
  service.reviewService.reviewChapter = async () => {
    throw new Error("Timeout after 300000ms: Quality review chapter 1");
  };

  const row = {
    id: "job-review-timeout",
    novelId: "novel-1",
    totalCount: 1,
    completedCount: 0,
    retryCount: 0,
    maxRetries: 0,
    currentStage: null,
    currentItemKey: null,
    currentItemLabel: null,
  };
  const payload = {
    chapterIds: [chapter.id],
    threshold: 75,
    qualifiedCount: 0,
  };

  await service.executeQualityReviewAll(row, payload);

  const finalUpdate = updates.at(-1);
  const finalPayload = JSON.parse(finalUpdate.payload);
  assert.equal(finalUpdate.status, "succeeded");
  assert.equal(finalUpdate.completedCount, 1);
  assert.equal(finalPayload.qualifiedCount, 0);
  assert.match(finalPayload.message, /保留待审校/);
  assert.deepEqual(markedQualityResults, []);
});

test("executeQualityRepairUntilPass re-checks continuity before marking a chapter as qualified", async () => {
  const service = new NovelCoreReviewBatchService();
  const chapter = createChapter("chapter-1", 1, "第一章");
  const updates = [];
  const repairCalls = [];
  const resolvedIssueCalls = [];
  const markedQualityResults = [];
  let reviewCallCount = 0;
  let auditCallCount = 0;

  service.loadOrderedChapters = async () => [chapter];
  service.ensureNotCancelled = async () => {};
  service.startHeartbeat = () => createDummyTimer();
  service.updateJobSafe = async (_jobId, data) => {
    updates.push(data);
  };
  service.markChapterQualityResult = async (markedChapter, qualified) => {
    markedQualityResults.push({ chapterId: markedChapter.id, qualified });
  };
  service.runRepair = async (_novelId, chapterId, options) => {
    repairCalls.push({ chapterId, options });
  };
  service.reviewService.resolveAuditIssues = async (_novelId, issueIds) => {
    resolvedIssueCalls.push(issueIds);
  };
  service.reviewService.reviewChapter = async () => {
    reviewCallCount += 1;
    if (reviewCallCount === 1) {
      return {
        score: {
          coherence: 62,
          repetition: 80,
          pacing: 72,
          voice: 74,
          engagement: 70,
          overall: 68,
        },
        issues: [{ severity: "high", category: "coherence", evidence: "问题", fixSuggestion: "修复" }],
      };
    }
    return {
      score: {
        coherence: 88,
        repetition: 12,
        pacing: 86,
        voice: 84,
        engagement: 85,
        overall: 86,
      },
      issues: [],
    };
  };
  service.reviewService.auditChapter = async () => {
    auditCallCount += 1;
    if (auditCallCount === 1) {
      return createAuditResult(63, [{ id: "continuity-1", status: "open", severity: "high" }]);
    }
    return createAuditResult(90, []);
  };

  const row = {
    id: "job-3",
    novelId: "novel-1",
    totalCount: 1,
    completedCount: 0,
    retryCount: 0,
    maxRetries: 3,
    currentStage: null,
    currentItemKey: null,
    currentItemLabel: null,
  };
  const payload = {
    chapterIds: [chapter.id],
    threshold: 75,
    repairedCount: 0,
    qualifiedCount: 0,
  };

  await service.executeQualityRepairUntilPass(row, payload);

  assert.equal(reviewCallCount, 3);
  assert.equal(auditCallCount, 2);
  assert.equal(repairCalls.length, 2);
  assert.deepEqual(repairCalls[0].options.reviewIssues?.map((item) => item.fixSuggestion), ["修复"]);
  assert.deepEqual(repairCalls[1].options.auditIssueIds, ["continuity-1"]);
  assert.deepEqual(resolvedIssueCalls, [["continuity-1"]]);

  const finalUpdate = updates.at(-1);
  const finalPayload = JSON.parse(finalUpdate.payload);
  assert.equal(finalUpdate.status, "succeeded");
  assert.equal(finalUpdate.retryCount, 2);
  assert.equal(finalPayload.repairedCount, 2);
  assert.equal(finalPayload.qualifiedCount, 1);
  assert.deepEqual(markedQualityResults, [{ chapterId: "chapter-1", qualified: true }]);
});

test("executeQualityRepairUntilPass treats low repetition as qualified", async () => {
  const service = new NovelCoreReviewBatchService();
  const chapter = createChapter("chapter-low-repetition", 1, "低重复章");
  const updates = [];
  const markedQualityResults = [];
  let reviewCallCount = 0;
  let repairCallCount = 0;

  service.loadOrderedChapters = async () => [chapter];
  service.ensureNotCancelled = async () => {};
  service.startHeartbeat = () => createDummyTimer();
  service.updateJobSafe = async (_jobId, data) => {
    updates.push(data);
  };
  service.markChapterQualityResult = async (markedChapter, qualified) => {
    markedQualityResults.push({ chapterId: markedChapter.id, qualified });
  };
  service.runRepair = async () => {
    repairCallCount += 1;
  };
  service.reviewService.reviewChapter = async () => {
    reviewCallCount += 1;
    return {
      score: {
        coherence: 85,
        repetition: 0,
        pacing: 82,
        voice: 80,
        engagement: 76,
        overall: 84,
      },
      issues: [],
    };
  };
  service.reviewService.auditChapter = async () => createAuditResult(90, []);

  const row = {
    id: "job-low-repetition",
    novelId: "novel-1",
    totalCount: 1,
    completedCount: 0,
    retryCount: 0,
    maxRetries: 3,
    currentStage: null,
    currentItemKey: null,
    currentItemLabel: null,
  };
  const payload = {
    chapterIds: [chapter.id],
    threshold: 75,
    repairedCount: 0,
    qualifiedCount: 0,
  };

  await service.executeQualityRepairUntilPass(row, payload);

  const finalUpdate = updates.at(-1);
  const finalPayload = JSON.parse(finalUpdate.payload);
  assert.equal(finalUpdate.status, "succeeded");
  assert.equal(reviewCallCount, 1);
  assert.equal(repairCallCount, 0);
  assert.equal(finalPayload.qualifiedCount, 1);
  assert.deepEqual(markedQualityResults, [{ chapterId: "chapter-low-repetition", qualified: true }]);
});

test("startQualityRepairJob falls back to quality review when there are no repair targets", async () => {
  const service = new NovelCoreReviewBatchService();
  const calls = [];

  service.startJob = async (_novelId, jobType, options) => {
    calls.push({ jobType, options });
    if (jobType === "quality_repair_until_pass") {
      throw new Error("当前没有待处理的质量章节。");
    }
    return {
      id: "fallback-quality-review",
      novelId: "novel-1",
      jobType,
      status: "queued",
    };
  };

  const result = await service.startQualityRepairJob("novel-1", { threshold: 82 });

  assert.deepEqual(calls.map((call) => call.jobType), ["quality_repair_until_pass", "quality_review_all"]);
  assert.equal(calls[1].options.threshold, 82);
  assert.equal(result.jobType, "quality_review_all");
});

test("startContinuityRepairJob falls back to auto-repairing continuity audit when blockers are already cleared", async () => {
  const service = new NovelCoreReviewBatchService();
  const calls = [];

  service.startJob = async (_novelId, jobType, options) => {
    calls.push({ jobType, options });
    if (jobType === "continuity_repair_blocked") {
      throw new Error("当前没有待修复的连贯性阻塞章节。");
    }
    return {
      id: "fallback-continuity-audit",
      novelId: "novel-1",
      jobType,
      status: "queued",
    };
  };

  const result = await service.startContinuityRepairJob("novel-1", { threshold: 78, autoRepairBlocked: false });

  assert.deepEqual(calls.map((call) => call.jobType), ["continuity_repair_blocked", "continuity_audit"]);
  assert.equal(calls[1].options.threshold, 78);
  assert.equal(calls[1].options.autoRepairBlocked, true);
  assert.equal(result.jobType, "continuity_audit");
});

test("getQualityCandidates prioritizes real low-score chapters over stale finalized chapters", async () => {
  const service = new NovelCoreReviewBatchService();
  const originals = {
    chapterFindMany: prisma.chapter.findMany,
    getQualityReport: service.reviewService.getQualityReport,
  };

  prisma.chapter.findMany = async () => ([
    {
      id: "chapter-stale-finalized",
      title: "陈旧已定稿",
      order: 6,
      content: "正文",
      generationState: "approved",
      chapterStatus: "unplanned",
      updatedAt: new Date("2026-04-09T10:00:20+09:00"),
    },
    {
      id: "chapter-stale-review",
      title: "陈旧待复检",
      order: 10,
      content: "正文",
      generationState: "reviewed",
      chapterStatus: "unplanned",
      updatedAt: new Date("2026-04-09T10:00:20+09:00"),
    },
    {
      id: "chapter-low-score",
      title: "真实低分章",
      order: 135,
      content: "正文",
      generationState: "reviewed",
      chapterStatus: "unplanned",
      updatedAt: new Date("2026-04-09T10:00:00+09:00"),
    },
  ]);
  service.reviewService.getQualityReport = async () => ({
    novelId: "novel-1",
    summary: { coherence: 80, repetition: 12, pacing: 80, voice: 80, engagement: 80, overall: 80 },
    totalReports: 3,
    chapterReports: [
      {
        chapterId: "chapter-stale-finalized",
        overall: 84,
        isMissing: false,
        isStale: true,
      },
      {
        chapterId: "chapter-stale-review",
        overall: 81,
        isMissing: false,
        isStale: true,
      },
      {
        chapterId: "chapter-low-score",
        overall: 7,
        isMissing: false,
        isStale: false,
      },
    ],
  });

  try {
    const candidates = await service.getQualityCandidates("novel-1", 75);
    assert.deepEqual(candidates.map((item) => item.id), [
      "chapter-low-score",
      "chapter-stale-review",
    ]);
  } finally {
    prisma.chapter.findMany = originals.chapterFindMany;
    service.reviewService.getQualityReport = originals.getQualityReport;
  }
});

test("getQualityCandidates can include finalized stale chapters for explicit recheck runs", async () => {
  const service = new NovelCoreReviewBatchService();
  const originals = {
    chapterFindMany: prisma.chapter.findMany,
    getQualityReport: service.reviewService.getQualityReport,
  };

  prisma.chapter.findMany = async () => ([
    {
      id: "chapter-finalized-stale",
      title: "已定稿旧章",
      order: 6,
      content: "正文",
      generationState: "approved",
      chapterStatus: "unplanned",
      updatedAt: new Date("2026-04-09T10:00:20+09:00"),
    },
  ]);
  service.reviewService.getQualityReport = async () => ({
    novelId: "novel-1",
    summary: { coherence: 84, repetition: 10, pacing: 84, voice: 84, engagement: 84, overall: 84 },
    totalReports: 1,
    chapterReports: [
      {
        chapterId: "chapter-finalized-stale",
        overall: 84,
        isMissing: false,
        isStale: true,
      },
    ],
  });

  try {
    const defaultCandidates = await service.getQualityCandidates("novel-1", 75, false);
    const finalizedRecheckCandidates = await service.getQualityCandidates("novel-1", 75, true);
    assert.equal(defaultCandidates.length, 0);
    assert.deepEqual(finalizedRecheckCandidates.map((item) => item.id), ["chapter-finalized-stale"]);
  } finally {
    prisma.chapter.findMany = originals.chapterFindMany;
    service.reviewService.getQualityReport = originals.getQualityReport;
  }
});
