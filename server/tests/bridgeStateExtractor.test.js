const test = require("node:test");
const assert = require("node:assert/strict");

const {
  extractBridgeState,
} = require("../dist/services/novel/runtime/utils/bridgeStateExtractor.js");

test("extractBridgeState derives reusable bridge context from the previous chapter tail", () => {
  const state = extractBridgeState([
    "陆子野把钥匙塞进口袋，没有立刻开口。",
    "老周看了他一眼，还是跟着他往校门口走。",
    "夜风吹过来的时候，两个人都没有停下脚步。",
    "陆子野决定明天一早去找供货商，把那张名片上的电话打通。",
    "随后他把文件夹抱紧，先记住仓库门口的车牌。",
  ].join(""));

  assert.equal(state.lastSentence, "随后他把文件夹抱紧，先记住仓库门口的车牌。");
  assert.equal(state.lastTime, "明天一早");
  assert.match(state.lastScene, /门口/);
  assert.ok(state.lastCharacters.includes("陆子野"));
  assert.ok(state.lastCharacters.includes("老周"));
  assert.ok(state.pendingActions.some((item) => item.includes("去找供货商")));
  assert.ok(state.keyItems.includes("钥匙"));
  assert.ok(state.keyItems.includes("名片"));
  assert.ok(state.keyItems.includes("文件"));
  assert.equal(state.lastTenSentences.length, 5);
});
