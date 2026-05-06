const test = require("node:test");
const assert = require("node:assert/strict");

const {
  directorBookContractSchema,
} = require("../dist/services/novel/director/novelDirectorSchemas.js");

function buildContractInput(overrides = {}) {
  return {
    readingPromise: "读者持续获得重生商战逆袭的阶段性回报。",
    protagonistFantasy: "主角用前世经验和现实执行力一步步翻盘。",
    coreSellingPoint: "2005 年商业机会与个人逆袭绑定推进。",
    chapter3Payoff: "前三章完成重生落点与第一笔机会判断。",
    chapter10Payoff: "第十章让主角拿到第一个可见成果。",
    chapter30Payoff: "第三十章完成第一阶段商业跃迁。",
    escalationLadder: "从小生意试错到资源整合，再到正面对抗。",
    relationshipMainline: "核心关系围绕信任、合作和利益冲突推进。",
    absoluteRedLines: [
      "不能写成轻松穿越喜剧",
      "不能让对手集体降智",
    ],
    ...overrides,
  };
}

test("directorBookContractSchema accepts numbered absoluteRedLines text and normalizes it to an array", () => {
  const parsed = directorBookContractSchema.parse(buildContractInput({
    absoluteRedLines: "1.前20章绝对禁止揭示主角显赫身世，否则摧毁白手起家的人设逻辑。2.主角商业认知不能万能化，不能想到就能做到。3.甜宠线戏份严格控制，禁止让感情线喧宾夺主。4.对手智商必须全程在线，禁止工具人对手。5.禁止发散至娱乐明星、官场政治、黑道火并等非商业领域。6.时间线严格控制在2005年内。",
  }));

  assert.deepEqual(parsed.absoluteRedLines, [
    "前20章绝对禁止揭示主角显赫身世，否则摧毁白手起家的人设逻辑。",
    "主角商业认知不能万能化，不能想到就能做到。",
    "甜宠线戏份严格控制，禁止让感情线喧宾夺主。",
    "对手智商必须全程在线，禁止工具人对手。",
    "禁止发散至娱乐明星、官场政治、黑道火并等非商业领域。",
    "时间线严格控制在2005年内。",
  ]);
});

