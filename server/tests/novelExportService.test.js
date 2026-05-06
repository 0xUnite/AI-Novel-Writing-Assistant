const test = require("node:test");
const assert = require("node:assert/strict");

const { prisma } = require("../dist/db/prisma.js");
const { NovelExportService } = require("../dist/services/novel/NovelExportService.js");

test("buildExportContent normalizes chapter headings for txt export", async () => {
  const originalFindUnique = prisma.novel.findUnique;

  prisma.novel.findUnique = async () => ({
    title: "测试小说",
    description: "一句话简介",
    chapters: [
      { order: 1, title: "第1章", content: "# 第1章 注视\n\n正文一" },
      { order: 2, title: "第2章", content: "# 第2章 灵视初醒\n\n正文二" },
      { order: 3, title: "   ", content: null },
      { order: 4, title: "New Chapter 4", content: "正文四" },
    ],
  });

  try {
    const service = new NovelExportService();
    const result = await service.buildExportContent("novel-1", "txt");

    assert.match(result.content, /第1章 注视\n-+\n正文一/);
    assert.match(result.content, /第2章 灵视初醒\n-+/);
    assert.match(result.content, /第3章\n-+\n（本章暂无内容）/);
    assert.match(result.content, /第4章 New Chapter 4\n-+/);
    assert.doesNotMatch(result.content, /第1章 第1章/);
    assert.doesNotMatch(result.content, /第2章 第2章/);
    assert.doesNotMatch(result.content, /# 第1章 注视/);
    assert.doesNotMatch(result.content, /# 第2章 灵视初醒/);
  } finally {
    prisma.novel.findUnique = originalFindUnique;
  }
});

test("buildExportContent normalizes chapter headings for markdown export", async () => {
  const originalFindUnique = prisma.novel.findUnique;

  prisma.novel.findUnique = async () => ({
    title: "测试小说",
    description: null,
    chapters: [
      { order: 5, title: "第5章", content: "# 第5章 旧梦回潮\n\n正文五" },
      { order: 6, title: "", content: "# 第6章\n\n正文六" },
      { order: 7, title: "灵视再启", content: "正文七" },
    ],
  });

  try {
    const service = new NovelExportService();
    const result = await service.buildExportContent("novel-2", "markdown");

    assert.match(result.content, /## 第5章 旧梦回潮\n\n正文五/);
    assert.match(result.content, /## 第6章\n/);
    assert.match(result.content, /## 第7章 灵视再启\n/);
    assert.doesNotMatch(result.content, /## 第5章 第5章/);
    assert.doesNotMatch(result.content, /\n# 第5章 旧梦回潮/);
  } finally {
    prisma.novel.findUnique = originalFindUnique;
  }
});
