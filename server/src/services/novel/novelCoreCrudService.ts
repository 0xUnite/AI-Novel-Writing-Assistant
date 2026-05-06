import { serializeCommercialTagsJson } from "@ai-novel/shared/types/novelFraming";
import type { NovelAutoDirectorTaskSummary } from "@ai-novel/shared/types/novel";
import { prisma } from "../../db/prisma";
import { AppError } from "../../middleware/errorHandler";
import { mapNovelAutoDirectorTaskSummary } from "../task/novelWorkflowTaskSummary";
import { getArchivedTaskIdSet } from "../task/taskArchive";
import { NovelContinuationService } from "./NovelContinuationService";
import { sanitizeGeneratedChapterContent } from "./chapterContentSanitizer";
import { buildContentEditProgress, hasChapterContentText, reconcileChapterProgress } from "./chapterProgressState";
import { ensureChapterTitle } from "./chapterTitle";
import { STORY_WORLD_SLICE_SCHEMA_VERSION } from "./storyWorldSlice/storyWorldSlicePersistence";
import { syncChapterArtifacts } from "./novelChapterArtifacts";
import { normalizeNovelPlanningScale } from "./novelPlanningScale";
import {
  ChapterInput,
  CreateNovelInput,
  normalizeNovelOutput,
  normalizeOptionalTextForCreate,
  normalizeOptionalTextForUpdate,
  PaginationInput,
  parseContinuationBookAnalysisSections,
  serializeContinuationBookAnalysisSections,
  UpdateNovelInput,
} from "./novelCoreShared";
import { queueRagDelete, queueRagUpsert } from "./novelCoreSupport";

export class NovelCoreCrudService {
  private readonly novelContinuationService = new NovelContinuationService();

  private validateStoryModeSelection(primaryStoryModeId?: string | null, secondaryStoryModeId?: string | null): void {
    if (primaryStoryModeId && secondaryStoryModeId && primaryStoryModeId === secondaryStoryModeId) {
      throw new AppError("主流派模式和副流派模式不能选择同一项。", 400);
    }
  }

  async listNovels({ page, limit, contentForm }: PaginationInput) {
    const where = contentForm ? { contentForm } : {};
    const [items, total] = await Promise.all([
      prisma.novel.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { updatedAt: "desc" },
        include: {
          genre: true,
          primaryStoryMode: true,
          secondaryStoryMode: true,
          world: { select: { id: true, name: true, worldType: true } },
          bible: true,
          bookContract: true,
          _count: { select: { chapters: true, characters: true, plotBeats: true } },
        },
      }),
      prisma.novel.count({ where }),
    ]);

    const latestAutoDirectorTaskByNovelId = await this.listLatestVisibleAutoDirectorTasksByNovelIds(
      items.map((item) => item.id),
    );

    return {
      items: items.map((item) => ({
        ...normalizeNovelOutput(item),
        latestAutoDirectorTask: latestAutoDirectorTaskByNovelId.get(item.id) ?? null,
      })),
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  private async listLatestVisibleAutoDirectorTasksByNovelIds(
    novelIds: string[],
  ): Promise<Map<string, NovelAutoDirectorTaskSummary>> {
    const uniqueNovelIds = Array.from(new Set(novelIds.filter((id) => id.trim().length > 0)));
    if (uniqueNovelIds.length === 0) {
      return new Map();
    }

    const rows = await prisma.novelWorkflowTask.findMany({
      where: {
        lane: "auto_director",
        novelId: {
          in: uniqueNovelIds,
        },
      },
      select: {
        id: true,
        novelId: true,
        status: true,
        progress: true,
        currentStage: true,
        currentItemLabel: true,
        checkpointType: true,
        checkpointSummary: true,
        updatedAt: true,
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    });

    if (rows.length === 0) {
      return new Map();
    }

    const archivedTaskIds = await getArchivedTaskIdSet("novel_workflow", rows.map((row) => row.id));
    const taskByNovelId = new Map<string, NovelAutoDirectorTaskSummary>();
    for (const row of rows) {
      if (!row.novelId || archivedTaskIds.has(row.id) || taskByNovelId.has(row.novelId)) {
        continue;
      }
      taskByNovelId.set(row.novelId, mapNovelAutoDirectorTaskSummary(row));
    }
    return taskByNovelId;
  }

  async createNovel(input: CreateNovelInput) {
    const writingMode = input.writingMode ?? "original";
    const sourceNovelId = input.sourceNovelId ?? null;
    const sourceKnowledgeDocumentId = input.sourceKnowledgeDocumentId ?? null;
    const continuationBookAnalysisId = input.continuationBookAnalysisId ?? null;
    const normalizedContinuationBookAnalysisId =
      writingMode === "continuation" && (sourceNovelId || sourceKnowledgeDocumentId) ? continuationBookAnalysisId : null;
    const continuationBookAnalysisSections = serializeContinuationBookAnalysisSections(
      input.continuationBookAnalysisSections,
    );
    const commercialTagsJson = serializeCommercialTagsJson(input.commercialTags);
    this.validateStoryModeSelection(input.primaryStoryModeId, input.secondaryStoryModeId);
    const planningScale = normalizeNovelPlanningScale(input);

    await this.novelContinuationService.validateWritingModeConfig({
      writingMode,
      sourceNovelId,
      sourceKnowledgeDocumentId,
      continuationBookAnalysisId: normalizedContinuationBookAnalysisId,
    });

    const created = await prisma.novel.create({
      data: {
        contentForm: planningScale.contentForm,
        title: input.title,
        description: input.description,
        targetAudience: normalizeOptionalTextForCreate(input.targetAudience),
        bookSellingPoint: normalizeOptionalTextForCreate(input.bookSellingPoint),
        competingFeel: normalizeOptionalTextForCreate(input.competingFeel),
        first30ChapterPromise: normalizeOptionalTextForCreate(input.first30ChapterPromise),
        commercialTagsJson,
        genreId: input.genreId,
        primaryStoryModeId: input.primaryStoryModeId ?? null,
        secondaryStoryModeId: input.secondaryStoryModeId ?? null,
        worldId: input.worldId,
        writingMode,
        projectMode: input.projectMode,
        narrativePov: input.narrativePov,
        pacePreference: input.pacePreference,
        styleTone: input.styleTone,
        emotionIntensity: input.emotionIntensity,
        aiFreedom: input.aiFreedom,
        defaultChapterLength: planningScale.defaultChapterLength,
        estimatedChapterCount: planningScale.estimatedChapterCount,
        targetTotalWordCount: planningScale.targetTotalWordCount,
        projectStatus: input.projectStatus,
        storylineStatus: input.storylineStatus,
        outlineStatus: input.outlineStatus,
        resourceReadyScore: input.resourceReadyScore,
        sourceNovelId: writingMode === "continuation" ? sourceNovelId : null,
        sourceKnowledgeDocumentId: writingMode === "continuation" ? sourceKnowledgeDocumentId : null,
        continuationBookAnalysisId: normalizedContinuationBookAnalysisId,
        continuationBookAnalysisSections:
          writingMode === "continuation"
          && (sourceNovelId || sourceKnowledgeDocumentId)
          && normalizedContinuationBookAnalysisId
            ? continuationBookAnalysisSections
            : null,
      },
    });

    queueRagUpsert("novel", created.id);
    if (created.worldId) {
      queueRagUpsert("world", created.worldId);
    }
    return normalizeNovelOutput(created);
  }

  async getNovelById(id: string) {
    await this.reconcileNovelChapterProgress(id);
    const row = await prisma.novel.findUnique({
      where: { id },
      include: {
        genre: true,
        primaryStoryMode: true,
        secondaryStoryMode: true,
        world: true,
        bible: true,
        bookContract: true,
        chapters: { orderBy: { order: "asc" }, include: { chapterSummary: true } },
        characters: { orderBy: { createdAt: "asc" } },
        plotBeats: { orderBy: [{ chapterOrder: "asc" }, { createdAt: "asc" }] },
      },
    });
    if (!row) {
      return null;
    }
    return normalizeNovelOutput(row);
  }

  async updateNovel(id: string, input: UpdateNovelInput) {
    const existing = await prisma.novel.findUnique({
      where: { id },
      select: {
        id: true,
        worldId: true,
        writingMode: true,
        sourceNovelId: true,
        sourceKnowledgeDocumentId: true,
        continuationBookAnalysisId: true,
        continuationBookAnalysisSections: true,
        primaryStoryModeId: true,
        secondaryStoryModeId: true,
        contentForm: true,
        defaultChapterLength: true,
        estimatedChapterCount: true,
        targetTotalWordCount: true,
      },
    });
    if (!existing) {
      throw new Error("小说不存在");
    }

    const nextWritingMode = input.writingMode ?? (existing.writingMode === "continuation" ? "continuation" : "original");
    const nextSourceNovelId = input.sourceNovelId !== undefined ? input.sourceNovelId : existing.sourceNovelId;
    const nextSourceKnowledgeDocumentId = input.sourceKnowledgeDocumentId !== undefined
      ? input.sourceKnowledgeDocumentId
      : existing.sourceKnowledgeDocumentId;
    const nextContinuationBookAnalysisId = input.continuationBookAnalysisId !== undefined
      ? input.continuationBookAnalysisId
      : existing.continuationBookAnalysisId;
    const nextContinuationBookAnalysisSections = input.continuationBookAnalysisSections !== undefined
      ? input.continuationBookAnalysisSections
      : parseContinuationBookAnalysisSections(existing.continuationBookAnalysisSections);
    const nextPrimaryStoryModeId = input.primaryStoryModeId !== undefined
      ? input.primaryStoryModeId
      : existing.primaryStoryModeId;
    const nextSecondaryStoryModeId = input.secondaryStoryModeId !== undefined
      ? input.secondaryStoryModeId
      : existing.secondaryStoryModeId;
    const normalizedNextContinuationBookAnalysisId =
      nextWritingMode === "continuation" && (nextSourceNovelId || nextSourceKnowledgeDocumentId)
        ? nextContinuationBookAnalysisId
        : null;
    this.validateStoryModeSelection(nextPrimaryStoryModeId, nextSecondaryStoryModeId);

    await this.novelContinuationService.validateWritingModeConfig({
      novelId: id,
      writingMode: nextWritingMode,
      sourceNovelId: nextSourceNovelId,
      sourceKnowledgeDocumentId: nextSourceKnowledgeDocumentId,
      continuationBookAnalysisId: normalizedNextContinuationBookAnalysisId,
    });

    const {
      continuationBookAnalysisSections: _ignoreSectionPatch,
      contentForm: _ignoreContentForm,
      defaultChapterLength: _ignoreDefaultChapterLength,
      estimatedChapterCount: _ignoreEstimatedChapterCount,
      targetTotalWordCount: _ignoreTargetTotalWordCount,
      targetAudience: _ignoreTargetAudience,
      bookSellingPoint: _ignoreBookSellingPoint,
      competingFeel: _ignoreCompetingFeel,
      first30ChapterPromise: _ignoreFirst30ChapterPromise,
      commercialTags: _ignoreCommercialTags,
      ...restInput
    } = input;

    const serializedContinuationSections = serializeContinuationBookAnalysisSections(nextContinuationBookAnalysisSections);
    const commercialTagsJson = input.commercialTags !== undefined
      ? serializeCommercialTagsJson(input.commercialTags)
      : undefined;
    const nextWorldId = input.worldId !== undefined ? input.worldId : existing.worldId;
    const shouldResetWorldSlice = nextWorldId !== existing.worldId;
    const planningScale = normalizeNovelPlanningScale(input, existing);

    const updated = await prisma.novel.update({
      where: { id },
      data: {
        ...restInput,
        contentForm: planningScale.contentForm,
        defaultChapterLength: planningScale.defaultChapterLength,
        estimatedChapterCount: planningScale.estimatedChapterCount,
        targetTotalWordCount: planningScale.targetTotalWordCount,
        sourceNovelId: nextWritingMode === "continuation" ? nextSourceNovelId : null,
        sourceKnowledgeDocumentId: nextWritingMode === "continuation" ? nextSourceKnowledgeDocumentId : null,
        continuationBookAnalysisId: normalizedNextContinuationBookAnalysisId,
        primaryStoryModeId: nextPrimaryStoryModeId ?? null,
        secondaryStoryModeId: nextSecondaryStoryModeId ?? null,
        targetAudience: normalizeOptionalTextForUpdate(input.targetAudience),
        bookSellingPoint: normalizeOptionalTextForUpdate(input.bookSellingPoint),
        competingFeel: normalizeOptionalTextForUpdate(input.competingFeel),
        first30ChapterPromise: normalizeOptionalTextForUpdate(input.first30ChapterPromise),
        commercialTagsJson,
        continuationBookAnalysisSections:
          nextWritingMode === "continuation"
          && (nextSourceNovelId || nextSourceKnowledgeDocumentId)
          && normalizedNextContinuationBookAnalysisId
            ? serializedContinuationSections
            : null,
        ...(shouldResetWorldSlice
          ? {
            storyWorldSliceJson: null,
            storyWorldSliceOverridesJson: null,
            storyWorldSliceSchemaVersion: STORY_WORLD_SLICE_SCHEMA_VERSION,
          }
          : {}),
      },
      include: {
        primaryStoryMode: true,
        secondaryStoryMode: true,
      },
    });

    queueRagUpsert("novel", id);
    if (updated.worldId) {
      queueRagUpsert("world", updated.worldId);
    }
    return normalizeNovelOutput(updated);
  }

  async deleteNovel(id: string) {
    queueRagDelete("novel", id);
    queueRagDelete("bible", id);
    await prisma.novel.delete({ where: { id } });
  }

  async listChapters(novelId: string) {
    await this.reconcileNovelChapterProgress(novelId);
    return prisma.chapter.findMany({
      where: { novelId },
      orderBy: { order: "asc" },
      include: { chapterSummary: true },
    });
  }

  async sanitizeNovelTypography(novelId: string) {
    const novel = await prisma.novel.findUnique({
      where: { id: novelId },
      select: {
        id: true,
        outline: true,
        structuredOutline: true,
        chapters: {
          orderBy: { order: "asc" },
          select: {
            id: true,
            title: true,
            order: true,
            content: true,
          },
        },
      },
    });
    if (!novel) {
      throw new Error("小说不存在");
    }

    const contentChapters = novel.chapters.filter((chapter) => typeof chapter.content === "string" && chapter.content.trim().length > 0);
    const changes = contentChapters
      .map((chapter) => {
        const originalContent = chapter.content ?? "";
        const sanitizedContent = sanitizeGeneratedChapterContent(originalContent);
        return {
          id: chapter.id,
          title: chapter.title,
          order: chapter.order,
          originalContent,
          sanitizedContent,
        };
      })
      .filter((chapter) => chapter.sanitizedContent !== chapter.originalContent);

    if (changes.length === 0) {
      return {
        totalChapterCount: novel.chapters.length,
        contentChapterCount: contentChapters.length,
        changedCount: 0,
        unchangedCount: contentChapters.length,
        snapshotId: null,
        snapshotLabel: null,
        changedChapters: [],
      };
    }

    const snapshotLabel = `before-typography-sanitize-${Date.now()}`;
    const snapshot = await prisma.novelSnapshot.create({
      data: {
        novelId,
        triggerType: "manual",
        label: snapshotLabel,
        snapshotData: JSON.stringify({
          outline: novel.outline,
          structuredOutline: novel.structuredOutline,
          chapters: novel.chapters.map((chapter) => ({
            id: chapter.id,
            title: chapter.title,
            order: chapter.order,
            content: chapter.content,
          })),
        }),
      },
    });

    for (const chapter of changes) {
      await prisma.chapter.update({
        where: { id: chapter.id },
        data: {
          content: chapter.sanitizedContent,
        },
      });
      queueRagUpsert("chapter", chapter.id);
    }
    queueRagUpsert("novel", novelId);

    return {
      totalChapterCount: novel.chapters.length,
      contentChapterCount: contentChapters.length,
      changedCount: changes.length,
      unchangedCount: contentChapters.length - changes.length,
      snapshotId: snapshot.id,
      snapshotLabel,
      changedChapters: changes.map((chapter) => ({
        id: chapter.id,
        title: chapter.title,
        order: chapter.order,
      })),
    };
  }

  async createChapter(novelId: string, input: ChapterInput) {
    const sanitizedContent = sanitizeGeneratedChapterContent(input.content ?? "");
    const chapterTitle = ensureChapterTitle({
      order: input.order,
      title: input.title,
      content: sanitizedContent,
      expectation: input.expectation,
    });
    const draftProgress = hasChapterContentText(sanitizedContent)
      ? buildContentEditProgress({
        content: sanitizedContent,
        chapterStatus: input.chapterStatus ?? null,
      })
      : {
        generationState: "planned" as const,
        chapterStatus: input.chapterStatus ?? "unplanned",
      };
    const chapter = await prisma.chapter.create({
      data: {
        novelId,
        title: chapterTitle,
        order: input.order,
        content: sanitizedContent,
        expectation: input.expectation,
        chapterStatus: draftProgress.chapterStatus,
        targetWordCount: input.targetWordCount ?? null,
        conflictLevel: input.conflictLevel ?? null,
        revealLevel: input.revealLevel ?? null,
        mustAvoid: input.mustAvoid ?? null,
        taskSheet: input.taskSheet ?? null,
        sceneCards: input.sceneCards ?? null,
        repairHistory: input.repairHistory ?? null,
        qualityScore: input.qualityScore ?? null,
        continuityScore: input.continuityScore ?? null,
        characterScore: input.characterScore ?? null,
        pacingScore: input.pacingScore ?? null,
        riskFlags: input.riskFlags ?? null,
        generationState: draftProgress.generationState,
      },
    });

    if (chapter.content) {
      await syncChapterArtifacts(novelId, chapter.id, sanitizedContent);
    }
    queueRagUpsert("chapter", chapter.id);
    return chapter;
  }

  async updateChapter(novelId: string, chapterId: string, input: Partial<ChapterInput>) {
    const exists = await prisma.chapter.findFirst({
      where: { id: chapterId, novelId },
      select: { id: true, title: true, order: true, content: true, generationState: true, chapterStatus: true },
    });
    if (!exists) {
      throw new Error("章节不存在");
    }
    const sanitizedContent = typeof input.content === "string"
      ? sanitizeGeneratedChapterContent(input.content)
      : undefined;
    const nextOrder = input.order ?? exists.order;
    const nextTitle = ensureChapterTitle({
      order: nextOrder,
      title: input.title ?? exists.title,
      content: sanitizedContent ?? exists.content,
      expectation: input.expectation,
    });

    const progressFromContentEdit = typeof sanitizedContent === "string"
      ? buildContentEditProgress({
        content: sanitizedContent,
        chapterStatus: input.chapterStatus ?? null,
      })
      : null;
    const chapter = await prisma.chapter.update({
      where: { id: chapterId },
      data: {
        title: nextTitle,
        order: input.order,
        content: sanitizedContent,
        expectation: input.expectation,
        chapterStatus: progressFromContentEdit?.chapterStatus ?? input.chapterStatus,
        targetWordCount: input.targetWordCount,
        conflictLevel: input.conflictLevel,
        revealLevel: input.revealLevel,
        mustAvoid: input.mustAvoid,
        taskSheet: input.taskSheet,
        sceneCards: input.sceneCards,
        repairHistory: input.repairHistory,
        qualityScore: input.qualityScore,
        continuityScore: input.continuityScore,
        characterScore: input.characterScore,
        pacingScore: input.pacingScore,
        riskFlags: input.riskFlags,
        generationState: progressFromContentEdit?.generationState,
      },
    });

    if (typeof sanitizedContent === "string") {
      await syncChapterArtifacts(novelId, chapterId, sanitizedContent);
    }
    queueRagUpsert("chapter", chapterId);
    return chapter;
  }

  private async reconcileNovelChapterProgress(novelId: string): Promise<void> {
    const rows = await prisma.chapter.findMany({
      where: { novelId },
      select: {
        id: true,
        content: true,
        generationState: true,
        chapterStatus: true,
      },
    });
    const updates = rows
      .map((row) => ({
        id: row.id,
        next: reconcileChapterProgress({
          content: row.content,
          generationState: row.generationState,
          chapterStatus: row.chapterStatus,
        }),
        current: {
          generationState: row.generationState,
          chapterStatus: row.chapterStatus ?? "unplanned",
        },
      }))
      .filter((item) => (
        item.current.generationState !== item.next.generationState
        || item.current.chapterStatus !== item.next.chapterStatus
      ));
    if (updates.length === 0) {
      return;
    }
    await prisma.$transaction(
      updates.map((item) => prisma.chapter.update({
        where: { id: item.id },
        data: {
          generationState: item.next.generationState,
          chapterStatus: item.next.chapterStatus,
        },
      })),
    );
  }

  async deleteChapter(novelId: string, chapterId: string) {
    queueRagDelete("chapter", chapterId);
    queueRagDelete("chapter_summary", chapterId);
    const deleted = await prisma.chapter.deleteMany({ where: { id: chapterId, novelId } });
    if (deleted.count === 0) {
      throw new Error("章节不存在");
    }
  }
}
