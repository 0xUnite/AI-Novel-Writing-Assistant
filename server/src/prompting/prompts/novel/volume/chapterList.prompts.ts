import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { PromptAsset } from "../../../core/promptTypes";
import { renderSelectedContextBlocks } from "../../../core/renderContextBlocks";
import { createVolumeChapterListSchema } from "../../../../services/novel/volume/volumeGenerationSchemas";
import { assertChapterTitleDiversity } from "../../../../services/novel/volume/chapterTitleDiversity";
import { type VolumeChapterListPromptInput } from "./shared";
import { buildVolumeChapterListContextBlocks } from "./contextBlocks";
import { NOVEL_PROMPT_BUDGETS } from "../promptBudgetProfiles";

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function buildRetryDirective(reason?: string | null): string {
  const normalizedReason = reason?.trim();
  if (!normalizedReason) {
    return "";
  }
  return [
    "上一次输出没有通过业务校验，本次必须优先修正：",
    normalizedReason,
  ].join("\n");
}

function buildTitleDistributionDirective(targetChapterCount: number): string {
  const dominantFrameCap = Math.max(3, Math.ceil(targetChapterCount * 0.4));
  const commaFrameCap = Math.max(2, Math.ceil(targetChapterCount * 0.35));
  const requiredFamilies = Math.min(5, Math.max(4, Math.floor(targetChapterCount / 4)));

  return [
    "【标题句法分布硬约束】",
    `1. 任一单一表层骨架最多只能占 ${dominantFrameCap} 章。`,
    `2. 含顿挫并列感的逗号式标题最多只能占 ${commaFrameCap} 章。`,
    `3. 全卷至少要混用 ${requiredFamilies} 类不同表层句法。`,
    "4. 至少覆盖这些类型中的大部分：直接动作推进型、冲突压迫型、异常发现型、结果兑现型、决断转向型、问题钩子型、A：B 对照型。",
    "5. 不允许把多数标题都写成并列短句或同一种节奏模板。",
  ].join("\n");
}

export function createVolumeChapterListPrompt(
  targetChapterCount: number,
): PromptAsset<
  VolumeChapterListPromptInput,
  ReturnType<typeof createVolumeChapterListSchema>["_output"]
> {
  return {
    id: "novel.volume.chapter_list",
    version: "v4",
    taskType: "planner",
    mode: "structured",
    language: "zh",
    contextPolicy: {
      maxTokensBudget: NOVEL_PROMPT_BUDGETS.volumeChapterList,
      requiredGroups: ["book_contract", "target_volume", "target_beat_sheet", "target_chapter_count"],
      preferredGroups: ["macro_constraints", "adjacent_volumes", "soft_future_summary"],
      dropOrder: ["soft_future_summary"],
    },
    semanticRetryPolicy: {
      maxAttempts: 3,
      buildMessages: ({ attempt, baseMessages, parsedOutput, validationError }) => [
        ...baseMessages,
        new HumanMessage([
          `上一次章节列表通过了 JSON 结构校验，但没有通过业务校验。这是第 ${attempt} 次语义重试。`,
          `失败原因：${validationError}`,
          "",
          "重写要求：",
          "1. 保持章节总数不变，保持 beat 推进顺序不变。",
          "2. 优先重写标题结构分布，避免大量回落到“X的Y / X中的Y / 在X中Y”这类名词性骨架。",
          "3. 同时避免整批标题继续塌成“A，B / 四字动作，四字结果”这一类并列式模板。",
          "4. 禁止复用机械标题骨架：X起血口、X背后的Y、X里摸到Y、拿X换Y、X反噬到Y、借X咬穿Y、X替Y开口、踏进X门、为X和Y见血、X后面那张Y牌。",
          "5. 相邻章节标题不要连续复用同一种句法骨架或语气。",
          "6. 摘要不要空泛重复，必须体现本章新增推进与卷内节奏职责。",
          "7. 不要把章节写成只有气氛没有事件推进的占位章。",
          "8. 至少一半章节标题必须使用非“X的Y / X中的Y”句法。",
          "9. 低压或承接章节也必须写出结算反馈、信息差、关系变化、风险变化或下一段期待，不能只写移动、等待、寒暄或复盘。",
          "10. 冲突章节必须写出不能退让的理由和具体失败代价。",
          buildTitleDistributionDirective(targetChapterCount),
          "",
          "上一次的 JSON 输出：",
          safeJsonStringify(parsedOutput),
          "",
          "请重新输出完整 JSON 对象。",
        ].join("\n")),
      ],
    },
    outputSchema: createVolumeChapterListSchema(targetChapterCount),
    render: (input, context) => [
      new SystemMessage([
        "你是网文章节拆分规划助手。",
        "你的任务不是写正文，也不是扩写详细细纲，而是把当前卷与当前卷 beat sheet 拆成可执行的章节列表。",
        "",
        "【任务边界】",
        `必须严格输出 ${targetChapterCount} 章，数量不得多也不得少。`,
        "每章只能包含 title、summary、chapter_meta 三个字段，不得新增字段，不得输出 Markdown、注释、解释或额外文本。",
        "当前阶段只做章节级拆分，不写场景细纲、对白、人物小传、章内分幕。",
        "",
        "【核心原则】",
        "1. 章节列表必须严格服从当前卷骨架与 beat sheet，章节顺序不得破坏 beat 的推进顺序。",
        "2. 每章都必须回答：这一章为什么必须存在，它推进了什么，它在当前卷节奏中承担什么作用。",
        "3. 章节拆分要体现网文阅读感，避免机械平均切分，允许不同 beat 下章节密度不同。",
        "4. 章节必须形成连续递进，不能出现只换说法、不增推进的信息重复章。",
        "5. 不存在空白过渡章：低压、换场或结算章节也必须提供读者可感知的新信息、结算反馈、关系变化、风险变化或下一段期待铺垫。",
        "6. 主要冲突章节必须让双方都有不能退让的理由，并在 summary 里体现失败代价或机会窗口。",
        "7. 必须为后续正文生成建立详略依据：chapter_meta.event_weight 越高，正文会越集中详写核心场景；event_weight 越低，正文会压缩支线、路程和衔接。",
        "",
        "【标题要求】",
        "1. 每章 title 必须像真实网文章名，优先体现推进动作、冲突压迫、异常发现、局面变化、阶段兑现或关系异动。",
        "2. 同一批章节标题必须做表层结构分散，不能大面积重复“X的Y / X中的Y / 在X中Y”这一类名词性结构。",
        "3. 也不能让大部分标题都变成“A，B / 四字动作，四字结果”这种并列模板。",
        "4. 相邻章节标题不能连续套用同一骨架，优先混用动作推进型、冲突压迫型、发现异常型、结果兑现型、决断转向型标题。",
        "5. 只有在极少数确有必要时，才允许使用“X的Y / X中的Y”结构或统一并列式结构。",
        "6. 至少一半章节标题必须使用非“X的Y / X中的Y”句法。",
        "7. 标题要有推进感与可读性，避免空泛文学化、抽象抒情化或模板味过重。",
        "8. 同一卷标题至少要混用 4 类以上表层句法，不允许多数标题都回落到同一种模板。",
        `9. 任一单一表层骨架最多只能占 ${Math.max(3, Math.ceil(targetChapterCount * 0.4))} 章。`,
        `10. 含逗号并列感的标题最多只能占 ${Math.max(2, Math.ceil(targetChapterCount * 0.35))} 章。`,
        "11. 请主动覆盖：直接动作推进型、冲突压迫型、异常发现型、结果兑现型、决断转向型、问题钩子型、A：B 对照型中的多种句法。",
        "12. 禁止把流程标签写进章名，例如“开卷抓手”“第一信号”“中段转向”“压力锁定”“高压挤压”“卷高潮”“卷尾钩子”“当前节奏”。",
        "13. 禁止批量套用机械标题骨架：X起血口、X背后的Y、X里摸到Y、拿X换Y、X反噬到Y、借X咬穿Y、X替Y开口、踏进X门、为X和Y见血、X后面那张Y牌。标题必须来自本章具体行动、选择、信息变化或阶段兑现。",
        "",
        "【摘要要求】",
        "1. 每章 summary 必须写清本章具体推进了什么，以及它在当前卷节奏中的作用。",
        "2. summary 必须体现新增信息、局面变化、冲突推进、关系变化、代价上升、风险转向或阶段兑现中的至少一种，不能写成空泛口号。",
        "3. summary 必须服务于拆章，不要写成过粗的章节标题解释，也不要写成详细剧情复述。",
        "4. 相邻章节 summary 不能只是同义重复，必须体现明确的推进差异。",
        "5. 如果该章承担承接或结算功能，summary 必须写出上一段高潮后的物质、情感、关系、名声或风险变化，以及它如何提前制造下一段期待。",
        "6. 如果该章承担冲突功能，summary 必须写出主角或对手失败会失去什么，代价越具体越好。",
        "7. summary 必须暗含本章详略重心：哪些必须展开，哪些只需带过；不要把支线小事写得像主线高潮。",
        "",
        "【chapter_meta 要求】",
        "1. 每章必须输出 chapter_meta，且只能包含 event_weight、high_stakes_dialogue、scheme_beat、kind_of_hook。",
        "2. event_weight 使用 1-5 整数；4-5 代表正文阶段必须启用高能事件三段式：异常感→挫折或代价→超预期回报并带来新麻烦。",
        "3. high_stakes_dialogue 表示本章是否需要高价值对话；scheme_beat 表示本章是否必须使用算计四步结构。",
        "4. kind_of_hook 必须四选一：information_reversal、decision_reversal、threat_approaches、suspense_question。",
        "5. chapter_meta 必须继承当前 beat sheet 的对应倾向，并根据本章职责微调；不要所有章节都给同一个权重或同一个钩子类型。",
        "",
        "【beat 承接要求】",
        "1. 章节列表整体必须完整覆盖 target_beat_sheet 的 beats，且推进顺序保持一致。",
        "2. 必须严格按每个 beat 的 chapterSpanHint 拆章：例如 17-19章 必须拆成 3 个章节，20-25章 必须拆成 6 个章节。",
        "3. 绝对不能只给每个 beat 输出 1 个章节；最终 chapters 数组长度必须等于目标章节数。",
        "4. 开头章节必须承接本卷的 openingHook 与前段 beats，快速建立本卷主要困境、钩子和阅读承诺。",
        "5. 中段章节必须承接升级、反制或转向类 beats，体现局面变化，而不是线性重复加码。",
        "6. 高潮前章节必须完成挤压、锁死、代价抬高或方案失效，不得提前把高潮写完。",
        "7. 高潮章节必须形成明确兑现。",
        "8. 结尾章节必须承接卷尾钩子，并形成下一阶段入口，不能只是收尾性总结。",
        "",
        "【拆章质量要求】",
        "1. 不要平均分配信息量，关键 beat 可以占更多章节，过渡 beat 应尽量短促有力。",
        "2. 不要连续出现多个功能完全相同的章节，例如连续铺压、连续解释、连续反应、连续等待。",
        "3. 不要为了凑章节数制造低信息密度章节。",
        "4. 不要脱离上下文擅自发明重大设定或重大人物变化。",
        "5. 在信息不足时也要给出完整章节列表，但应保守，不要空泛。",
        "6. 连续两个章节不能都只承担“移动、等待、解释、回忆、反应”功能；至少一个必须产生可见推进或兑现。",
        "7. 长篇项目只把当前卷拆到可执行层级；后续卷保持软规划，待章节执行进度和读者反馈出现后再重新拆章。",
        "",
        buildRetryDirective(input.retryReason),
      ].join("\n")),
      new HumanMessage([
        "请基于以下上下文，输出当前卷的章节列表。",
        "",
        "【输出要求】",
        "- 只输出严格 JSON",
        `- 必须严格输出 ${targetChapterCount} 章`,
        "- 章节数按 target_beat_sheet 中每个 chapterSpanHint 的宽度拆分，不要把 1 个 beat 压缩成 1 个章节",
        "- 每章只能包含 title、summary、chapter_meta",
        "- 保持 beat 顺序不变",
        "- 优先保证章节推进感、节奏承接关系与标题结构分散度",
        `- 任一单一标题骨架最多 ${Math.max(3, Math.ceil(targetChapterCount * 0.4))} 章，逗号并列式最多 ${Math.max(2, Math.ceil(targetChapterCount * 0.35))} 章`,
        "",
        "【当前卷拆章上下文】",
        renderSelectedContextBlocks(context),
      ].join("\n")),
    ],
    postValidate: (output) => {
      assertChapterTitleDiversity(output.chapters.map((chapter) => chapter.title));
      return output;
    },
  };
}

export { buildVolumeChapterListContextBlocks };
