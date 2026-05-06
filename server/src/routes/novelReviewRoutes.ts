import type { Router } from "express";
import type { ApiResponse } from "@ai-novel/shared/types/api";
import { z } from "zod";
import { streamToSSE } from "../llm/streaming";
import { AppError } from "../middleware/errorHandler";
import { validate } from "../middleware/validate";
import type { NovelService } from "../services/novel/NovelService";

interface RegisterNovelReviewRoutesInput {
  router: Router;
  novelService: NovelService;
  idParamsSchema: z.ZodType<{ id: string }>;
  chapterParamsSchema: z.ZodType<{ id: string; chapterId: string }>;
  auditIssueParamsSchema: z.ZodType<{ id: string; issueId: string }>;
  reviewSchema: z.ZodTypeAny;
  reviewBatchJobSchema: z.ZodTypeAny;
  repairSchema: z.ZodTypeAny;
}

export function registerNovelReviewRoutes(input: RegisterNovelReviewRoutesInput): void {
  const {
    router,
    novelService,
    idParamsSchema,
    chapterParamsSchema,
    auditIssueParamsSchema,
    reviewSchema,
    reviewBatchJobSchema,
    repairSchema,
  } = input;
  const continuityProgressQuerySchema = z.object({
    threshold: z.coerce.number().int().min(0).max(100).optional(),
  });
  const reviewBatchJobParamsSchema = z.object({
    id: z.string().trim().min(1),
    reviewJobId: z.string().trim().min(1),
  });
  const reviewBatchJobListQuerySchema = z.object({
    jobTypes: z.string().trim().optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
  });
  const forwardReviewBusinessError = (error: unknown, next: (err?: unknown) => void): boolean => {
    if (!(error instanceof Error)) {
      return false;
    }
    if (!/当前已有其他质量\/连贯性后台任务在运行|当前没有待审校章节|当前没有待处理的质量章节|当前有连贯性阻塞章节|当前所有已写章节都已完成连贯性审查|当前没有待修复的连贯性阻塞章节/.test(error.message)) {
      return false;
    }
    next(new AppError(error.message, 400));
    return true;
  };

  router.get(
    "/:id/review-batch-jobs",
    validate({ params: idParamsSchema, query: reviewBatchJobListQuerySchema }),
    async (req, res, next) => {
      try {
        const { id } = req.params as z.infer<typeof idParamsSchema>;
        const { jobTypes, limit } = req.query as z.infer<typeof reviewBatchJobListQuerySchema>;
        const parsedJobTypes = jobTypes
          ? jobTypes
            .split(",")
            .map((item) => item.trim())
            .filter((item): item is "quality_review_all" | "quality_repair_until_pass" | "continuity_audit" | "continuity_repair_blocked" => (
              item === "quality_review_all"
              || item === "quality_repair_until_pass"
              || item === "continuity_audit"
              || item === "continuity_repair_blocked"
            ))
          : undefined;
        const data = await novelService.listReviewBatchJobs(id, {
          jobTypes: parsedJobTypes,
          limit,
        });
        res.status(200).json({
          success: true,
          data,
          message: "Review batch jobs loaded.",
        } satisfies ApiResponse<typeof data>);
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    "/:id/review-batch-jobs/:reviewJobId",
    validate({ params: reviewBatchJobParamsSchema }),
    async (req, res, next) => {
      try {
        const { id, reviewJobId } = req.params as z.infer<typeof reviewBatchJobParamsSchema>;
        const data = await novelService.getReviewBatchJob(id, reviewJobId);
        if (!data) {
          res.status(404).json({
            success: false,
            error: "后台审校任务不存在。",
          } satisfies ApiResponse<null>);
          return;
        }
        res.status(200).json({
          success: true,
          data,
          message: "Review batch job loaded.",
        } satisfies ApiResponse<typeof data>);
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/:id/review-batch-jobs/quality-review",
    validate({ params: idParamsSchema, body: reviewBatchJobSchema }),
    async (req, res, next) => {
      try {
        const { id } = req.params as z.infer<typeof idParamsSchema>;
        const data = await novelService.startQualityReviewJob(id, req.body as any);
        res.status(202).json({
          success: true,
          data,
          message: data.reusedExisting ? "已切回当前质量审校后台任务。" : "Quality review batch job created.",
        } satisfies ApiResponse<typeof data>);
      } catch (error) {
        if (forwardReviewBusinessError(error, next)) {
          return;
        }
        next(error);
      }
    },
  );

  router.post(
    "/:id/review-batch-jobs/quality-repair",
    validate({ params: idParamsSchema, body: reviewBatchJobSchema }),
    async (req, res, next) => {
      try {
        const { id } = req.params as z.infer<typeof idParamsSchema>;
        const data = await novelService.startQualityRepairJob(id, req.body as any);
        res.status(202).json({
          success: true,
          data,
          message: data.reusedExisting
            ? "已切回当前质量修复后台任务。"
            : data.jobType === "quality_review_all"
              ? "当前没有待修复质量章节，已改为启动质量审校。"
              : "质量修复后台任务已启动。",
        } satisfies ApiResponse<typeof data>);
      } catch (error) {
        if (forwardReviewBusinessError(error, next)) {
          return;
        }
        next(error);
      }
    },
  );

  router.post(
    "/:id/review-batch-jobs/continuity-audit",
    validate({ params: idParamsSchema, body: reviewBatchJobSchema }),
    async (req, res, next) => {
      try {
        const { id } = req.params as z.infer<typeof idParamsSchema>;
        const data = await novelService.startContinuityAuditJob(id, req.body as any);
        const autoRepairBlocked = (req.body as { autoRepairBlocked?: boolean } | undefined)?.autoRepairBlocked ?? true;
        res.status(202).json({
          success: true,
          data,
          message: data.reusedExisting
            ? "已切回当前整体连贯性后台任务。"
            : autoRepairBlocked
              ? "整体连贯性自动审查任务已启动。"
              : "Continuity audit batch job created.",
        } satisfies ApiResponse<typeof data>);
      } catch (error) {
        if (forwardReviewBusinessError(error, next)) {
          return;
        }
        next(error);
      }
    },
  );

  router.post(
    "/:id/review-batch-jobs/continuity-repair",
    validate({ params: idParamsSchema, body: reviewBatchJobSchema }),
    async (req, res, next) => {
      try {
        const { id } = req.params as z.infer<typeof idParamsSchema>;
        const data = await novelService.startContinuityRepairJob(id, req.body as any);
        res.status(202).json({
          success: true,
          data,
          message: data.reusedExisting
            ? "已切回当前连贯性修复后台任务。"
            : data.jobType === "continuity_audit"
              ? "当前没有待修复阻塞，已改为继续自动连贯性审查。"
              : "连贯性修复后台任务已启动。",
        } satisfies ApiResponse<typeof data>);
      } catch (error) {
        if (forwardReviewBusinessError(error, next)) {
          return;
        }
        next(error);
      }
    },
  );

  router.post(
    "/:id/review-batch-jobs/:reviewJobId/cancel",
    validate({ params: reviewBatchJobParamsSchema }),
    async (req, res, next) => {
      try {
        const { reviewJobId } = req.params as z.infer<typeof reviewBatchJobParamsSchema>;
        const data = await novelService.cancelReviewBatchJob(reviewJobId);
        res.status(200).json({
          success: true,
          data,
          message: "Review batch job cancelled.",
        } satisfies ApiResponse<typeof data>);
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/:id/chapters/:chapterId/review",
    validate({ params: chapterParamsSchema, body: reviewSchema }),
    async (req, res, next) => {
      try {
        const { id, chapterId } = req.params as z.infer<typeof chapterParamsSchema>;
        const data = await novelService.reviewChapter(id, chapterId, req.body as any);
        res.status(200).json({
          success: true,
          data,
          message: "Chapter review completed.",
        } satisfies ApiResponse<typeof data>);
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/:id/chapters/:chapterId/audit/continuity",
    validate({ params: chapterParamsSchema, body: reviewSchema }),
    async (req, res, next) => {
      try {
        const { id, chapterId } = req.params as z.infer<typeof chapterParamsSchema>;
        const data = await novelService.auditChapter(id, chapterId, "continuity", req.body as any);
        res.status(200).json({
          success: true,
          data,
          message: "Continuity audit completed.",
        } satisfies ApiResponse<typeof data>);
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/:id/chapters/:chapterId/audit/character",
    validate({ params: chapterParamsSchema, body: reviewSchema }),
    async (req, res, next) => {
      try {
        const { id, chapterId } = req.params as z.infer<typeof chapterParamsSchema>;
        const data = await novelService.auditChapter(id, chapterId, "character", req.body as any);
        res.status(200).json({
          success: true,
          data,
          message: "Character audit completed.",
        } satisfies ApiResponse<typeof data>);
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/:id/chapters/:chapterId/audit/plot",
    validate({ params: chapterParamsSchema, body: reviewSchema }),
    async (req, res, next) => {
      try {
        const { id, chapterId } = req.params as z.infer<typeof chapterParamsSchema>;
        const data = await novelService.auditChapter(id, chapterId, "plot", req.body as any);
        res.status(200).json({
          success: true,
          data,
          message: "Plot audit completed.",
        } satisfies ApiResponse<typeof data>);
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/:id/chapters/:chapterId/audit/full",
    validate({ params: chapterParamsSchema, body: reviewSchema }),
    async (req, res, next) => {
      try {
        const { id, chapterId } = req.params as z.infer<typeof chapterParamsSchema>;
        const data = await novelService.auditChapter(id, chapterId, "full", req.body as any);
        res.status(200).json({
          success: true,
          data,
          message: "Full audit completed.",
        } satisfies ApiResponse<typeof data>);
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    "/:id/chapters/:chapterId/audit-reports",
    validate({ params: chapterParamsSchema }),
    async (req, res, next) => {
      try {
        const { id, chapterId } = req.params as z.infer<typeof chapterParamsSchema>;
        const data = await novelService.listChapterAuditReports(id, chapterId);
        res.status(200).json({
          success: true,
          data,
          message: "Audit reports loaded.",
        } satisfies ApiResponse<typeof data>);
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    "/:id/continuity-progress",
    validate({ params: idParamsSchema, query: continuityProgressQuerySchema }),
    async (req, res, next) => {
      try {
        const { id } = req.params as z.infer<typeof idParamsSchema>;
        const { threshold } = req.query as z.infer<typeof continuityProgressQuerySchema>;
        const thresholdValue = typeof threshold === "number"
          ? threshold
          : Number.parseInt(String(threshold ?? 75), 10);
        const data = await novelService.getContinuityAuditProgress(id, thresholdValue);
        res.status(200).json({
          success: true,
          data,
          message: "Continuity progress loaded.",
        } satisfies ApiResponse<typeof data>);
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    "/:id/production-next-action",
    validate({ params: idParamsSchema, query: continuityProgressQuerySchema }),
    async (req, res, next) => {
      try {
        const { id } = req.params as z.infer<typeof idParamsSchema>;
        const { threshold } = req.query as z.infer<typeof continuityProgressQuerySchema>;
        const thresholdValue = typeof threshold === "number"
          ? threshold
          : Number.parseInt(String(threshold ?? 75), 10);
        const data = await novelService.getProductionNextAction(id, thresholdValue);
        res.status(200).json({
          success: true,
          data,
          message: "Production next action loaded.",
        } satisfies ApiResponse<typeof data>);
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/:id/audit-issues/:issueId/resolve",
    validate({ params: auditIssueParamsSchema }),
    async (req, res, next) => {
      try {
        const { id, issueId } = req.params as z.infer<typeof auditIssueParamsSchema>;
        const data = await novelService.resolveAuditIssues(id, [issueId]);
        res.status(200).json({
          success: true,
          data,
          message: "Audit issue resolved.",
        } satisfies ApiResponse<typeof data>);
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/:id/chapters/:chapterId/repair",
    validate({ params: chapterParamsSchema, body: repairSchema }),
    async (req, res, next) => {
      try {
        const { id, chapterId } = req.params as z.infer<typeof chapterParamsSchema>;
        const { stream, onDone } = await novelService.createRepairStream(
          id,
          chapterId,
          req.body as any,
        );
        await streamToSSE(res, stream, onDone);
      } catch (error) {
        next(error);
      }
    },
  );

  router.get("/:id/quality-report", validate({ params: idParamsSchema }), async (req, res, next) => {
    try {
      const { id } = req.params as z.infer<typeof idParamsSchema>;
      const data = await novelService.getQualityReport(id);
      res.status(200).json({
        success: true,
        data,
        message: "Quality report loaded.",
      } satisfies ApiResponse<typeof data>);
    } catch (error) {
      next(error);
    }
  });
}
