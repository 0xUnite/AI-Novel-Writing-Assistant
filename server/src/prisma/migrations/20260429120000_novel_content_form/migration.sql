ALTER TABLE "Novel" ADD COLUMN "contentForm" TEXT NOT NULL DEFAULT 'novel';

CREATE INDEX "Novel_contentForm_idx" ON "Novel"("contentForm");
