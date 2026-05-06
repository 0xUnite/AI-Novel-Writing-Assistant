const test = require("node:test");
const assert = require("node:assert/strict");

const { prisma } = require("../dist/db/prisma.js");
const { novelEventBus } = require("../dist/events/index.js");
const reviewService = require("../dist/services/novel/novelCoreReviewService.js");
const { NovelCorePipelineService } = require("../dist/services/novel/novelCorePipelineService.js");
const { NovelVolumeService } = require("../dist/services/novel/volume/NovelVolumeService.js");

test("listRecoverablePipelineJobs excludes cancellation-pending jobs", async () => {
  const originalFindMany = prisma.generationJob.findMany;
  let capturedInput = null;

  prisma.generationJob.findMany = async (input) => {
    capturedInput = input;
    return [];
  };

  try {
    const service = new NovelCorePipelineService();
    await service.listRecoverablePipelineJobs();
    assert.equal(capturedInput.where.cancelRequestedAt, null);
  } finally {
    prisma.generationJob.findMany = originalFindMany;
  }
});

test("retryPipelineJob rejects jobs that are still cancelling", async () => {
  const originalFindUnique = prisma.generationJob.findUnique;

  prisma.generationJob.findUnique = async () => ({
    id: "job-1",
    status: "cancelled",
    cancelRequestedAt: new Date("2026-04-03T09:00:00+08:00"),
    finishedAt: null,
  });

  try {
    const service = new NovelCorePipelineService();
    await assert.rejects(
      () => service.retryPipelineJob("job-1"),
      /任务仍在取消中，请等待取消完成后再重试/,
    );
  } finally {
    prisma.generationJob.findUnique = originalFindUnique;
  }
});

test("createPlaceholderPipelineChapters fills the full requested range beyond estimated count", async () => {
  const originalFindMany = prisma.chapter.findMany;
  const originalCreateMany = prisma.chapter.createMany;
  let createdOrders = [];

  prisma.chapter.findMany = async () => ([
    { order: 401 },
    { order: 405 },
  ]);
  prisma.chapter.createMany = async (input) => {
    createdOrders = input.data.map((item) => item.order);
    return { count: createdOrders.length };
  };

  try {
    const service = new NovelCorePipelineService();
    await service.createPlaceholderPipelineChapters("novel-1", {
      startOrder: 401,
      endOrder: 406,
    });

    assert.deepEqual(createdOrders, [402, 403, 404, 406]);
  } finally {
    prisma.chapter.findMany = originalFindMany;
    prisma.chapter.createMany = originalCreateMany;
  }
});

test("executePipeline preserves quality warnings across resume without stopping the batch", async () => {
  const original = {
    generationFindUnique: prisma.generationJob.findUnique,
    generationUpdate: prisma.generationJob.update,
    novelFindUnique: prisma.novel.findUnique,
    chapterFindMany: prisma.chapter.findMany,
    createQualityReport: reviewService.createQualityReport,
    emit: novelEventBus.emit,
  };

  const updates = [];
  prisma.generationJob.findUnique = async (input) => {
    if (input.select?.startedAt) {
      return {
        startedAt: new Date("2026-04-03T09:00:00+08:00"),
        completedCount: 1,
        totalCount: 2,
        retryCount: 0,
        payload: JSON.stringify({
          provider: "deepseek",
          model: "deepseek-chat",
          temperature: 0.8,
          runMode: "fast",
          autoReview: true,
          autoRepair: true,
          skipCompleted: true,
          qualityThreshold: 75,
          repairMode: "light_repair",
          failedDetails: ["1章（coherence=60, repetition=10, engagement=70）"],
        }),
      };
    }
    if (input.select?.status) {
      return {
        status: "running",
        cancelRequestedAt: null,
      };
    }
    throw new Error(`Unexpected generationJob.findUnique call: ${JSON.stringify(input)}`);
  };
  prisma.generationJob.update = async (input) => {
    updates.push(input);
    return input;
  };
  prisma.novel.findUnique = async () => ({
    id: "novel-1",
    title: "测试小说",
  });
  prisma.chapter.findMany = async () => ([
    { id: "chapter-1", order: 1, title: "第一章", content: "已生成内容" },
    { id: "chapter-2", order: 2, title: "第二章", content: "" },
  ]);
  reviewService.createQualityReport = async () => null;
  novelEventBus.emit = async () => null;

  const service = new NovelCorePipelineService();
  service.chapterRuntimeCoordinator.runPipelineChapter = async () => ({
    retryCountUsed: 0,
    score: {
      coherence: 88,
      repetition: 8,
      pacing: 82,
      voice: 80,
      engagement: 86,
      overall: 84,
    },
    issues: [],
    pass: true,
  });

  try {
    await service.executePipeline("job-1", "novel-1", {
      startOrder: 1,
      endOrder: 2,
      provider: "deepseek",
      model: "deepseek-chat",
      temperature: 0.8,
      runMode: "fast",
      autoReview: true,
      autoRepair: true,
      skipCompleted: true,
      qualityThreshold: 75,
      repairMode: "light_repair",
      maxRetries: 2,
    });

    const finalUpdate = updates[updates.length - 1];
    assert.equal(finalUpdate.data.status, "succeeded");
    assert.match(finalUpdate.data.error, /仍需进入单章质量修复：1章/);
    assert.match(finalUpdate.data.payload, /failedDetails/);
    assert.match(finalUpdate.data.payload, /1章/);
  } finally {
    prisma.generationJob.findUnique = original.generationFindUnique;
    prisma.generationJob.update = original.generationUpdate;
    prisma.novel.findUnique = original.novelFindUnique;
    prisma.chapter.findMany = original.chapterFindMany;
    reviewService.createQualityReport = original.createQualityReport;
    novelEventBus.emit = original.emit;
  }
});

test("executePipeline stops when a chapter remains below threshold", async () => {
  const original = {
    generationFindUnique: prisma.generationJob.findUnique,
    generationUpdate: prisma.generationJob.update,
    novelFindUnique: prisma.novel.findUnique,
    chapterFindMany: prisma.chapter.findMany,
    createQualityReport: reviewService.createQualityReport,
    emit: novelEventBus.emit,
  };

  const updates = [];
  const processedChapterIds = [];
  prisma.generationJob.findUnique = async (input) => {
    if (input.select?.startedAt) {
      return {
        startedAt: null,
        completedCount: 0,
        totalCount: 2,
        retryCount: 0,
        payload: JSON.stringify({
          provider: "deepseek",
          model: "deepseek-chat",
          temperature: 0.8,
          runMode: "fast",
          autoReview: true,
          autoRepair: true,
          skipCompleted: true,
          qualityThreshold: 75,
          repairMode: "light_repair",
        }),
      };
    }
    if (input.select?.status) {
      return {
        status: "running",
        cancelRequestedAt: null,
      };
    }
    throw new Error(`Unexpected generationJob.findUnique call: ${JSON.stringify(input)}`);
  };
  prisma.generationJob.update = async (input) => {
    updates.push(input);
    return input;
  };
  prisma.novel.findUnique = async () => ({
    id: "novel-1",
    title: "测试小说",
  });
  prisma.chapter.findMany = async () => ([
    { id: "chapter-1", order: 1, title: "第一章", content: "", generationState: "planned" },
    { id: "chapter-2", order: 2, title: "第二章", content: "", generationState: "planned" },
  ]);
  reviewService.createQualityReport = async () => null;
  novelEventBus.emit = async () => null;

  const service = new NovelCorePipelineService();
  service.chapterRuntimeCoordinator.runPipelineChapter = async (_novelId, chapterId) => {
    processedChapterIds.push(chapterId);
    if (chapterId === "chapter-1") {
      return {
        retryCountUsed: 2,
        score: {
          coherence: 60,
          repetition: 45,
          pacing: 70,
          voice: 78,
          engagement: 68,
          overall: 70,
        },
        issues: [],
        pass: false,
      };
    }
    return {
      retryCountUsed: 0,
      score: {
        coherence: 88,
        repetition: 8,
        pacing: 82,
        voice: 80,
        engagement: 86,
        overall: 84,
      },
      issues: [],
      pass: true,
    };
  };

  try {
    await service.executePipeline("job-1", "novel-1", {
      startOrder: 1,
      endOrder: 2,
      provider: "deepseek",
      model: "deepseek-chat",
      temperature: 0.8,
      runMode: "fast",
      autoReview: true,
      autoRepair: true,
      skipCompleted: true,
      qualityThreshold: 75,
      repairMode: "light_repair",
      maxRetries: 2,
    });

    const finalUpdate = updates[updates.length - 1];
    assert.deepEqual(processedChapterIds, ["chapter-1"]);
    assert.equal(finalUpdate.data.status, "failed");
    assert.match(finalUpdate.data.error, /第1章修复后仍未达标/);
    assert.match(finalUpdate.data.payload, /failedDetails/);
    assert.equal(
      updates.some((item) => item.data.completedCount === 2),
      false,
    );
  } finally {
    prisma.generationJob.findUnique = original.generationFindUnique;
    prisma.generationJob.update = original.generationUpdate;
    prisma.novel.findUnique = original.novelFindUnique;
    prisma.chapter.findMany = original.chapterFindMany;
    reviewService.createQualityReport = original.createQualityReport;
    novelEventBus.emit = original.emit;
  }
});

test("executePipeline auto-prepares missing bible and beats before batch generation", async () => {
  const original = {
    generationFindUnique: prisma.generationJob.findUnique,
    generationUpdate: prisma.generationJob.update,
    novelFindUnique: prisma.novel.findUnique,
    chapterFindMany: prisma.chapter.findMany,
    plotBeatCount: prisma.plotBeat.count,
    createQualityReport: reviewService.createQualityReport,
    emit: novelEventBus.emit,
  };

  const updates = [];
  const preparedAssets = [];
  const processedChapterIds = [];
  prisma.generationJob.findUnique = async (input) => {
    if (input.select?.startedAt) {
      return {
        startedAt: null,
        completedCount: 0,
        totalCount: 1,
        retryCount: 0,
        payload: JSON.stringify({
          provider: "deepseek",
          model: "deepseek-chat",
          temperature: 0.8,
          runMode: "fast",
          autoReview: true,
          autoRepair: true,
          autoPrepareStoryAssets: true,
          skipCompleted: true,
          qualityThreshold: 75,
          repairMode: "light_repair",
        }),
      };
    }
    if (input.select?.status) {
      return {
        status: "running",
        cancelRequestedAt: null,
      };
    }
    throw new Error(`Unexpected generationJob.findUnique call: ${JSON.stringify(input)}`);
  };
  prisma.generationJob.update = async (input) => {
    updates.push(input);
    return input;
  };
  prisma.novel.findUnique = async () => ({
    id: "novel-auto-assets",
    title: "测试小说",
    bible: null,
    _count: { characters: 1 },
  });
  prisma.chapter.findMany = async () => ([
    { id: "chapter-1", order: 1, title: "第一章", content: "", generationState: "planned" },
  ]);
  prisma.plotBeat.count = async () => 0;
  reviewService.createQualityReport = async () => null;
  novelEventBus.emit = async () => null;

  const service = new NovelCorePipelineService();
  service.generationService.createBibleStream = async () => ({
    stream: (async function* streamBible() {
      yield { content: "bible" };
    })(),
    onDone: async () => {
      preparedAssets.push("bible");
    },
  });
  service.generationService.createBeatStream = async (_novelId, options) => {
    preparedAssets.push(`beats:${options.startOrder}-${options.targetChapters}`);
    return {
      stream: (async function* streamBeats() {
        yield { content: "beats" };
      })(),
      onDone: async () => {},
    };
  };
  service.chapterRuntimeCoordinator.runPipelineChapter = async (_novelId, chapterId) => {
    processedChapterIds.push(chapterId);
    return {
      retryCountUsed: 0,
      score: {
        coherence: 88,
        repetition: 8,
        pacing: 82,
        voice: 80,
        engagement: 86,
        overall: 84,
      },
      issues: [],
      pass: true,
    };
  };

  try {
    await service.executePipeline("job-1", "novel-auto-assets", {
      startOrder: 1,
      endOrder: 1,
      provider: "deepseek",
      model: "deepseek-chat",
      temperature: 0.8,
      runMode: "fast",
      autoReview: true,
      autoRepair: true,
      autoPrepareStoryAssets: true,
      skipCompleted: true,
      qualityThreshold: 75,
      repairMode: "light_repair",
      maxRetries: 2,
    });

    assert.deepEqual(preparedAssets, ["bible", "beats:1-1"]);
    assert.deepEqual(processedChapterIds, ["chapter-1"]);
    assert.equal(
      updates.some((item) => item.data.currentItemLabel === "自动准备作品圣经"),
      true,
    );
    assert.equal(
      updates.some((item) => item.data.currentItemLabel === "自动准备第 1 章 - 第 1 章剧情拍点"),
      true,
    );
  } finally {
    prisma.generationJob.findUnique = original.generationFindUnique;
    prisma.generationJob.update = original.generationUpdate;
    prisma.novel.findUnique = original.novelFindUnique;
    prisma.chapter.findMany = original.chapterFindMany;
    prisma.plotBeat.count = original.plotBeatCount;
    reviewService.createQualityReport = original.createQualityReport;
    novelEventBus.emit = original.emit;
  }
});

test("startPipelineJob auto-syncs planned chapters from volume workspace before validating range", async () => {
  const original = {
    characterCount: prisma.character.count,
    chapterCount: prisma.chapter.count,
    chapterAggregate: prisma.chapter.aggregate,
    chapterFindMany: prisma.chapter.findMany,
    generationCreate: prisma.generationJob.create,
    getVolumes: NovelVolumeService.prototype.getVolumes,
    syncVolumeChapters: NovelVolumeService.prototype.syncVolumeChapters,
  };

  let aggregateCall = 0;
  let rangeCount = 0;
  let syncCalled = false;
  let createdPayload = null;

  prisma.character.count = async () => 1;
  prisma.chapter.count = async (input) => {
    if (input?.where?.order) {
      return rangeCount;
    }
    return 1;
  };
  prisma.chapter.aggregate = async () => {
    aggregateCall += 1;
    return aggregateCall === 1
      ? {
        _min: { order: 1 },
        _max: { order: 1 },
        _count: { order: 1 },
      }
      : {
        _min: { order: 1 },
        _max: { order: 400 },
        _count: { order: 400 },
      };
  };
  prisma.chapter.findMany = async () => {
    if (!syncCalled) {
      return [{ id: "chapter-1" }];
    }
    return Array.from({ length: 400 }, (_value, index) => ({
      id: `chapter-${index + 1}`,
    }));
  };
  prisma.generationJob.create = async (input) => {
    createdPayload = input;
    return {
      id: "job-1",
      novelId: "novel-1",
      totalCount: input.data.totalCount,
    };
  };

  NovelVolumeService.prototype.getVolumes = async () => ({
    novelId: "novel-1",
    workspaceVersion: "v2",
    volumes: [{
      id: "volume-1",
      novelId: "novel-1",
      sortOrder: 1,
      title: "第一卷",
      summary: null,
      openingHook: null,
      mainPromise: null,
      primaryPressureSource: null,
      coreSellingPoint: null,
      escalationMode: null,
      protagonistChange: null,
      midVolumeRisk: null,
      climax: null,
      payoffType: null,
      nextVolumeHook: null,
      resetPoint: null,
      openPayoffs: [],
      status: "active",
      sourceVersionId: null,
      chapters: Array.from({ length: 400 }, (_value, index) => ({
        id: `volume-chapter-${index + 1}`,
        volumeId: "volume-1",
        chapterOrder: index + 1,
        title: `第${index + 1}章`,
        summary: `第${index + 1}章摘要`,
        purpose: null,
        conflictLevel: null,
        revealLevel: null,
        targetWordCount: null,
        mustAvoid: null,
        taskSheet: null,
        payoffRefs: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }],
    strategyPlan: null,
    critiqueReport: null,
    beatSheets: [],
    rebalanceDecisions: [],
    readiness: {
      canGenerateStrategy: true,
      canGenerateSkeleton: true,
      canGenerateBeatSheet: true,
      canGenerateChapterList: true,
      blockingReasons: [],
    },
    derivedOutline: "",
    derivedStructuredOutline: "",
    source: "volume",
    activeVersionId: null,
  });
  NovelVolumeService.prototype.syncVolumeChapters = async () => {
    syncCalled = true;
    rangeCount = 400;
    return {
      createCount: 399,
      updateCount: 1,
      keepCount: 0,
      moveCount: 0,
      deleteCount: 0,
      deleteCandidateCount: 0,
      affectedGeneratedCount: 0,
      clearContentCount: 0,
      affectedVolumeCount: 1,
      items: [],
    };
  };

  const service = new NovelCorePipelineService();
  service.executePipeline = async () => undefined;

  try {
    const job = await service.startPipelineJob("novel-1", {
      startOrder: 1,
      endOrder: 400,
      provider: "deepseek",
      model: "deepseek-chat",
      temperature: 0.8,
      runMode: "fast",
      autoReview: true,
      autoRepair: true,
      skipCompleted: true,
      qualityThreshold: 75,
      repairMode: "light_repair",
      maxRetries: 2,
    });

    assert.equal(syncCalled, true);
    assert.equal(createdPayload.data.totalCount, 400);
    assert.equal(job.totalCount, 400);
  } finally {
    prisma.character.count = original.characterCount;
    prisma.chapter.count = original.chapterCount;
    prisma.chapter.aggregate = original.chapterAggregate;
    prisma.chapter.findMany = original.chapterFindMany;
    prisma.generationJob.create = original.generationCreate;
    NovelVolumeService.prototype.getVolumes = original.getVolumes;
    NovelVolumeService.prototype.syncVolumeChapters = original.syncVolumeChapters;
  }
});

test("startPipelineJob creates placeholder chapters when no structured chapter list is available", async () => {
  const original = {
    characterCount: prisma.character.count,
    chapterCount: prisma.chapter.count,
    chapterAggregate: prisma.chapter.aggregate,
    chapterFindMany: prisma.chapter.findMany,
    chapterCreateMany: prisma.chapter.createMany,
    novelFindUnique: prisma.novel.findUnique,
    generationCreate: prisma.generationJob.create,
    getVolumes: NovelVolumeService.prototype.getVolumes,
    syncVolumeChapters: NovelVolumeService.prototype.syncVolumeChapters,
  };

  let createdPlaceholders = [];
  let createdPayload = null;
  let placeholderCreated = false;

  prisma.character.count = async () => 1;
  prisma.chapter.count = async () => 0;
  prisma.chapter.aggregate = async () => (
    placeholderCreated
      ? {
        _min: { order: 1 },
        _max: { order: 400 },
        _count: { order: 400 },
      }
      : {
        _min: { order: 1 },
        _max: { order: 1 },
        _count: { order: 1 },
      }
  );
  prisma.chapter.findMany = async (input) => {
    if (input?.select?.order) {
      return [{ order: 1 }];
    }
    if (!placeholderCreated) {
      return [{ id: "chapter-1" }];
    }
    return Array.from({ length: 400 }, (_value, index) => ({
      id: `chapter-${index + 1}`,
    }));
  };
  prisma.chapter.createMany = async (input) => {
    placeholderCreated = true;
    createdPlaceholders = input.data;
    return { count: input.data.length };
  };
  prisma.novel.findUnique = async () => ({
    estimatedChapterCount: 400,
  });
  prisma.generationJob.create = async (input) => {
    createdPayload = input;
    return {
      id: "job-2",
      novelId: "novel-2",
      totalCount: input.data.totalCount,
    };
  };

  NovelVolumeService.prototype.getVolumes = async () => ({
    novelId: "novel-2",
    workspaceVersion: "v2",
    volumes: [{
      id: "volume-1",
      novelId: "novel-2",
      sortOrder: 1,
      title: "第一卷",
      summary: null,
      openingHook: null,
      mainPromise: null,
      primaryPressureSource: null,
      coreSellingPoint: null,
      escalationMode: null,
      protagonistChange: null,
      midVolumeRisk: null,
      climax: null,
      payoffType: null,
      nextVolumeHook: null,
      resetPoint: null,
      openPayoffs: [],
      status: "active",
      sourceVersionId: null,
      chapters: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }],
    strategyPlan: null,
    critiqueReport: null,
    beatSheets: [],
    rebalanceDecisions: [],
    readiness: {
      canGenerateStrategy: true,
      canGenerateSkeleton: true,
      canGenerateBeatSheet: true,
      canGenerateChapterList: true,
      blockingReasons: [],
    },
    derivedOutline: "",
    derivedStructuredOutline: "",
    source: "volume",
    activeVersionId: null,
  });
  NovelVolumeService.prototype.syncVolumeChapters = async () => {
    throw new Error("should not sync empty chapter lists");
  };

  const service = new NovelCorePipelineService();
  service.executePipeline = async () => undefined;

  try {
    const job = await service.startPipelineJob("novel-2", {
      startOrder: 1,
      endOrder: 400,
      provider: "deepseek",
      model: "deepseek-chat",
      temperature: 0.8,
      runMode: "fast",
      autoReview: true,
      autoRepair: true,
      skipCompleted: true,
      qualityThreshold: 75,
      repairMode: "light_repair",
      maxRetries: 2,
    });

    assert.equal(createdPlaceholders.length, 399);
    assert.equal(createdPlaceholders[0].order, 2);
    assert.equal(createdPlaceholders[createdPlaceholders.length - 1].order, 400);
    assert.equal(createdPayload.data.totalCount, 400);
    assert.equal(job.totalCount, 400);
  } finally {
    prisma.character.count = original.characterCount;
    prisma.chapter.count = original.chapterCount;
    prisma.chapter.aggregate = original.chapterAggregate;
    prisma.chapter.findMany = original.chapterFindMany;
    prisma.chapter.createMany = original.chapterCreateMany;
    prisma.novel.findUnique = original.novelFindUnique;
    prisma.generationJob.create = original.generationCreate;
    NovelVolumeService.prototype.getVolumes = original.getVolumes;
    NovelVolumeService.prototype.syncVolumeChapters = original.syncVolumeChapters;
  }
});

test("startPipelineJob skipCompleted skips pre-existing chapters that already have正文", async () => {
  const original = {
    characterCount: prisma.character.count,
    chapterCount: prisma.chapter.count,
    chapterAggregate: prisma.chapter.aggregate,
    chapterFindMany: prisma.chapter.findMany,
    generationFindFirst: prisma.generationJob.findFirst,
    generationCreate: prisma.generationJob.create,
    getVolumes: NovelVolumeService.prototype.getVolumes,
  };

  let createdPayload = null;

  prisma.character.count = async () => 1;
  prisma.chapter.count = async () => 3;
  prisma.chapter.aggregate = async () => ({
    _min: { order: 1 },
    _max: { order: 3 },
    _count: { order: 3 },
  });
  prisma.chapter.findMany = async () => ([
    {
      id: "chapter-1",
      generationState: "reviewed",
      content: "旧正文",
      updatedAt: new Date("2026-04-05T04:00:00.000Z"),
    },
    {
      id: "chapter-2",
      generationState: "planned",
      content: "",
      updatedAt: new Date("2026-04-05T04:00:00.000Z"),
    },
    {
      id: "chapter-3",
      generationState: "drafted",
      content: "旧正文",
      updatedAt: new Date("2026-04-05T04:00:00.000Z"),
    },
  ]);
  prisma.generationJob.findFirst = async () => null;
  prisma.generationJob.create = async (input) => {
    createdPayload = input;
    return {
      id: "job-existing-content-skip",
      novelId: "novel-existing-content-skip",
      totalCount: input.data.totalCount,
    };
  };
  NovelVolumeService.prototype.getVolumes = async () => ({
    novelId: "novel-existing-content-skip",
    workspaceVersion: "v1",
    volumes: [{
      id: "volume-1",
      novelId: "novel-existing-content-skip",
      sortOrder: 1,
      title: "第一卷",
      summary: null,
      openingHook: null,
      mainPromise: null,
      primaryPressureSource: null,
      coreSellingPoint: null,
      escalationMode: null,
      protagonistChange: null,
      midVolumeRisk: null,
      climax: null,
      payoffType: null,
      nextVolumeHook: null,
      resetPoint: null,
      openPayoffs: [],
      status: "active",
      sourceVersionId: null,
      chapters: [
        { chapterOrder: 1 },
        { chapterOrder: 2 },
        { chapterOrder: 3 },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }],
    strategyPlan: null,
    critiqueReport: null,
    beatSheets: [],
    rebalanceDecisions: [],
    readiness: {
      canGenerateStrategy: true,
      canGenerateSkeleton: true,
      canGenerateBeatSheet: true,
      canGenerateChapterList: true,
      blockingReasons: [],
    },
    derivedOutline: "",
    derivedStructuredOutline: "",
    source: "volume",
    activeVersionId: null,
  });

  const service = new NovelCorePipelineService();
  service.executePipeline = async () => undefined;

  try {
    const job = await service.startPipelineJob("novel-existing-content-skip", {
      startOrder: 1,
      endOrder: 3,
      provider: "deepseek",
      model: "deepseek-chat",
      temperature: 0.8,
      runMode: "fast",
      autoReview: true,
      autoRepair: true,
      skipCompleted: true,
      qualityThreshold: 75,
      repairMode: "light_repair",
      maxRetries: 2,
    });

    assert.equal(createdPayload.data.totalCount, 1);
    assert.equal(job.totalCount, 1);
    assert.match(createdPayload.data.payload, /queueBaselineAt/);
  } finally {
    prisma.character.count = original.characterCount;
    prisma.chapter.count = original.chapterCount;
    prisma.chapter.aggregate = original.chapterAggregate;
    prisma.chapter.findMany = original.chapterFindMany;
    prisma.generationJob.findFirst = original.generationFindFirst;
    prisma.generationJob.create = original.generationCreate;
    NovelVolumeService.prototype.getVolumes = original.getVolumes;
  }
});

test("executePipeline fresh force run processes reviewed chapters", async () => {
  const original = {
    generationFindUnique: prisma.generationJob.findUnique,
    generationUpdate: prisma.generationJob.update,
    novelFindUnique: prisma.novel.findUnique,
    chapterFindMany: prisma.chapter.findMany,
    createQualityReport: reviewService.createQualityReport,
    emit: novelEventBus.emit,
  };

  const processedChapterIds = [];
  prisma.generationJob.findUnique = async (input) => {
    if (input.select?.startedAt) {
      return {
        startedAt: null,
        completedCount: 0,
        totalCount: 2,
        retryCount: 0,
        payload: JSON.stringify({
          provider: "deepseek",
          model: "deepseek-chat",
          temperature: 0.8,
          runMode: "fast",
          autoReview: true,
          autoRepair: true,
          skipCompleted: false,
          queueBaselineAt: "2026-04-06T10:00:00.000Z",
          qualityThreshold: 75,
          repairMode: "light_repair",
        }),
      };
    }
    if (input.select?.status) {
      return {
        status: "running",
        cancelRequestedAt: null,
      };
    }
    throw new Error(`Unexpected generationJob.findUnique call: ${JSON.stringify(input)}`);
  };
  prisma.generationJob.update = async (input) => input;
  prisma.novel.findUnique = async () => ({
    id: "novel-force-run",
    title: "测试小说",
  });
  prisma.chapter.findMany = async () => ([
    {
      id: "chapter-reviewed-1",
      order: 1,
      title: "第1章",
      generationState: "reviewed",
      content: "已有正文一",
      updatedAt: new Date("2026-04-06T09:00:00.000Z"),
    },
    {
      id: "chapter-reviewed-2",
      order: 2,
      title: "第2章",
      generationState: "reviewed",
      content: "已有正文二",
      updatedAt: new Date("2026-04-06T09:05:00.000Z"),
    },
  ]);
  reviewService.createQualityReport = async () => null;
  novelEventBus.emit = async () => null;

  const service = new NovelCorePipelineService();
  service.chapterRuntimeCoordinator.runPipelineChapter = async (_novelId, chapterId) => {
    processedChapterIds.push(chapterId);
    return {
      retryCountUsed: 0,
      score: {
        coherence: 90,
        repetition: 5,
        pacing: 86,
        voice: 84,
        engagement: 88,
        overall: 86,
      },
      issues: [],
      pass: true,
    };
  };

  try {
    await service.executePipeline("job-force-run", "novel-force-run", {
      startOrder: 1,
      endOrder: 2,
      provider: "deepseek",
      model: "deepseek-chat",
      temperature: 0.8,
      runMode: "fast",
      autoReview: true,
      autoRepair: true,
      skipCompleted: false,
      qualityThreshold: 75,
      repairMode: "light_repair",
      maxRetries: 2,
    });

    assert.deepEqual(processedChapterIds, ["chapter-reviewed-1", "chapter-reviewed-2"]);
  } finally {
    prisma.generationJob.findUnique = original.generationFindUnique;
    prisma.generationJob.update = original.generationUpdate;
    prisma.novel.findUnique = original.novelFindUnique;
    prisma.chapter.findMany = original.chapterFindMany;
    reviewService.createQualityReport = original.createQualityReport;
    novelEventBus.emit = original.emit;
  }
});

test("executePipeline resume keeps chapters generated after queue baseline in the current queue", async () => {
  const original = {
    generationFindUnique: prisma.generationJob.findUnique,
    generationUpdate: prisma.generationJob.update,
    novelFindUnique: prisma.novel.findUnique,
    chapterFindMany: prisma.chapter.findMany,
    createQualityReport: reviewService.createQualityReport,
    emit: novelEventBus.emit,
  };

  const processedChapterIds = [];
  prisma.generationJob.findUnique = async (input) => {
    if (input.select?.startedAt) {
      return {
        startedAt: new Date("2026-04-05T05:20:00.000Z"),
        completedCount: 1,
        totalCount: 2,
        retryCount: 0,
        payload: JSON.stringify({
          provider: "deepseek",
          model: "deepseek-chat",
          temperature: 0.8,
          runMode: "fast",
          autoReview: true,
          autoRepair: true,
          skipCompleted: true,
          queueBaselineAt: "2026-04-05T05:13:28.000Z",
          qualityThreshold: 75,
          repairMode: "light_repair",
        }),
      };
    }
    if (input.select?.status) {
      return {
        status: "running",
        cancelRequestedAt: null,
      };
    }
    throw new Error(`Unexpected generationJob.findUnique call: ${JSON.stringify(input)}`);
  };
  prisma.generationJob.update = async (input) => input;
  prisma.novel.findUnique = async () => ({
    id: "novel-resume-baseline",
    title: "测试小说",
  });
  prisma.chapter.findMany = async () => ([
    {
      id: "chapter-121",
      order: 121,
      title: "第121章",
      generationState: "reviewed",
      content: "本轮刚生成的正文",
      updatedAt: new Date("2026-04-05T05:25:00.000Z"),
    },
    {
      id: "chapter-122",
      order: 122,
      title: "第122章",
      generationState: "planned",
      content: "",
      updatedAt: new Date("2026-04-05T05:00:00.000Z"),
    },
  ]);
  reviewService.createQualityReport = async () => null;
  novelEventBus.emit = async () => null;

  const service = new NovelCorePipelineService();
  service.chapterRuntimeCoordinator.runPipelineChapter = async (_novelId, chapterId) => {
    processedChapterIds.push(chapterId);
    return {
      retryCountUsed: 0,
      score: {
        coherence: 90,
        repetition: 5,
        pacing: 86,
        voice: 84,
        engagement: 88,
        overall: 86,
      },
      issues: [],
      pass: true,
    };
  };

  try {
    await service.executePipeline("job-resume-baseline", "novel-resume-baseline", {
      startOrder: 121,
      endOrder: 122,
      provider: "deepseek",
      model: "deepseek-chat",
      temperature: 0.8,
      runMode: "fast",
      autoReview: true,
      autoRepair: true,
      skipCompleted: true,
      qualityThreshold: 75,
      repairMode: "light_repair",
      maxRetries: 2,
    });

    assert.deepEqual(processedChapterIds, ["chapter-122"]);
  } finally {
    prisma.generationJob.findUnique = original.generationFindUnique;
    prisma.generationJob.update = original.generationUpdate;
    prisma.novel.findUnique = original.novelFindUnique;
    prisma.chapter.findMany = original.chapterFindMany;
    reviewService.createQualityReport = original.createQualityReport;
    novelEventBus.emit = original.emit;
  }
});

test("executePipeline resume trusts earliest unprocessed chapter over stale completed count", async () => {
  const original = {
    generationFindUnique: prisma.generationJob.findUnique,
    generationUpdate: prisma.generationJob.update,
    novelFindUnique: prisma.novel.findUnique,
    chapterFindMany: prisma.chapter.findMany,
    createQualityReport: reviewService.createQualityReport,
    emit: novelEventBus.emit,
  };

  const processedChapterIds = [];
  prisma.generationJob.findUnique = async (input) => {
    if (input.select?.startedAt) {
      return {
        startedAt: new Date("2026-04-06T11:00:00.000Z"),
        completedCount: 47,
        totalCount: 280,
        retryCount: 0,
        payload: JSON.stringify({
          provider: "deepseek",
          model: "deepseek-chat",
          temperature: 0.8,
          runMode: "fast",
          autoReview: true,
          autoRepair: true,
          skipCompleted: true,
          queueBaselineAt: "2026-04-06T10:00:00.000Z",
          qualityThreshold: 75,
          repairMode: "light_repair",
        }),
      };
    }
    if (input.select?.status) {
      return {
        status: "running",
        cancelRequestedAt: null,
      };
    }
    throw new Error(`Unexpected generationJob.findUnique call: ${JSON.stringify(input)}`);
  };
  prisma.generationJob.update = async (input) => input;
  prisma.novel.findUnique = async () => ({
    id: "novel-resume-gap",
    title: "测试小说",
  });
  prisma.chapter.findMany = async () => ([
    {
      id: "chapter-121",
      order: 121,
      title: "第121章",
      generationState: "reviewed",
      content: "已有正文",
      updatedAt: new Date("2026-04-06T10:05:00.000Z"),
    },
    {
      id: "chapter-122",
      order: 122,
      title: "第122章",
      generationState: "reviewed",
      content: "已有正文",
      updatedAt: new Date("2026-04-06T10:10:00.000Z"),
    },
    {
      id: "chapter-123",
      order: 123,
      title: "第123章",
      generationState: "planned",
      content: "",
      updatedAt: new Date("2026-04-06T09:00:00.000Z"),
    },
    {
      id: "chapter-124",
      order: 124,
      title: "第124章",
      generationState: "repaired",
      content: "误跳生成的正文",
      updatedAt: new Date("2026-04-06T10:15:00.000Z"),
    },
  ]);
  reviewService.createQualityReport = async () => null;
  novelEventBus.emit = async () => null;

  const service = new NovelCorePipelineService();
  service.chapterRuntimeCoordinator.runPipelineChapter = async (_novelId, chapterId) => {
    processedChapterIds.push(chapterId);
    return {
      retryCountUsed: 0,
      score: {
        coherence: 90,
        repetition: 5,
        pacing: 86,
        voice: 84,
        engagement: 88,
        overall: 86,
      },
      issues: [],
      pass: true,
    };
  };

  try {
    await service.executePipeline("job-resume-gap", "novel-resume-gap", {
      startOrder: 121,
      endOrder: 124,
      provider: "deepseek",
      model: "deepseek-chat",
      temperature: 0.8,
      runMode: "fast",
      autoReview: true,
      autoRepair: true,
      skipCompleted: true,
      qualityThreshold: 75,
      repairMode: "light_repair",
      maxRetries: 2,
    });

    assert.deepEqual(processedChapterIds[0], "chapter-123");
  } finally {
    prisma.generationJob.findUnique = original.generationFindUnique;
    prisma.generationJob.update = original.generationUpdate;
    prisma.novel.findUnique = original.novelFindUnique;
    prisma.chapter.findMany = original.chapterFindMany;
    reviewService.createQualityReport = original.createQualityReport;
    novelEventBus.emit = original.emit;
  }
});
