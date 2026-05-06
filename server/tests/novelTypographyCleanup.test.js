const test = require("node:test");
const assert = require("node:assert/strict");

const { prisma } = require("../dist/db/prisma.js");
const { NovelCoreCrudService } = require("../dist/services/novel/novelCoreCrudService.js");

test("sanitizeNovelTypography only updates changed chapters and creates a snapshot before cleanup", async () => {
  const original = {
    novelFindUnique: prisma.novel.findUnique,
    snapshotCreate: prisma.novelSnapshot.create,
    chapterUpdate: prisma.chapter.update,
  };

  const snapshotCalls = [];
  const chapterUpdates = [];

  prisma.novel.findUnique = async () => ({
    id: "novel-1",
    outline: "旧大纲",
    structuredOutline: "旧拆章",
    chapters: [
      {
        id: "chapter-1",
        title: "第一章",
        order: 1,
        content: "\"你在做什么...\" *她叹了口气* ～",
      },
      {
        id: "chapter-2",
        title: "第二章",
        order: 2,
        content: "这一章已经很正常。",
      },
      {
        id: "chapter-3",
        title: "第三章",
        order: 3,
        content: "",
      },
    ],
  });

  prisma.novelSnapshot.create = async (input) => {
    snapshotCalls.push(input);
    return {
      id: "snapshot-1",
      ...input.data,
    };
  };

  prisma.chapter.update = async (input) => {
    chapterUpdates.push(input);
    return input;
  };

  try {
    const service = new NovelCoreCrudService();
    const result = await service.sanitizeNovelTypography("novel-1");

    assert.equal(result.totalChapterCount, 3);
    assert.equal(result.contentChapterCount, 2);
    assert.equal(result.changedCount, 1);
    assert.equal(result.unchangedCount, 1);
    assert.equal(result.snapshotId, "snapshot-1");
    assert.equal(result.changedChapters.length, 1);
    assert.equal(result.changedChapters[0].order, 1);

    assert.equal(snapshotCalls.length, 1);
    assert.equal(chapterUpdates.length, 1);
    assert.deepEqual(chapterUpdates[0], {
      where: { id: "chapter-1" },
      data: {
        content: "“你在做什么……” 她叹了口气",
      },
    });
  } finally {
    prisma.novel.findUnique = original.novelFindUnique;
    prisma.novelSnapshot.create = original.snapshotCreate;
    prisma.chapter.update = original.chapterUpdate;
  }
});
