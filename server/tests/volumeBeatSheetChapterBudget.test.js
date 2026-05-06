const test = require("node:test");
const assert = require("node:assert/strict");
const {
  getBeatSheetChapterSpanUpperBound,
  inferRequiredChapterCountFromBeatSheet,
  normalizeBeatSheetChapterSpans,
} = require("../dist/services/novel/volume/volumeBeatSheetChapterBudget.js");

test("getBeatSheetChapterSpanUpperBound returns the upper bound for chapter ranges", () => {
  assert.equal(getBeatSheetChapterSpanUpperBound("20-25章"), 25);
  assert.equal(getBeatSheetChapterSpanUpperBound("第29-30章"), 30);
  assert.equal(getBeatSheetChapterSpanUpperBound("第8章"), 8);
  assert.equal(getBeatSheetChapterSpanUpperBound("未标注"), 0);
});

test("inferRequiredChapterCountFromBeatSheet uses the farthest beat span end for local spans", () => {
  const beatSheet = {
    beats: [
      { chapterSpanHint: "1-2章" },
      { chapterSpanHint: "5-7章" },
      { chapterSpanHint: "12-15章" },
      { chapterSpanHint: "20-25章" },
      { chapterSpanHint: "29-30章" },
    ],
  };

  assert.equal(inferRequiredChapterCountFromBeatSheet(beatSheet), 30);
  assert.equal(inferRequiredChapterCountFromBeatSheet({ beats: [] }), 0);
  assert.equal(inferRequiredChapterCountFromBeatSheet(null), 0);
});

test("inferRequiredChapterCountFromBeatSheet uses span width for global chapter spans", () => {
  const beatSheet = {
    beats: [
      { chapterSpanHint: "31-33章" },
      { chapterSpanHint: "34-39章" },
      { chapterSpanHint: "40-44章" },
      { chapterSpanHint: "45-49章" },
      { chapterSpanHint: "50-55章" },
      { chapterSpanHint: "56-60章" },
    ],
  };

  assert.equal(inferRequiredChapterCountFromBeatSheet(beatSheet), 30);
});

test("normalizeBeatSheetChapterSpans offsets generated spans to the expected volume start", () => {
  const beats = [
    { label: "起势", chapterSpanHint: "31-33章" },
    { label: "推进", chapterSpanHint: "34-39章" },
    { label: "收束", chapterSpanHint: "56-60章" },
  ];

  assert.deepEqual(normalizeBeatSheetChapterSpans(beats, 17), [
    { label: "起势", chapterSpanHint: "17-19章" },
    { label: "推进", chapterSpanHint: "20-25章" },
    { label: "收束", chapterSpanHint: "42-46章" },
  ]);
});
