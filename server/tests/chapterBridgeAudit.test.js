const test = require("node:test");
const assert = require("node:assert/strict");

const {
  detectChapterOpeningJumpCut,
  detectChapterOpeningSceneRewind,
  detectChapterTransitionIssues,
  validateEndingDiversity,
  applyChapterOpeningJumpCutPenalty,
  mergeChapterOpeningJumpCutIntoReports,
} = require("../dist/services/audit/chapterBridgeAudit.js");

function createContextPackage() {
  return {
    chapterBridge: {
      previousChapterId: "chapter-3",
      previousChapterOrder: 3,
      previousChapterTitle: "先手",
      previousChapterSummary: "主角发现自己还握着几天先手，准备顺势追查。",
      tailExcerpt: "他心里清楚，那个姓赵的老板今天从省城供货商手里接走了一张名片。而他，也已经找到了那条缝。这场比赛才刚刚开始，而他至少还有几天的先手。",
      carryOverFacts: [
        "省城供货商手里接走了一张名片",
        "已经找到了那条缝",
        "至少还有几天的先手",
      ],
      lastTenSentences: [
        "那个姓赵的老板今天从省城供货商手里接走了一张名片。",
        "陆子野已经找到了那条缝。",
        "这场比赛还没有到亮底牌的时候。",
      ],
      lastScene: "供货商办公室门口",
      lastTime: "当晚",
      lastCharacters: ["陆子野"],
      lastCharacterStates: ["陆子野：已经找到突破口，但还不能露底。"],
      pendingActions: ["顺势追查供货商线索"],
      keyItems: ["名片"],
      lastSentence: "这场比赛才刚刚开始，而他至少还有几天的先手。",
      openingDirective: "本章开头必须承接上一章尾声。",
    },
  };
}

test("detectChapterOpeningJumpCut flags explicit reset without a bridge", () => {
  const issue = detectChapterOpeningJumpCut(
    createContextPackage(),
    "九月十三日，下午两点。陆子野坐在宿舍那张吱呀作响的旧椅子上，面前摊着一张横格纸，像一张简陋的作战地图。",
  );

  assert.ok(issue);
  assert.equal(issue.code, "continuity_opening_jump_cut");
  assert.match(issue.evidence, /上一章尾声/);
  assert.match(issue.evidence, /本章开头/);
});

test("detectChapterOpeningJumpCut stays quiet when the opening carries the bridge forward", () => {
  const issue = detectChapterOpeningJumpCut(
    createContextPackage(),
    "第二天一早，陆子野还记着昨晚那张名片的事，顺着昨天理出来的那条缝去找供货商留下的线索。",
  );

  assert.equal(issue, null);
});

test("detectChapterOpeningSceneRewind flags openings that roll back to an earlier scene step", () => {
  const issue = detectChapterOpeningSceneRewind(
    {
      chapterBridge: {
        previousChapterId: "chapter-1",
        previousChapterOrder: 1,
        previousChapterTitle: "重生起点",
        previousChapterSummary: "主角已经走出门外，往校门方向去找老周。",
        tailExcerpt: "陆子野深吸一口气，推开门，走进了九月的阳光里。他走向校门的方向，脚步不急不缓。第一步，先去找老周。",
        carryOverFacts: ["走进了九月的阳光里", "走向校门的方向", "先去找老周"],
        openingDirective: "承接上一章尾声。",
      },
    },
    "走廊里还有几个同学在喝水聊天，看见他出来，打了个招呼。陆子野扯了个浅淡的笑，没多说什么，侧身从人缝里绕了出去，顺着楼梯往下走。",
  );

  assert.ok(issue);
  assert.equal(issue.code, "continuity_opening_scene_rewind");
});

test("chapter bridge penalty lowers coherence and injects a continuity issue", () => {
  const reports = mergeChapterOpeningJumpCutIntoReports([
    {
      auditType: "continuity",
      overallScore: 84,
      summary: "continuity 审计已生成。",
      issues: [],
    },
  ], detectChapterOpeningJumpCut(
    createContextPackage(),
    "九月十三日，下午两点。陆子野重新摊开账本，像是什么都没发生过一样。",
  ));

  assert.equal(reports[0].overallScore, 68);
  assert.equal(reports[0].issues[0].code, "continuity_opening_jump_cut");

  const score = applyChapterOpeningJumpCutPenalty({
    coherence: 88,
    repetition: 10,
    pacing: 84,
    voice: 80,
    engagement: 86,
    overall: 85,
  });

  assert.equal(score.coherence, 68);
  assert.equal(score.overall, 70);
});


test("detectChapterTransitionIssues flags missing event progress from previous ending", () => {
  const issues = detectChapterTransitionIssues({
    chapterBridge: {
      previousChapterId: "chapter-22",
      previousChapterOrder: 22,
      previousChapterTitle: "明天见张德明",
      previousChapterSummary: "主角决定明天去见张德明，队伍还没成型。",
      tailExcerpt: "陆子野翻了个身，闭上眼睛。明天，去见张德明。后面还有很多仗要打。而他身边这支队伍，还远远没成型。",
      carryOverFacts: ["明天去见张德明", "队伍还远远没成型"],
      lastTenSentences: ["明天，去见张德明。", "队伍还远远没成型。"],
      lastScene: "宿舍",
      lastTime: "深夜",
      lastCharacters: ["陆子野"],
      lastCharacterStates: ["陆子野：已经决定主动出击。"],
      pendingActions: ["明天去见张德明"],
      keyItems: [],
      lastSentence: "而他身边这支队伍，还远远没成型。",
      openingDirective: "承接上一章尾声。",
    },
  }, "第二天一早，陆子野坐在食堂靠窗的位置，把账本摊开，开始重新计算校园数码生意的利润。", {
    novelTitle: "重生2005：从打工仔到商业教父",
  });

  assert.ok(issues.some((issue) => issue.code === "continuity_event_progress_gap"));
});

test("detectChapterTransitionIssues flags unresolved signal not carried into the next opening", () => {
  const issues = detectChapterTransitionIssues({
    chapterBridge: {
      previousChapterId: "chapter-1",
      previousChapterOrder: 1,
      previousChapterTitle: "监控下的生存逻辑",
      previousChapterSummary: "裴言发现凌晨三点十七分存在0点7秒同步紊乱。",
      tailExcerpt: "那团光似乎接收到了这个信号——它闪烁了一下，然后重新陷入沉默。裴言不知道那意味着什么。但他的后台数据里，多了一条新的记录。",
      carryOverFacts: ["信号闪烁了一下", "后台数据里多了一条新的记录"],
      lastTenSentences: ["那团光闪烁了一下。", "后台数据里多了一条新的记录。"],
      lastScene: "病房",
      lastTime: "凌晨",
      lastCharacters: ["裴言"],
      lastCharacterStates: ["裴言：仍在消化异常信号。"],
      pendingActions: ["查清那条新记录"],
      keyItems: ["药丸"],
      lastSentence: "但他的后台数据里，多了一条新的记录。",
      openingDirective: "承接上一章尾声。",
    },
  }, "药丸是淡蓝色的，和病号服的条纹同色系。小青端着托盘走进来的时候，裴言已经在病床上坐直了身体。");

  assert.ok(issues.some((issue) => issue.code === "continuity_unresolved_tail_not_carried"));
});

test("detectChapterTransitionIssues flags location regression from maintenance path to ward", () => {
  const issues = detectChapterTransitionIssues({
    chapterBridge: {
      previousChapterId: "chapter-28",
      previousChapterOrder: 28,
      previousChapterTitle: "地下二层旧接口",
      previousChapterSummary: "裴言进入地下二层维护通道并确认旧接口。",
      tailExcerpt: "通道的门锁发出了沉闷的咔嗒声。裴言靠在墙壁上，让心跳逐渐恢复正常节奏。黑暗中只有通风管道的嗡鸣声和他的呼吸声。旧接口的位置已经确认。",
      carryOverFacts: ["通道的门锁发出了沉闷的咔嗒声", "旧接口的位置已经确认"],
      lastTenSentences: ["旧接口的位置已经确认。"],
      lastScene: "地下二层维护通道",
      lastTime: "深夜",
      lastCharacters: ["裴言"],
      lastCharacterStates: ["裴言：刚确认旧接口位置。"],
      pendingActions: ["决定怎么从维护通道撤回"],
      keyItems: ["钥匙"],
      lastSentence: "旧接口的位置已经确认。",
      openingDirective: "承接上一章尾声。",
    },
  }, "病房的天花板仍然灰白。裴言维持着睡眠状态的呼吸节奏，等药车从走廊尽头靠近。");

  assert.ok(issues.some((issue) => issue.code === "continuity_location_regression"));
});

test("detectChapterTransitionIssues allows explicit return from maintenance path to ward", () => {
  const issues = detectChapterTransitionIssues({
    chapterBridge: {
      previousChapterId: "chapter-28",
      previousChapterOrder: 28,
      previousChapterTitle: "地下二层旧接口",
      previousChapterSummary: "裴言进入地下二层维护通道并确认旧接口。",
      tailExcerpt: "通道的门锁发出了沉闷的咔嗒声。裴言靠在墙壁上，让心跳逐渐恢复正常节奏。黑暗中只有通风管道的嗡鸣声和他的呼吸声。旧接口的位置已经确认。",
      carryOverFacts: ["通道的门锁发出了沉闷的咔嗒声", "旧接口的位置已经确认"],
      lastTenSentences: ["旧接口的位置已经确认。"],
      lastScene: "地下二层维护通道",
      lastTime: "深夜",
      lastCharacters: ["裴言"],
      lastCharacterStates: ["裴言：还在撤离路径上。"],
      pendingActions: ["折返回病房"],
      keyItems: [],
      lastSentence: "旧接口的位置已经确认。",
      openingDirective: "承接上一章尾声。",
    },
  }, "裴言沿着隐藏路径折返回病房时，青云的权限校验车还停在东侧走廊。他重新躺回床上，把呼吸压回睡眠状态。");

  assert.equal(issues.some((issue) => issue.code === "continuity_location_regression"), false);
});

test("detectChapterTransitionIssues flags bed-to-door bridge gaps", () => {
  const issues = detectChapterTransitionIssues({
    chapterBridge: {
      previousChapterId: "chapter-23",
      previousChapterOrder: 23,
      previousChapterTitle: "裴言伪装成病发",
      previousChapterSummary: "裴言躺在床上，药丸纹路被白噪淹没。",
      tailExcerpt: "裴言躺在床上，掌心握着那枚药丸，试图集中注意力解析掌心药丸上的纹路。但那些纹路在他的视野里闪烁了零点一秒，然后被白噪彻底淹没。",
      carryOverFacts: ["掌心握着那枚药丸", "白噪彻底淹没"],
      lastTenSentences: ["掌心握着那枚药丸。", "白噪彻底淹没。"],
      lastScene: "病床边",
      lastTime: "深夜",
      lastCharacters: ["裴言"],
      lastCharacterStates: ["裴言：仍被白噪干扰。"],
      pendingActions: ["等窗口恢复再行动"],
      keyItems: ["药丸"],
      lastSentence: "那些纹路被白噪彻底淹没。",
      openingDirective: "承接上一章尾声。",
    },
  }, "他的手仍然按在门锁上，指尖传来金属的冰凉。白噪还在，走廊尽头安静无声。");

  assert.ok(issues.some((issue) => issue.code === "continuity_bed_to_door_bridge_missing"));
});

test("detectChapterTransitionIssues flags false continuity restatement without forward push", () => {
  const issues = detectChapterTransitionIssues({
    chapterBridge: {
      previousChapterId: "chapter-9",
      previousChapterOrder: 9,
      previousChapterTitle: "先迈出去",
      previousChapterSummary: "陆子野已经推门出发，准备去找老周。",
      tailExcerpt: "陆子野推开宿舍门，朝校门方向走去。他没再回头。",
      carryOverFacts: ["推开宿舍门", "朝校门方向走去"],
      lastTenSentences: ["陆子野推开宿舍门，朝校门方向走去。", "他没再回头。"],
      lastScene: "宿舍门口",
      lastTime: "当晚",
      lastCharacters: ["陆子野"],
      lastCharacterStates: ["陆子野：已经做出决定。"],
      pendingActions: ["去找老周"],
      keyItems: [],
      lastSentence: "陆子野推开宿舍门，朝校门方向走去。",
      openingDirective: "承接上一章尾声。",
    },
  }, "陆子野推开宿舍门，朝校门方向走去。他的步子和刚才一样，不快也不慢。");

  assert.ok(issues.some((issue) => issue.code === "continuity_false_bridge_restatement"));
});

test("validateEndingDiversity rejects template endings and repeated suspense defaults", () => {
  const phraseIssues = validateEndingDiversity("他抬头看向夜色，这只是开始。", [
    { content: "他望着窗外的黑暗，这只是开始。" },
  ]);
  const functionIssues = validateEndingDiversity("手机忽然震了一下。", [
    { content: "电话忽然响了起来。" },
    { content: "门外忽然传来敲门声。" },
  ]);
  const calmCloseIssues = validateEndingDiversity("窗外的风慢慢停下来，茶水也凉了。", []);

  assert.ok(phraseIssues.some((issue) => issue.code === "continuity_ending_phrase_repetition"));
  assert.ok(functionIssues.some((issue) => issue.code === "continuity_ending_type_repetition"));
  assert.equal(calmCloseIssues.length, 0);
});
