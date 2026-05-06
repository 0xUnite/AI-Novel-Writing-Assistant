const test = require("node:test");
const assert = require("node:assert/strict");

const { ensureChapterTitle } = require("../dist/services/novel/chapterTitle.js");

test("ensureChapterTitle falls back to chapter order when title is blank", () => {
  assert.equal(
    ensureChapterTitle({
      order: 12,
      title: "   ",
    }),
    "第12章",
  );
});

test("ensureChapterTitle strips duplicated chapter prefixes from explicit titles", () => {
  assert.equal(
    ensureChapterTitle({
      order: 8,
      title: "第8章：雨夜来信",
    }),
    "雨夜来信",
  );
});

test("ensureChapterTitle can derive a title from the leading markdown heading", () => {
  assert.equal(
    ensureChapterTitle({
      order: 5,
      title: "",
      content: "# 第5章 星火将燃\n\n正文开始。",
    }),
    "星火将燃",
  );
});

test("ensureChapterTitle rejects generic english placeholders", () => {
  assert.equal(
    ensureChapterTitle({
      order: 3,
      title: "New Chapter 3",
    }),
    "第3章",
  );
});

test("ensureChapterTitle rejects schema placeholder strings", () => {
  assert.equal(
    ensureChapterTitle({
      order: 1,
      title: "string",
      expectation: "监控下的生存逻辑：裴言表面配合服药，暗中拆解昆仑系统漏洞。",
    }),
    "监控下的生存逻辑",
  );
});

test("ensureChapterTitle can derive a usable title from chapter expectation", () => {
  assert.equal(
    ensureChapterTitle({
      order: 9,
      title: "第9章",
      expectation: "她在废弃观测站里听见第二次回声，并发现门后的权限记录还活着。",
    }),
    "她在废弃观测站里听见第二次回声",
  );
});

test("ensureChapterTitle strips workflow labels from explicit titles", () => {
  assert.equal(
    ensureChapterTitle({
      order: 2,
      title: "开卷抓手：监控下的生存逻辑",
    }),
    "监控下的生存逻辑",
  );
});

test("ensureChapterTitle derives the real title from workflow-labeled expectations", () => {
  assert.equal(
    ensureChapterTitle({
      order: 2,
      title: "当前节奏起势",
      expectation: "承接「开卷抓手：监控下的生存逻辑」节奏段，补齐第 2 章的阶段推进。",
    }),
    "监控下的生存逻辑",
  );
});
