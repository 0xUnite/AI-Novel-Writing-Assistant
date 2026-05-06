const test = require("node:test");
const assert = require("node:assert/strict");

const { prisma } = require("../dist/db/prisma.js");
const { NovelCoreReviewService } = require("../dist/services/novel/novelCoreReviewService.js");

test("getQualityReport returns stable per-chapter rows and flags stale or missing reports", async () => {
  const originalChapterFindMany = prisma.chapter.findMany;
  const originalQualityFindMany = prisma.qualityReport.findMany;

  prisma.chapter.findMany = async () => ([
    {
      id: "chapter-1",
      title: "第一章",
      order: 1,
      content: "正文一",
      chapterStatus: "completed",
      generationState: "approved",
      updatedAt: new Date("2026-04-09T10:00:20+09:00"),
    },
    {
      id: "chapter-2",
      title: "第二章",
      order: 2,
      content: "正文二",
      chapterStatus: "pending_review",
      generationState: "drafted",
      updatedAt: new Date("2026-04-09T10:00:00+09:00"),
    },
  ]);

  prisma.qualityReport.findMany = async () => ([
    {
      id: "report-1",
      novelId: "novel-1",
      chapterId: "chapter-1",
      coherence: 84,
      repetition: 20,
      pacing: 82,
      voice: 80,
      engagement: 79,
      overall: 81,
      issues: null,
      createdAt: new Date("2026-04-09T10:00:00+09:00"),
      updatedAt: new Date("2026-04-09T10:00:00+09:00"),
    },
  ]);

  try {
    const service = new NovelCoreReviewService();
    const result = await service.getQualityReport("novel-1");

    assert.equal(result.chapterReports.length, 2);
    assert.equal(result.chapterReports[0].chapterId, "chapter-1");
    assert.equal(result.chapterReports[0].isStale, true);
    assert.equal(result.chapterReports[0].isMissing, false);
    assert.equal(result.chapterReports[1].chapterId, "chapter-2");
    assert.equal(result.chapterReports[1].isStale, true);
    assert.equal(result.chapterReports[1].isMissing, true);
  } finally {
    prisma.chapter.findMany = originalChapterFindMany;
    prisma.qualityReport.findMany = originalQualityFindMany;
  }
});
