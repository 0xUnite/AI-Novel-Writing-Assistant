import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { PromptAsset } from "../../../core/promptTypes";
import { renderSelectedContextBlocks } from "../../../core/renderContextBlocks";
import {
  createChapterBoundarySchema,
  createChapterPurposeSchema,
  createChapterTaskSheetSchema,
} from "../../../../services/novel/volume/volumeGenerationSchemas";
import { type VolumeChapterDetailPromptInput } from "./shared";
import { buildVolumeChapterDetailContextBlocks } from "./contextBlocks";
import { NOVEL_PROMPT_BUDGETS } from "../promptBudgetProfiles";

function createVolumeDetailSystemPrompt(detailMode: VolumeChapterDetailPromptInput["detailMode"]): string {
  if (detailMode === "purpose") {
    return [
      "你是资深网文章节编辑。",
      "当前任务是收束单章 purpose。",
      "只输出严格 JSON，且只包含 purpose 字段。",
      "purpose 必须说明这一章要推进什么，不要复述摘要。",
      "purpose 必须体现读者本章会获得什么新的可读内容：新信息、局面变化、关系变化、风险变化、阶段兑现、结算反馈或下一段期待中的至少一项。",
      "低压承接章也不能只写从A到B，必须说明它如何结算上一段结果或铺垫下一段期待。",
    ].join("\n");
  }
  if (detailMode === "boundary") {
    return [
      "你是资深网文章节编辑。",
      "当前任务是为单章定义执行边界。",
      "只输出严格 JSON，且只包含 conflictLevel、revealLevel、targetWordCount、mustAvoid、payoffRefs。",
      "mustAvoid 的值必须是字符串；如果有多个禁止事项，请合并成一段文本，不要写成数组。",
      "各字段必须与当前卷节奏和相邻章节保持一致。",
      "targetWordCount 必须贴近 book_contract 中 default chapter length；只能根据 event_weight 和本章功能小幅上下浮动，不能随意扩写到远超默认章节字数。",
      "必须用 conflictLevel、revealLevel、targetWordCount 明确区分详写高光、标准推进、略写承接。",
      "若 conflictLevel 较高，边界必须能支持双方不可退让的动机和具体失败代价；若 conflictLevel 较低，也必须用 revealLevel、payoffRefs 或 mustAvoid 保证章节不空转。",
      "mustAvoid 必须显式禁止无信息量过渡、重复回顾、只写路程寒暄或读者跳过也不影响理解的段落。",
    ].join("\n");
  }
  return [
    "你是资深网文章节编辑。",
    "当前任务是生成可直接交给正文生成器的 taskSheet。",
    "只输出严格 JSON，且只包含 taskSheet 字段。",
    "taskSheet 的值必须是字符串，不得写成对象、数组、列表或多字段结构。",
    "taskSheet 需要覆盖情绪基调、冲突对象、关键推进、因果链、chapter_meta 和收尾要求。",
    "taskSheet 必须包含这些可读标签：入场状态、触发事件、不可退让理由、三段推进、状态变化、下一章承接。",
    "入场状态要写清上一章结尾后角色/地点/压力如何转入本章下一步动作、反应或后果；禁止把上一章尾句换一种说法重复。触发事件要写清本章为什么非发生不可。",
    "状态变化必须具体落到信息、局面、关系、风险、资源或目标的改变；下一章承接必须是动作、物件、地点、决定、人物状态或新风险。",
    "taskSheet 必须写明本章的 reader_value：读者读完后新增知道了什么、看见什么变化、获得什么兑现或被什么下一步期待牵引。",
    "taskSheet 必须写明详略层级和篇幅分配：哪些场景详写，哪些信息略写，如何贴近 targetWordCount。",
    "如果本章是低压承接、换场或结算章，taskSheet 必须把平淡部分压短，并安排结算反馈、配角反应、信息差、对手布局、危机感或主角应对中的至少一项。",
    "如果本章有主要冲突，taskSheet 必须写清双方不能退让的理由和失败代价，不能只写“冲突升级”。",
    "必须把 chapter_meta 四项写入 taskSheet 文本：event_weight、high_stakes_dialogue、scheme_beat、kind_of_hook，供正文生成器读取。",
    "如果 event_weight>=4，taskSheet 必须明确写入高能事件三段式：异常感→挫折或代价→超预期回报并带来新麻烦。",
    "如果 high_stakes_dialogue=true，taskSheet 必须要求生成前内部规划高价值对话策略表。",
    "如果 scheme_beat=true，taskSheet 必须写入算计四步结构。",
  ].join("\n");
}

function buildChapterDetailPrompt(contextText: string, detailMode: VolumeChapterDetailPromptInput["detailMode"]): string {
  return [
    `detail mode: ${detailMode}`,
    "",
    "chapter detail context:",
    contextText,
  ].join("\n");
}

const baseContextPolicy = {
  maxTokensBudget: NOVEL_PROMPT_BUDGETS.volumeChapterDetail,
  requiredGroups: ["book_contract", "target_volume", "chapter_neighbors", "chapter_detail_draft"],
  preferredGroups: ["macro_constraints", "target_beat_sheet", "volume_window"],
  dropOrder: ["volume_window"],
};

export const volumeChapterPurposePrompt: PromptAsset<
  VolumeChapterDetailPromptInput,
  ReturnType<typeof createChapterPurposeSchema>["_output"]
> = {
  id: "novel.volume.chapter_purpose",
  version: "v1",
  taskType: "planner",
  mode: "structured",
  language: "zh",
  contextPolicy: baseContextPolicy,
  outputSchema: createChapterPurposeSchema(),
  render: (input, context) => [
    new SystemMessage(createVolumeDetailSystemPrompt("purpose")),
    new HumanMessage(buildChapterDetailPrompt(renderSelectedContextBlocks(context), input.detailMode)),
  ],
};

export const volumeChapterBoundaryPrompt: PromptAsset<
  VolumeChapterDetailPromptInput,
  ReturnType<typeof createChapterBoundarySchema>["_output"]
> = {
  id: "novel.volume.chapter_boundary",
  version: "v1",
  taskType: "planner",
  mode: "structured",
  language: "zh",
  contextPolicy: baseContextPolicy,
  outputSchema: createChapterBoundarySchema(),
  render: (input, context) => [
    new SystemMessage(createVolumeDetailSystemPrompt("boundary")),
    new HumanMessage(buildChapterDetailPrompt(renderSelectedContextBlocks(context), input.detailMode)),
  ],
};

export const volumeChapterTaskSheetPrompt: PromptAsset<
  VolumeChapterDetailPromptInput,
  ReturnType<typeof createChapterTaskSheetSchema>["_output"]
> = {
  id: "novel.volume.chapter_task_sheet",
  version: "v1",
  taskType: "planner",
  mode: "structured",
  language: "zh",
  contextPolicy: baseContextPolicy,
  outputSchema: createChapterTaskSheetSchema(),
  render: (input, context) => [
    new SystemMessage(createVolumeDetailSystemPrompt("task_sheet")),
    new HumanMessage(buildChapterDetailPrompt(renderSelectedContextBlocks(context), input.detailMode)),
  ],
};

export { buildVolumeChapterDetailContextBlocks };
