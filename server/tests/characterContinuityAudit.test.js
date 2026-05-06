const test = require("node:test");
const assert = require("node:assert/strict");

const {
  auditCharacterContinuity,
} = require("../dist/services/audit/characterContinuityAudit.js");

test("auditCharacterContinuity is a no-op when no profile exists", () => {
  const result = auditCharacterContinuity({
    novelId: "novel-without-profile",
    content: "主角接过手机，继续往前走。",
  });

  assert.equal(result.profileId, null);
  assert.equal(result.issues.length, 0);
});

test("auditCharacterContinuity applies only the rebirth2005 profile rules", () => {
  const result = auditCharacterContinuity({
    novelId: "cmnvhbpjb004zt4jui6ac85tn",
    content: [
      "陆子野深吸一口气，决定把自己重生过一次的事直接告诉老周。",
      "李志强今天绝对可靠，永远不会背叛。",
      "裴言站在门口，看见数据流在墙面上闪动。",
    ].join(""),
  });

  assert.equal(result.profileId, "cmnvhbpjb004zt4jui6ac85tn");
  assert.ok(result.issues.some((issue) => issue.code === "profile_rebirth2005_luziye_identity_exposed"));
  assert.ok(result.issues.some((issue) => issue.code === "profile_rebirth2005_lizhiqiang_betrayal_reset"));
  assert.ok(result.issues.some((issue) => issue.code === "profile_rebirth2005_cross_project_contamination"));
});
