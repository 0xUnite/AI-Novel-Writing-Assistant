import { trackEntityOwnership } from "./EntityOwnershipTracker";
import {
  getNovelRuleProfile,
  type NovelItemTrackingRule,
  type NovelRuleConstraint,
} from "../novel/config/novelRuleProfiles";

interface AuditReportIssueInput {
  severity: "low" | "medium" | "high" | "critical";
  code: string;
  description: string;
  evidence: string;
  fixSuggestion: string;
}

export interface CharacterContinuityAuditResult {
  profileId: string | null;
  profileTitle: string | null;
  issues: AuditReportIssueInput[];
  summary: string;
}

function compactText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}

function buildPatternIssues(
  content: string,
  sectionLabel: string,
  constraint: NovelRuleConstraint | NovelItemTrackingRule,
): AuditReportIssueInput[] {
  const issues: AuditReportIssueInput[] = [];
  for (const rule of constraint.forbiddenPatterns ?? []) {
    const match = rule.pattern.exec(content);
    if (!match) {
      continue;
    }
    issues.push({
      severity: rule.severity,
      code: rule.code,
      description: rule.description,
      evidence: `${sectionLabel} 命中：${compactText(match[0], 120)}`,
      fixSuggestion: rule.fixSuggestion,
    });
  }
  return issues;
}

function buildItemTrackingIssues(
  content: string,
  itemRules: NovelItemTrackingRule[],
): AuditReportIssueInput[] {
  if (itemRules.length === 0) {
    return [];
  }
  const trackedItems = itemRules.flatMap((rule) => [rule.item, ...(rule.aliases ?? [])]);
  const ownership = trackEntityOwnership(content, trackedItems);
  return ownership.ambiguities.flatMap((ambiguity) => {
    const matchedRule = itemRules.find((rule) => (
      rule.item === ambiguity.item || (rule.aliases ?? []).includes(ambiguity.item)
    ));
    if (!matchedRule) {
      return [];
    }
    return [{
      severity: "medium" as const,
      code: `profile_item_ownership_${matchedRule.item}`,
      description: `${matchedRule.item} 的当前持有者不够清晰，容易破坏该线索的延续性。`,
      evidence: compactText(ambiguity.evidence, 120),
      fixSuggestion: matchedRule.rules[0] ?? `补写 ${matchedRule.item} 当前在谁手里，以及它为何出现在当前场景。`,
    }];
  });
}

export function auditCharacterContinuity(input: {
  novelId: string;
  content: string;
}): CharacterContinuityAuditResult {
  const profile = getNovelRuleProfile(input.novelId);
  if (!profile) {
    return {
      profileId: null,
      profileTitle: null,
      issues: [],
      summary: "No novel-specific profile found; global rules only.",
    };
  }

  const issues = [
    ...profile.characterIdentityConstraints.flatMap((constraint) => buildPatternIssues(input.content, constraint.label, constraint)),
    ...profile.relationshipProgression.flatMap((constraint) => buildPatternIssues(input.content, constraint.label, constraint)),
    ...profile.worldSettingContinuity.flatMap((constraint) => buildPatternIssues(input.content, constraint.label, constraint)),
    ...profile.foreshadowingRules.flatMap((constraint) => buildPatternIssues(input.content, constraint.label, constraint)),
    ...profile.itemClueTracking.flatMap((constraint) => buildPatternIssues(input.content, constraint.item, constraint)),
    ...buildItemTrackingIssues(input.content, profile.itemClueTracking),
  ].filter((issue, index, items) => (
    items.findIndex((entry) => entry.code === issue.code && entry.evidence === issue.evidence) === index
  ));

  return {
    profileId: profile.novelId,
    profileTitle: profile.title,
    issues,
    summary: issues.length > 0
      ? `Applied profile ${profile.title}; ${issues.length} issue(s) detected.`
      : `Applied profile ${profile.title}; no profile-specific continuity issues detected.`,
  };
}
