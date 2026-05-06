const test = require("node:test");
const assert = require("node:assert/strict");

const { trackEntityOwnership } = require("../dist/services/audit/EntityOwnershipTracker.js");

test("trackEntityOwnership does not flag explicit phone handoff chains as ambiguous", () => {
  const content = [
    "陆子野接过钱，收进口袋，然后从女生手中把展示机收回，转手递给钱德明。",
    "钱德明接过展示机搁到托盘上，从身后纸箱里取出一台塑封完好的同款手机递过来。",
    "陆子野接过钱德明递来的新机，当着她的面撕开包装，装上电池后按亮屏幕。",
  ].join("");

  const analysis = trackEntityOwnership(content, ["手机"]);

  assert.equal(analysis.ambiguities.length, 0);
  assert.equal(analysis.transfers.at(-1)?.from, "钱德明");
  assert.equal(analysis.transfers.at(-1)?.to, "陆子野");
});

test("trackEntityOwnership still flags explicit multi-owner phone ambiguity", () => {
  const content = "陆子野的手机落在钱德明手里，两个人都没有立刻说明到底谁在保管。";

  const analysis = trackEntityOwnership(content, ["手机"]);

  assert.equal(analysis.ambiguities.length, 1);
  assert.equal(analysis.ambiguities[0].item, "手机");
  assert.match(analysis.ambiguities[0].evidence, /落在钱德明手里/);
});

test("trackEntityOwnership ignores pure sales-count mentions after prior handoffs", () => {
  const content = [
    "陆子野把手机递给钱德明。",
    "钱德明把手机递给李志强。",
    "这一天，他们卖掉了四十三台手机、六十个U盘。",
  ].join("");

  const analysis = trackEntityOwnership(content, ["手机"]);

  assert.equal(analysis.ambiguities.length, 0);
});
