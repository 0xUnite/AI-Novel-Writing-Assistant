import type { GenerationContextPackage } from "@ai-novel/shared/types/chapterRuntime";
import type { AuditType, QualityScore } from "@ai-novel/shared/types/novel";
import { analyzeEndingStrategy, measureEndingSimilarity, type EndingStrategySample } from "./EndingStrategyAnalyzer";
import { trackEntityOwnership } from "./EntityOwnershipTracker";
import { validateTransition } from "./TransitionValidator";

export interface AuditReportIssueInput {
  severity: "low" | "medium" | "high" | "critical";
  code: string;
  description: string;
  evidence: string;
  fixSuggestion: string;
}

export interface MutableAuditReportInput {
  auditType: AuditType;
  overallScore?: number;
  summary?: string;
  issues: AuditReportIssueInput[];
}

export interface ChapterTransitionAuditOptions {
  novelTitle?: string | null;
  recentEndingSamples?: EndingStrategySample[];
}

const OPENING_SLICE_LENGTH = 320;
const EXPLICIT_RESET_REGEX = /(次日|翌日|第二天|几天后|数日后|当天|当晚|清晨|凌晨|早上|上午|中午|下午|傍晚|晚上|深夜|九月|十月|十一月|十二月|一月|二月|三月|四月|五月|六月|七月|八月|与此同时|另一边|另一头|回到|再回到)/;
const BRIDGE_MARKER_REGEX = /(第二天一早|第二天早上|第二天早晨|次日一早|头天|头一天|隔天|昨晚|昨夜|一夜|刚才|刚刚|随后|接着|一路上|按计划|照计划|因为|为了|带着|揣着|想着|记着|离开现场|出门后|从[^。！？]{0,12}出来|去找|赶到|来到|回宿舍的时候|从教学楼方向)/;
const WEAK_FRAGMENT_SET = new Set(["主角", "自己", "现在", "今天", "明天", "时候", "事情", "然后", "一个", "没有", "只是", "已经", "他们", "她们", "我们", "你们", "有人"]);
const FORWARD_EXIT_REGEX = /(推开门|走进[^。！？]{0,12}(阳光|校园|门外)|走向[^。！？]{0,12}(校门|门口|路口|校园)|迈开步子|迈开脚步|出了[^。！？]{0,12}(门|宿舍|房间|楼)|离开[^。！？]{0,12}(宿舍|房间|屋子)|先去找)/;
const INTERIOR_REWIND_REGEX = /(走廊里|楼道里|顺着楼梯|宿舍里|宿舍床上|床铺上|床上|屋里|房间里|教室里|窗前|床头|刚从宿舍出来)/;
const FUTURE_EVENT_TAIL_REGEX = /(明天|接下来|下一步|第一步|现在|立刻|马上|必须|需要|打算|准备|决定|先).{0,36}(去|见|找|查|盯|问|谈|拿|交|赶|到|回|送|拦|联系|确认|处理|面对)/;
const EVENT_PROGRESS_BRIDGE_REGEX = /(赶到|来到|到了|见到|找到|联系|拨通|推开|敲开|照着|按计划|带着|想着|记着|继续|接着|随后|那件事|这一步|这个决定)/;
const SLEEP_OR_NIGHT_TAIL_REGEX = /(闭上眼|睡|睡意|失眠|夜色|深夜|月光|天黑|熄灯|躺在|床上|翻身|一夜|窗外的天已经.*暗)/;
const NEXT_TIME_OPENING_REGEX = /^(次日|翌日|第二天|清晨|凌晨|早上|上午|天刚亮|天刚蒙蒙亮|第二天一早)/;
const TIME_BRIDGE_REGEX = /(一夜|昨晚|昨夜|夜里|没睡|睡不着|醒来|睁开眼|带着|想着|记着|还在|仍然|压在|那件事|那个问题|余温|紧迫感)/;
const EMOTION_TAIL_REGEX = /(愤怒|恐惧|忐忑|期待|不安|担心|紧迫感|压力|威胁|风险|放不下|意识到|想起|惦记|心里|眼神|发抖|惨白|出事|不够用)/;
const EMOTION_OPENING_REGEX = /(愤怒|恐惧|忐忑|期待|不安|担心|紧迫感|压力|威胁|风险|放不下|还在|仍然|记着|想着|心里|眼神|出事|不够用)/;
const UNRESOLVED_TAIL_REGEX = /(信号|记录|异常|裂缝|窗口|倒计时|同步|紊乱|钥匙|门|答案|问题|等待|闪烁|沉默|不知道|意味着什么|出事|威胁|风险|危险|谁|什么|为什么)/;
const GENERIC_BRIDGE_REGEX = /(信号|记录|异常|裂缝|窗口|倒计时|同步|紊乱|钥匙|门|答案|问题|等待|昨夜|昨晚|刚才|刚刚|仍然|还在|记着|想着|压着|带着|因为|随后|接着|第二天|清晨|醒来|睁开眼|那件事|那个)/;
const DEEP_ROUTE_TAIL_REGEX = /(电梯井|井道|向下|地下|负二层|维护通道|垂直通道|旧接口|中继站|隐藏路径|维护层|通道的门锁)/;
const WARD_OR_EARLIER_OPENING_REGEX = /(病房|病床|床上|床铺|被子|床单|门锁|药车|睡眠状态|天花板|枕头)/;
const RETURN_BRIDGE_REGEX = /(回到|返回|折返|撤回|重新躺回|沿着.*回|穿过.*回|退回|绕回|撤离|回撤|复位)/;
const BED_OR_PILL_TAIL_REGEX = /(躺在床上|掌心握着.{0,12}药丸|药丸.{0,20}纹路|白噪.{0,24}淹没|闭上眼睛.{0,18}解析|纹路.{0,24}淹没)/;
const DOOR_LOCK_OPENING_REGEX = /(手[^。！？]{0,16}(按|触到|贴上)[^。！？]{0,16}门锁|门锁的金属|病房门锁)/;
const BED_TO_DOOR_BRIDGE_REGEX = /(数了|等到|等[^。！？]{0,24}才|才把|撑起|坐起|起身|走到|移向|重新|随后|接着)/;
const FORWARD_PUSH_ACTION_REGEX = /(继续|接着|来到|赶到|找到|联系|拨通|收到|发现|看见|听见|问|说|递给|交给|决定|答应|拒绝|安排|对视|开口)/;
const FORWARD_PUSH_INFO_REGEX = /(发现|原来|竟然|才知道|消息|电话|短信|纸条|资料|线索|证据|名字|地址|号码|真相|新的|变化|多了一条|确认)/;
const RELATION_SHIFT_REGEX = /(语气|目光|态度|沉默|缓和|僵住|靠近|疏远|信任|怀疑|答应|拒绝|和解|翻脸)/;
const DEFAULT_TRACKED_ITEMS = ["名片", "文件", "手机", "钥匙", "信封"];

function normalizeText(value: string | null | undefined): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function compactText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}

function splitSentences(value: string): string[] {
  return normalizeText(value)
    .split(/(?<=[。！？])/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function extractOpening(content: string, maxLength = OPENING_SLICE_LENGTH): string {
  return normalizeText(content).slice(0, maxLength);
}

function getBridge(contextPackage: GenerationContextPackage | undefined) {
  return contextPackage?.chapterBridge ?? contextPackage?.chapterWriteContext?.chapterBridge ?? null;
}

function buildFactFragments(fact: string): string[] {
  const normalized = normalizeText(fact).replace(/[“”"'‘’]/g, "");
  if (!normalized) {
    return [];
  }
  const fragments = [
    normalized,
    normalized.slice(0, 10),
    normalized.slice(-10),
    normalized.slice(0, 8),
    normalized.slice(-8),
    normalized.slice(0, 6),
    normalized.slice(-6),
    normalized.slice(0, 4),
    normalized.slice(-4),
    normalized.slice(-3),
    normalized.slice(-2),
  ];
  if (!/^[他她它我你]/.test(normalized)) {
    fragments.push(normalized.slice(0, 3), normalized.slice(0, 2));
  }
  return Array.from(new Set(fragments
    .map((item) => normalizeText(item))
    .filter((item) => item.length >= 2 && !WEAK_FRAGMENT_SET.has(item))));
}

function hasCarryOverOverlap(bridgeFacts: string[], opening: string): boolean {
  const openingText = normalizeText(opening);
  return bridgeFacts
    .flatMap((fact) => buildFactFragments(fact))
    .some((fragment) => openingText.includes(fragment));
}

function buildEvidence(previousTail: string, opening: string): string {
  return [
    `上一章尾声：${compactText(previousTail, 100)}`,
    `本章开头：${compactText(opening, 100)}`,
  ].join(" | ");
}

function uniqueIssues(issues: AuditReportIssueInput[]): AuditReportIssueInput[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    if (seen.has(issue.code)) {
      return false;
    }
    seen.add(issue.code);
    return true;
  });
}

function getOpeningParagraphWindow(content: string): string {
  const paragraphs = String(content ?? "")
    .split(/\n{2,}/g)
    .map((item) => item.trim())
    .filter(Boolean);
  if (paragraphs.length >= 2) {
    return normalizeText(paragraphs.slice(0, 2).join("\n"));
  }
  const sentences = splitSentences(content).slice(0, 4);
  return sentences.join("");
}

function hasForwardPush(openingWindow: string): boolean {
  return FORWARD_PUSH_ACTION_REGEX.test(openingWindow)
    || FORWARD_PUSH_INFO_REGEX.test(openingWindow)
    || RELATION_SHIFT_REGEX.test(openingWindow)
    || /“[^”]{2,}”/.test(openingWindow);
}

function detectFalseContinuityRestatement(
  contextPackage: GenerationContextPackage | undefined,
  content: string,
): AuditReportIssueInput | null {
  const bridge = getBridge(contextPackage);
  if (!bridge) {
    return null;
  }
  const openingWindow = getOpeningParagraphWindow(content);
  if (!openingWindow) {
    return null;
  }
  const referenceSentences = [
    bridge.lastSentence,
    ...(bridge.lastTenSentences ?? []).slice(-3),
    bridge.tailExcerpt,
  ].map((item) => normalizeText(item)).filter(Boolean);
  const maxSimilarity = referenceSentences.reduce((max, reference) => (
    Math.max(max, measureEndingSimilarity(reference, openingWindow))
  ), 0);
  const normalizedOpening = normalizeText(openingWindow);
  const sameLeadingPhrase = referenceSentences.some((reference) => (
    normalizedOpening.startsWith(reference.slice(0, 10)) || reference.startsWith(normalizedOpening.slice(0, 10))
  ));
  if ((!sameLeadingPhrase && maxSimilarity <= 0.68) || hasForwardPush(openingWindow)) {
    return null;
  }
  return {
    severity: "high",
    code: "continuity_false_bridge_restatement",
    description: "本章开头虽然回扣了上一章尾声，但前 1-2 段基本停留在同义复述，没有把剧情往前推。",
    evidence: `开头相似度 ${maxSimilarity.toFixed(2)}；上一章尾声=${compactText(bridge.lastSentence || bridge.tailExcerpt, 80)} | 本章开头=${compactText(openingWindow, 100)}`,
    fixSuggestion: "在开头第一段就加入新动作、新互动、新信息或关系变化，避免只换一种说法复述上一章最后一句。",
  };
}

function buildOwnershipIssues(
  contextPackage: GenerationContextPackage | undefined,
  content: string,
): AuditReportIssueInput[] {
  const bridge = getBridge(contextPackage);
  const trackedItems = Array.from(new Set([
    ...DEFAULT_TRACKED_ITEMS,
    ...(bridge?.keyItems ?? []),
  ]));
  const ownership = trackEntityOwnership(content, trackedItems);
  return ownership.ambiguities.slice(0, 2).map((ambiguity) => ({
    severity: "medium",
    code: `continuity_item_ownership_${ambiguity.item}`,
    description: `${ambiguity.item} 的当前持有人不够明确，可能导致跨章道具归属断线。`,
    evidence: compactText(ambiguity.evidence, 120),
    fixSuggestion: `补写 ${ambiguity.item} 现在在谁手里、何时转手，以及人物为什么会在当前场景使用它。`,
  }));
}

export function validateEndingDiversity(
  content: string,
  recentEndingSamples: EndingStrategySample[] = [],
): AuditReportIssueInput[] {
  const analysis = analyzeEndingStrategy(content, recentEndingSamples);
  const issues: AuditReportIssueInput[] = [];
  if (analysis.repeatedPhraseRisk) {
    issues.push({
      severity: "high",
      code: "continuity_ending_phrase_repetition",
      description: "章节收尾出现了重复模板句或与近几章结尾过于相似，容易形成固定化闭章手法。",
      evidence: analysis.matchedBannedPhrase
        ? `命中禁用收尾短语：${analysis.matchedBannedPhrase} | 当前结尾：${compactText(analysis.endingSentence, 100)}`
        : `当前结尾与近章结尾相似度 ${analysis.maxSimilarity.toFixed(2)} | 当前结尾：${compactText(analysis.endingSentence, 100)}`,
      fixSuggestion: "改写最后一句，换成更贴合本章结果的具体决策、动作延续、完成互动、平静收束或情绪回响，不要套用固定闭章模板。",
    });
  }
  if (analysis.repeatedFunctionRisk) {
    issues.push({
      severity: analysis.endingType === "suspense" ? "high" : "medium",
      code: "continuity_ending_type_repetition",
      description: "近几章结尾功能重复过多，收尾类型缺乏变化。",
      evidence: `当前结尾类型=${analysis.endingType} | 最近结尾类型=${analysis.recentEndingTypes.join(", ") || "none"}`,
      fixSuggestion: "调整本章结尾功能，优先考虑决策、行动延续、完成互动、平静收场或情绪回响；悬念只在真正需要时使用。",
    });
  }
  return issues;
}

export function detectChapterOpeningJumpCut(
  contextPackage: GenerationContextPackage | undefined,
  content: string,
): AuditReportIssueInput | null {
  const bridge = getBridge(contextPackage);
  if (!bridge) {
    return null;
  }
  const opening = extractOpening(content);
  const openingLead = opening.slice(0, 90);
  if (!opening || !EXPLICIT_RESET_REGEX.test(openingLead)) {
    return null;
  }
  const transition = validateTransition({ opening: openingLead });
  if (transition.valid && (transition.transitionType === "time-shift" || transition.transitionType === "location-shift")) {
    return null;
  }
  if (BRIDGE_MARKER_REGEX.test(opening) || hasCarryOverOverlap(bridge.carryOverFacts, opening)) {
    return null;
  }
  return {
    severity: "high",
    code: "continuity_opening_jump_cut",
    description: "本章开头直接切入新的时间或场景，但没有交代如何承接上一章结尾的动作、地点或压力。",
    evidence: buildEvidence(bridge.tailExcerpt, opening),
    fixSuggestion: "在本章开头先补足过桥，让读者看清上一章尾声如何过渡到当前场景，并延续上一章留下的决策、风险或悬念。",
  };
}

export function detectChapterOpeningSceneRewind(
  contextPackage: GenerationContextPackage | undefined,
  content: string,
): AuditReportIssueInput | null {
  const bridge = getBridge(contextPackage);
  if (!bridge) {
    return null;
  }
  const tail = normalizeText(bridge.tailExcerpt);
  const opening = extractOpening(content);
  const openingLead = opening.slice(0, 100);
  if (!tail || !opening || !FORWARD_EXIT_REGEX.test(tail) || !INTERIOR_REWIND_REGEX.test(openingLead)) {
    return null;
  }
  if (BRIDGE_MARKER_REGEX.test(openingLead)) {
    return null;
  }
  return {
    severity: "high",
    code: "continuity_opening_scene_rewind",
    description: "上一章尾声已经把人物推进到更靠后的场景节点，但本章开头又退回到更早的楼道、房间或出门过程，形成回卷式断层。",
    evidence: buildEvidence(bridge.tailExcerpt, opening),
    fixSuggestion: "把本章开头改成紧接上一章尾声的下一步动作；如果确实需要补写此前过程，就应回收进上一章，而不是在新章开头倒退。",
  };
}

export function detectChapterTransitionIssues(
  contextPackage: GenerationContextPackage | undefined,
  content: string,
  options: ChapterTransitionAuditOptions = {},
): AuditReportIssueInput[] {
  const bridge = getBridge(contextPackage);
  const issues: AuditReportIssueInput[] = [];
  const opening = extractOpening(content);

  if (bridge && opening) {
    const jumpCut = detectChapterOpeningJumpCut(contextPackage, content);
    const rewind = detectChapterOpeningSceneRewind(contextPackage, content);
    const falseRestatement = detectFalseContinuityRestatement(contextPackage, content);
    if (jumpCut) {
      issues.push(jumpCut);
    }
    if (rewind) {
      issues.push(rewind);
    }
    if (falseRestatement) {
      issues.push(falseRestatement);
    }

    const tail = normalizeText(bridge.tailExcerpt);
    if (FUTURE_EVENT_TAIL_REGEX.test(tail)
      && !EVENT_PROGRESS_BRIDGE_REGEX.test(opening.slice(0, 160))
      && !hasCarryOverOverlap(bridge.carryOverFacts, opening)) {
      issues.push({
        severity: "high",
        code: "continuity_event_progress_gap",
        description: "上一章结尾已经给出下一步行动或见人目标，但本章开头没有先写到达、见到、联系或继续执行该动作。",
        evidence: buildEvidence(bridge.tailExcerpt, opening),
        fixSuggestion: "在本章开头 1-2 句话中先承接上一章的行动目标，写清人物如何抵达、见到或继续推进，再展开本章新事件。",
      });
    }

    if (SLEEP_OR_NIGHT_TAIL_REGEX.test(tail)
      && NEXT_TIME_OPENING_REGEX.test(opening)
      && !TIME_BRIDGE_REGEX.test(opening.slice(0, 180))
      && !hasCarryOverOverlap(bridge.carryOverFacts, opening)) {
      issues.push({
        severity: "high",
        code: "continuity_time_bridge_missing",
        description: "上一章以夜晚、睡前或强情绪收束，本章直接跳到次日/清晨，但没有交代夜间情绪、醒来状态或压力如何延续。",
        evidence: buildEvidence(bridge.tailExcerpt, opening),
        fixSuggestion: "补写一两句过夜承接，例如一夜未眠、醒来仍记着上一章压力，或说明跳时原因。",
      });
    }

    if (EMOTION_TAIL_REGEX.test(tail)
      && !EMOTION_OPENING_REGEX.test(opening.slice(0, 180))
      && !hasCarryOverOverlap(bridge.carryOverFacts, opening)
      && EXPLICIT_RESET_REGEX.test(opening.slice(0, 90))) {
      issues.push({
        severity: "high",
        code: "continuity_emotion_state_gap",
        description: "上一章结尾留下明显情绪、压力或人物牵挂，本章开头却像无事发生一样切到新场景。",
        evidence: buildEvidence(bridge.tailExcerpt, opening),
        fixSuggestion: "让本章开头先承接上一章情绪状态，再进入新动作，避免角色心理断线。",
      });
    }

    if (UNRESOLVED_TAIL_REGEX.test(tail)
      && !GENERIC_BRIDGE_REGEX.test(opening.slice(0, 220))
      && !hasCarryOverOverlap(bridge.carryOverFacts, opening)) {
      issues.push({
        severity: "high",
        code: "continuity_unresolved_tail_not_carried",
        description: "上一章结尾留下了明确信号、异常、疑问或风险，但本章开头没有先接住该未解压力，形成悬念断线。",
        evidence: buildEvidence(bridge.tailExcerpt, opening),
        fixSuggestion: "在本章开头第一段先回扣上一章尾声的具体信号、异常、疑问或风险，再进入新的日常/场景推进。",
      });
    }

    if (DEEP_ROUTE_TAIL_REGEX.test(tail)
      && WARD_OR_EARLIER_OPENING_REGEX.test(opening.slice(0, 180))
      && !RETURN_BRIDGE_REGEX.test(opening.slice(0, 220))) {
      issues.push({
        severity: "high",
        code: "continuity_location_regression",
        description: "上一章尾声已经推进到地下、井道、维护通道或旧接口等更深位置，但本章开头回到病房、床铺、药车或门锁附近，没有交代人物如何折返。",
        evidence: buildEvidence(bridge.tailExcerpt, opening),
        fixSuggestion: "在本章开头补足折返、撤回、回到病房或继续留在维护通道的过渡；不能直接从地下/维护路径回卷到更早场景。",
      });
    }

    if (BED_OR_PILL_TAIL_REGEX.test(tail)
      && DOOR_LOCK_OPENING_REGEX.test(opening.slice(0, 180))
      && !BED_TO_DOOR_BRIDGE_REGEX.test(opening.slice(0, 220))) {
      issues.push({
        severity: "high",
        code: "continuity_bed_to_door_bridge_missing",
        description: "上一章尾声停在床上、药丸或白噪解析状态，本章开头直接切到门锁动作，缺少起身、等待或移动过桥。",
        evidence: buildEvidence(bridge.tailExcerpt, opening),
        fixSuggestion: "在开头先写清人物如何从原地恢复、等待窗口并移动到门边，再进入门锁或走廊行动。",
      });
    }
  }

  issues.push(...buildOwnershipIssues(contextPackage, content));
  issues.push(...validateEndingDiversity(content, options.recentEndingSamples ?? []));

  return uniqueIssues(issues);
}

export function applyChapterOpeningJumpCutPenalty(score: QualityScore): QualityScore {
  return {
    coherence: Math.min(score.coherence, 68),
    repetition: score.repetition,
    pacing: Math.min(score.pacing, 72),
    voice: score.voice,
    engagement: Math.min(score.engagement, 74),
    overall: Math.min(score.overall, 70),
  };
}

export function applyChapterTransitionPenalty(score: QualityScore, issues: AuditReportIssueInput[]): QualityScore {
  if (issues.length === 0) {
    return score;
  }
  const hasCritical = issues.some((issue) => issue.severity === "critical");
  const hasHigh = issues.some((issue) => issue.severity === "high");
  if (!hasCritical && !hasHigh) {
    return {
      ...score,
      coherence: Math.min(score.coherence, 76),
      overall: Math.min(score.overall, 78),
    };
  }
  const cap = hasCritical ? 60 : 68;
  return {
    coherence: Math.min(score.coherence, cap),
    repetition: score.repetition,
    pacing: Math.min(score.pacing, hasCritical ? 66 : 72),
    voice: Math.min(score.voice, hasCritical ? 68 : 74),
    engagement: Math.min(score.engagement, hasCritical ? 68 : 74),
    overall: Math.min(score.overall, hasCritical ? 62 : 70),
  };
}

export function mergeChapterOpeningJumpCutIntoReports(
  reports: MutableAuditReportInput[],
  issue: AuditReportIssueInput | null,
): MutableAuditReportInput[] {
  return mergeChapterTransitionIssuesIntoReports(reports, issue ? [issue] : []);
}

export function mergeChapterTransitionIssuesIntoReports(
  reports: MutableAuditReportInput[],
  issues: AuditReportIssueInput[],
): MutableAuditReportInput[] {
  if (issues.length === 0) {
    return reports;
  }
  const cap = issues.some((issue) => issue.severity === "critical")
    ? 60
    : issues.some((issue) => issue.severity === "high")
      ? 68
      : 76;
  return reports.map((report) => {
    if (report.auditType !== "continuity") {
      return report;
    }
    return {
      ...report,
      overallScore: Math.min(typeof report.overallScore === "number" ? report.overallScore : cap, cap),
      summary: [report.summary?.trim(), "章节过渡检查发现本章与上一章尾声之间存在承接风险。"].filter(Boolean).join(" "),
      issues: [...issues, ...report.issues],
    };
  });
}
