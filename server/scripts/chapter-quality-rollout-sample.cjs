#!/usr/bin/env node

process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.LLM_DEBUG_LOG = process.env.LLM_DEBUG_LOG || "0";
process.env.CHAPTER_QUALITY_ROLLOUT_BATCH = process.env.CHAPTER_QUALITY_ROLLOUT_BATCH || "1";

const fs = require("node:fs/promises");
const path = require("node:path");
const { AIMessage } = require("@langchain/core/messages");

const { prisma } = require("../dist/db/prisma.js");
const { getLLM } = require("../dist/llm/factory.js");
const { preparePromptExecution } = require("../dist/prompting/core/promptRunner.js");
const { chapterWriterPrompt } = require("../dist/prompting/prompts/novel/chapterWriter.prompts.js");
const {
  buildChapterWriterContextBlocks,
  sanitizeWriterContextBlocks,
  resolveTargetWordRange,
} = require("../dist/prompting/prompts/novel/chapterLayeredContext.js");
const { GenerationContextAssembler } = require("../dist/services/novel/runtime/GenerationContextAssembler.js");
const {
  sanitizeGeneratedChapterContent,
} = require("../dist/services/novel/chapterContentSanitizer.js");
const {
  extractSnapshotWithAI,
} = require("../dist/services/state/stateSnapshotExtraction.js");
const { estimateTokenCount } = require("../dist/services/rag/utils.js");

const REPO_ROOT = path.resolve(__dirname, "../..");
const DEFAULT_NOVEL_ID = "cmo4g0x8w0003938okwij1zvx";
const DEFAULT_OUT_DIR = path.join(REPO_ROOT, "test_sample/chapter_quality_rollout/batch1_after");
const PROMPT_PROOF_DIR = path.join(REPO_ROOT, "test_sample/chapter_quality_rollout/prompt_proof");

function parseArgs(argv) {
  const args = {
    novelId: DEFAULT_NOVEL_ID,
    start: 1,
    end: 5,
    outDir: DEFAULT_OUT_DIR,
    provider: "minimax",
    model: process.env.MINIMAX_MODEL || "MiniMax-M2.7",
    temperature: 0.8,
    mode: "batch",
  };
  for (let index = 2; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];
    if (current === "--novel-id" && next) args.novelId = next, index += 1;
    else if (current === "--start" && next) args.start = Number.parseInt(next, 10), index += 1;
    else if (current === "--end" && next) args.end = Number.parseInt(next, 10), index += 1;
    else if (current === "--out-dir" && next) args.outDir = path.resolve(next), index += 1;
    else if (current === "--provider" && next) args.provider = next, index += 1;
    else if (current === "--model" && next) args.model = next, index += 1;
    else if (current === "--temperature" && next) args.temperature = Number.parseFloat(next), index += 1;
    else if (current === "--mode" && next) args.mode = next, index += 1;
  }
  return args;
}

function countChars(content) {
  return content.replace(/\s+/g, "").trim().length;
}

function resolveWriterMaxTokens(maxWordCount) {
  if (maxWordCount == null) {
    return 9000;
  }
  return Math.max(3600, Math.min(10000, Math.ceil(maxWordCount * 1.1)));
}

function extractTextFromMessage(message) {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content.map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part.text === "string") return part.text;
      return "";
    }).join("\n");
  }
  return String(message.content ?? "");
}

function extractPromptUsage(aiMessage) {
  const usage = aiMessage?.usage_metadata || aiMessage?.usageMetadata;
  const response = aiMessage?.response_metadata || aiMessage?.responseMetadata;
  const tokenUsage = response?.tokenUsage || response?.token_usage || response?.usage || response?.usage_metadata;
  const promptTokens =
    usage?.input_tokens
    ?? usage?.inputTokens
    ?? tokenUsage?.promptTokens
    ?? tokenUsage?.prompt_tokens
    ?? tokenUsage?.input_tokens
    ?? tokenUsage?.inputTokens
    ?? response?.prompt_tokens;
  const completionTokens =
    usage?.output_tokens
    ?? usage?.outputTokens
    ?? tokenUsage?.completionTokens
    ?? tokenUsage?.completion_tokens
    ?? tokenUsage?.output_tokens
    ?? tokenUsage?.outputTokens
    ?? response?.completion_tokens;
  const totalTokens =
    usage?.total_tokens
    ?? usage?.totalTokens
    ?? tokenUsage?.totalTokens
    ?? tokenUsage?.total_tokens
    ?? response?.total_tokens;
  if (typeof promptTokens !== "number") {
    return {
      promptTokens: null,
      completionTokens: typeof completionTokens === "number" ? completionTokens : null,
      totalTokens: typeof totalTokens === "number" ? totalTokens : null,
      rawUsage: { usage, response },
    };
  }
  return {
    promptTokens,
    completionTokens: typeof completionTokens === "number" ? completionTokens : null,
    totalTokens: typeof totalTokens === "number" ? totalTokens : null,
    rawUsage: { usage, response },
  };
}

function renderPromptMarkdown(messages) {
  return messages.map((message, index) => {
    const role = typeof message._getType === "function"
      ? message._getType()
      : message instanceof AIMessage
        ? "ai"
        : message.constructor?.name?.replace(/Message$/u, "").toLowerCase() || `message_${index + 1}`;
    return `## ${index + 1}. ${role}\n\n${extractTextFromMessage(message)}`;
  }).join("\n\n---\n\n");
}

async function buildWriterPrompt(args, chapter, overrides = {}) {
  const assembler = new GenerationContextAssembler();
  const assembled = await assembler.assemble(args.novelId, chapter.id, {
    provider: args.provider,
    model: args.model,
    temperature: args.temperature,
  });
  if (overrides.chapterMeta && assembled.contextPackage.chapterWriteContext) {
    assembled.contextPackage.chapterWriteContext.chapterMeta = overrides.chapterMeta;
    assembled.contextPackage.chapterWriteContext.chapterMission.chapterMeta = overrides.chapterMeta;
    assembled.contextPackage.chapterMeta = overrides.chapterMeta;
  }
  const writeContext = assembled.contextPackage.chapterWriteContext;
  if (!writeContext) {
    throw new Error(`No chapterWriteContext for chapter ${chapter.order}.`);
  }
  const targetRange = resolveTargetWordRange(writeContext.chapterMission.targetWordCount);
  const sanitized = sanitizeWriterContextBlocks(buildChapterWriterContextBlocks(writeContext));
  const prepared = preparePromptExecution({
    asset: chapterWriterPrompt,
    promptInput: {
      novelTitle: assembled.novel.title,
      chapterOrder: chapter.order,
      chapterTitle: chapter.title,
      mode: "draft",
      targetWordCount: writeContext.chapterMission.targetWordCount ?? null,
      minWordCount: targetRange.minWordCount,
      maxWordCount: targetRange.maxWordCount,
      softWordCountLimit: targetRange.softWordCountLimit,
      hardWordCountLimit: targetRange.hardWordCountLimit,
    },
    contextBlocks: sanitized.allowedBlocks,
  });
  return {
    assembled,
    prepared,
    targetRange,
    removedBlockIds: sanitized.removedBlockIds,
  };
}

async function extractActualHook(args, chapter, content) {
  const [characters, summaryRow, factRows, timelineRows, previousSnapshot] = await Promise.all([
    prisma.character.findMany({
      where: { novelId: args.novelId },
      select: { id: true, name: true, currentGoal: true, currentState: true, role: true },
    }),
    prisma.chapterSummary.findUnique({
      where: { chapterId: chapter.id },
      select: { summary: true, keyEvents: true, characterStates: true, hook: true },
    }),
    prisma.consistencyFact.findMany({
      where: { novelId: args.novelId, chapterId: chapter.id },
      select: { category: true, content: true },
    }),
    prisma.characterTimeline.findMany({
      where: { novelId: args.novelId, chapterId: chapter.id, source: "chapter_extract" },
      select: { characterId: true, content: true },
    }),
    prisma.storyStateSnapshot.findFirst({
      where: { novelId: args.novelId, sourceChapter: { order: { lt: chapter.order } } },
      orderBy: { createdAt: "desc" },
      select: { summary: true },
    }),
  ]);
  const extracted = await extractSnapshotWithAI({
    novelId: args.novelId,
    chapter: {
      id: chapter.id,
      title: chapter.title,
      order: chapter.order,
      expectation: chapter.expectation ?? null,
    },
    content,
    characters,
    summaryRow,
    factRows,
    timelineRows,
    previousSnapshot,
    options: {
      provider: args.provider,
      model: args.model,
      temperature: 0.2,
    },
  });
  return extracted.chapter_meta?.kind_of_hook
    ?? extracted.chapterMeta?.kindOfHook
    ?? "missing";
}

async function runBatch(args) {
  await fs.mkdir(args.outDir, { recursive: true });
  const chapters = await prisma.chapter.findMany({
    where: {
      novelId: args.novelId,
      order: { gte: args.start, lte: args.end },
    },
    orderBy: { order: "asc" },
    select: {
      id: true,
      title: true,
      order: true,
      content: true,
      expectation: true,
      targetWordCount: true,
      taskSheet: true,
    },
  });
  const llm = await getLLM(args.provider, {
    model: args.model,
    temperature: args.temperature,
    taskType: "writer",
  });
  const metrics = [];
  for (const chapter of chapters) {
    const promptStart = Date.now();
    const { prepared, targetRange, removedBlockIds } = await buildWriterPrompt(args, chapter);
    const promptText = renderPromptMarkdown(prepared.messages);
    const promptRenderMs = Date.now() - promptStart;
    const maxTokens = resolveWriterMaxTokens(targetRange.maxWordCount);
    const startedAt = Date.now();
    const result = await llm.invoke(prepared.messages, { maxTokens });
    const generationMs = Date.now() - startedAt;
    const rawContent = extractTextFromMessage(result);
    const content = sanitizeGeneratedChapterContent(rawContent).trim();
    const usage = extractPromptUsage(result);
    if (usage.promptTokens == null) {
      throw new Error(`Provider did not return actual prompt token usage for chapter ${chapter.order}: ${JSON.stringify(usage.rawUsage).slice(0, 600)}`);
    }
    const hook = await extractActualHook(args, chapter, content);
    const baselineChars = countChars(chapter.content ?? "");
    const outputChars = countChars(content);
    const promptPath = path.join(args.outDir, `chapter_${chapter.order}_prompt.md`);
    const contentPath = path.join(args.outDir, `chapter_${chapter.order}.txt`);
    await fs.writeFile(contentPath, content, "utf8");
    await fs.writeFile(promptPath, promptText, "utf8");
    metrics.push({
      chapterOrder: chapter.order,
      title: chapter.title,
      baselineChars,
      outputChars,
      charDelta: outputChars - baselineChars,
      kindOfHookActual: hook,
      promptTokensActual: usage.promptTokens,
      completionTokensActual: usage.completionTokens,
      totalTokensActual: usage.totalTokens,
      generationMs,
      promptRenderMs,
      removedBlockIds,
      promptCharCount: promptText.length,
      promptTokenEstimateLocalOnly: estimateTokenCount(promptText),
      contentPath: path.relative(REPO_ROOT, contentPath),
      promptPath: path.relative(REPO_ROOT, promptPath),
    });
    console.log(JSON.stringify(metrics[metrics.length - 1]));
  }
  const promptTokens = metrics.map((item) => item.promptTokensActual);
  const summary = {
    rolloutBatch: process.env.CHAPTER_QUALITY_ROLLOUT_BATCH,
    provider: args.provider,
    model: args.model,
    chapters: metrics,
    promptTokensAverage: Math.round(promptTokens.reduce((sum, value) => sum + value, 0) / promptTokens.length),
    promptTokensMax: Math.max(...promptTokens),
    generatedAt: new Date().toISOString(),
  };
  await fs.writeFile(path.join(args.outDir, "metrics.json"), JSON.stringify(summary, null, 2), "utf8");
  console.log(JSON.stringify(summary, null, 2));
}

async function runPromptProof(args) {
  process.env.CHAPTER_QUALITY_ROLLOUT_BATCH = "3";
  await fs.mkdir(PROMPT_PROOF_DIR, { recursive: true });
  const chapter = await prisma.chapter.findFirst({
    where: { novelId: args.novelId, order: args.start },
    select: {
      id: true,
      title: true,
      order: true,
      content: true,
      expectation: true,
      targetWordCount: true,
      taskSheet: true,
    },
  });
  if (!chapter) {
    throw new Error(`Chapter ${args.start} not found.`);
  }
  const { prepared } = await buildWriterPrompt(args, chapter, {
    chapterMeta: {
      eventWeight: 5,
      highStakesDialogue: true,
      schemeBeat: true,
      kindOfHook: "suspense_question",
    },
  });
  const text = renderPromptMarkdown(prepared.messages);
  const outPath = path.join(PROMPT_PROOF_DIR, "high_pressure_prompt.md");
  await fs.writeFile(outPath, text, "utf8");
  console.log(JSON.stringify({
    promptPath: path.relative(REPO_ROOT, outPath),
    messages: prepared.messages.length,
    estimatedFullPromptTokensLocalOnly: estimateTokenCount(text),
    promptInvocationEstimatedContextTokens: prepared.invocation.estimatedInputTokens,
  }, null, 2));
}

async function main() {
  const args = parseArgs(process.argv);
  try {
    if (args.mode === "prompt-proof") {
      await runPromptProof(args);
    } else {
      await runBatch(args);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
