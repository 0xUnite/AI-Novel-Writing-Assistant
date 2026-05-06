const SERVER_RESTART_RECOVERY_MESSAGE = "质量/连贯性后台任务因服务重启中断，正在尝试恢复。";
const STALE_REVIEW_BATCH_RECOVERY_MESSAGE = "质量/连贯性后台任务心跳超时，正在尝试恢复。";
const DEFAULT_WATCHDOG_INTERVAL_MS = 60_000;
const DEFAULT_STALE_THRESHOLD_MS = 3 * 60 * 1000;

interface ReviewBatchRecoveryPort {
  listPendingCancellationReviewBatchJobs(): Promise<Array<{ id: string; status: string }>>;
  listRecoverableReviewBatchJobs(): Promise<Array<{ id: string; status: string }>>;
  listStaleRecoverableReviewBatchJobs(cutoff: Date): Promise<Array<{ id: string; status: string }>>;
  markReviewBatchJobCancelled(jobId: string): Promise<void>;
  markReviewBatchJobFailed(jobId: string, message: string): Promise<void>;
}

interface ReviewBatchResumePort {
  resumeReviewBatchJob(jobId: string): Promise<void>;
}

function createReviewBatchService(): ReviewBatchRecoveryPort & ReviewBatchResumePort {
  const { NovelCoreReviewBatchService } = require("./novelCoreReviewBatchService") as typeof import("./novelCoreReviewBatchService");
  return new NovelCoreReviewBatchService();
}

export class NovelReviewBatchRuntimeService {
  private watchdogTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly reviewBatchService: ReviewBatchRecoveryPort & ReviewBatchResumePort = createReviewBatchService(),
  ) {}

  async resumePendingReviewBatchJobs(): Promise<void> {
    const pendingCancellationRows = await this.reviewBatchService.listPendingCancellationReviewBatchJobs();
    await this.finalizeCancelledJobs(pendingCancellationRows);
    const rows = await this.reviewBatchService.listRecoverableReviewBatchJobs();
    await this.recoverJobs(rows, SERVER_RESTART_RECOVERY_MESSAGE);
  }

  async recoverStaleReviewBatchJobs(now = new Date(), staleThresholdMs = DEFAULT_STALE_THRESHOLD_MS): Promise<void> {
    const pendingCancellationRows = await this.reviewBatchService.listPendingCancellationReviewBatchJobs();
    await this.finalizeCancelledJobs(pendingCancellationRows);
    const cutoff = new Date(now.getTime() - Math.max(10_000, staleThresholdMs));
    const rows = await this.reviewBatchService.listStaleRecoverableReviewBatchJobs(cutoff);
    await this.recoverJobs(rows, STALE_REVIEW_BATCH_RECOVERY_MESSAGE);
  }

  startWatchdog(input: {
    intervalMs?: number;
    staleThresholdMs?: number;
  } = {}): void {
    if (this.watchdogTimer) {
      return;
    }
    const intervalMs = Math.max(15_000, input.intervalMs ?? DEFAULT_WATCHDOG_INTERVAL_MS);
    const staleThresholdMs = Math.max(intervalMs * 2, input.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS);
    this.watchdogTimer = setInterval(() => {
      void this.recoverStaleReviewBatchJobs(new Date(), staleThresholdMs).catch((error) => {
        console.warn("Failed to recover stale novel review batch jobs.", error);
      });
    }, intervalMs);
    this.watchdogTimer.unref?.();
  }

  stopWatchdog(): void {
    if (!this.watchdogTimer) {
      return;
    }
    clearInterval(this.watchdogTimer);
    this.watchdogTimer = null;
  }

  private async recoverJobs(
    rows: Array<{ id: string; status: string }>,
    recoveryMessage: string,
  ): Promise<void> {
    for (const row of rows) {
      try {
        await this.reviewBatchService.resumeReviewBatchJob(row.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : "质量/连贯性后台任务恢复失败。";
        await this.reviewBatchService.markReviewBatchJobFailed(row.id, `${recoveryMessage} 恢复失败：${message}`);
      }
    }
  }

  private async finalizeCancelledJobs(rows: Array<{ id: string; status: string }>): Promise<void> {
    for (const row of rows) {
      try {
        await this.reviewBatchService.markReviewBatchJobCancelled(row.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : "质量/连贯性后台任务取消收尾失败。";
        await this.reviewBatchService.markReviewBatchJobFailed(row.id, `${SERVER_RESTART_RECOVERY_MESSAGE} 取消收尾失败：${message}`);
      }
    }
  }
}
