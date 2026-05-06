import { useEffect, useState } from "react";
import type { UnifiedTaskDetail } from "@ai-novel/shared/types/task";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BOOK_ANALYSIS_SECTIONS } from "@ai-novel/shared/types/bookAnalysis";
import type { NovelContentForm } from "@ai-novel/shared/types/novel";
import { flattenGenreTreeOptions, getGenreTree } from "@/api/genre";
import { bootstrapNovelWorkflow } from "@/api/novelWorkflow";
import { createNovel, getNovelDetail } from "@/api/novel";
import { queryKeys } from "@/api/queryKeys";
import { flattenStoryModeTreeOptions, getStoryModeTree } from "@/api/storyMode";
import { getWorldList } from "@/api/world";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import NovelAutoDirectorDialog from "./components/NovelAutoDirectorDialog";
import NovelBasicInfoForm from "./components/NovelBasicInfoForm";
import { BookFramingQuickFillButton } from "./components/basicInfoForm/BookFramingQuickFillButton";
import NovelCreateTitleQuickFill from "./components/titleWorkshop/NovelCreateTitleQuickFill";
import { useNovelContinuationSources } from "./hooks/useNovelContinuationSources";
import {
  buildNovelCreatePayload,
  createDefaultNovelBasicFormState,
  createShortStoryBasicFormState,
  patchNovelBasicForm,
} from "./novelBasicInfo.shared";

function buildContinuationPrefillFromNovel(
  source: Awaited<ReturnType<typeof getNovelDetail>>["data"],
  targetContentForm: NovelContentForm,
) {
  const commercialTagsText = Array.isArray(source?.commercialTags) ? source.commercialTags.join("，") : "";
  const isShortStory = targetContentForm === "short_story";
  return {
    contentForm: targetContentForm,
    title: source?.title?.trim() ? `${source.title.trim()}·续篇` : "",
    description: source?.title?.trim()
      ? `承接《${source.title.trim()}》已写内容与人物状态，开启下一阶段主线。`
      : "承接前作已写内容与人物状态，开启下一阶段主线。",
    targetAudience: source?.targetAudience ?? "",
    bookSellingPoint: source?.bookSellingPoint ?? "",
    competingFeel: source?.competingFeel ?? "",
    first30ChapterPromise: isShortStory
      ? "整篇必须完成承接前作状态、抛出新阶段核心矛盾，并在有限篇幅内兑现一个完整转折或阶段结局。"
      : "前30章必须完成承接前作结局、抛出新阶段主冲突，并让老角色进入新局势的第一轮失衡与重组。",
    commercialTagsText,
    genreId: source?.genreId ?? "",
    primaryStoryModeId: source?.primaryStoryModeId ?? "",
    secondaryStoryModeId: source?.secondaryStoryModeId ?? "",
    worldId: source?.worldId ?? "",
    writingMode: "continuation" as const,
    continuationSourceType: "novel" as const,
    sourceNovelId: source?.id ?? "",
    sourceKnowledgeDocumentId: "",
    continuationBookAnalysisId: "",
    continuationBookAnalysisSections: [],
    projectMode: source?.projectMode ?? "co_pilot",
    narrativePov: source?.narrativePov ?? "third_person",
    pacePreference: source?.pacePreference ?? "balanced",
    styleTone: source?.styleTone ?? "",
    emotionIntensity: source?.emotionIntensity ?? "medium",
    aiFreedom: source?.aiFreedom ?? "medium",
    defaultChapterLength: source?.defaultChapterLength ?? (isShortStory ? 2500 : 2000),
    estimatedChapterCount: isShortStory ? Math.max(1, Math.min(32, source?.estimatedChapterCount ?? 8)) : source?.estimatedChapterCount ?? 0,
    targetTotalWordCount: isShortStory ? Math.max(20000, Math.min(80000, source?.targetTotalWordCount ?? 20000)) : source?.targetTotalWordCount ?? 0,
    projectStatus: "not_started" as const,
    storylineStatus: "not_started" as const,
    outlineStatus: "not_started" as const,
    resourceReadyScore: 0,
  };
}

interface NovelCreateProps {
  contentForm?: NovelContentForm;
}

export default function NovelCreate({ contentForm = "novel" }: NovelCreateProps) {
  const isShortStory = contentForm === "short_story";
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [basicForm, setBasicForm] = useState(() => (
    isShortStory ? createShortStoryBasicFormState() : createDefaultNovelBasicFormState()
  ));
  const [restoredWorkflowTask, setRestoredWorkflowTask] = useState<UnifiedTaskDetail | null>(null);
  const [directorWorkflowTaskId, setDirectorWorkflowTaskId] = useState("");
  const [appliedContinuationPrefillId, setAppliedContinuationPrefillId] = useState("");

  const workflowTaskIdFromQuery = searchParams.get("workflowTaskId") ?? "";
  const workflowMode = searchParams.get("mode");
  const continueFromNovelId = searchParams.get("continueFromNovelId") ?? "";

  const worldListQuery = useQuery({
    queryKey: queryKeys.worlds.all,
    queryFn: getWorldList,
  });

  const genreTreeQuery = useQuery({
    queryKey: queryKeys.genres.all,
    queryFn: getGenreTree,
  });
  const genreOptions = flattenGenreTreeOptions(genreTreeQuery.data?.data ?? []);
  const storyModeTreeQuery = useQuery({
    queryKey: queryKeys.storyModes.all,
    queryFn: getStoryModeTree,
  });
  const storyModeOptions = flattenStoryModeTreeOptions(storyModeTreeQuery.data?.data ?? []);
  const continuationPrefillQuery = useQuery({
    queryKey: [...queryKeys.novels.detail(continueFromNovelId), "continuation-prefill"],
    queryFn: () => getNovelDetail(continueFromNovelId),
    enabled: Boolean(continueFromNovelId) && !workflowTaskIdFromQuery,
  });

  const {
    sourceBookAnalysesQuery,
    sourceNovelOptions,
    sourceKnowledgeOptions,
    sourceNovelBookAnalysisOptions,
  } = useNovelContinuationSources("", basicForm);

  useEffect(() => {
    if (!continueFromNovelId || workflowTaskIdFromQuery) {
      return;
    }
    if (!continuationPrefillQuery.data?.data) {
      return;
    }
    if (appliedContinuationPrefillId === continueFromNovelId) {
      return;
    }
    setBasicForm((prev) => patchNovelBasicForm(prev, {
      ...buildContinuationPrefillFromNovel(continuationPrefillQuery.data?.data, contentForm),
    }));
    setAppliedContinuationPrefillId(continueFromNovelId);
  }, [
    appliedContinuationPrefillId,
    continuationPrefillQuery.data?.data,
    contentForm,
    continueFromNovelId,
    workflowTaskIdFromQuery,
  ]);

  useEffect(() => {
    if (
      basicForm.writingMode !== "continuation"
      || !basicForm.continuationBookAnalysisId
    ) {
      return;
    }
    if (sourceBookAnalysesQuery.isLoading || sourceBookAnalysesQuery.isFetching) {
      return;
    }
    const exists = sourceNovelBookAnalysisOptions.some((item) => item.id === basicForm.continuationBookAnalysisId);
    if (exists) {
      return;
    }
    setBasicForm((prev) => ({
      ...prev,
      continuationBookAnalysisId: "",
      continuationBookAnalysisSections: [],
    }));
  }, [
    basicForm.continuationBookAnalysisId,
    basicForm.writingMode,
    sourceBookAnalysesQuery.isFetching,
    sourceBookAnalysesQuery.isLoading,
    sourceNovelBookAnalysisOptions,
  ]);

  useEffect(() => {
    if (!continueFromNovelId || workflowTaskIdFromQuery) {
      return;
    }
    if (basicForm.writingMode !== "continuation" || basicForm.continuationSourceType !== "novel") {
      return;
    }
    if (basicForm.sourceNovelId !== continueFromNovelId || basicForm.continuationBookAnalysisId) {
      return;
    }
    const latestAnalysis = sourceNovelBookAnalysisOptions[0];
    if (!latestAnalysis) {
      return;
    }
    setBasicForm((prev) => ({
      ...prev,
      continuationBookAnalysisId: latestAnalysis.id,
      continuationBookAnalysisSections: [...BOOK_ANALYSIS_SECTIONS].map((item) => item.key),
    }));
  }, [
    basicForm.continuationBookAnalysisId,
    basicForm.continuationSourceType,
    basicForm.sourceNovelId,
    basicForm.writingMode,
    continueFromNovelId,
    sourceNovelBookAnalysisOptions,
    workflowTaskIdFromQuery,
  ]);

  const restoreWorkflowMutation = useMutation({
    mutationFn: () => bootstrapNovelWorkflow({
      workflowTaskId: workflowTaskIdFromQuery || undefined,
      lane: workflowMode === "director" ? "auto_director" : "manual_create",
    }),
    onSuccess: (response) => {
      const task = response.data;
      setRestoredWorkflowTask(task ?? null);
      if (!task) {
        return;
      }
      const seedPayload = (task.meta.seedPayload ?? null) as { basicForm?: Partial<typeof basicForm> } | null;
      if (seedPayload?.basicForm) {
        setBasicForm((prev) => patchNovelBasicForm(prev, {
          ...seedPayload.basicForm,
          contentForm,
        }));
      }
      if (workflowMode === "director") {
        setDirectorWorkflowTaskId(task.id);
      }
      if (task.id !== workflowTaskIdFromQuery) {
        setSearchParams((prev) => {
          const next = new URLSearchParams(prev);
          next.set("workflowTaskId", task.id);
          if (workflowMode === "director") {
            next.set("mode", "director");
          }
          return next;
        }, { replace: true });
      }
    },
  });

  useEffect(() => {
    if (!workflowTaskIdFromQuery) {
      setRestoredWorkflowTask(null);
      if (workflowMode !== "director") {
        setDirectorWorkflowTaskId("");
      }
      return;
    }
    restoreWorkflowMutation.mutate();
  }, [workflowTaskIdFromQuery, workflowMode]);

  const createNovelMutation = useMutation({
    mutationFn: async () => {
      const task = await bootstrapNovelWorkflow({
        lane: "manual_create",
        title: basicForm.title,
        seedPayload: {
          basicForm,
        },
      });
      const created = await createNovel(buildNovelCreatePayload(basicForm));
      const novelId = created.data?.id;
      if (!novelId) {
        return {
          response: created,
          workflowTaskId: task.data?.id ?? "",
        };
      }
      const attached = await bootstrapNovelWorkflow({
        workflowTaskId: task.data?.id,
        novelId,
        lane: "manual_create",
        title: created.data?.title,
        seedPayload: {
          basicForm,
        },
      });
      return {
        response: created,
        workflowTaskId: attached.data?.id ?? task.data?.id ?? "",
      };
    },
    onSuccess: async ({ response, workflowTaskId }) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.novels.all });
      if (response.data?.id) {
        const search = new URLSearchParams();
        search.set("stage", "basic");
        if (workflowTaskId) {
          search.set("taskId", workflowTaskId);
        }
        navigate(`${isShortStory ? "/short-stories" : "/novels"}/${response.data.id}/edit?${search.toString()}`);
      }
    },
  });

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{isShortStory ? "创建短故事项目" : "创建小说项目"}</CardTitle>
          <CardDescription>
            {isShortStory
              ? "短故事入口会按更小体量规划，优先保证 2 万到 8 万字以内的完整闭环、章节控量和正文质量，不和长篇小说列表混在一起。"
              : "先把这本书写给谁、靠什么吸引追读、前 30 章要兑现什么定义清楚。这里的设置会直接影响后续主线规划、世界边界、写法建议和 AI 生成行为，创建后仍可继续调整。"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {continueFromNovelId && continuationPrefillQuery.data?.data ? (
            <div className="mb-4 rounded-lg border border-primary/20 bg-primary/5 px-4 py-3 text-sm text-muted-foreground">
              已从《{continuationPrefillQuery.data.data.title}》预装续写来源。你可以直接微调书名和这一部的阶段目标，再进入创建。
            </div>
          ) : null}
          <NovelBasicInfoForm
            basicForm={basicForm}
            genreOptions={genreOptions}
            storyModeOptions={storyModeOptions}
            worldOptions={worldListQuery.data?.data ?? []}
            sourceNovelOptions={sourceNovelOptions}
            sourceKnowledgeOptions={sourceKnowledgeOptions}
            sourceNovelBookAnalysisOptions={sourceNovelBookAnalysisOptions}
            isLoadingSourceNovelBookAnalyses={sourceBookAnalysesQuery.isLoading}
            availableBookAnalysisSections={[...BOOK_ANALYSIS_SECTIONS]}
            onFormChange={(patch) => setBasicForm((prev) => patchNovelBasicForm(prev, patch))}
            onSubmit={() => createNovelMutation.mutate()}
            isSubmitting={createNovelMutation.isPending}
            submitLabel={isShortStory ? "创建并进入短故事" : "创建并进入项目"}
            showPublicationStatus={false}
            framingQuickFill={(
              <BookFramingQuickFillButton
                basicForm={basicForm}
                genreOptions={genreOptions}
                onApplySuggestion={(patch) => setBasicForm((prev) => patchNovelBasicForm(prev, patch))}
              />
            )}
            projectQuickStart={(
              <NovelAutoDirectorDialog
                basicForm={basicForm}
                workflowTaskId={directorWorkflowTaskId}
                restoredTask={restoredWorkflowTask}
                initialOpen={workflowMode === "director"}
                onWorkflowTaskChange={(taskId) => {
                  setDirectorWorkflowTaskId(taskId);
                  setSearchParams((prev) => {
                    const next = new URLSearchParams(prev);
                    next.set("workflowTaskId", taskId);
                    next.set("mode", "director");
                    return next;
                  }, { replace: true });
                }}
                onConfirmed={({ novelId, workflowTaskId, resumeTarget }) => {
                  const search = new URLSearchParams();
                  search.set("stage", resumeTarget?.stage ?? "story_macro");
                  if (workflowTaskId) {
                    search.set("taskId", workflowTaskId);
                  }
                  if (resumeTarget?.chapterId) {
                    search.set("chapterId", resumeTarget.chapterId);
                  }
                  if (resumeTarget?.volumeId) {
                    search.set("volumeId", resumeTarget.volumeId);
                  }
                  navigate(`${isShortStory ? "/short-stories" : "/novels"}/${novelId}/edit?${search.toString()}`);
                }}
              />
            )}
            titleQuickFill={(
              <NovelCreateTitleQuickFill
                basicForm={basicForm}
                onApplyTitle={(title) => setBasicForm((prev) => patchNovelBasicForm(prev, { title }))}
              />
            )}
          />
        </CardContent>
      </Card>
    </div>
  );
}
