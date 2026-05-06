import type {
  ChapterMeta,
  VolumeBeatSheet,
  VolumeGenerationScope,
  VolumeGenerationScopeInput,
  VolumePlan,
  VolumePlanDocument,
  VolumeRebalanceDecision,
  VolumeStrategyPlan,
} from "@ai-novel/shared/types/novel";
import { prisma } from "../../../db/prisma";
import { runStructuredPrompt } from "../../../prompting/core/promptRunner";
import { volumeBeatSheetPrompt } from "../../../prompting/prompts/novel/volume/beatSheet.prompts";
import { createVolumeChapterListPrompt } from "../../../prompting/prompts/novel/volume/chapterList.prompts";
import {
  volumeChapterBoundaryPrompt,
  volumeChapterPurposePrompt,
  volumeChapterTaskSheetPrompt,
} from "../../../prompting/prompts/novel/volume/chapterDetail.prompts";
import { volumeRebalancePrompt } from "../../../prompting/prompts/novel/volume/rebalance.prompts";
import { createVolumeSkeletonPrompt } from "../../../prompting/prompts/novel/volume/skeleton.prompts";
import {
  createVolumeStrategyPrompt,
  volumeStrategyCritiquePrompt,
} from "../../../prompting/prompts/novel/volume/strategy.prompts";
import {
  buildVolumeBeatSheetContextBlocks,
  buildVolumeChapterDetailContextBlocks,
  buildVolumeChapterListContextBlocks,
  buildVolumeRebalanceContextBlocks,
  buildVolumeSkeletonContextBlocks,
  buildVolumeStrategyContextBlocks,
  buildVolumeStrategyCritiqueContextBlocks,
} from "../../../prompting/prompts/novel/volume/contextBlocks";
import type { StoryMacroPlanService } from "../storyMacro/StoryMacroPlanService";
import { buildStoryModePromptBlock, normalizeStoryModeOutput } from "../../storyMode/storyModeProfile";
import {
  buildVolumeWorkspaceDocument,
} from "./volumeWorkspaceDocument";
import { normalizeVolumeDraftContextInput } from "./volumeDraftContext";
import {
  parseBeatSheetChapterSpan,
} from "./volumeBeatSheetChapterBudget";
import {
  allocateChapterBudgets,
  deriveChapterBudget as deriveStructuralChapterBudget,
  normalizeBeatSheetSpansToChapterBudget,
  resolveTargetVolumeCount,
  resolveVolumeChapterBudget,
} from "./volumeStructureBudget";
import { deriveChapterDetailPolicy } from "./volumeChapterDetailPolicy";
import type {
  ChapterDetailMode,
  VolumeGenerateOptions,
  VolumeGenerationPhase,
  VolumeGenerationNovel,
  VolumeWorkspace,
} from "./volumeModels";

function normalizeScope(scope?: VolumeGenerationScopeInput): VolumeGenerationScope {
  if (scope === "book") {
    return "skeleton";
  }
  if (scope === "volume") {
    return "chapter_list";
  }
  return scope ?? "strategy";
}

function deriveChapterBudget(params: {
  novel: VolumeGenerationNovel;
  workspace: VolumeWorkspace;
  options: VolumeGenerateOptions;
}): number {
  const { novel, workspace, options } = params;
  return deriveStructuralChapterBudget({
    optionEstimatedChapterCount: options.estimatedChapterCount,
    novelEstimatedChapterCount: novel.estimatedChapterCount,
    existingChapterCount: workspace.volumes.flatMap((volume) => volume.chapters).length,
  });
}

async function notifyVolumeGenerationPhase(input: {
  novelId: string;
  scope: VolumeGenerationScope;
  phase: VolumeGenerationPhase;
  label: string;
  options: VolumeGenerateOptions;
}): Promise<void> {
  console.info(
    `[volume.generate] event=phase_start novelId=${input.novelId} scope=${input.scope} phase=${input.phase} label=${JSON.stringify(input.label)}`,
  );
  await input.options.onPhaseStart?.({
    scope: input.scope,
    phase: input.phase,
    label: input.label,
  });
}

function getTargetVolume(document: VolumePlanDocument, targetVolumeId?: string): VolumePlan {
  const volumeId = targetVolumeId?.trim();
  if (!volumeId) {
    throw new Error("缺少目标卷。");
  }
  const targetVolume = document.volumes.find((volume) => volume.id === volumeId);
  if (!targetVolume) {
    throw new Error("目标卷不存在。");
  }
  return targetVolume;
}

function getTargetChapter(targetVolume: VolumePlan, targetChapterId?: string): VolumePlan["chapters"][number] {
  const chapterId = targetChapterId?.trim();
  if (!chapterId) {
    throw new Error("缺少目标章节。");
  }
  const targetChapter = targetVolume.chapters.find((chapter) => chapter.id === chapterId);
  if (!targetChapter) {
    throw new Error("目标章节不存在。");
  }
  return targetChapter;
}

function getBeatSheet(document: VolumePlanDocument, volumeId: string): VolumeBeatSheet | null {
  return document.beatSheets.find((sheet) => sheet.volumeId === volumeId && sheet.beats.length > 0) ?? null;
}

function assertScopeReadiness(
  document: VolumePlanDocument,
  scope: VolumeGenerationScope,
  targetVolumeId?: string,
): void {
  if (scope === "strategy") {
    return;
  }
  if (scope === "strategy_critique" || scope === "skeleton") {
    if (!document.strategyPlan) {
      throw new Error("请先生成卷战略建议，再继续当前步骤。");
    }
    return;
  }
  if (scope === "beat_sheet") {
    if (!document.strategyPlan) {
      throw new Error("请先生成卷战略建议，再生成当前卷节奏板。");
    }
    getTargetVolume(document, targetVolumeId);
    return;
  }
  if (scope === "chapter_list") {
    const targetVolume = getTargetVolume(document, targetVolumeId);
    if (!getBeatSheet(document, targetVolume.id)) {
      throw new Error("当前卷还没有节奏板，默认不能直接拆章节列表。");
    }
    return;
  }
  if (scope === "rebalance") {
    const targetVolume = getTargetVolume(document, targetVolumeId);
    if (!document.strategyPlan) {
      throw new Error("请先生成卷战略建议，再生成相邻卷再平衡建议。");
    }
    if (!getBeatSheet(document, targetVolume.id)) {
      throw new Error("请先生成当前卷节奏板，再生成相邻卷再平衡建议。");
    }
    if (targetVolume.chapters.length === 0) {
      throw new Error("请先生成当前卷章节列表，再生成相邻卷再平衡建议。");
    }
    return;
  }
  const targetVolume = getTargetVolume(document, targetVolumeId);
  if (!getBeatSheet(document, targetVolume.id)) {
    throw new Error("请先生成当前卷节奏板，再细化章节。");
  }
}

function mergeStrategyPlan(document: VolumePlanDocument, strategyPlan: VolumeStrategyPlan): VolumePlanDocument {
  return buildVolumeWorkspaceDocument({
    novelId: document.novelId,
    volumes: document.volumes,
    strategyPlan,
    critiqueReport: null,
    beatSheets: [],
    rebalanceDecisions: [],
    source: "volume",
    activeVersionId: document.activeVersionId,
  });
}

function mergeCritiqueReport(document: VolumePlanDocument, critiqueReport: VolumePlanDocument["critiqueReport"]): VolumePlanDocument {
  return buildVolumeWorkspaceDocument({
    novelId: document.novelId,
    volumes: document.volumes,
    strategyPlan: document.strategyPlan,
    critiqueReport,
    beatSheets: document.beatSheets,
    rebalanceDecisions: document.rebalanceDecisions,
    source: "volume",
    activeVersionId: document.activeVersionId,
  });
}

function mergeSkeleton(document: VolumePlanDocument, generatedVolumes: Array<{
  title: string;
  summary?: string | null;
  openingHook: string;
  mainPromise: string;
  primaryPressureSource: string;
  coreSellingPoint: string;
  escalationMode: string;
  protagonistChange: string;
  midVolumeRisk: string;
  climax: string;
  payoffType: string;
  nextVolumeHook: string;
  resetPoint?: string | null;
  openPayoffs: string[];
}>): VolumePlanDocument {
  const mergedVolumes = generatedVolumes.map((volume, index) => {
    const existing = document.volumes[index];
    return {
      id: existing?.id,
      novelId: document.novelId,
      sortOrder: index + 1,
      title: volume.title,
      summary: volume.summary ?? null,
      openingHook: volume.openingHook,
      mainPromise: volume.mainPromise,
      primaryPressureSource: volume.primaryPressureSource,
      coreSellingPoint: volume.coreSellingPoint,
      escalationMode: volume.escalationMode,
      protagonistChange: volume.protagonistChange,
      midVolumeRisk: volume.midVolumeRisk,
      climax: volume.climax,
      payoffType: volume.payoffType,
      nextVolumeHook: volume.nextVolumeHook,
      resetPoint: volume.resetPoint ?? null,
      openPayoffs: volume.openPayoffs,
      status: existing?.status ?? "active",
      sourceVersionId: existing?.sourceVersionId ?? null,
      chapters: existing?.chapters ?? [],
      createdAt: existing?.createdAt ?? new Date(0).toISOString(),
      updatedAt: existing?.updatedAt ?? new Date(0).toISOString(),
    };
  });

  return buildVolumeWorkspaceDocument({
    novelId: document.novelId,
    volumes: mergedVolumes,
    strategyPlan: document.strategyPlan,
    critiqueReport: document.critiqueReport,
    beatSheets: [],
    rebalanceDecisions: [],
    source: "volume",
    activeVersionId: document.activeVersionId,
  });
}

function mergeBeatSheet(
  document: VolumePlanDocument,
  targetVolume: VolumePlan,
  beats: VolumeBeatSheet["beats"],
  chapterBudgetContract: {
    targetChapterStartOrder: number;
    targetChapterCount: number;
  },
): VolumePlanDocument {
  const normalizedBeats = normalizeBeatSheetSpansToChapterBudget(
    beats,
    chapterBudgetContract.targetChapterStartOrder,
    chapterBudgetContract.targetChapterCount,
  );
  const nextBeatSheets = [
    ...document.beatSheets.filter((sheet) => sheet.volumeId !== targetVolume.id),
    {
      volumeId: targetVolume.id,
      volumeSortOrder: targetVolume.sortOrder,
      status: "generated" as const,
      beats: normalizedBeats,
    },
  ].sort((left, right) => left.volumeSortOrder - right.volumeSortOrder);

  return buildVolumeWorkspaceDocument({
    novelId: document.novelId,
    volumes: document.volumes,
    strategyPlan: document.strategyPlan,
    critiqueReport: document.critiqueReport,
    beatSheets: nextBeatSheets,
    rebalanceDecisions: document.rebalanceDecisions,
    source: "volume",
    activeVersionId: document.activeVersionId,
  });
}

function mergeChapterList(
  document: VolumePlanDocument,
  targetVolumeId: string,
  generatedChapters: Array<{ title: string; summary: string; chapterMeta?: ChapterMeta | null }>,
  startChapterOrder: number,
  defaultChapterLength?: number | null,
): VolumePlanDocument {
  const mergedVolumes = document.volumes.map((volume) => {
    if (volume.id !== targetVolumeId) {
      return volume;
    }
    return {
      ...volume,
      chapters: generatedChapters.map((chapter, chapterIndex) => {
        const existingChapter = volume.chapters[chapterIndex];
        const policy = deriveChapterDetailPolicy({
          defaultChapterLength,
          chapterMeta: chapter.chapterMeta ?? existingChapter?.chapterMeta ?? null,
          title: chapter.title,
          summary: chapter.summary,
        });
        return {
          id: existingChapter?.id,
          volumeId: volume.id,
          chapterOrder: startChapterOrder + chapterIndex,
          title: chapter.title,
          summary: chapter.summary,
          purpose: existingChapter?.purpose ?? null,
          conflictLevel: existingChapter?.conflictLevel ?? policy.conflictLevel,
          revealLevel: existingChapter?.revealLevel ?? policy.revealLevel,
          targetWordCount: existingChapter?.targetWordCount ?? policy.targetWordCount,
          mustAvoid: existingChapter?.mustAvoid ?? policy.mustAvoid,
          taskSheet: existingChapter?.taskSheet ?? policy.taskSheet,
          payoffRefs: existingChapter?.payoffRefs ?? [],
          chapterMeta: chapter.chapterMeta ?? existingChapter?.chapterMeta ?? null,
          createdAt: existingChapter?.createdAt ?? new Date(0).toISOString(),
          updatedAt: existingChapter?.updatedAt ?? new Date(0).toISOString(),
        };
      }),
    };
  });

  return buildVolumeWorkspaceDocument({
    novelId: document.novelId,
    volumes: mergedVolumes,
    strategyPlan: document.strategyPlan,
    critiqueReport: document.critiqueReport,
    beatSheets: document.beatSheets,
    rebalanceDecisions: document.rebalanceDecisions,
    source: "volume",
    activeVersionId: document.activeVersionId,
  });
}

function mergeChapterDetail(params: {
  document: VolumePlanDocument;
  targetVolumeId: string;
  targetChapterId: string;
  detailMode: ChapterDetailMode;
  generatedDetail: Record<string, unknown>;
}): VolumePlanDocument {
  const { document, targetVolumeId, targetChapterId, detailMode, generatedDetail } = params;
  const mergedVolumes = document.volumes.map((volume) => {
    if (volume.id !== targetVolumeId) {
      return volume;
    }
    return {
      ...volume,
      chapters: volume.chapters.map((chapter) => {
        if (chapter.id !== targetChapterId) {
          return chapter;
        }
        if (detailMode === "purpose") {
          return {
            ...chapter,
            purpose: typeof generatedDetail.purpose === "string" ? generatedDetail.purpose : chapter.purpose,
          };
        }
        if (detailMode === "boundary") {
          return {
            ...chapter,
            conflictLevel: typeof generatedDetail.conflictLevel === "number" ? generatedDetail.conflictLevel : chapter.conflictLevel,
            revealLevel: typeof generatedDetail.revealLevel === "number" ? generatedDetail.revealLevel : chapter.revealLevel,
            targetWordCount: typeof generatedDetail.targetWordCount === "number" ? generatedDetail.targetWordCount : chapter.targetWordCount,
            mustAvoid: typeof generatedDetail.mustAvoid === "string" ? generatedDetail.mustAvoid : chapter.mustAvoid,
            payoffRefs: Array.isArray(generatedDetail.payoffRefs)
              ? generatedDetail.payoffRefs.filter((item): item is string => typeof item === "string")
              : chapter.payoffRefs,
          };
        }
        return {
          ...chapter,
          taskSheet: typeof generatedDetail.taskSheet === "string" ? generatedDetail.taskSheet : chapter.taskSheet,
        };
      }),
    };
  });

  return buildVolumeWorkspaceDocument({
    novelId: document.novelId,
    volumes: mergedVolumes,
    strategyPlan: document.strategyPlan,
    critiqueReport: document.critiqueReport,
    beatSheets: document.beatSheets,
    rebalanceDecisions: document.rebalanceDecisions,
    source: "volume",
    activeVersionId: document.activeVersionId,
  });
}

function mergeRebalance(
  document: VolumePlanDocument,
  anchorVolumeId: string,
  decisions: VolumeRebalanceDecision[],
): VolumePlanDocument {
  const nextDecisions = [
    ...document.rebalanceDecisions.filter((decision) => decision.anchorVolumeId !== anchorVolumeId),
    ...decisions,
  ];
  return buildVolumeWorkspaceDocument({
    novelId: document.novelId,
    volumes: document.volumes,
    strategyPlan: document.strategyPlan,
    critiqueReport: document.critiqueReport,
    beatSheets: document.beatSheets,
    rebalanceDecisions: nextDecisions,
    source: "volume",
    activeVersionId: document.activeVersionId,
  });
}

async function loadGenerationContext(params: {
  novelId: string;
  workspace: VolumeWorkspace;
  storyMacroPlanService: Pick<StoryMacroPlanService, "getPlan">;
}): Promise<{
  novel: VolumeGenerationNovel;
  storyMacroPlan: Awaited<ReturnType<StoryMacroPlanService["getPlan"]>> | null;
}> {
  const { novelId, storyMacroPlanService } = params;
  const [rawNovel, storyMacroPlan] = await Promise.all([
    prisma.novel.findUnique({
      where: { id: novelId },
      select: {
        title: true,
        contentForm: true,
        description: true,
        targetAudience: true,
        bookSellingPoint: true,
        competingFeel: true,
        first30ChapterPromise: true,
        commercialTagsJson: true,
        defaultChapterLength: true,
        estimatedChapterCount: true,
        targetTotalWordCount: true,
        narrativePov: true,
        pacePreference: true,
        emotionIntensity: true,
        primaryStoryMode: {
          select: {
            id: true,
            name: true,
            description: true,
            template: true,
            parentId: true,
            profileJson: true,
            createdAt: true,
            updatedAt: true,
          },
        },
        secondaryStoryMode: {
          select: {
            id: true,
            name: true,
            description: true,
            template: true,
            parentId: true,
            profileJson: true,
            createdAt: true,
            updatedAt: true,
          },
        },
        genre: {
          select: { name: true },
        },
        characters: {
          orderBy: { createdAt: "asc" },
          select: {
            name: true,
            role: true,
            currentGoal: true,
            currentState: true,
          },
        },
      },
    }),
    storyMacroPlanService.getPlan(novelId).catch(() => null),
  ]);

  if (!rawNovel) {
    throw new Error("小说不存在。");
  }

  const novel: VolumeGenerationNovel = {
    ...rawNovel,
    storyModePromptBlock: buildStoryModePromptBlock({
      primary: rawNovel.primaryStoryMode ? normalizeStoryModeOutput(rawNovel.primaryStoryMode) : null,
      secondary: rawNovel.secondaryStoryMode ? normalizeStoryModeOutput(rawNovel.secondaryStoryMode) : null,
    }),
  };

  return {
    novel,
    storyMacroPlan,
  };
}

function resolveBookTargetVolumeCount(params: {
  novel?: VolumeGenerationNovel;
  workspace: VolumeWorkspace;
  chapterBudget: number;
  options: VolumeGenerateOptions;
}): number {
  if (params.novel?.contentForm === "short_story") {
    return 1;
  }
  return resolveTargetVolumeCount({
    chapterBudget: params.chapterBudget,
    existingVolumeCount: params.workspace.volumes.length,
    respectExistingVolumeCount: params.options.respectExistingVolumeCount,
    targetVolumeCount: params.options.targetVolumeCount,
    guidance: params.options.guidance,
  });
}

function normalizeStrategyPlanToVolumeCount(
  strategyPlan: VolumeStrategyPlan,
  targetVolumeCount: number,
): VolumeStrategyPlan {
  const hardPlannedVolumeCount = Math.max(
    1,
    Math.min(targetVolumeCount, Math.round(strategyPlan.hardPlannedVolumeCount || Math.min(3, targetVolumeCount))),
  );
  const lastVolume = strategyPlan.volumes[strategyPlan.volumes.length - 1];
  const volumes = Array.from({ length: targetVolumeCount }, (_, index) => {
    const existing = strategyPlan.volumes[index] ?? lastVolume;
    return {
      sortOrder: index + 1,
      planningMode: index < hardPlannedVolumeCount ? "hard" as const : "soft" as const,
      roleLabel: existing?.roleLabel?.trim() || `第${index + 1}卷阶段定位`,
      coreReward: existing?.coreReward?.trim() || "承接书级卖点，完成本阶段读者回报。",
      escalationFocus: existing?.escalationFocus?.trim() || "延续主线压力并形成阶段升级。",
      uncertaintyLevel: existing?.uncertaintyLevel ?? (index < hardPlannedVolumeCount ? "low" as const : "medium" as const),
    };
  });

  return {
    ...strategyPlan,
    recommendedVolumeCount: targetVolumeCount,
    hardPlannedVolumeCount,
    volumes,
    uncertainties: strategyPlan.uncertainties.slice(0, targetVolumeCount),
  };
}

function resolveDocumentVolumeBudget(params: {
  document: VolumePlanDocument;
  novel: VolumeGenerationNovel;
  workspace: VolumeWorkspace;
  options: VolumeGenerateOptions;
  targetVolume: VolumePlan;
}) {
  const chapterBudget = deriveChapterBudget({
    novel: params.novel,
    workspace: {
      ...params.workspace,
      volumes: params.document.volumes,
    },
    options: params.options,
  });
  return resolveVolumeChapterBudget({
    volumes: params.document.volumes,
    targetVolume: params.targetVolume,
    chapterBudget,
  });
}

async function generateStrategy(params: {
  document: VolumePlanDocument;
  novel: VolumeGenerationNovel;
  workspace: VolumeWorkspace;
  storyMacroPlan: Awaited<ReturnType<StoryMacroPlanService["getPlan"]>> | null;
  options: VolumeGenerateOptions;
}): Promise<VolumePlanDocument> {
  const { document, novel, workspace, storyMacroPlan, options } = params;
  const chapterBudget = deriveChapterBudget({ novel, workspace, options });
  const suggestedVolumeCount = resolveBookTargetVolumeCount({
    novel,
    workspace,
    chapterBudget,
    options,
  });
  await notifyVolumeGenerationPhase({
    novelId: document.novelId,
    scope: "strategy",
    phase: "prompt",
    label: "正在生成卷战略",
    options,
  });
  const generated = await runStructuredPrompt({
    asset: createVolumeStrategyPrompt(12),
    promptInput: {
      novel,
      workspace,
      storyMacroPlan,
      guidance: options.guidance,
      suggestedVolumeCount,
    },
    contextBlocks: buildVolumeStrategyContextBlocks({
      novel,
      workspace,
      storyMacroPlan,
      guidance: options.guidance,
      suggestedVolumeCount,
    }),
    options: {
      provider: options.provider,
      model: options.model,
      temperature: options.temperature ?? 0.3,
    },
  });
  return mergeStrategyPlan(document, normalizeStrategyPlanToVolumeCount(generated.output, suggestedVolumeCount));
}

async function generateStrategyCritique(params: {
  document: VolumePlanDocument;
  novel: VolumeGenerationNovel;
  workspace: VolumeWorkspace;
  storyMacroPlan: Awaited<ReturnType<StoryMacroPlanService["getPlan"]>> | null;
  options: VolumeGenerateOptions;
}): Promise<VolumePlanDocument> {
  const { document, novel, workspace, storyMacroPlan, options } = params;
  if (!document.strategyPlan) {
    throw new Error("请先生成卷战略建议。");
  }
  await notifyVolumeGenerationPhase({
    novelId: document.novelId,
    scope: "strategy_critique",
    phase: "prompt",
    label: "正在评估卷战略",
    options,
  });
  const generated = await runStructuredPrompt({
    asset: volumeStrategyCritiquePrompt,
    promptInput: {
      novel,
      workspace,
      storyMacroPlan,
      strategyPlan: document.strategyPlan,
      guidance: options.guidance,
    },
    contextBlocks: buildVolumeStrategyCritiqueContextBlocks({
      novel,
      workspace,
      storyMacroPlan,
      strategyPlan: document.strategyPlan,
      guidance: options.guidance,
    }),
    options: {
      provider: options.provider,
      model: options.model,
      temperature: options.temperature ?? 0.2,
    },
  });
  return mergeCritiqueReport(document, generated.output);
}

async function generateSkeleton(params: {
  document: VolumePlanDocument;
  novel: VolumeGenerationNovel;
  workspace: VolumeWorkspace;
  storyMacroPlan: Awaited<ReturnType<StoryMacroPlanService["getPlan"]>> | null;
  options: VolumeGenerateOptions;
}): Promise<VolumePlanDocument> {
  let { document } = params;
  const { novel, workspace, storyMacroPlan, options } = params;
  if (!document.strategyPlan) {
    throw new Error("请先生成卷战略建议。");
  }
  const chapterBudget = deriveChapterBudget({ novel, workspace, options });
  const targetVolumeCount = resolveBookTargetVolumeCount({
    novel,
    workspace: {
      ...workspace,
      volumes: document.volumes,
    },
    chapterBudget,
    options,
  });
  const strategyPlan = normalizeStrategyPlanToVolumeCount(document.strategyPlan, targetVolumeCount);
  document = mergeStrategyPlan(document, strategyPlan);
  const chapterBudgets = allocateChapterBudgets({
    volumeCount: targetVolumeCount,
    chapterBudget,
    existingVolumes: document.volumes,
  });
  await notifyVolumeGenerationPhase({
    novelId: document.novelId,
    scope: "skeleton",
    phase: "prompt",
    label: "正在生成卷骨架",
    options,
  });
  const generated = await runStructuredPrompt({
    asset: createVolumeSkeletonPrompt(targetVolumeCount),
    promptInput: {
      novel,
      workspace: {
        ...workspace,
        ...document,
      },
      storyMacroPlan,
      strategyPlan,
      guidance: options.guidance,
      chapterBudget,
      targetVolumeCount,
      chapterBudgets,
    },
    contextBlocks: buildVolumeSkeletonContextBlocks({
      novel,
      workspace: {
        ...workspace,
        ...document,
      },
      storyMacroPlan,
      strategyPlan,
      guidance: options.guidance,
      chapterBudget,
      targetVolumeCount,
      chapterBudgets,
    }),
    options: {
      provider: options.provider,
      model: options.model,
      temperature: options.temperature ?? 0.35,
    },
  });
  return mergeSkeleton(document, generated.output.volumes);
}

async function generateBeatSheet(params: {
  document: VolumePlanDocument;
  novel: VolumeGenerationNovel;
  workspace: VolumeWorkspace;
  storyMacroPlan: Awaited<ReturnType<StoryMacroPlanService["getPlan"]>> | null;
  options: VolumeGenerateOptions;
}): Promise<VolumePlanDocument> {
  const { document, novel, workspace, storyMacroPlan, options } = params;
  const targetVolume = getTargetVolume(document, options.targetVolumeId);
  const volumeBudget = resolveDocumentVolumeBudget({
    document,
    novel,
    workspace,
    options,
    targetVolume,
  });
  await notifyVolumeGenerationPhase({
    novelId: document.novelId,
    scope: "beat_sheet",
    phase: "prompt",
    label: `正在生成第 ${targetVolume.sortOrder} 卷节奏板`,
    options,
  });
  const generated = await runStructuredPrompt({
    asset: volumeBeatSheetPrompt,
    promptInput: {
      novel,
      workspace,
      storyMacroPlan,
      strategyPlan: document.strategyPlan,
      targetVolume,
      targetChapterCount: volumeBudget.targetChapterCount,
      targetChapterStartOrder: volumeBudget.targetChapterStartOrder,
      guidance: options.guidance,
    },
    contextBlocks: buildVolumeBeatSheetContextBlocks({
      novel,
      workspace,
      storyMacroPlan,
      strategyPlan: document.strategyPlan,
      targetVolume,
      targetChapterCount: volumeBudget.targetChapterCount,
      targetChapterStartOrder: volumeBudget.targetChapterStartOrder,
      guidance: options.guidance,
    }),
    options: {
      provider: options.provider,
      model: options.model,
      temperature: options.temperature ?? 0.35,
    },
  });
  return mergeBeatSheet(document, targetVolume, generated.output.beats, volumeBudget);
}

async function generateRebalance(params: {
  document: VolumePlanDocument;
  novel: VolumeGenerationNovel;
  workspace: VolumeWorkspace;
  storyMacroPlan: Awaited<ReturnType<StoryMacroPlanService["getPlan"]>> | null;
  options: VolumeGenerateOptions;
}): Promise<VolumePlanDocument> {
  const { document, novel, workspace, storyMacroPlan, options } = params;
  const anchorVolume = getTargetVolume(document, options.targetVolumeId);
  const anchorIndex = document.volumes.findIndex((volume) => volume.id === anchorVolume.id);
  const previousVolume = anchorIndex > 0 ? document.volumes[anchorIndex - 1] : undefined;
  const nextVolume = anchorIndex >= 0 && anchorIndex < document.volumes.length - 1 ? document.volumes[anchorIndex + 1] : undefined;
  await notifyVolumeGenerationPhase({
    novelId: document.novelId,
    scope: "rebalance",
    phase: "prompt",
    label: `正在校准第 ${anchorVolume.sortOrder} 卷与相邻卷衔接`,
    options,
  });
  const generated = await runStructuredPrompt({
    asset: volumeRebalancePrompt,
    promptInput: {
      novel,
      workspace,
      storyMacroPlan,
      strategyPlan: document.strategyPlan,
      anchorVolume,
      previousVolume,
      nextVolume,
      guidance: options.guidance,
    },
    contextBlocks: buildVolumeRebalanceContextBlocks({
      novel,
      workspace,
      storyMacroPlan,
      strategyPlan: document.strategyPlan,
      anchorVolume,
      previousVolume,
      nextVolume,
      guidance: options.guidance,
    }),
    options: {
      provider: options.provider,
      model: options.model,
      temperature: options.temperature ?? 0.25,
    },
  });
  return mergeRebalance(document, anchorVolume.id, generated.output.decisions);
}

function findBeatForChapterOrder(
  beats: VolumeBeatSheet["beats"],
  chapterOrder: number,
): VolumeBeatSheet["beats"][number] | null {
  return beats.find((beat) => {
    const span = parseBeatSheetChapterSpan(beat.chapterSpanHint);
    return span ? chapterOrder >= span.start && chapterOrder <= span.end : false;
  }) ?? null;
}

function getBeatSheetStartOrder(beatSheet: VolumeBeatSheet): number {
  const starts = beatSheet.beats
    .map((beat) => parseBeatSheetChapterSpan(beat.chapterSpanHint)?.start)
    .filter((value): value is number => typeof value === "number");
  return starts.length > 0 ? Math.min(...starts) : 1;
}

const WORKFLOW_CHAPTER_TITLE_LABELS = [
  "开卷抓手",
  "第一信号",
  "中段转向",
  "压力锁定",
  "高压挤压",
  "卷高潮",
  "卷尾钩子",
  "当前节奏",
];
const workflowChapterTitleLabelSource = WORKFLOW_CHAPTER_TITLE_LABELS.join("|");
const workflowChapterTitleLabelPrefixPattern = new RegExp(
  `^(?:承接)?[「“"']?(${workflowChapterTitleLabelSource})(?:[：:]\\s*|[」”"']?\\s+)(.+)$`,
  "u",
);
const workflowChapterTitleLabelOnlyPattern = new RegExp(`^(${workflowChapterTitleLabelSource})(?:[：:\\s]|$)`, "u");
const workflowChapterTextLabelPattern = new RegExp(`「(${workflowChapterTitleLabelSource})[：:]([^」]+)」节奏段`, "gu");

function normalizeChapterListText(value: string | null | undefined): string {
  return (value ?? "").replace(/\r\n?/g, "\n").replace(/\s+/g, " ").trim();
}

function stripWorkflowChapterTitleLabel(value: string | null | undefined): string {
  const normalized = normalizeChapterListText(value);
  const match = normalized.match(workflowChapterTitleLabelPrefixPattern);
  if (!match) {
    return normalized;
  }
  return normalizeChapterListText(match[2].replace(/[」”"'].*$/u, ""));
}

function normalizeGeneratedChapterTitle(title: string): string {
  const normalized = stripWorkflowChapterTitleLabel(title);
  return workflowChapterTitleLabelOnlyPattern.test(normalized) || /^当前节奏/u.test(normalized) ? "" : normalized;
}

function normalizeGeneratedChapterSummary(summary: string): string {
  return normalizeChapterListText(summary)
    .replace(workflowChapterTextLabelPattern, "「$2」推进")
    .replace(new RegExp(`(?:${workflowChapterTitleLabelSource})[：:]`, "gu"), "");
}

function deriveFallbackChapterTitleBase(beat: VolumeBeatSheet["beats"][number] | null, chapterOrder: number): string {
  const fromLabel = normalizeGeneratedChapterTitle(beat?.label ?? "");
  if (fromLabel && !workflowChapterTitleLabelOnlyPattern.test(fromLabel)) {
    return fromLabel.slice(0, 14);
  }

  const fromSummary = normalizeGeneratedChapterSummary(beat?.summary ?? "")
    .split(/[，。！？；：、]/u)
    .map((segment) => normalizeGeneratedChapterTitle(segment))
    .find((segment) => segment.length >= 4 && segment.length <= 14);
  return fromSummary || `第${chapterOrder}章关键推进`;
}

function normalizeGeneratedChapterList(params: {
  chapters: Array<{ title: string; summary: string; chapterMeta?: ChapterMeta | null }>;
  targetChapterCount: number;
  targetBeatSheet: VolumeBeatSheet;
}): Array<{ title: string; summary: string; chapterMeta: ChapterMeta | null }> {
  const { chapters, targetChapterCount, targetBeatSheet } = params;
  const startOrder = getBeatSheetStartOrder(targetBeatSheet);
  const normalized = chapters
    .map((chapter, index) => {
      const chapterOrder = startOrder + index;
      const beat = findBeatForChapterOrder(targetBeatSheet.beats, chapterOrder);
      return {
        title: normalizeGeneratedChapterTitle(chapter.title),
        summary: normalizeGeneratedChapterSummary(chapter.summary),
        chapterMeta: chapter.chapterMeta ?? (beat
          ? {
              eventWeight: Math.max(1, Math.min(5, beat.eventWeight ?? 3)),
              highStakesDialogue: beat.highStakesDialogue ?? false,
              schemeBeat: beat.schemeBeat ?? false,
              kindOfHook: beat.kindOfHook ?? "suspense_question",
            }
          : null),
      };
    })
    .filter((chapter) => chapter.title && chapter.summary)
    .slice(0, targetChapterCount);
  const fallbackFrames = ["起势", "加压", "转向", "反制", "兑现", "余波"];

  while (normalized.length < targetChapterCount) {
    const chapterOrder = startOrder + normalized.length;
    const beat = findBeatForChapterOrder(targetBeatSheet.beats, chapterOrder);
    const fallbackTitleBase = deriveFallbackChapterTitleBase(beat, chapterOrder);
    const frame = fallbackFrames[normalized.length % fallbackFrames.length];
    normalized.push({
      title: `${fallbackTitleBase}${frame}`,
      summary: beat
        ? `补齐第 ${chapterOrder} 章的阶段推进，围绕「${fallbackTitleBase}」继续落实：${normalizeGeneratedChapterSummary(beat.summary)}`
        : `补齐第 ${chapterOrder} 章的阶段推进，承接本卷主线并保持后续章节连续。`,
      chapterMeta: beat
        ? {
            eventWeight: Math.max(1, Math.min(5, beat.eventWeight ?? 3)),
            highStakesDialogue: beat.highStakesDialogue ?? false,
            schemeBeat: beat.schemeBeat ?? false,
            kindOfHook: beat.kindOfHook ?? "suspense_question",
          }
        : null,
    });
  }

  return normalized;
}

async function generateChapterList(params: {
  document: VolumePlanDocument;
  novel: VolumeGenerationNovel;
  workspace: VolumeWorkspace;
  storyMacroPlan: Awaited<ReturnType<StoryMacroPlanService["getPlan"]>> | null;
  options: VolumeGenerateOptions;
}): Promise<VolumePlanDocument> {
  const { document, novel, workspace, storyMacroPlan, options } = params;
  const targetVolume = getTargetVolume(document, options.targetVolumeId);
  const targetBeatSheet = getBeatSheet(document, targetVolume.id);
  if (!targetBeatSheet) {
    throw new Error("当前卷还没有节奏板，默认不能直接拆章节列表。");
  }
  const targetIndex = document.volumes.findIndex((volume) => volume.id === targetVolume.id);
  const volumeBudget = resolveDocumentVolumeBudget({
    document,
    novel,
    workspace,
    options,
    targetVolume,
  });
  const targetChapterCount = volumeBudget.targetChapterCount;
  const effectiveTargetBeatSheet: VolumeBeatSheet = {
    ...targetBeatSheet,
    beats: normalizeBeatSheetSpansToChapterBudget(
      targetBeatSheet.beats,
      volumeBudget.targetChapterStartOrder,
      targetChapterCount,
    ),
  };

  await notifyVolumeGenerationPhase({
    novelId: document.novelId,
    scope: "chapter_list",
    phase: "prompt",
    label: `正在生成第 ${targetVolume.sortOrder} 卷章节列表`,
    options,
  });
  const generated = await runStructuredPrompt({
    asset: createVolumeChapterListPrompt(targetChapterCount),
    promptInput: {
      novel,
      workspace,
      storyMacroPlan,
      strategyPlan: document.strategyPlan,
      targetVolume,
      targetBeatSheet: effectiveTargetBeatSheet,
      previousVolume: targetIndex > 0 ? document.volumes[targetIndex - 1] : undefined,
      nextVolume: targetIndex < document.volumes.length - 1 ? document.volumes[targetIndex + 1] : undefined,
      guidance: options.guidance,
      targetChapterCount,
    },
    contextBlocks: buildVolumeChapterListContextBlocks({
      novel,
      workspace,
      storyMacroPlan,
      strategyPlan: document.strategyPlan,
      targetVolume,
      targetBeatSheet: effectiveTargetBeatSheet,
      previousVolume: targetIndex > 0 ? document.volumes[targetIndex - 1] : undefined,
      nextVolume: targetIndex < document.volumes.length - 1 ? document.volumes[targetIndex + 1] : undefined,
      guidance: options.guidance,
      targetChapterCount,
    }),
    options: {
      provider: options.provider,
      model: options.model,
      temperature: options.temperature ?? 0.35,
    },
  });

  const generatedChapters = normalizeGeneratedChapterList({
    chapters: generated.output.chapters,
    targetChapterCount,
    targetBeatSheet: effectiveTargetBeatSheet,
  });
  const beatAlignedDocument = mergeBeatSheet(document, targetVolume, effectiveTargetBeatSheet.beats, volumeBudget);
  const mergedDocument = mergeChapterList(
    beatAlignedDocument,
    targetVolume.id,
    generatedChapters,
    volumeBudget.targetChapterStartOrder,
    novel.defaultChapterLength,
  );
  return generateRebalance({
    document: mergedDocument,
    novel,
    workspace: {
      ...workspace,
      ...mergedDocument,
    },
    storyMacroPlan,
    options: {
      ...options,
      scope: "rebalance",
      targetVolumeId: targetVolume.id,
    },
  });
}

async function generateChapterDetail(params: {
  document: VolumePlanDocument;
  novel: VolumeGenerationNovel;
  workspace: VolumeWorkspace;
  storyMacroPlan: Awaited<ReturnType<StoryMacroPlanService["getPlan"]>> | null;
  options: VolumeGenerateOptions;
}): Promise<VolumePlanDocument> {
  const { document, novel, workspace, storyMacroPlan, options } = params;
  const targetVolume = getTargetVolume(document, options.targetVolumeId);
  const targetChapter = getTargetChapter(targetVolume, options.targetChapterId);
  const detailMode = options.detailMode;
  if (!detailMode) {
    throw new Error("生成章节细化时必须指定生成类型。");
  }
  const promptInput = {
    novel,
    workspace,
    storyMacroPlan,
    strategyPlan: document.strategyPlan,
    targetVolume,
    targetBeatSheet: getBeatSheet(document, targetVolume.id),
    targetChapter,
    guidance: options.guidance,
    detailMode,
  };
  await notifyVolumeGenerationPhase({
    novelId: document.novelId,
    scope: "chapter_detail",
    phase: "prompt",
    label: `正在细化第 ${targetVolume.sortOrder} 卷第 ${targetChapter.chapterOrder} 章 · ${detailMode}`,
    options,
  });
  const generated = detailMode === "purpose"
    ? await runStructuredPrompt({
      asset: volumeChapterPurposePrompt,
      promptInput,
      contextBlocks: buildVolumeChapterDetailContextBlocks(promptInput),
      options: {
        provider: options.provider,
        model: options.model,
        temperature: options.temperature ?? 0.35,
      },
    })
    : detailMode === "boundary"
      ? await runStructuredPrompt({
        asset: volumeChapterBoundaryPrompt,
        promptInput,
        contextBlocks: buildVolumeChapterDetailContextBlocks(promptInput),
        options: {
          provider: options.provider,
          model: options.model,
          temperature: options.temperature ?? 0.35,
        },
      })
      : await runStructuredPrompt({
        asset: volumeChapterTaskSheetPrompt,
        promptInput,
        contextBlocks: buildVolumeChapterDetailContextBlocks(promptInput),
        options: {
          provider: options.provider,
          model: options.model,
          temperature: options.temperature ?? 0.35,
        },
      });

  return mergeChapterDetail({
    document,
    targetVolumeId: targetVolume.id,
    targetChapterId: targetChapter.id,
    detailMode,
    generatedDetail: generated.output as Record<string, unknown>,
  });
}

export async function generateVolumePlanDocument(params: {
  novelId: string;
  workspace: VolumeWorkspace;
  options?: VolumeGenerateOptions;
  storyMacroPlanService: Pick<StoryMacroPlanService, "getPlan">;
}): Promise<VolumePlanDocument> {
  const { novelId, workspace, options = {}, storyMacroPlanService } = params;
  const scope = normalizeScope(options.scope);
  const baseDocument = buildVolumeWorkspaceDocument({
    novelId,
    volumes: options.draftVolumes
      ? normalizeVolumeDraftContextInput(novelId, options.draftVolumes)
      : workspace.volumes,
    strategyPlan: workspace.strategyPlan,
    critiqueReport: workspace.critiqueReport,
    beatSheets: workspace.beatSheets,
    rebalanceDecisions: workspace.rebalanceDecisions,
    source: workspace.source,
    activeVersionId: workspace.activeVersionId,
  });
  assertScopeReadiness(baseDocument, scope, options.targetVolumeId);
  await notifyVolumeGenerationPhase({
    novelId,
    scope,
    phase: "load_context",
    label: scope === "chapter_list"
      ? "正在整理拆章上下文"
      : scope === "beat_sheet"
        ? "正在整理节奏板上下文"
        : scope === "skeleton"
          ? "正在整理卷骨架上下文"
          : scope === "strategy"
            ? "正在整理卷战略上下文"
            : scope === "rebalance"
              ? "正在整理相邻卷衔接上下文"
              : "正在整理卷规划上下文",
    options,
  });
  const { novel, storyMacroPlan } = await loadGenerationContext({
    novelId,
    workspace,
    storyMacroPlanService,
  });
  const currentWorkspace: VolumeWorkspace = {
    ...workspace,
    ...baseDocument,
  };

  if (scope === "strategy") {
    return generateStrategy({
      document: baseDocument,
      novel,
      workspace: currentWorkspace,
      storyMacroPlan,
      options,
    });
  }
  if (scope === "strategy_critique") {
    return generateStrategyCritique({
      document: baseDocument,
      novel,
      workspace: currentWorkspace,
      storyMacroPlan,
      options,
    });
  }
  if (scope === "skeleton") {
    return generateSkeleton({
      document: baseDocument,
      novel,
      workspace: currentWorkspace,
      storyMacroPlan,
      options,
    });
  }
  if (scope === "beat_sheet") {
    return generateBeatSheet({
      document: baseDocument,
      novel,
      workspace: currentWorkspace,
      storyMacroPlan,
      options,
    });
  }
  if (scope === "chapter_list") {
    return generateChapterList({
      document: baseDocument,
      novel,
      workspace: currentWorkspace,
      storyMacroPlan,
      options,
    });
  }
  if (scope === "rebalance") {
    return generateRebalance({
      document: baseDocument,
      novel,
      workspace: currentWorkspace,
      storyMacroPlan,
      options,
    });
  }
  return generateChapterDetail({
    document: baseDocument,
    novel,
    workspace: currentWorkspace,
    storyMacroPlan,
    options,
  });
}
