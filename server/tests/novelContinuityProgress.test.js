const test = require("node:test");
const assert = require("node:assert/strict");

const { NovelCoreReviewService } = require("../dist/services/novel/novelCoreReviewService.js");
const { prisma } = require("../dist/db/prisma.js");

function createChapter(order) {
  return {
    id: `chapter-${order}`,
    title: `第${order}章`,
    order,
    content: `第${order}章正文`,
    updatedAt: new Date("2026-04-09T10:00:00+09:00"),
  };
}

function stringifyContinuityPayload(payload) {
  return JSON.stringify({
    provider: "minimax",
    model: "MiniMax-M2.7",
    temperature: 0.7,
    threshold: 75,
    chapterIds: [],
    qualifiedCount: 0,
    repairedCount: 0,
    passedCount: payload.passedCount ?? 0,
    currentBatchStartOrder: payload.currentBatchStartOrder ?? null,
    currentBatchEndOrder: payload.currentBatchEndOrder ?? null,
    lastPassedOrder: payload.lastPassedOrder ?? null,
    blockedChapters: payload.blockedChapters ?? [],
    issueIdsByChapter: {},
    message: payload.message ?? null,
  });
}

test("getContinuityAuditProgress lets fresh continuity reports override stale blocked batch payloads", async () => {
  const service = new NovelCoreReviewService();
  const originals = {
    chapterFindMany: prisma.chapter.findMany,
    reviewBatchFindMany: prisma.novelReviewBatchJob.findMany,
    auditReportFindMany: prisma.auditReport.findMany,
  };

  let auditReportsCalled = false;

  prisma.chapter.findMany = async () => Array.from({ length: 400 }, (_, index) => createChapter(index + 1));
  prisma.novelReviewBatchJob.findMany = async () => ([
    {
      id: "continuity-audit-1",
      jobType: "continuity_audit",
      status: "succeeded",
      payload: stringifyContinuityPayload({
        lastPassedOrder: 100,
        currentBatchStartOrder: 101,
        currentBatchEndOrder: 120,
        blockedChapters: [{
          chapterId: "chapter-118",
          chapterOrder: 118,
          chapterLabel: "第118章 - 第118章",
          coherence: 3,
          issueIds: ["issue-118"],
        }],
      }),
      createdAt: new Date("2026-04-08T19:45:07+09:00"),
      updatedAt: new Date("2026-04-08T20:09:02+09:00"),
    },
    {
      id: "continuity-repair-1",
      jobType: "continuity_repair_blocked",
      status: "succeeded",
      payload: stringifyContinuityPayload({
        lastPassedOrder: 118,
        currentBatchStartOrder: 118,
        currentBatchEndOrder: 137,
        passedCount: 1,
        repairedCount: 1,
        blockedChapters: [],
      }),
      createdAt: new Date("2026-04-08T21:05:59+09:00"),
      updatedAt: new Date("2026-04-08T21:17:29+09:00"),
    },
    {
      id: "continuity-audit-2",
      jobType: "continuity_audit",
      status: "succeeded",
      payload: stringifyContinuityPayload({
        lastPassedOrder: 120,
        currentBatchStartOrder: 121,
        currentBatchEndOrder: 140,
        passedCount: 19,
        blockedChapters: [{
          chapterId: "chapter-135",
          chapterOrder: 135,
          chapterLabel: "第135章 - 第135章",
          coherence: 4,
          issueIds: ["issue-135-a", "issue-135-b"],
        }],
      }),
      createdAt: new Date("2026-04-08T21:18:13+09:00"),
      updatedAt: new Date("2026-04-08T21:30:55+09:00"),
    },
  ]);
  prisma.auditReport.findMany = async () => {
    auditReportsCalled = true;
    return Array.from({ length: 400 }, (_, index) => ({
      chapterId: `chapter-${index + 1}`,
      overallScore: 92,
      createdAt: new Date("2026-04-09T12:00:00+09:00"),
      issues: [],
    }));
  };

  try {
    const progress = await service.getContinuityAuditProgress("novel-1", 75);

    assert.equal(auditReportsCalled, true);
    assert.equal(progress.writtenChapterCount, 400);
    assert.equal(progress.status, "completed");
    assert.equal(progress.lastPassedOrder, 400);
    assert.equal(progress.resumeOrder, 401);
    assert.equal(progress.nextBatchStartOrder, null);
    assert.equal(progress.nextBatchEndOrder, null);
    assert.equal(progress.blockedChapters.length, 0);
  } finally {
    prisma.chapter.findMany = originals.chapterFindMany;
    prisma.novelReviewBatchJob.findMany = originals.reviewBatchFindMany;
    prisma.auditReport.findMany = originals.auditReportFindMany;
  }
});

test("getContinuityAuditProgress keeps completed cancelled audit batches as recovery anchors", async () => {
  const service = new NovelCoreReviewService();
  const originals = {
    chapterFindMany: prisma.chapter.findMany,
    reviewBatchFindMany: prisma.novelReviewBatchJob.findMany,
    auditReportFindMany: prisma.auditReport.findMany,
  };

  let auditReportsCalled = false;

  prisma.chapter.findMany = async () => Array.from({ length: 400 }, (_, index) => createChapter(index + 1));
  prisma.novelReviewBatchJob.findMany = async () => ([
    {
      id: "cancelled-complete-1",
      jobType: "continuity_audit",
      status: "cancelled",
      payload: stringifyContinuityPayload({
        lastPassedOrder: 160,
        currentBatchStartOrder: 141,
        currentBatchEndOrder: 160,
        passedCount: 20,
        blockedChapters: [],
      }),
      createdAt: new Date("2026-04-10T10:00:00+09:00"),
      updatedAt: new Date("2026-04-10T10:39:00+09:00"),
    },
    {
      id: "cancelled-blocked-1",
      jobType: "continuity_audit",
      status: "cancelled",
      payload: stringifyContinuityPayload({
        lastPassedOrder: 179,
        currentBatchStartOrder: 161,
        currentBatchEndOrder: 180,
        passedCount: 19,
        blockedChapters: [{
          chapterId: "chapter-179",
          chapterOrder: 179,
          chapterLabel: "第179章 - 第179章",
          coherence: 6,
          issueIds: ["issue-179"],
        }],
      }),
      createdAt: new Date("2026-04-10T11:00:00+09:00"),
      updatedAt: new Date("2026-04-10T11:35:00+09:00"),
    },
  ]);
  prisma.auditReport.findMany = async () => {
    auditReportsCalled = true;
    return [];
  };

  try {
    const progress = await service.getContinuityAuditProgress("novel-1", 75);

    assert.equal(auditReportsCalled, true);
    assert.equal(progress.status, "ready");
    assert.equal(progress.lastPassedOrder, 160);
    assert.equal(progress.resumeOrder, 161);
    assert.equal(progress.nextBatchStartOrder, 161);
    assert.equal(progress.nextBatchEndOrder, 180);
    assert.equal(progress.blockedChapters.length, 0);
  } finally {
    prisma.chapter.findMany = originals.chapterFindMany;
    prisma.novelReviewBatchJob.findMany = originals.reviewBatchFindMany;
    prisma.auditReport.findMany = originals.auditReportFindMany;
  }
});

test("getContinuityAuditProgress reuses failed continuity batches when they carry resumable progress", async () => {
  const service = new NovelCoreReviewService();
  const originals = {
    chapterFindMany: prisma.chapter.findMany,
    reviewBatchFindMany: prisma.novelReviewBatchJob.findMany,
    auditReportFindMany: prisma.auditReport.findMany,
  };

  let auditReportsCalled = false;

  prisma.chapter.findMany = async () => Array.from({ length: 400 }, (_, index) => createChapter(index + 1));
  prisma.novelReviewBatchJob.findMany = async () => ([
    {
      id: "continuity-audit-failed",
      jobType: "continuity_audit",
      status: "failed",
      payload: stringifyContinuityPayload({
        lastPassedOrder: 342,
        currentBatchStartOrder: 341,
        currentBatchEndOrder: 360,
        passedCount: 177,
        repairedCount: 35,
        blockedChapters: [{
          chapterId: "chapter-348",
          chapterOrder: 348,
          chapterLabel: "第348章 - 第348章",
          coherence: 9,
          issueIds: ["issue-348-a", "issue-348-b"],
        }],
        message: "第348章 - 第348章 第 1 次连贯性修复中。",
      }),
      createdAt: new Date("2026-04-11T12:54:55+09:00"),
      updatedAt: new Date("2026-04-11T19:30:08+09:00"),
    },
  ]);
  prisma.auditReport.findMany = async () => {
    auditReportsCalled = true;
    return [];
  };

  try {
    const progress = await service.getContinuityAuditProgress("novel-1", 75);

    assert.equal(auditReportsCalled, true);
    assert.equal(progress.status, "blocked");
    assert.equal(progress.lastPassedOrder, 342);
    assert.equal(progress.resumeOrder, 341);
    assert.equal(progress.nextBatchStartOrder, 341);
    assert.equal(progress.nextBatchEndOrder, 360);
    assert.equal(progress.blockedChapters.length, 1);
    assert.equal(progress.blockedChapters[0].chapterOrder, 348);
    assert.deepEqual(progress.blockedChapters[0].issueIds, ["issue-348-a", "issue-348-b"]);
  } finally {
    prisma.chapter.findMany = originals.chapterFindMany;
    prisma.novelReviewBatchJob.findMany = originals.reviewBatchFindMany;
    prisma.auditReport.findMany = originals.auditReportFindMany;
  }
});

test("getContinuityAuditProgress drops blocked payload snapshots after the chapter content changed", async () => {
  const service = new NovelCoreReviewService();
  const originals = {
    chapterFindMany: prisma.chapter.findMany,
    reviewBatchFindMany: prisma.novelReviewBatchJob.findMany,
    auditReportFindMany: prisma.auditReport.findMany,
  };

  prisma.chapter.findMany = async () => ([
    {
      ...createChapter(25),
      updatedAt: new Date("2026-04-16T04:58:00+09:00"),
    },
    {
      ...createChapter(26),
      updatedAt: new Date("2026-04-16T04:58:00+09:00"),
    },
  ]);
  prisma.novelReviewBatchJob.findMany = async () => ([
    {
      id: "continuity-audit-failed",
      jobType: "continuity_audit",
      status: "failed",
      payload: stringifyContinuityPayload({
        lastPassedOrder: 24,
        currentBatchStartOrder: 25,
        currentBatchEndOrder: 26,
        blockedChapters: [{
          chapterId: "chapter-25",
          chapterOrder: 25,
          chapterLabel: "第25章 - 第25章",
          coherence: 12,
          issueIds: ["issue-25-a"],
        }],
      }),
      createdAt: new Date("2026-04-16T04:40:00+09:00"),
      updatedAt: new Date("2026-04-16T04:50:00+09:00"),
    },
  ]);
  prisma.auditReport.findMany = async () => [];

  try {
    const progress = await service.getContinuityAuditProgress("novel-1", 75);

    assert.equal(progress.status, "ready");
    assert.equal(progress.lastPassedOrder, 24);
    assert.equal(progress.resumeOrder, 25);
    assert.equal(progress.nextBatchStartOrder, 25);
    assert.equal(progress.nextBatchEndOrder, 26);
    assert.equal(progress.blockedChapters.length, 0);
  } finally {
    prisma.chapter.findMany = originals.chapterFindMany;
    prisma.novelReviewBatchJob.findMany = originals.reviewBatchFindMany;
    prisma.auditReport.findMany = originals.auditReportFindMany;
  }
});
