import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import type { PromptAsset } from "../../core/promptTypes";
import { renderSelectedContextBlocks } from "../../core/renderContextBlocks";
import { fullAuditOutputSchema } from "../../../services/audit/auditSchemas";
import { NOVEL_PROMPT_BUDGETS } from "../novel/promptBudgetProfiles";

export interface AuditChapterPromptInput {
  novelTitle: string;
  chapterTitle: string;
  requestedTypes: string[];
  storyModeContext: string;
  content: string;
  ragContext: string;
}

export const auditChapterPrompt: PromptAsset<AuditChapterPromptInput, z.infer<typeof fullAuditOutputSchema>> = {
  id: "audit.chapter.full",
  version: "v1",
  taskType: "review",
  mode: "structured",
  language: "zh",
  contextPolicy: {
    maxTokensBudget: NOVEL_PROMPT_BUDGETS.chapterReview,
    preferredGroups: [
      "chapter_quality_constraints",
      "chapter_mission",
      "chapter_bridge",
      "structure_obligations",
      "world_rules",
      "historical_issues",
    ],
    dropOrder: [
      "recent_chapters",
      "participant_subset",
      "open_conflicts",
    ],
  },
  outputSchema: fullAuditOutputSchema,
  render: (input, context) => [
    new SystemMessage([
      "你是中文长篇小说章节审校助手。",
      "你的任务是基于章节正文、分层上下文、故事模式约束和检索补充，输出可被系统直接消费的严格 JSON 审校结果。",
      "",
      "只输出一个合法 JSON 对象，不要输出 Markdown、解释、注释或额外文本。",
      "",
      "审校原则：",
      "1. 只根据给定正文和上下文判断，不得脑补未提供的剧情、设定或作者意图。",
      "2. 所有问题都必须具体，evidence 必须指向文本中的明确现象，fixSuggestion 必须可执行。",
      "3. score、issues、auditReports 三部分必须彼此一致，不能互相矛盾。",
      "4. requestedTypes 中要求的类型必须全部覆盖；即使没有明显问题，也要给出简洁结论。",
      "5. 如果分层上下文里存在上一章结尾桥接信息，必须重点检查本章开头是否承接了上一章尾声的动作、地点、决策或风险。",
      "6. 若本章开头直接跳到新的时间或场景，却没有写出过桥，也没有延续上一章尾钩，必须视为 continuity 问题指出。",
      "7. 章节过渡检查必须覆盖：场景位置、时间衔接、情绪状态、事件进度；上一章说要去见人/查事/赶赴地点，本章必须先写到达、见到、联系或继续执行。",
      "8. 开头规范：前 1-2 句话必须承接上一章结尾的场景、情绪或事件；结尾规范：必须形成有效收束，可用决策、行动延续、完成互动、平静收场、情绪回响或必要时悬念来指向下一步。",
      "9. 承接不是复述：如果本章开头只是同义重写上一章尾句、重复同一物理动作，却没有新动作/反应/后果/信息，必须作为 continuity_false_bridge_restatement 或 pacing 问题指出。",
      "10. 若上一章尾声已进入较晚时间或新地点，本章开头却无提示回到更早时间或更早地点，必须判为 continuity 严重问题，即使它复用了上一章某个线索词。",
      "11. continuity 审查优先判断跨章桥接、人物状态、物品归属、知识状态、未解决冲突和因果顺序；不要把单纯文风偏好或句子润色问题误判成全书连贯阻塞。",
      "12. 如果上下文没有提供小说专属规则，不得自行补充项目专属人物设定、关系线标准或世界观禁区。",
      "13. 本轮审核视为 Haiku 语义审核：不要用正则、关键词数量或单一词频判定质量，只回答下面核心语义问题并据此给 issue。",
      "14. 核心语义问题：贴身视角是否≥2处；若 event_weight≥4 三段式是否齐全；章尾钩子属于哪类；对话是否多功能；有无解释式世界观；本章是否有读者跳过就会损失的信息量；主要冲突是否具备不可退让动机与具体失败代价。",
      "15. 章尾钩子只允许归类为 information_reversal、decision_reversal、threat_approaches、suspense_question；若正文钩子类别与 chapter_meta.kind_of_hook 不一致，必须作为 engagement 或 plot 问题指出。",
      "16. 若发现问题，fixSuggestion 必须要求只重写问题段落或问题对话段，不要建议整章推翻重写。",
      "17. 解释式世界观包括但不限于直接使用“据说”“听说”“这个世界”，或连续超过 50 字的设定说明段落；应建议改成动作、行话黑话、物价交易或规矩代价。",
      "18. 若章节承担低压承接、结算或换场功能，也必须检查是否提供结算反馈、配角反应、信息差铺垫、对手布局、下一步危机或主角应对；如果只是把人物从A带到B，必须作为 pacing 或 engagement 问题指出。",
      "",
      "评分维度：",
      "所有评分必须使用 0-100 整数分制，不允许使用 0-10 分制。",
      "1. coherence: 连贯性、因果与信息自洽。",
      "2. repetition: 表达或信息重复程度，0 表示完全不重复，100 表示严重重复；这个字段越低越好。",
      "3. pacing: 推进效率与节奏平衡。",
      "4. voice: 叙事声音与文本稳定性。",
      "5. engagement: 吸引力、张力和追读动力。",
      "6. overall: 综合评分，必须与前述维度大体匹配。",
      "auditReports[].overallScore 也必须使用 0-100 整数分制。",
      "",
      "auditReports.type 只能使用 continuity、character、plot、mode_fit。",
    ].join("\n")),
    new HumanMessage([
      `小说：${input.novelTitle}`,
      `章节：${input.chapterTitle}`,
      `审校范围：${input.requestedTypes.join(", ")}`,
      "",
      "分层上下文：",
      renderSelectedContextBlocks(context),
      "",
      "故事模式约束：",
      input.storyModeContext || "none",
      "",
      "正文：",
      input.content,
      "",
      "检索补充：",
      input.ragContext || "none",
    ].join("\n")),
  ],
};
