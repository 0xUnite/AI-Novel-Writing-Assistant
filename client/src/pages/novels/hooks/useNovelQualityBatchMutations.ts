import { useMutation, useQuery, type QueryClient } from "@tanstack/react-query";
import type { LLMProvider } from "@ai-novel/shared/types/llm";
import {
  cancelNovelReviewBatchJob,
  getNovelContinuityProgress,
  getNovelProductionNextAction,
  listNovelReviewBatchJobs,
  startContinuityAuditBatchJob,
  startContinuityRepairBatchJob,
  startQualityRepairBatchJob,
  startQualityReviewBatchJob,
} from "@/api/novel";
import { queryKeys } from "@/api/queryKeys";
import { useEffect, useMemo } from "react";

interface LlmSettings {
  provider?: LLMProvider;
  model?: string;
  temperature?: number;
}

interface UseNovelQualityBatchMutationsArgs {
  id: string;
  llm: LlmSettings;
  pipelineForm: {
    qualityThreshold: number;
  };
  queryClient: QueryClient;
  setPipelineMessage: (value: string) => void;
  invalidateNovelDetail: () => Promise<void>;
}

const ACTIVE_BATCH_JOB_STATUSES = new Set(["queued", "running"]);

function getJobUpdatedAt(job: { updatedAt?: string | null; createdAt?: string | null }): number {
  const updatedAt = job.updatedAt ? Date.parse(job.updatedAt) : Number.NaN;
  if (Number.isFinite(updatedAt)) {
    return updatedAt;
  }
  const createdAt = job.createdAt ? Date.parse(job.createdAt) : Number.NaN;
  return Number.isFinite(createdAt) ? createdAt : 0;
}

function getActiveJobStatusPriority(status?: string | null): number {
  if (status === "running") {
    return 0;
  }
  if (status === "queued") {
    return 1;
  }
  return 2;
}

function pickLatestActiveJob<
  T extends {
    status?: string | null;
    updatedAt?: string | null;
    createdAt?: string | null;
  },
>(jobs: T[] | undefined, predicate: (job: T) => boolean): T | undefined {
  return [...(jobs ?? [])]
    .filter((job) => predicate(job) && ACTIVE_BATCH_JOB_STATUSES.has(job.status ?? ""))
    .sort((left, right) => {
      const statusPriorityDiff = getActiveJobStatusPriority(left.status) - getActiveJobStatusPriority(right.status);
      if (statusPriorityDiff !== 0) {
        return statusPriorityDiff;
      }
      return getJobUpdatedAt(right) - getJobUpdatedAt(left);
    })[0];
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

export function useNovelQualityBatchMutations({
  id,
  llm,
  pipelineForm,
  queryClient,
  setPipelineMessage,
  invalidateNovelDetail,
}: UseNovelQualityBatchMutationsArgs) {
  const continuityProgressQueryKey = queryKeys.novels.continuityProgress(id, pipelineForm.qualityThreshold);
  const productionNextActionQueryKey = queryKeys.novels.productionNextAction(id, pipelineForm.qualityThreshold);
  const reviewBatchJobsQueryKey = queryKeys.novels.reviewBatchJobs(id);

  // 连贯性进度查询
  const continuityProgressQuery = useQuery({
    queryKey: continuityProgressQueryKey,
    queryFn: () => getNovelContinuityProgress(id, pipelineForm.qualityThreshold),
    enabled: Boolean(id),
    refetchInterval: 3000,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
  });

  // 批量任务列表查询
  const reviewBatchJobsQuery = useQuery({
    queryKey: reviewBatchJobsQueryKey,
    queryFn: () => listNovelReviewBatchJobs(id, { limit: 10 }),
    enabled: Boolean(id),
    refetchInterval: (query) => {
      const jobs = (query.state.data as Awaited<ReturnType<typeof listNovelReviewBatchJobs>> | undefined)?.data ?? [];
      const hasActiveJob = jobs.some((job) => ACTIVE_BATCH_JOB_STATUSES.has(job.status ?? ""));
      return hasActiveJob ? 2000 : 8000;
    },
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
  });

  const productionNextActionQuery = useQuery({
    queryKey: productionNextActionQueryKey,
    queryFn: () => getNovelProductionNextAction(id, pipelineForm.qualityThreshold),
    enabled: Boolean(id),
    refetchInterval: (query) => {
      const action = (query.state.data as Awaited<ReturnType<typeof getNovelProductionNextAction>> | undefined)?.data;
      return action?.action?.startsWith("wait_") ? 3000 : 8000;
    },
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
  });

  const activeQualityJob = useMemo(
    () => pickLatestActiveJob(
      reviewBatchJobsQuery.data?.data,
      (job) => job.jobType === "quality_review_all" || job.jobType === "quality_repair_until_pass",
    ),
    [reviewBatchJobsQuery.data?.data],
  );

  const activeContinuityJob = useMemo(
    () => pickLatestActiveJob(
      reviewBatchJobsQuery.data?.data,
      (job) => job.jobType === "continuity_audit" || job.jobType === "continuity_repair_blocked",
    ),
    [reviewBatchJobsQuery.data?.data],
  );
  const hasActiveBatchJob = Boolean(activeQualityJob || activeContinuityJob);

  const refreshBatchState = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: reviewBatchJobsQueryKey }),
      queryClient.invalidateQueries({ queryKey: continuityProgressQueryKey }),
      queryClient.invalidateQueries({ queryKey: productionNextActionQueryKey }),
      invalidateNovelDetail(),
    ]);
  };

  const handleBatchError = async (error: unknown, fallback: string) => {
    setPipelineMessage(getErrorMessage(error, fallback));
    await refreshBatchState();
  };

  useEffect(() => {
    if (!hasActiveBatchJob) {
      return undefined;
    }

    void invalidateNovelDetail();
    const intervalId = window.setInterval(() => {
      void invalidateNovelDetail();
    }, 5000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [
    activeContinuityJob?.id,
    activeQualityJob?.id,
    hasActiveBatchJob,
    invalidateNovelDetail,
  ]);

  const startQualityReviewMutation = useMutation({
    mutationFn: () => startQualityReviewBatchJob(id, {
      provider: llm.provider,
      model: llm.model,
      temperature: llm.temperature,
      threshold: pipelineForm.qualityThreshold,
    }),
    onSuccess: async (response) => {
      setPipelineMessage(response?.message ?? "批量审校任务已启动。");
      await refreshBatchState();
    },
    onError: (error) => handleBatchError(error, "批量审校任务启动失败。"),
  });

  const startFinalizedQualityReviewMutation = useMutation({
    mutationFn: () => startQualityReviewBatchJob(id, {
      provider: llm.provider,
      model: llm.model,
      temperature: llm.temperature,
      threshold: pipelineForm.qualityThreshold,
      includeFinalizedRecheck: true,
    }),
    onSuccess: async (response) => {
      setPipelineMessage(response?.message ?? "已定稿章节复核任务已启动。");
      await refreshBatchState();
    },
    onError: (error) => handleBatchError(error, "已定稿章节复核任务启动失败。"),
  });

  const startQualityRepairMutation = useMutation({
    mutationFn: () => startQualityRepairBatchJob(id, {
      provider: llm.provider,
      model: llm.model,
      temperature: llm.temperature,
      threshold: pipelineForm.qualityThreshold,
    }),
    onSuccess: async (response) => {
      setPipelineMessage(response?.message ?? "批量修复任务已启动。");
      await refreshBatchState();
    },
    onError: (error) => handleBatchError(error, "批量修复任务启动失败。"),
  });

  const startContinuityAuditMutation = useMutation({
    mutationFn: () => startContinuityAuditBatchJob(id, {
      provider: llm.provider,
      model: llm.model,
      temperature: llm.temperature,
      threshold: pipelineForm.qualityThreshold,
      autoRepairBlocked: true,
    }),
    onSuccess: async (response) => {
      setPipelineMessage(response?.message ?? "整体连贯性自动审查任务已启动。");
      await refreshBatchState();
    },
    onError: (error) => handleBatchError(error, "整体连贯性自动审查任务启动失败。"),
  });

  const startContinuityRepairMutation = useMutation({
    mutationFn: () => startContinuityRepairBatchJob(id, {
      provider: llm.provider,
      model: llm.model,
      temperature: llm.temperature,
      threshold: pipelineForm.qualityThreshold,
    }),
    onSuccess: async (response) => {
      setPipelineMessage(response?.message ?? "连贯性修复任务已启动。");
      await refreshBatchState();
    },
    onError: (error) => handleBatchError(error, "连贯性修复任务启动失败。"),
  });

  const cancelBatchJobMutation = useMutation({
    mutationFn: (jobId: string) => cancelNovelReviewBatchJob(id, jobId),
    onSuccess: async () => {
      setPipelineMessage("任务已取消。");
      await refreshBatchState();
    },
    onError: (error) => handleBatchError(error, "任务取消失败。"),
  });

  return {
    continuityProgress: continuityProgressQuery.data?.data,
    isLoadingContinuityProgress: continuityProgressQuery.isLoading,
    reviewBatchJobs: reviewBatchJobsQuery.data?.data ?? [],
    productionNextAction: productionNextActionQuery.data?.data ?? null,
    activeQualityJob,
    activeContinuityJob,
    startQualityReviewMutation,
    startFinalizedQualityReviewMutation,
    startQualityRepairMutation,
    startContinuityAuditMutation,
    startContinuityRepairMutation,
    cancelBatchJobMutation,
  };
}
