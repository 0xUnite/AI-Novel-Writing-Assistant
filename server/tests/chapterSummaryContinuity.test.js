const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildChapterSummarySource,
} = require("../dist/services/novel/NovelChapterSummaryService.js");
const {
  briefSummary,
  extractFacts,
} = require("../dist/services/novel/novelP0Utils.js");
const {
  extractCharacterEventLines,
} = require("../dist/services/novel/novelCoreShared.js");
const {
  sanitizeStateText,
} = require("../dist/services/novel/chapterMemorySanitizer.js");

test("buildChapterSummarySource keeps the chapter ending in summary input", () => {
  const head = "阳光从破旧的窗帘缝隙里挤进来，陆子野在床铺上醒来。".repeat(120);
  const middle = "MIDDLE_SENTINEL_SHOULD_BE_DROPPED".repeat(160);
  const tail = "他推开门，走进阳光里，朝校门口走去，第一步先去找老周。".repeat(180);

  const source = buildChapterSummarySource(`${head}${middle}${tail}`);

  assert.match(source, /章节开头节选/);
  assert.match(source, /章节结尾节选/);
  assert.match(source, /朝校门口走去/);
  assert.equal(source.includes("MIDDLE_SENTINEL_SHOULD_BE_DROPPED"), false);
  assert.ok(source.length <= 7000);
});

test("briefSummary uses balanced facts instead of only the opening", () => {
  const content = Array.from({ length: 18 }, (_, index) => {
    const order = index + 1;
    if (order === 18) {
      return `第${order}句主角已经离开宿舍，朝校门口走去准备找老周`;
    }
    return `第${order}句主角仍在整理记忆和当前局面`;
  }).join("。");

  const facts = extractFacts(content);
  const summary = briefSummary(content, facts);

  assert.ok(facts.some((fact) => fact.content.includes("第18句")));
  assert.match(summary, /第18句/);
  assert.match(summary, /校门口/);
});

test("extractCharacterEventLines keeps late character state", () => {
  const content = Array.from({ length: 10 }, (_, index) => {
    const order = index + 1;
    if (order === 10) {
      return `陆子野第${order}次出现时已经推门走向校门口去找老周`;
    }
    return `陆子野第${order}次出现时仍在宿舍里整理局面`;
  }).join("。");

  const lines = extractCharacterEventLines(content, "陆子野", 3);

  assert.equal(lines.length, 3);
  assert.match(lines.join("\n"), /第10次/);
  assert.match(lines.join("\n"), /校门口/);
});

test("sanitizeStateText turns copied prose into durable state memory", () => {
  const raw = "那声音从石缝里挤出来的瞬间，周衍的左手已经本能地按住伤口，脚步在矿道里回响。";
  const state = sanitizeStateText(raw);

  assert.equal(state.includes("那声音从石缝里挤出来的瞬间"), false);
  assert.match(state, /身体|处境|警惕/);
});
