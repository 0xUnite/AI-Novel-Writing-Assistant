export type PersistedChapterGenerationState =
  | "planned"
  | "drafted"
  | "reviewed"
  | "repaired"
  | "approved"
  | "published";

export type PersistedChapterStatus =
  | "unplanned"
  | "pending_generation"
  | "generating"
  | "pending_review"
  | "needs_repair"
  | "completed";

export function hasChapterContentText(content?: string | null): boolean {
  return Boolean(content?.trim());
}

export function buildDraftChapterProgress(
  generationState: "drafted" | "repaired",
): {
  generationState: "drafted" | "repaired";
  chapterStatus: "pending_review";
} {
  return {
    generationState,
    chapterStatus: "pending_review",
  };
}

export function buildApprovedChapterProgress(
  generationState: "approved" | "published" = "approved",
): {
  generationState: "approved" | "published";
  chapterStatus: "completed";
} {
  return {
    generationState,
    chapterStatus: "completed",
  };
}

export function buildReviewedChapterProgress(input: {
  hasIssues: boolean;
}): {
  generationState: "reviewed";
  chapterStatus: "needs_repair" | "completed";
} {
  return {
    generationState: "reviewed",
    chapterStatus: input.hasIssues ? "needs_repair" : "completed",
  };
}

export function buildContentEditProgress(input: {
  content?: string | null;
  chapterStatus?: PersistedChapterStatus | null;
}): {
  generationState: PersistedChapterGenerationState;
  chapterStatus: PersistedChapterStatus;
} {
  if (hasChapterContentText(input.content)) {
    return {
      generationState: "drafted",
      chapterStatus: input.chapterStatus ?? "pending_review",
    };
  }
  return {
    generationState: "planned",
    chapterStatus: input.chapterStatus ?? "pending_generation",
  };
}

export function reconcileChapterProgress(input: {
  content?: string | null;
  generationState?: PersistedChapterGenerationState | null;
  chapterStatus?: PersistedChapterStatus | null;
}): {
  generationState: PersistedChapterGenerationState;
  chapterStatus: PersistedChapterStatus;
} {
  const hasContent = hasChapterContentText(input.content);
  let generationState = input.generationState ?? (hasContent ? "drafted" : "planned");

  if (generationState === "planned" && hasContent) {
    generationState = "drafted";
  } else if (generationState !== "planned" && !hasContent) {
    generationState = "planned";
  }

  if (generationState === "approved" || generationState === "published") {
    return buildApprovedChapterProgress(generationState);
  }
  if (generationState === "drafted" || generationState === "reviewed" || generationState === "repaired") {
    return {
      generationState,
      chapterStatus: input.chapterStatus === "needs_repair" ? "needs_repair" : "pending_review",
    };
  }
  if (input.chapterStatus === "generating") {
    return {
      generationState,
      chapterStatus: hasContent ? "pending_review" : "generating",
    };
  }
  if (input.chapterStatus === "pending_generation") {
    return {
      generationState,
      chapterStatus: hasContent ? "pending_review" : "pending_generation",
    };
  }
  return {
    generationState,
    chapterStatus: hasContent ? "pending_review" : (input.chapterStatus ?? "unplanned"),
  };
}
