const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildChapterWriteContext,
  buildChapterReviewContext,
  buildChapterRepairContext,
  buildChapterWriterContextBlocks,
  buildChapterReviewContextBlocks,
  buildChapterRepairContextBlocks,
} = require("../dist/prompting/prompts/novel/chapterLayeredContext.js");

function createContextPackage() {
  const now = new Date().toISOString();
  return {
    chapter: {
      id: "chapter-5",
      title: "第5章 反压落点",
      order: 5,
      content: null,
      expectation: "完成第一次明确反压",
      targetWordCount: 3000,
      taskSheet: "任务单：女二必须带来半份情报，结尾用交换情报制造新悬念。",
      supportingContextText: "",
    },
    plan: {
      id: "plan-5",
      chapterId: "chapter-5",
      planRole: "pressure",
      phaseLabel: "反压前夜",
      title: "第5章计划",
      objective: "完成第一次明确反压",
      participants: ["主角"],
      reveals: ["女二手里还有半份情报"],
      riskNotes: ["不要抢跑幕后黑手"],
      mustAdvance: ["完成第一次明确反压"],
      mustPreserve: ["压迫感和资源差距"],
      sourceIssueIds: [],
      replannedFromPlanId: null,
      hookTarget: "把交换情报做成新的悬念",
      chapterMeta: {
        eventWeight: 4,
        highStakesDialogue: true,
        schemeBeat: true,
        kindOfHook: "threat_approaches",
      },
      rawPlanJson: null,
      scenes: [],
      createdAt: now,
      updatedAt: now,
    },
    stateSnapshot: {
      id: "snapshot-4",
      novelId: "novel-1",
      sourceChapterId: "chapter-4",
      summary: "主角暂时被压制，女二失联但仍掌握关键线索。",
      rawStateJson: null,
      characterStates: [],
      relationStates: [],
      informationStates: [],
      foreshadowStates: [],
      createdAt: now,
      updatedAt: now,
    },
    openConflicts: [{
      id: "conflict-1",
      novelId: "novel-1",
      chapterId: "chapter-4",
      sourceSnapshotId: null,
      sourceIssueId: null,
      sourceType: "state",
      conflictType: "plot",
      conflictKey: "first-counterattack",
      title: "第一次反压仍未落地",
      summary: "主角还没有把反击落成实际收益，压迫感正在透支。",
      severity: "high",
      status: "open",
      evidence: ["上一章只拿到半份情报。"],
      affectedCharacterIds: ["char-2"],
      resolutionHint: "让女二带来的情报成为反压支点。",
      lastSeenChapterOrder: 4,
      createdAt: now,
      updatedAt: now,
    }],
    storyWorldSlice: null,
    characterRoster: [
      {
        id: "char-1",
        name: "主角",
        role: "主角",
        personality: "谨慎但不服输",
        currentState: "被压制",
        currentGoal: "抢回主动权",
      },
      {
        id: "char-2",
        name: "女二",
        role: "盟友",
        personality: "冷静克制",
        currentState: "暂时失联",
        currentGoal: "把关键情报送到主角手里",
      },
    ],
    creativeDecisions: [],
    openAuditIssues: [{
      id: "issue-1",
      reportId: "report-1",
      auditType: "plot",
      severity: "high",
      code: "plot_payoff_missing",
      description: "上一轮没有完成预期兑现。",
      evidence: "反压只停留在口头层面。",
      fixSuggestion: "必须给读者一个明确的反压结果。",
      status: "open",
      createdAt: now,
      updatedAt: now,
    }],
    previousChaptersSummary: [
      "上一章：主角踩进陷阱，但确认女二仍掌握关键情报。",
    ],
    openingHint: "Recent openings: none.",
    continuation: {
      enabled: false,
      sourceType: null,
      sourceId: null,
      sourceTitle: "",
      systemRule: "",
      humanBlock: "",
      antiCopyCorpus: [],
    },
    styleContext: null,
    characterDynamics: {
      novelId: "novel-1",
      currentVolume: {
        id: "volume-1",
        title: "第一卷",
        sortOrder: 1,
        startChapterOrder: 1,
        endChapterOrder: 10,
        currentChapterOrder: 5,
      },
      summary: "当前卷需要完成第一次反压，女二缺席风险已经升高。",
      pendingCandidateCount: 1,
      characters: [
        {
          characterId: "char-1",
          name: "主角",
          role: "主角",
          castRole: "lead",
          currentState: "被压制",
          currentGoal: "抢回主动权",
          volumeRoleLabel: "破局者",
          volumeResponsibility: "完成第一次反压",
          isCoreInVolume: true,
          plannedChapterOrders: [5],
          appearanceCount: 4,
          lastAppearanceChapterOrder: 4,
          absenceSpan: 0,
          absenceRisk: "none",
          factionLabel: "主角方",
          stanceLabel: "主动反扑",
        },
        {
          characterId: "char-2",
          name: "女二",
          role: "盟友",
          castRole: "support",
          currentState: "暂时失联",
          currentGoal: "把关键情报送到主角手里",
          volumeRoleLabel: "暗线持钥者",
          volumeResponsibility: "补足情报链并触发反压机会",
          isCoreInVolume: true,
          plannedChapterOrders: [3, 5, 6],
          appearanceCount: 2,
          lastAppearanceChapterOrder: 2,
          absenceSpan: 3,
          absenceRisk: "high",
          factionLabel: "主角方",
          stanceLabel: "隐线支援",
        },
      ],
      relations: [{
        id: "rel-1",
        novelId: "novel-1",
        relationId: "pair-1",
        sourceCharacterId: "char-1",
        targetCharacterId: "char-2",
        sourceCharacterName: "主角",
        targetCharacterName: "女二",
        volumeId: "volume-1",
        volumeTitle: "第一卷",
        chapterId: null,
        chapterOrder: 5,
        stageLabel: "互试探合作",
        stageSummary: "双方都要靠交换信息来建立基本信任。",
        nextTurnPoint: "交换关键情报",
        sourceType: "projection",
        confidence: 0.9,
        isCurrent: true,
        createdAt: now,
        updatedAt: now,
      }],
      candidates: [{
        id: "candidate-1",
        novelId: "novel-1",
        sourceChapterId: "chapter-4",
        sourceChapterOrder: 4,
        proposedName: "林策",
        proposedRole: "情报商",
        summary: "可能承接黑市情报链。",
        evidence: ["第四章提到一个只闻其名的黑市联系人。"],
        matchedCharacterId: null,
        status: "pending",
        confidence: 0.72,
        createdAt: now,
        updatedAt: now,
      }],
      factionTracks: [],
      assignments: [],
    },
    bookContract: {
      title: "测试小说",
      genre: "都市",
      targetAudience: "新手向男频读者",
      sellingPoint: "高压开局与持续反压",
      first30ChapterPromise: "前三十章稳定兑现压迫与反压快感",
      narrativePov: "limited-third-person",
      pacePreference: "fast",
      emotionIntensity: "high",
      toneGuardrails: ["不写空泛鸡汤"],
      hardConstraints: ["主线必须持续升级"],
    },
    macroConstraints: {
      sellingPoint: "高压开局与持续反压",
      coreConflict: "主角在压迫中夺回主动权",
      mainHook: "更大的幕后势力正在浮现",
      progressionLoop: "每次反压都会引来更强反扑",
      growthPath: "从被动求生到主动设局",
      endingFlavor: "阶段性大胜但保留更大战场",
      hardConstraints: ["不能跳过压迫链兑现"],
    },
    volumeWindow: {
      volumeId: "volume-1",
      sortOrder: 1,
      title: "第一卷",
      missionSummary: "建立压迫源并完成第一次反压",
      adjacentSummary: "下一卷升级敌我盘面",
      pendingPayoffs: ["伏笔A"],
      softFutureSummary: "第二卷会引出更高层势力。",
    },
    chapterMission: null,
    chapterWriteContext: null,
    chapterReviewContext: null,
    chapterRepairContext: null,
    promptBudgetProfiles: [],
  };
}

test("chapter layered contexts carry volume mission, character duties and repair guardrails", () => {
  const contextPackage = createContextPackage();
  const writeContext = buildChapterWriteContext({
    bookContract: contextPackage.bookContract,
    macroConstraints: contextPackage.macroConstraints,
    volumeWindow: contextPackage.volumeWindow,
    contextPackage,
  });
  const reviewContext = buildChapterReviewContext(writeContext, contextPackage);
  const repairContext = buildChapterRepairContext({
    writeContext,
    contextPackage,
    issues: [{
      severity: "high",
      category: "pacing",
      evidence: "上一轮没有把女二情报落成反压结果。",
      fixSuggestion: "让女二的情报直接推动第一次反压兑现。",
    }],
  });

  assert.ok(writeContext.participants.some((item) => item.name === "女二"));
  assert.ok(writeContext.characterBehaviorGuides.some((item) => item.volumeResponsibility.includes("反压机会")));
  assert.ok(writeContext.characterBehaviorGuides.some((item) => item.absenceRisk === "high"));
  assert.ok(writeContext.pendingCandidateGuards.some((item) => item.proposedName === "林策"));
  assert.ok(writeContext.openConflictSummaries.some((item) => item.includes("第一次反压仍未落地")));
  assert.equal(writeContext.chapterBridge, null);
  assert.equal(writeContext.chapterMission.targetWordCount, 3000);
  assert.equal(writeContext.chapterMission.taskSheet, "任务单：女二必须带来半份情报，结尾用交换情报制造新悬念。");
  assert.equal(writeContext.chapterMeta.eventWeight, 4);
  assert.equal(writeContext.chapterMeta.kindOfHook, "threat_approaches");
  assert.ok(reviewContext.structureObligations.includes("volume mission: 建立压迫源并完成第一次反压"));
  assert.ok(reviewContext.structureObligations.includes("pending payoff: 伏笔A"));
  assert.ok(repairContext.allowedEditBoundaries.some((item) => item.includes("Pending character candidates remain read-only")));
  assert.ok(repairContext.allowedEditBoundaries.some((item) => item.includes("女二")));

  const reviewBlocks = buildChapterReviewContextBlocks(reviewContext);
  const repairBlocks = buildChapterRepairContextBlocks(repairContext);
  const writerBlocks = buildChapterWriterContextBlocks(writeContext);

  assert.ok(writerBlocks.some((block) => (
    block.id === "chapter_mission"
    && /Task sheet:/.test(block.content)
    && /女二必须带来半份情报/.test(block.content)
  )));
  assert.ok(writerBlocks.some((block) => (
    block.id === "chapter_quality_constraints"
    && /event_weight=4/.test(block.content)
    && /High-energy event is mandatory/.test(block.content)
    && /scheme_four_step/.test(block.content)
    && /读者信息量/.test(block.content)
    && /不可退让动机/.test(block.content)
  )));
  assert.ok(writerBlocks.some((block) => (
    block.id === "human_texture_guidance"
    && /心理戏必须嵌在动作前后/.test(block.content)
    && /4-8 轮有效对话/.test(block.content)
    && /轻微幽默/.test(block.content)
    && /Relationship micro-shift targets/.test(block.content)
  )));
  assert.ok(writerBlocks.some((block) => (
    block.id === "chapter_pacing_guidance"
    && /读者看完只能用一句话概括/.test(block.content)
    && /十几句话才能复述/.test(block.content)
    && /主线逻辑断裂/.test(block.content)
    && /Plan signal: plan_role=pressure; event_weight=4/.test(block.content)
  )));
  assert.ok(writerBlocks.some((block) => (
    block.id === "creative_agency_guidance"
    && /大纲、人设、伏笔是导航和护栏/.test(block.content)
    && /主角不能只被剧情推着走/.test(block.content)
    && /人物要有撞击感/.test(block.content)
    && /Character agency seeds/.test(block.content)
  )));
  assert.ok(writerBlocks.some((block) => (
    block.id === "character_social_depth_guidance"
    && /功能性大于完美性/.test(block.content)
    && /记忆点大于完整性/.test(block.content)
    && /破坏力大于邪恶值/.test(block.content)
    && /Strong-link relation seeds/.test(block.content)
  )));
  assert.ok(writerBlocks.some((block) => (
    block.id === "opening_conversion_guidance"
    && /chapter_order=5; opening_window=false/.test(block.content)
    && /不要把正文强行写成投放文案/.test(block.content)
    && /有效微创新/.test(block.content)
    && /300 字以内必须进入主题/.test(block.content)
    && /前置高光事件/.test(block.content)
    && /排比、夸张和数字强调/.test(block.content)
  )));
  assert.ok(writerBlocks.some((block) => (
    block.id === "launch_appeal_density_guidance"
    && /直白、吸睛、快节奏/.test(block.content)
    && /每 300 字争取有一个小看点/.test(block.content)
    && /每 500 字有一个小钩子/.test(block.content)
    && /真情实感优先于预制套路/.test(block.content)
  )));
  assert.ok(writerBlocks.some((block) => (
    block.id === "chapter_detail_policy_guidance"
    && /detail_level=spotlight/.test(block.content)
    && /篇幅是硬合同/.test(block.content)
    && /详写高光/.test(block.content)
  )));

  assert.ok(reviewBlocks.some((block) => (
    block.id === "character_dynamics"
    && /Character behavior guidance/.test(block.content)
    && /Pending candidate guardrails/.test(block.content)
  )));
  assert.ok(!writerBlocks.some((block) => block.id === "chapter_bridge"));
  assert.ok(reviewBlocks.some((block) => (
    block.id === "chapter_mission"
    && /Target length: around 3000 Chinese characters/.test(block.content)
    && /2700-3240/.test(block.content)
    && /start wrapping near 3120/.test(block.content)
    && /never exceed 3360/.test(block.content)
  )));
  assert.ok(repairBlocks.some((block) => block.id === "structure_obligations" && /volume mission/.test(block.content)));
  assert.ok(repairBlocks.some((block) => block.id === "repair_boundaries" && /read-only/.test(block.content)));
});
