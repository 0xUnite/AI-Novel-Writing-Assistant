const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeScore,
} = require("../dist/services/novel/novelP0Utils.js");

test("normalizeScore converts ten-point audit scores to pipeline percent scores", () => {
  const normalized = normalizeScore({
    coherence: 8,
    repetition: 8,
    pacing: 7,
    voice: 8,
    engagement: 9,
    overall: 8,
  });

  assert.equal(normalized.coherence, 80);
  assert.equal(normalized.repetition, 20);
  assert.equal(normalized.pacing, 70);
  assert.equal(normalized.voice, 80);
  assert.equal(normalized.engagement, 90);
  assert.equal(normalized.overall, 80);
});

test("normalizeScore preserves percent-scale repetition penalties", () => {
  const normalized = normalizeScore({
    coherence: 85,
    repetition: 8,
    pacing: 82,
    voice: 80,
    engagement: 72,
    overall: 84,
  });

  assert.equal(normalized.coherence, 85);
  assert.equal(normalized.repetition, 8);
  assert.equal(normalized.engagement, 72);
  assert.equal(normalized.overall, 84);
});
