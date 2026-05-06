import type {
  BookContractContext,
  ChapterMissionContext,
  ChapterRepairContext,
  ChapterReviewContext,
  ChapterWriteContext,
  GenerationContextPackage,
  MacroConstraintContext,
  PromptBudgetProfile,
  VolumeWindowContext,
} from "@ai-novel/shared/types/chapterRuntime";
import type { ReviewIssue } from "@ai-novel/shared/types/novel";
import type { StoryMacroPlan } from "@ai-novel/shared/types/storyMacro";
import { createContextBlock } from "../../core/contextBudget";
import type { PromptContextBlock } from "../../core/promptTypes";
import { RUNTIME_PROMPT_BUDGET_PROFILES } from "./promptBudgetProfiles";
import { normalizeChapterMeta, serializeChapterMetaForPrompt } from "../../../services/novel/chapterMeta";
import {
  deriveChapterDetailPolicy,
  resolveChapterDetailLevel,
} from "../../../services/novel/volume/volumeChapterDetailPolicy";
import {
  getActiveChapterQualityRolloutBatch,
  listEnabledChapterQualityUpgrades,
} from "../../../services/novel/config/chapterQualityRollout";

export const WRITER_FORBIDDEN_GROUPS = [
  "full_outline",
  "full_bible",
  "all_characters",
  "all_audit_issues",
  "anti_copy_corpus",
  "raw_rag_dump",
] as const;

type RuntimeVolumeSeed = {
  currentVolume?: {
    id?: string | null;
    sortOrder?: number | null;
    title?: string | null;
    summary?: string | null;
    mainPromise?: string | null;
    openPayoffs?: string[];
  } | null;
  previousVolume?: {
    title?: string | null;
    summary?: string | null;
  } | null;
  nextVolume?: {
    title?: string | null;
    summary?: string | null;
  } | null;
  softFutureSummary?: string;
};

function compactText(value: string | null | undefined, fallback = ""): string {
  return value?.replace(/\s+/g, " ").trim() || fallback;
}

function takeUnique(items: Array<string | null | undefined>, limit = items.length): string[] {
  const seen = new Set<string>();
  const results: string[] = [];
  for (const item of items) {
    const normalized = compactText(item);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    results.push(normalized);
    if (results.length >= limit) {
      break;
    }
  }
  return results;
}

function splitLines(value: string | null | undefined, limit = 4): string[] {
  return takeUnique(
    (value ?? "")
      .split(/\r?\n+/g)
      .map((line) => line.replace(/^[-*\d.\s]+/, "").trim()),
    limit,
  );
}

function toListBlock(title: string, values: string[], emptyLabel = "none"): string {
  if (values.length === 0) {
    return `${title}: ${emptyLabel}`;
  }
  return [title, ...values.map((value) => `- ${value}`)].join("\n");
}

export function resolveTargetWordRange(targetWordCount: number | null | undefined): {
  targetWordCount: number | null;
  minWordCount: number | null;
  maxWordCount: number | null;
  softWordCountLimit: number | null;
  hardWordCountLimit: number | null;
} {
  if (!Number.isFinite(targetWordCount) || (targetWordCount ?? 0) <= 0) {
    return {
      targetWordCount: null,
      minWordCount: null,
      maxWordCount: null,
      softWordCountLimit: null,
      hardWordCountLimit: null,
    };
  }
  const normalizedTarget = Math.max(800, Math.round(targetWordCount as number));
  const minWordCount = Math.max(700, Math.floor(normalizedTarget * 0.9));
  const maxWordCount = Math.ceil(normalizedTarget * 1.08);
  return {
    targetWordCount: normalizedTarget,
    minWordCount,
    maxWordCount,
    softWordCountLimit: Math.max(0, maxWordCount - Math.min(180, Math.max(80, Math.round(normalizedTarget * 0.04)))),
    hardWordCountLimit: maxWordCount + Math.min(180, Math.max(80, Math.round(normalizedTarget * 0.04))),
  };
}

function summarizeStateSnapshot(contextPackage: GenerationContextPackage): string {
  const fragments = takeUnique([
    contextPackage.stateSnapshot?.summary,
    ...contextPackage.stateSnapshot?.characterStates
      .slice(0, 3)
      .map((state) => {
        const parts = takeUnique([
          state.currentGoal ? `goal=${state.currentGoal}` : "",
          state.emotion ? `emotion=${state.emotion}` : "",
          state.summary,
        ]);
        if (parts.length === 0) {
          return "";
        }
        return `${state.characterId}: ${parts.join(" | ")}`;
      }) ?? [],
    ...contextPackage.stateSnapshot?.informationStates
      .slice(0, 2)
      .map((info) => `${info.fact} (${info.status})`) ?? [],
  ], 6);
  return fragments.join("\n") || "No prior state snapshot.";
}

function resolveWriteContextChapterMeta(writeContext: ChapterWriteContext) {
  return normalizeChapterMeta(writeContext.chapterMeta ?? writeContext.chapterMission.chapterMeta ?? null);
}

function buildChapterQualityConstraintText(writeContext: ChapterWriteContext): string {
  const meta = resolveWriteContextChapterMeta(writeContext);
  const activeRolloutBatch = getActiveChapterQualityRolloutBatch();
  const activeUpgrades = listEnabledChapterQualityUpgrades(activeRolloutBatch);
  const activeUpgradeSet = new Set(activeUpgrades);
  const lines = [
    `chapter_meta: ${serializeChapterMetaForPrompt(meta)}`,
    `active_quality_rollout_batch: ${activeRolloutBatch}`,
    `active_quality_upgrades: ${activeUpgrades.join(", ")}`,
    "",
    "Active reader-feedback upgrades:",
  ];
  if (activeUpgradeSet.has("close_pov_triad")) {
    lines.push("1. 贴身视角三件套：关键场景至少命中两项：生理反应先于判断；表面动作与内心独白错位；算计过程显性化。");
  }
  if (activeUpgradeSet.has("ending_hook_kind")) {
    lines.push("2. 章尾钩子四选一：结尾必须落到 kind_of_hook 指定类别之一：information_reversal / decision_reversal / threat_approaches / suspense_question。");
  }
  if (activeUpgradeSet.has("dialogue_double_layer")) {
    lines.push("3. 高价值对话：若 high_stakes_dialogue=true，每句重要台词至少承担字面信息，并额外承担试探、伪装、施压、世界观暗示、人物语言习惯中的两项；策略表只做内部规划，不写进正文。");
  }
  if (activeUpgradeSet.has("scheme_four_step")) {
    lines.push("4. 算计四步：若 scheme_beat=true，必须有信息差展示、错误选项演算、最优解落子只写动作不写意图、结果揭晓时让读者顿悟。");
  }
  if (activeUpgradeSet.has("immersive_worldbuilding")) {
    lines.push("5. 浸入式世界观：禁止解释式设定灌输，世界规则必须从日常动作、行话黑话、物价交易、规矩代价或器物细节里显出来。");
  }
  if (activeUpgradeSet.has("reader_value_density")) {
    lines.push("6. 读者信息量：每章都必须给读者新的可感知内容，至少命中一项：新信息、局面变化、关系变化、风险变化、阶段兑现、结算反馈或下一剧情期待铺垫；禁止只写从A到B、空泛日常或读者跳过也不影响理解的段落。");
  }
  if (activeUpgradeSet.has("stakes_motivation_lock")) {
    lines.push("7. 不可退让动机：发生冲突时，主要对抗双方都必须有清楚动机和失败代价；代价要具体到失去资源、机会、关系、生命/安全、身份、时间窗口或承诺兑现，不能只写情绪上不愿意。");
  }
  lines.push("8. 约束优先级：连续性和任务推进最高，其次是读者信息量与不可退让动机，再是 event_weight 三段式、算计/对话/贴身视角，最后才是章尾留白；结尾留白不得牺牲交接锚点与本章新增信息。");
  if (activeUpgradeSet.has("high_energy_three_stage") && meta.eventWeight >= 4) {
    lines.push(
      "High-energy event is mandatory because event_weight>=4: write abnormal signal -> setback or concrete cost -> unexpected reward, and the reward must create a new trouble.",
    );
  }
  return lines.join("\n");
}

function buildHumanTextureGuidanceText(writeContext: ChapterWriteContext): string {
  const relationHints = writeContext.activeRelationStages
    .slice(0, 3)
    .map((relation) => `${relation.sourceCharacterName}->${relation.targetCharacterName}: ${relation.stageLabel} / ${relation.stageSummary}${relation.nextTurnPoint ? ` / next=${relation.nextTurnPoint}` : ""}`);
  const characterVoices = writeContext.participants
    .slice(0, 5)
    .map((character) => {
      const guide = writeContext.characterBehaviorGuides.find((item) => item.characterId === character.id);
      const parts = takeUnique([
        character.personality,
        character.currentState ? `state=${character.currentState}` : "",
        character.currentGoal ? `goal=${character.currentGoal}` : "",
        guide?.stanceLabel ? `stance=${guide.stanceLabel}` : "",
        guide?.relationStageLabels.length ? `relation=${guide.relationStageLabels.join("/")}` : "",
      ], 4);
      return `${character.name}: ${parts.join(" | ") || character.role}`;
    });

  return [
    "Human texture execution card:",
    "1. 心理戏必须嵌在动作前后：用触发物、身体反应、短判断和选择变化来写，禁止连续大段抽象自我分析。",
    "2. 关键场景至少给视角角色 2-3 次即时内心反应：误判、犹豫、压住情绪、暗自盘算或被一句话刺中；每次都要改变下一步动作或台词。",
    "3. 有两名以上角色在场时，至少安排一段 4-8 轮有效对话。台词要带潜台词，承担试探、遮掩、施压、反讽、套话、让步或交换筹码之一，不要写成问答式说明书。",
    "4. 每章至少落一次人物关系微变化：眼神躲开、称呼变化、沉默变长、站位改变、临时让步、互相试探或一次不完全信任的合作。",
    "5. 允许轻微幽默，但必须来自角色性格、局面尴尬、压力下的偏差反应或带刺的对白；禁止硬塞网络梗、俏皮旁白和破坏危机感的段子。",
    "6. 人物语言要有差异：谨慎者先绕弯，急躁者先顶撞，算计者少解释多试探；不要让所有人都用同一种端正宣告腔。",
    "7. 减少 AI 味：少用‘他意识到/她明白/局势变得复杂/空气凝固’这类总结句，改成可听见、看见、能推动选择的细节。",
    writeContext.bookContract.emotionIntensity ? `8. 情绪强度参考：${writeContext.bookContract.emotionIntensity}。强情绪也要落在动作、台词和具体代价上。` : "",
    characterVoices.length > 0 ? toListBlock("Character voice seeds", characterVoices) : "",
    relationHints.length > 0 ? toListBlock("Relationship micro-shift targets", relationHints) : "",
  ].filter(Boolean).join("\n");
}

function buildChapterPacingGuidanceText(writeContext: ChapterWriteContext): string {
  const meta = resolveWriteContextChapterMeta(writeContext);
  const planRole = compactText(writeContext.chapterMission.planRole, "unspecified");
  const pacePreference = compactText(writeContext.bookContract.pacePreference, "not specified");
  return [
    "Single-chapter pacing and edit diagnosis:",
    `Plan signal: plan_role=${planRole}; event_weight=${meta.eventWeight}; pace_preference=${pacePreference}.`,
    "1. 先判断问题层级：节奏过快/过慢、对白生硬、描写过多或过少、情绪不到位、小毒点，属于本章局部修；主线逻辑断裂、人设前后矛盾、重大剧情方向改变或类型漂移，必须回到大纲/结构修正，不能靠润色掩盖。",
    "2. 节奏过慢信号：读者看完只能用一句话概括，且没有新增信息、局面变化、关系变化、风险变化、阶段兑现或下一剧情期待；修法是删减/合并路程、寒暄、重复心理和无效配角反应，把有效章节功能提前。",
    "3. 节奏过快信号：一章塞进太多转折、战斗、揭示或地点切换，读者需要十几句话才能复述，且缺少心理消化、因果过桥和角色反应；修法是补即时情绪、失败代价、对话回合和场景余波，而不是加旁白解释。",
    "4. 衔接或低压章节要快：除非承担结算反馈、配角反应、信息差、对手布局、关系微变或下一危机，否则从A到B必须压缩。",
    "5. 重点或高光章节要慢：若 event_weight>=4 或 plan_role 承担 pressure/turn/payoff/climax，应多写冲突、抉择、不可退让代价、关系拉扯和结果余波，让读者消化爽点与情绪。",
    "6. 章尾钩子不是硬反转模板：慢章靠钩子变成有效铺垫，快章靠情绪落点给读者消化空间；结尾必须有可承接的动作、物件、决定、风险或信息差。",
  ].join("\n");
}

function buildCreativeAgencyGuidanceText(writeContext: ChapterWriteContext): string {
  const characterSeeds = writeContext.participants
    .slice(0, 5)
    .map((character) => {
      const guide = writeContext.characterBehaviorGuides.find((item) => item.characterId === character.id);
      const parts = takeUnique([
        character.personality,
        character.currentGoal ? `goal=${character.currentGoal}` : "",
        character.currentState ? `state=${character.currentState}` : "",
        guide?.volumeResponsibility ? `duty=${guide.volumeResponsibility}` : "",
        guide?.stanceLabel ? `stance=${guide.stanceLabel}` : "",
      ], 4);
      return `${character.name}: ${parts.join(" | ") || character.role}`;
    });
  return [
    "Creative exploration and character agency guidance:",
    "1. 大纲、人设、伏笔是导航和护栏，不是逐句执行的清单。必须守住 mustAdvance、mustPreserve、continuity 与世界规则，但场景里的动作、对白、小误会、小道具、小幽默和关系细节可以在边界内自然生长。",
    "2. 写作顺序要像先有故事再整理大纲：把章节任务转译成一个正在发生的场景问题，再让人物用自己的欲望、恐惧、习惯、旧伤或利益去做选择。",
    "3. 主角不能只被剧情推着走。每个关键推进都要看见：谁主动做了什么，为什么他/她非做不可，如果不做会失去什么。",
    "4. 人物要有撞击感：至少制造一次目标、价值观、方法、信息差或情绪防线的碰撞；碰撞可以发生在角色之间，也可以发生在角色欲望与外部压力之间。",
    "5. 允许轻装上阵式的微创新：不新增核心设定、不改变大纲结局方向的前提下，可以增加临场反应、反讽对白、生活细节、背景故事碎片或小阻碍，让章节不像模板套出来。",
    "6. 若任务单很密，先抓一个核心场景问题和一个人物选择，不要把所有设定逐条塞进正文；未用完的信息留给后续摘要、状态和章节承接处理。",
    characterSeeds.length > 0 ? toListBlock("Character agency seeds", characterSeeds) : "",
  ].filter(Boolean).join("\n");
}

function buildCharacterSocialDepthGuidanceText(writeContext: ChapterWriteContext): string {
  const relationSeeds = writeContext.activeRelationStages
    .slice(0, 4)
    .map((relation) => (
      `${relation.sourceCharacterName}<->${relation.targetCharacterName}: ${relation.stageLabel}${relation.nextTurnPoint ? ` / next=${relation.nextTurnPoint}` : ""}`
    ));
  const characterSeeds = writeContext.participants
    .slice(0, 5)
    .map((character) => {
      const guide = writeContext.characterBehaviorGuides.find((item) => item.characterId === character.id);
      const parts = takeUnique([
        character.role,
        character.personality,
        character.currentGoal ? `goal=${character.currentGoal}` : "",
        guide?.volumeResponsibility ? `volume duty=${guide.volumeResponsibility}` : "",
        guide?.relationStageLabels.length ? `relation=${guide.relationStageLabels.join("/")}` : "",
      ], 4);
      return `${character.name}: ${parts.join(" | ")}`;
    });

  return [
    "Character social-depth and memory-anchor guidance:",
    "1. 人物不能只按好坏分类，必须放回社会层面理解：家庭、阶层、职业、门派/公司/家族、债务、旧伤、情感负债或生存压力，会改变他为什么行动。",
    "2. 主角写法：功能性大于完美性。主角要有缺陷和误判空间，也要有别人替代不了的能力、信息差、资源入口或选择胆量；缺陷负责引出故事，功能负责兑现看点。",
    "3. 配角写法：记忆点大于完整性。重要配角至少有一个可复现的锚点：口头禅、动作标签、特殊物件、职业行话、反差习惯、时间限制或独特癖好；配角服务主线，但不能像只为主角而生。",
    "4. 反派写法：破坏力大于邪恶值。反派可以有可理解的动机，但必须拥有能压迫主角的实力、资源、权力、信息差、群众影响或时间窗口，不能只是纯坏却无威胁。",
    "5. 背景与身份写法：家庭背景、情感联系、隐藏身份、双重身份和社会位置要通过动态出场、行为反应、他人态度、旧物件或一句失控台词露出来，禁止一整段静态人设说明。",
    "6. 性格立体化：优先使用价值观冲突、行为模式冲突或认知冲突；同一刺激下，不同人物应有不同的本能反应、理性反应和隐藏反应。",
    "7. 成长可视化：若本章承担成长或阶段兑现，要用可见变化呈现，例如能力形态、物品升级、服装/称呼/站位变化、权限提升、关系态度变化或旧反应被新选择替代。",
    "8. 强联系优先：重要人物之间至少绑定一种强联系：利益捆绑、信息差掌控、情感负债、血缘天然麻烦、共同秘密或同一风险；一方行动应能影响另一方。",
    "9. 信息不要堆砌：外貌、性格、背景和锚点优先从事件、对话、路人反应、动作细节和动态出场中体现；不要用大量形容词一次性介绍完。",
    characterSeeds.length > 0 ? toListBlock("Character social-depth seeds", characterSeeds) : "",
    relationSeeds.length > 0 ? toListBlock("Strong-link relation seeds", relationSeeds) : "",
  ].filter(Boolean).join("\n");
}

function buildOpeningConversionGuidanceText(writeContext: ChapterWriteContext): string {
  const chapterOrder = writeContext.chapterMission.chapterOrder;
  const isOpeningWindow = chapterOrder <= 3;
  return [
    "Opening conversion guidance:",
    `chapter_order=${chapterOrder}; opening_window=${isOpeningWindow ? "true" : "false"}.`,
    isOpeningWindow
      ? "1. 前三章目标：让读者点进来、看完开篇、想看后续；必须用极短篇幅证明这本书值得读。"
      : "1. 当前不是前三章，不要把正文强行写成投放文案；只在新卷开端、大转折或名场面前使用本卡的短平快原则。",
    "2. 设定要有新鲜感：若核心梗属于市场常见框架，必须做有效微创新，保留读者熟悉的期待线，但给出一个没那么容易预判的新身份、新切入、新限制或新组合。",
    "3. 开篇前三句优先抛出核心冲突、悬念、身份反差、危机或情绪爆点；禁止先铺世界观、履历、天气和长背景。",
    "4. 黄金三秒：最好第一个字就下钩，三段话以内必有重点，300 字以内必须进入主题；开篇每个字都要有功能。",
    "5. 可选切入法：前置高光事件、前置人设特性事件、或专门撰写一个与正文逻辑相连的吸睛小事件；吸睛事件必须能自然接回主线，不能和后文冲突。",
    "6. 表达要适合手机碎片阅读：短句、低理解成本、谁在什么地方做了什么要清楚；复杂设定延后，用动作和画面先让读者看懂。",
    "7. 可适度使用排比、夸张和数字强调来强化记忆点，但必须服务人物、冲突或悬念，不能变成广告腔堆梗。",
    "8. 开篇人物要一眼鲜明：用极端处境、反差行为、特殊能力、社会身份落差或一句有钩子的对白证明人设，而不是旁白宣布‘他很强/她很飒’。",
    "9. 开篇必须像一个独立小故事：读者能迅速看懂发生了什么、为什么有趣、哪里有冲突、接下来还想知道什么。",
    "10. 若必须交代设定，最多只给当前动作所需的信息；剩余设定拆到冲突后的对话、结果反应、道具细节或下一章承接里。",
  ].join("\n");
}

function buildLaunchAppealDensityGuidanceText(writeContext: ChapterWriteContext): string {
  const chapterOrder = writeContext.chapterMission.chapterOrder;
  return [
    "Launch appeal and delight-density guidance:",
    `chapter_order=${chapterOrder}; selling_point=${writeContext.bookContract.sellingPoint}.`,
    "1. 拉新向表达底线：直白、吸睛、快节奏。读者应在手机碎片时间里快速看懂冲突、情绪和看点。",
    "2. 看点密度要可感：大约每 300 字争取有一个小看点/趣味点，每 500 字有一个小钩子或悬念转向；这不是机械计数，而是禁止连续平淡段落。",
    "3. 单章要有完整剧情单元：1000-1500 字左右至少完成一个清楚的小事件、小冲突、小兑现或小关系变化，并在章尾留下卡点、悬念或明确未完成动作。",
    "4. 看点类型可以是：一句有趣的梗、炸裂情节、反套路行动、情绪拉扯、暧昧/试探台词、身份掉马边缘、数字强调、意外反应、小爽点或小虐点。",
    "5. 开篇和高压段不要容忍废话：任何不服务冲突、悬念、人设、关系、情绪或信息量的过渡句，都应删除、合并或改成有功能的动作/对白。",
    "6. 写每个段落前预设读者反应：这段会不会让人想笑、想爽、心疼、好奇、紧张或抓心挠肝？若没有情绪反应，必须补看点或缩短。",
    "7. 真情实感优先于预制套路：可以借用套路框架，但要把作者真正喜欢的关系、情绪、设定或名场面写进去，避免通篇像安全模板。",
  ].join("\n");
}

function buildChapterDetailPolicyGuidanceText(writeContext: ChapterWriteContext): string {
  const meta = resolveWriteContextChapterMeta(writeContext);
  const wordRange = resolveTargetWordRange(writeContext.chapterMission.targetWordCount);
  const policy = deriveChapterDetailPolicy({
    defaultChapterLength: writeContext.chapterMission.targetWordCount ?? null,
    chapterMeta: meta,
    title: writeContext.chapterMission.title,
    summary: writeContext.chapterMission.expectation,
  });
  const detailLevel = resolveChapterDetailLevel(meta);
  return [
    "Chapter detail allocation policy:",
    `detail_level=${detailLevel}; event_weight=${meta.eventWeight}; target_word_count=${wordRange.targetWordCount ?? policy.targetWordCount}.`,
    "1. 本章篇幅是硬合同，不是参考值。围绕目标字数写完整章节；接近 soft limit 时必须自然收束，达到 hard limit 前必须停止新增支线和新场景。",
    "2. 详略分配先看场景功能：主线冲突、不可退让代价、掉马/揭露、关系转向、阶段兑现属于详写；路程、等待、寒暄、重复回顾、支线交代属于略写。",
    "3. brief/略写承接：用少量动作、对话或结果反馈带过低价值过程，把字数留给结算变化、信息差和下一段期待。",
    "4. standard/标准推进：核心事件写完整，普通衔接快速压缩；不要所有段落平均用力。",
    "5. spotlight/详写高光：把字数集中给核心场景的动作-对话-心理余波链条，写出对抗理由、失败代价和结果反应；旁支只保留能抬高主线压力的部分。",
    "6. 若发现本章要超字数，优先删低权重描写和解释性设定；若发现低于字数，只能扩核心冲突、有效对白、即时心理和后果余波，禁止水路程和重复心理。",
  ].join("\n");
}

function summarizeOpenConflicts(contextPackage: GenerationContextPackage): string[] {
  return contextPackage.openConflicts
    .slice(0, 4)
    .map((conflict) => {
      const parts = takeUnique([
        conflict.title,
        conflict.summary,
        conflict.resolutionHint ? `resolution hint: ${conflict.resolutionHint}` : "",
      ], 3);
      return parts.join(" | ");
    })
    .filter(Boolean);
}

function summarizeWorldRules(contextPackage: GenerationContextPackage): string[] {
  const worldSlice = contextPackage.storyWorldSlice;
  if (!worldSlice) {
    return [];
  }
  return takeUnique([
    worldSlice.coreWorldFrame,
    ...worldSlice.appliedRules.slice(0, 3).map((rule) => `${rule.name}: ${rule.summary}`),
    ...worldSlice.forbiddenCombinations.slice(0, 2),
    worldSlice.storyScopeBoundary,
  ], 6);
}

function summarizeHistoricalIssues(contextPackage: GenerationContextPackage): string[] {
  return contextPackage.openAuditIssues
    .slice(0, 4)
    .map((issue) => `${issue.severity}/${issue.auditType}: ${issue.description}`)
    .filter(Boolean);
}

function summarizeStyleConstraints(contextPackage: GenerationContextPackage): string[] {
  const compiled = contextPackage.styleContext?.compiledBlocks;
  if (!compiled) {
    return [];
  }
  return takeUnique([
    ...splitLines(compiled.style, 2),
    ...splitLines(compiled.character, 2),
    ...splitLines(compiled.antiAi, 2),
    ...splitLines(compiled.selfCheck, 1),
  ], 6);
}

function summarizeContinuationConstraints(contextPackage: GenerationContextPackage): string[] {
  if (!contextPackage.continuation.enabled) {
    return [];
  }
  return takeUnique([
    compactText(contextPackage.continuation.systemRule),
    ...splitLines(contextPackage.continuation.humanBlock, 3),
  ], 4);
}

function absenceRiskRank(risk: "none" | "info" | "warn" | "high"): number {
  return ["none", "info", "warn", "high"].indexOf(risk);
}

function buildDynamicCharacterGuidance(
  contextPackage: GenerationContextPackage,
): Pick<ChapterWriteContext, "characterBehaviorGuides" | "activeRelationStages" | "pendingCandidateGuards"> {
  const overview = contextPackage.characterDynamics;
  if (!overview) {
    return {
      characterBehaviorGuides: [],
      activeRelationStages: [],
      pendingCandidateGuards: [],
    };
  }

  const currentChapterOrder = contextPackage.chapter.order;
  const rosterById = new Map(contextPackage.characterRoster.map((character) => [character.id, character]));
  const planParticipantNames = new Set((contextPackage.plan?.participants ?? []).map((item) => compactText(item)));
  const conflictCharacterIds = new Set(
    contextPackage.openConflicts.flatMap((conflict) => conflict.affectedCharacterIds ?? []),
  );

  const activeRelationStages = overview.relations
    .slice(0, 8)
    .map((relation) => ({
      relationId: relation.relationId ?? null,
      sourceCharacterId: relation.sourceCharacterId,
      sourceCharacterName: compactText(relation.sourceCharacterName, relation.sourceCharacterId),
      targetCharacterId: relation.targetCharacterId,
      targetCharacterName: compactText(relation.targetCharacterName, relation.targetCharacterId),
      stageLabel: compactText(relation.stageLabel),
      stageSummary: compactText(relation.stageSummary),
      nextTurnPoint: compactText(relation.nextTurnPoint, "") || null,
      isCurrent: relation.isCurrent,
    }));
  const relationStageByCharacterId = new Map<string, typeof activeRelationStages>();
  for (const relation of activeRelationStages) {
    const sourceStages = relationStageByCharacterId.get(relation.sourceCharacterId) ?? [];
    sourceStages.push(relation);
    relationStageByCharacterId.set(relation.sourceCharacterId, sourceStages);

    const targetStages = relationStageByCharacterId.get(relation.targetCharacterId) ?? [];
    targetStages.push(relation);
    relationStageByCharacterId.set(relation.targetCharacterId, targetStages);
  }

  const characterBehaviorGuides = overview.characters
    .filter((item) => rosterById.has(item.characterId))
    .map((item) => {
      const roster = rosterById.get(item.characterId);
      const relationStages = relationStageByCharacterId.get(item.characterId) ?? [];
      const shouldPreferAppearance = item.isCoreInVolume && (
        item.plannedChapterOrders.includes(currentChapterOrder)
        || item.absenceRisk === "high"
        || item.absenceRisk === "warn"
      );
      let score = 0;
      if (item.isCoreInVolume) {
        score += 40;
      }
      if (item.volumeResponsibility) {
        score += 20;
      }
      if (item.plannedChapterOrders.includes(currentChapterOrder)) {
        score += 25;
      }
      if (relationStages.length > 0) {
        score += 24;
      }
      if (item.absenceRisk === "high") {
        score += 30;
      } else if (item.absenceRisk === "warn") {
        score += 20;
      } else if (item.absenceRisk === "info") {
        score += 8;
      }
      if (planParticipantNames.has(item.name)) {
        score += 16;
      }
      if (conflictCharacterIds.has(item.characterId)) {
        score += 12;
      }
      if (item.currentGoal) {
        score += 4;
      }
      return {
        score,
        guide: {
          characterId: item.characterId,
          name: item.name,
          role: roster?.role ?? item.role,
          castRole: item.castRole ?? null,
          volumeRoleLabel: item.volumeRoleLabel ?? null,
          volumeResponsibility: item.volumeResponsibility ?? null,
          currentGoal: roster?.currentGoal ?? item.currentGoal ?? null,
          currentState: roster?.currentState ?? item.currentState ?? null,
          factionLabel: item.factionLabel ?? null,
          stanceLabel: item.stanceLabel ?? null,
          relationStageLabels: takeUnique(
            relationStages.map((relation) => (
              relation.nextTurnPoint
                ? `${relation.stageLabel} -> ${relation.nextTurnPoint}`
                : relation.stageLabel
            )),
            3,
          ),
          relationRiskNotes: takeUnique(
            relationStages.map((relation) => (
              `${relation.sourceCharacterName} / ${relation.targetCharacterName}: ${relation.stageSummary}${relation.nextTurnPoint ? ` | next=${relation.nextTurnPoint}` : ""}`
            )),
            3,
          ),
          plannedChapterOrders: item.plannedChapterOrders,
          absenceRisk: item.absenceRisk,
          absenceSpan: item.absenceSpan,
          isCoreInVolume: item.isCoreInVolume,
          shouldPreferAppearance,
        },
      };
    })
    .sort((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }
      if (left.guide.shouldPreferAppearance !== right.guide.shouldPreferAppearance) {
        return left.guide.shouldPreferAppearance ? -1 : 1;
      }
      if (left.guide.isCoreInVolume !== right.guide.isCoreInVolume) {
        return left.guide.isCoreInVolume ? -1 : 1;
      }
      if (left.guide.absenceRisk !== right.guide.absenceRisk) {
        return absenceRiskRank(right.guide.absenceRisk) - absenceRiskRank(left.guide.absenceRisk);
      }
      return left.guide.name.localeCompare(right.guide.name, "zh-Hans-CN");
    })
    .slice(0, 8)
    .map((item) => item.guide);

  return {
    characterBehaviorGuides,
    activeRelationStages,
    pendingCandidateGuards: overview.candidates
      .slice(0, 4)
      .map((candidate) => ({
        id: candidate.id,
        proposedName: compactText(candidate.proposedName),
        proposedRole: compactText(candidate.proposedRole, "") || null,
        summary: compactText(candidate.summary, "") || null,
        evidence: takeUnique(candidate.evidence, 3),
        sourceChapterOrder: candidate.sourceChapterOrder ?? null,
      })),
  };
}

function buildChapterBridgeText(writeContext: ChapterWriteContext): string {
  const bridge = writeContext.chapterBridge;
  if (!bridge) {
    return "";
  }
  return [
    `Previous chapter: 第${bridge.previousChapterOrder}章《${bridge.previousChapterTitle}》`,
    `Previous summary: ${bridge.previousChapterSummary}`,
    `Last Scene: ${bridge.lastScene}`,
    `Time Context: ${bridge.lastTime}`,
    toListBlock("Active Characters", bridge.lastCharacters),
    bridge.lastCharacterStates.length > 0
      ? [
          "Active Character States",
          ...bridge.lastCharacterStates.map((item) => `- ${item}`),
        ].join("\n")
      : "Active Character States: none",
    toListBlock("Pending Actions", bridge.pendingActions),
    toListBlock("Key Items", bridge.keyItems),
    [
      "Reference Sentences",
      ...bridge.lastTenSentences.slice(-3).map((item) => `- ${item}`),
    ].join("\n"),
    toListBlock("Carry over facts", bridge.carryOverFacts),
    `Opening directive: ${bridge.openingDirective}`,
    bridge.imageryWarning
      ? `⚠️ 上一章结尾为意象化/哲学性描写（非物理行动），本章开头应从物理行动层面直接展开，禁止延续上一章的意象/感叹句式。`
      : null,
    [
      "Continuity constraints",
      "- Continue the previous scene unless the opening explicitly marks a shift.",
      "- Address pending actions promptly or explicitly explain why they are deferred.",
      "- Bridge by consequence, not restatement: treat the previous tail as a premise, then write the next action, reaction, result, or new information.",
      "- Do not paraphrase the previous chapter's final sentence or repeat the same physical action unless that action creates a new result, obstacle, or relationship change.",
      "- No abrupt jump without a visible bridge in the first paragraph.",
    ].join("\n"),
  ].filter(Boolean).join("\n");
}

function buildParticipants(
  contextPackage: GenerationContextPackage,
  characterBehaviorGuides: ChapterWriteContext["characterBehaviorGuides"] = [],
): GenerationContextPackage["characterRoster"] {
  const rosterById = new Map(contextPackage.characterRoster.map((character) => [character.id, character]));
  const participantNames = new Set(contextPackage.plan?.participants ?? []);
  const conflictCharacterIds = new Set(
    contextPackage.openConflicts.flatMap((conflict) => conflict.affectedCharacterIds ?? []),
  );
  if (characterBehaviorGuides.length > 0) {
    const selected = characterBehaviorGuides
      .filter((guide) => (
        guide.shouldPreferAppearance
        || guide.isCoreInVolume
        || guide.relationStageLabels.length > 0
        || participantNames.has(guide.name)
        || conflictCharacterIds.has(guide.characterId)
      ))
      .map((guide) => rosterById.get(guide.characterId))
      .filter((character): character is NonNullable<typeof character> => Boolean(character));
    if (selected.length > 0) {
      return selected.slice(0, 6);
    }
  }

  const selected = contextPackage.characterRoster.filter((character) => (
    participantNames.has(character.name) || conflictCharacterIds.has(character.id)
  ));
  if (selected.length > 0) {
    return selected.slice(0, 6);
  }
  return contextPackage.characterRoster.slice(0, 4);
}

export function buildBookContractContext(input: {
  title: string;
  genre?: string | null;
  targetAudience?: string | null;
  sellingPoint?: string | null;
  first30ChapterPromise?: string | null;
  narrativePov?: string | null;
  pacePreference?: string | null;
  emotionIntensity?: string | null;
  toneGuardrails?: string[];
  hardConstraints?: string[];
}): BookContractContext {
  return {
    title: compactText(input.title),
    genre: compactText(input.genre, "unknown"),
    targetAudience: compactText(input.targetAudience, "unknown"),
    sellingPoint: compactText(input.sellingPoint, "not specified"),
    first30ChapterPromise: compactText(input.first30ChapterPromise, "not specified"),
    narrativePov: compactText(input.narrativePov, "not specified"),
    pacePreference: compactText(input.pacePreference, "not specified"),
    emotionIntensity: compactText(input.emotionIntensity, "not specified"),
    toneGuardrails: takeUnique(input.toneGuardrails ?? [], 4),
    hardConstraints: takeUnique(input.hardConstraints ?? [], 6),
  };
}

export function buildMacroConstraintContext(storyMacroPlan: StoryMacroPlan | null): MacroConstraintContext | null {
  if (!storyMacroPlan) {
    return null;
  }
  return {
    sellingPoint: compactText(storyMacroPlan.decomposition?.selling_point, "not specified"),
    coreConflict: compactText(storyMacroPlan.decomposition?.core_conflict, "not specified"),
    mainHook: compactText(storyMacroPlan.decomposition?.main_hook, "not specified"),
    progressionLoop: compactText(storyMacroPlan.decomposition?.progression_loop, "not specified"),
    growthPath: compactText(storyMacroPlan.decomposition?.growth_path, "not specified"),
    endingFlavor: compactText(storyMacroPlan.decomposition?.ending_flavor, "not specified"),
    hardConstraints: takeUnique([
      ...(storyMacroPlan.constraints ?? []),
      ...(storyMacroPlan.constraintEngine?.hard_constraints ?? []),
    ], 8),
  };
}

export function buildVolumeWindowContext(seed: RuntimeVolumeSeed): VolumeWindowContext | null {
  const current = seed.currentVolume;
  if (!current?.title?.trim()) {
    return null;
  }
  const adjacentSummary = [
    seed.previousVolume?.title ? `previous: ${compactText(seed.previousVolume.title)} / ${compactText(seed.previousVolume.summary, "no summary")}` : "",
    seed.nextVolume?.title ? `next: ${compactText(seed.nextVolume.title)} / ${compactText(seed.nextVolume.summary, "no summary")}` : "",
  ].filter(Boolean).join("\n");
  return {
    volumeId: current.id ?? null,
    sortOrder: current.sortOrder ?? null,
    title: compactText(current.title),
    missionSummary: compactText(current.mainPromise || current.summary, "no volume mission"),
    adjacentSummary: adjacentSummary || "No adjacent volume summary.",
    pendingPayoffs: takeUnique(current.openPayoffs ?? [], 5),
    softFutureSummary: compactText(seed.softFutureSummary, "No future volume summary."),
  };
}

export function buildChapterMissionContext(contextPackage: GenerationContextPackage): ChapterMissionContext {
  const chapterMeta = normalizeChapterMeta(contextPackage.plan?.chapterMeta ?? null);
  return {
    chapterId: contextPackage.chapter.id,
    chapterOrder: contextPackage.chapter.order,
    title: compactText(contextPackage.chapter.title),
    objective: compactText(
      contextPackage.plan?.objective,
      contextPackage.chapter.expectation ?? "Push the current chapter mission forward.",
    ),
    expectation: compactText(
      contextPackage.chapter.expectation,
      contextPackage.plan?.title ?? "Deliver the current chapter mission.",
    ),
    targetWordCount: contextPackage.chapter.targetWordCount ?? null,
    taskSheet: compactText(contextPackage.chapter.taskSheet, "") || null,
    planRole: contextPackage.plan?.planRole ?? null,
    hookTarget: compactText(
      contextPackage.plan?.hookTarget,
      "Use the ending function that best fits this chapter: decision, action continuation, completed interaction, calm close, emotional reflection, or suspense only when it is earned.",
    ),
    chapterMeta,
    mustAdvance: takeUnique(contextPackage.plan?.mustAdvance ?? [], 5),
    mustPreserve: takeUnique(contextPackage.plan?.mustPreserve ?? [], 5),
    riskNotes: takeUnique(contextPackage.plan?.riskNotes ?? [], 5),
  };
}

export function buildChapterWriteContext(input: {
  bookContract: BookContractContext;
  macroConstraints: MacroConstraintContext | null;
  volumeWindow: VolumeWindowContext | null;
  contextPackage: GenerationContextPackage;
}): ChapterWriteContext {
  const dynamicCharacterGuidance = buildDynamicCharacterGuidance(input.contextPackage);
  const chapterMission = buildChapterMissionContext(input.contextPackage);
  return {
    bookContract: input.bookContract,
    macroConstraints: input.macroConstraints,
    volumeWindow: input.volumeWindow,
    chapterBridge: input.contextPackage.chapterBridge ?? null,
    chapterMission,
    chapterMeta: chapterMission.chapterMeta,
    participants: buildParticipants(input.contextPackage, dynamicCharacterGuidance.characterBehaviorGuides),
    characterBehaviorGuides: dynamicCharacterGuidance.characterBehaviorGuides,
    activeRelationStages: dynamicCharacterGuidance.activeRelationStages,
    pendingCandidateGuards: dynamicCharacterGuidance.pendingCandidateGuards,
    localStateSummary: summarizeStateSnapshot(input.contextPackage),
    openConflictSummaries: summarizeOpenConflicts(input.contextPackage),
    recentChapterSummaries: takeUnique(input.contextPackage.previousChaptersSummary.slice(0, 3), 3),
    openingAntiRepeatHint: compactText(input.contextPackage.openingHint, "No recent opening guidance."),
    styleConstraints: summarizeStyleConstraints(input.contextPackage),
    continuationConstraints: summarizeContinuationConstraints(input.contextPackage),
    ragFacts: [],
  };
}

export function buildChapterReviewContext(
  writeContext: ChapterWriteContext,
  contextPackage: GenerationContextPackage,
): ChapterReviewContext {
  return {
    ...writeContext,
    structureObligations: takeUnique([
      ...writeContext.chapterMission.mustAdvance,
      ...writeContext.chapterMission.mustPreserve,
      writeContext.chapterMission.hookTarget ? `ending guidance: ${writeContext.chapterMission.hookTarget}` : "",
      writeContext.volumeWindow?.missionSummary ? `volume mission: ${writeContext.volumeWindow.missionSummary}` : "",
      ...(writeContext.volumeWindow?.pendingPayoffs.map((item) => `pending payoff: ${item}`) ?? []),
    ], 8),
    worldRules: summarizeWorldRules(contextPackage),
    historicalIssues: summarizeHistoricalIssues(contextPackage),
  };
}

export function buildChapterRepairContext(input: {
  writeContext: ChapterWriteContext;
  contextPackage: GenerationContextPackage;
  issues: ReviewIssue[];
}): ChapterRepairContext {
  return {
    writeContext: input.writeContext,
    issues: input.issues.slice(0, 8).map((issue) => ({
      severity: issue.severity,
      category: issue.category,
      evidence: compactText(issue.evidence),
      fixSuggestion: compactText(issue.fixSuggestion),
    })),
    structureObligations: takeUnique([
      ...input.writeContext.chapterMission.mustAdvance,
      ...input.writeContext.chapterMission.mustPreserve,
      input.writeContext.volumeWindow?.missionSummary
        ? `volume mission: ${input.writeContext.volumeWindow.missionSummary}`
        : "",
      ...(input.writeContext.volumeWindow?.pendingPayoffs.map((item) => `pending payoff: ${item}`) ?? []),
    ], 10),
    worldRules: summarizeWorldRules(input.contextPackage),
    historicalIssues: summarizeHistoricalIssues(input.contextPackage),
    allowedEditBoundaries: takeUnique([
      "Keep the chapter's established objective, participants, and major outcome direction intact.",
      "Do not introduce new core characters, new world rules, or off-outline twists.",
      input.writeContext.volumeWindow?.missionSummary
        ? `Keep the repair aligned with the current volume mission: ${input.writeContext.volumeWindow.missionSummary}`
        : "",
      ...(input.writeContext.volumeWindow?.pendingPayoffs.map((item) => `Do not erase pending payoff setup: ${item}`) ?? []),
      input.writeContext.chapterMission.hookTarget
        ? `Keep the ending aligned with the chapter's closing function: ${input.writeContext.chapterMission.hookTarget}`
        : "",
      ...input.writeContext.characterBehaviorGuides
        .filter((guide) => guide.shouldPreferAppearance || guide.isCoreInVolume)
        .slice(0, 4)
        .map((guide) => `Keep ${guide.name} aligned with current role duty: ${guide.volumeResponsibility ?? guide.volumeRoleLabel ?? guide.role}`),
      input.writeContext.pendingCandidateGuards.length > 0
        ? "Pending character candidates remain read-only unless they are confirmed outside the repair flow."
        : "",
      ...input.writeContext.chapterMission.mustPreserve.map((item) => `must preserve: ${item}`),
    ], 12),
  };
}

function buildParticipantText(writeContext: ChapterWriteContext): string {
  if (writeContext.participants.length === 0) {
    return "Participants: none";
  }
  const guideByCharacterId = new Map(
    writeContext.characterBehaviorGuides.map((guide) => [guide.characterId, guide]),
  );
  return [
    "Participants:",
    ...writeContext.participants.map((character) => {
      const guide = guideByCharacterId.get(character.id);
      const parts = takeUnique([
        character.role,
        guide?.volumeRoleLabel ? `volume role=${guide.volumeRoleLabel}` : "",
        guide?.volumeResponsibility ? `volume duty=${guide.volumeResponsibility}` : "",
        character.personality,
        character.currentState ? `state=${character.currentState}` : "",
        character.currentGoal ? `goal=${character.currentGoal}` : "",
        guide?.relationStageLabels.length ? `relation=${guide.relationStageLabels.join(" / ")}` : "",
        guide?.absenceRisk && guide.absenceRisk !== "none"
          ? `absence risk=${guide.absenceRisk}(span=${guide.absenceSpan})`
          : "",
      ], 4);
      return `- ${character.name}: ${parts.join(" | ")}`;
    }),
  ].join("\n");
}

function buildCharacterGuidanceText(writeContext: ChapterWriteContext): string {
  if (writeContext.characterBehaviorGuides.length === 0) {
    return "Character behavior guidance: none";
  }
  return [
    "Character behavior guidance:",
    ...writeContext.characterBehaviorGuides.map((guide) => {
      const parts = takeUnique([
        guide.isCoreInVolume ? "core in current volume" : "supporting in current volume",
        guide.volumeRoleLabel ? `volume role=${guide.volumeRoleLabel}` : "",
        guide.volumeResponsibility ? `duty=${guide.volumeResponsibility}` : "",
        guide.currentGoal ? `goal=${guide.currentGoal}` : "",
        guide.currentState ? `state=${guide.currentState}` : "",
        guide.relationStageLabels.length ? `relation=${guide.relationStageLabels.join(" / ")}` : "",
        guide.absenceRisk !== "none" ? `absence=${guide.absenceRisk}(span=${guide.absenceSpan})` : "",
        guide.factionLabel ? `faction=${guide.factionLabel}` : "",
        guide.stanceLabel ? `stance=${guide.stanceLabel}` : "",
        guide.shouldPreferAppearance ? "prefer appearance in this chapter" : "",
      ], 6);
      return `- ${guide.name}: ${parts.join(" | ")}`;
    }),
  ].join("\n");
}

function buildRelationStageText(writeContext: ChapterWriteContext): string {
  if (writeContext.activeRelationStages.length === 0) {
    return "Active relationship stages: none";
  }
  return [
    "Active relationship stages:",
    ...writeContext.activeRelationStages.map((relation) => (
      `- ${relation.sourceCharacterName} -> ${relation.targetCharacterName}: ${relation.stageLabel} | ${relation.stageSummary}${relation.nextTurnPoint ? ` | next=${relation.nextTurnPoint}` : ""}`
    )),
  ].join("\n");
}

function buildPendingCandidateGuardText(writeContext: ChapterWriteContext): string {
  if (writeContext.pendingCandidateGuards.length === 0) {
    return "Pending candidate guardrails: none";
  }
  return [
    "Pending candidate guardrails (read-only, do not inject into generation):",
    ...writeContext.pendingCandidateGuards.map((candidate) => {
      const parts = takeUnique([
        candidate.proposedRole ? `role=${candidate.proposedRole}` : "",
        candidate.summary ?? "",
        candidate.sourceChapterOrder != null ? `source chapter=${candidate.sourceChapterOrder}` : "",
        ...candidate.evidence.slice(0, 2),
      ], 4);
      return `- ${candidate.proposedName}: ${parts.join(" | ")}`;
    }),
  ].join("\n");
}

export function sanitizeWriterContextBlocks(blocks: PromptContextBlock[]): {
  allowedBlocks: PromptContextBlock[];
  removedBlockIds: string[];
} {
  const forbidden = new Set<string>(WRITER_FORBIDDEN_GROUPS);
  const removedBlockIds = blocks
    .filter((block) => forbidden.has(block.group))
    .map((block) => block.id);
  return {
    allowedBlocks: blocks.filter((block) => !forbidden.has(block.group)),
    removedBlockIds,
  };
}

export function buildChapterWriterContextBlocks(writeContext: ChapterWriteContext): PromptContextBlock[] {
  const wordRange = resolveTargetWordRange(writeContext.chapterMission.targetWordCount);
  const blocks: PromptContextBlock[] = [
    createContextBlock({
      id: "chapter_quality_constraints",
      group: "chapter_quality_constraints",
      priority: 99,
      required: true,
      content: buildChapterQualityConstraintText(writeContext),
    }),
    createContextBlock({
      id: "human_texture_guidance",
      group: "human_texture_guidance",
      priority: 98,
      required: true,
      content: buildHumanTextureGuidanceText(writeContext),
    }),
    createContextBlock({
      id: "chapter_pacing_guidance",
      group: "chapter_pacing_guidance",
      priority: 97,
      required: true,
      content: buildChapterPacingGuidanceText(writeContext),
    }),
    createContextBlock({
      id: "chapter_detail_policy_guidance",
      group: "chapter_detail_policy_guidance",
      priority: 97,
      required: true,
      content: buildChapterDetailPolicyGuidanceText(writeContext),
    }),
    createContextBlock({
      id: "creative_agency_guidance",
      group: "creative_agency_guidance",
      priority: 96,
      required: true,
      content: buildCreativeAgencyGuidanceText(writeContext),
    }),
    createContextBlock({
      id: "character_social_depth_guidance",
      group: "character_social_depth_guidance",
      priority: 95,
      required: true,
      content: buildCharacterSocialDepthGuidanceText(writeContext),
    }),
    createContextBlock({
      id: "opening_conversion_guidance",
      group: "opening_conversion_guidance",
      priority: 94,
      required: writeContext.chapterMission.chapterOrder <= 3,
      content: buildOpeningConversionGuidanceText(writeContext),
    }),
    createContextBlock({
      id: "launch_appeal_density_guidance",
      group: "launch_appeal_density_guidance",
      priority: 93,
      required: true,
      content: buildLaunchAppealDensityGuidanceText(writeContext),
    }),
    createContextBlock({
      id: "chapter_mission",
      group: "chapter_mission",
      priority: 100,
      required: true,
      content: [
        `Chapter mission: ${writeContext.chapterMission.title}`,
        `Objective: ${writeContext.chapterMission.objective}`,
        `Expectation: ${writeContext.chapterMission.expectation}`,
        writeContext.chapterMission.taskSheet ? `Task sheet:\n${writeContext.chapterMission.taskSheet}` : "",
        writeContext.chapterMission.planRole ? `Plan role: ${writeContext.chapterMission.planRole}` : "",
        wordRange.targetWordCount != null
          ? `Target length: around ${wordRange.targetWordCount} Chinese characters (target range ${wordRange.minWordCount}-${wordRange.maxWordCount}; start wrapping near ${wordRange.softWordCountLimit}, never exceed ${wordRange.hardWordCountLimit}, and do not end clearly below the minimum).`
          : "",
        toListBlock("Must advance", writeContext.chapterMission.mustAdvance),
        toListBlock("Must preserve", writeContext.chapterMission.mustPreserve),
        toListBlock("Risk notes", writeContext.chapterMission.riskNotes),
        writeContext.chapterMission.hookTarget ? `Ending guidance: ${writeContext.chapterMission.hookTarget}` : "",
        `Chapter meta: ${serializeChapterMetaForPrompt(resolveWriteContextChapterMeta(writeContext))}`,
        "Ending strategy: do not force suspense or cliffhangers in every chapter. Natural endings can land on a decision, ongoing action, completed interaction, calm scene close, or emotional reflection. Vary ending styles across chapters and use suspense only when the chapter genuinely needs it.",
      ].filter(Boolean).join("\n"),
    }),
    createContextBlock({
      id: "volume_window",
      group: "volume_window",
      priority: 96,
      required: true,
      content: writeContext.volumeWindow
        ? [
            `Current volume: ${writeContext.volumeWindow.title}`,
            `Volume mission: ${writeContext.volumeWindow.missionSummary}`,
            writeContext.volumeWindow.adjacentSummary,
            toListBlock("Pending payoffs", writeContext.volumeWindow.pendingPayoffs),
            `Future window: ${writeContext.volumeWindow.softFutureSummary}`,
          ].filter(Boolean).join("\n")
        : "Current volume: none",
    }),
    createContextBlock({
      id: "participant_subset",
      group: "participant_subset",
      priority: 92,
      required: true,
      content: buildParticipantText(writeContext),
    }),
    createContextBlock({
      id: "character_dynamics",
      group: "character_dynamics",
      priority: 91,
      content: [
        buildCharacterGuidanceText(writeContext),
        buildRelationStageText(writeContext),
        buildPendingCandidateGuardText(writeContext),
      ].join("\n\n"),
    }),
    createContextBlock({
      id: "chapter_bridge",
      group: "chapter_bridge",
      priority: 98,
      required: true,
      content: buildChapterBridgeText(writeContext),
    }),
    createContextBlock({
      id: "local_state",
      group: "local_state",
      priority: 90,
      required: true,
      content: `Local state before writing:\n${writeContext.localStateSummary}`,
    }),
    createContextBlock({
      id: "rag_facts",
      group: "rag_facts",
      priority: 89,
      content: toListBlock("RAG facts (world bible first)", writeContext.ragFacts),
    }),
    createContextBlock({
      id: "open_conflicts",
      group: "open_conflicts",
      priority: 88,
      content: toListBlock("Open conflicts", writeContext.openConflictSummaries),
    }),
    createContextBlock({
      id: "recent_chapters",
      group: "recent_chapters",
      priority: 86,
      content: toListBlock("Recent chapter summaries", writeContext.recentChapterSummaries),
    }),
    createContextBlock({
      id: "opening_constraints",
      group: "opening_constraints",
      priority: 80,
      content: `Opening anti-repeat hint:\n${writeContext.openingAntiRepeatHint}`,
    }),
    createContextBlock({
      id: "style_constraints",
      group: "style_constraints",
      priority: 74,
      content: toListBlock("Style constraints", writeContext.styleConstraints),
    }),
    createContextBlock({
      id: "continuation_constraints",
      group: "continuation_constraints",
      priority: 72,
      content: toListBlock("Continuation constraints", writeContext.continuationConstraints),
    }),
  ];
  return blocks.filter((block) => block.content.trim().length > 0);
}

export function buildChapterReviewContextBlocks(reviewContext: ChapterReviewContext): PromptContextBlock[] {
  return [
    ...buildChapterWriterContextBlocks(reviewContext),
    createContextBlock({
      id: "structure_obligations",
      group: "structure_obligations",
      priority: 94,
      required: true,
      content: toListBlock("Structure obligations", reviewContext.structureObligations),
    }),
    createContextBlock({
      id: "world_rules",
      group: "world_rules",
      priority: 84,
      content: toListBlock("Relevant world rules", reviewContext.worldRules),
    }),
    createContextBlock({
      id: "historical_issues",
      group: "historical_issues",
      priority: 82,
      content: toListBlock("Historical unresolved issues", reviewContext.historicalIssues),
    }),
  ].filter((block) => block.content.trim().length > 0);
}

export function buildChapterRepairContextBlocks(repairContext: ChapterRepairContext): PromptContextBlock[] {
  return [
    ...buildChapterWriterContextBlocks(repairContext.writeContext),
    createContextBlock({
      id: "repair_issues",
      group: "repair_issues",
      priority: 100,
      required: true,
      content: repairContext.issues.length > 0
        ? [
            "Repair issues:",
            ...repairContext.issues.map((issue) => (
              `- ${issue.severity}/${issue.category}: ${issue.evidence} | fix: ${issue.fixSuggestion}`
            )),
          ].join("\n")
        : "Repair issues: none",
    }),
    createContextBlock({
      id: "structure_obligations",
      group: "structure_obligations",
      priority: 95,
      required: true,
      content: toListBlock("Structure obligations", repairContext.structureObligations),
    }),
    createContextBlock({
      id: "repair_boundaries",
      group: "repair_boundaries",
      priority: 96,
      required: true,
      content: toListBlock("Allowed edit boundaries", repairContext.allowedEditBoundaries),
    }),
    createContextBlock({
      id: "world_rules",
      group: "world_rules",
      priority: 84,
      content: toListBlock("Relevant world rules", repairContext.worldRules),
    }),
    createContextBlock({
      id: "historical_issues",
      group: "historical_issues",
      priority: 82,
      content: toListBlock("Historical unresolved issues", repairContext.historicalIssues),
    }),
  ].filter((block) => block.content.trim().length > 0);
}

export function getRuntimePromptBudgetProfiles(): PromptBudgetProfile[] {
  return RUNTIME_PROMPT_BUDGET_PROFILES;
}

export function buildChapterRepairContextFromPackage(
  contextPackage: GenerationContextPackage,
  issues: ReviewIssue[],
): ChapterRepairContext | null {
  if (!contextPackage.chapterWriteContext) {
    return null;
  }
  return buildChapterRepairContext({
    writeContext: contextPackage.chapterWriteContext,
    contextPackage,
    issues,
  });
}

export function withChapterRepairContext(
  contextPackage: GenerationContextPackage,
  issues: ReviewIssue[],
): GenerationContextPackage {
  const chapterRepairContext = buildChapterRepairContextFromPackage(contextPackage, issues);
  if (!chapterRepairContext) {
    return contextPackage;
  }
  return {
    ...contextPackage,
    chapterRepairContext,
  };
}
