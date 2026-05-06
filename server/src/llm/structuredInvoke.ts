import { z, type ZodError, type ZodType } from "zod";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import type { LLMProvider } from "@ai-novel/shared/types/llm";
import type { TaskType } from "./modelRouter";
import { getLLM } from "./factory";
import { getJsonCapability } from "./capabilities";
import { isTransientLlmTransportError } from "./transientErrors";
import { toText, extractJSONValue } from "../services/novel/novelP0Utils";
import type { PromptInvocationMeta } from "../prompting/core/promptTypes";

export interface StructuredInvokeInput<T> {
  systemPrompt?: string;
  userPrompt?: string;
  messages?: BaseMessage[];
  schema: ZodType<T>;
  provider?: LLMProvider;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  taskType?: TaskType;
  label: string;
  maxRepairAttempts?: number; // 默认 1
  promptMeta?: PromptInvocationMeta;
}

export interface StructuredInvokeResult<T> {
  data: T;
  repairUsed: boolean;
  repairAttempts: number;
}

export interface StructuredInvokeRawParseInput<T> {
  rawContent: string;
  schema: ZodType<T>;
  provider?: LLMProvider;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  taskType?: TaskType;
  label: string;
  maxRepairAttempts?: number;
  promptMeta?: PromptInvocationMeta;
}

function buildInvokeMessages<T>(input: StructuredInvokeInput<T>): BaseMessage[] {
  if (Array.isArray(input.messages) && input.messages.length > 0) {
    return input.messages;
  }
  if (typeof input.systemPrompt === "string" && typeof input.userPrompt === "string") {
    return [new SystemMessage(input.systemPrompt), new HumanMessage(input.userPrompt)];
  }
  throw new Error(`[${input.label}] missing prompt messages.`);
}

function tryFixTruncatedJson(raw: string): string {
  const text = raw.trim();
  if (!text) return text;

  // 简单的括号/方括号补全：用于模型输出被截断时提升成功率。
  const count = (re: RegExp) => (text.match(re) ?? []).length;
  const openBraces = count(/{/g);
  const closeBraces = count(/}/g);
  const openBrackets = count(/\[/g);
  const closeBrackets = count(/]/g);

  let fixed = text;

  // 去掉可能的末尾多余逗号（降低修复难度）
  fixed = fixed.replace(/,\s*$/g, "");

  if (openBrackets > closeBrackets) {
    fixed += "]".repeat(openBrackets - closeBrackets);
  }
  if (openBraces > closeBraces) {
    fixed += "}".repeat(openBraces - closeBraces);
  }
  return fixed;
}

function normalizeSmartQuotes(raw: string): string {
  return raw
    .replace(/[“”„‟]/g, "\"")
    .replace(/[‘’‚‛]/g, "'");
}

function normalizeJsonPunctuationOutsideStrings(raw: string): string {
  if (!raw) {
    return raw;
  }

  let result = "";
  let inString = false;
  let escaped = false;

  for (const char of raw) {
    if (escaped) {
      result += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      result += char;
      escaped = true;
      continue;
    }

    if (char === "\"") {
      result += char;
      inString = !inString;
      continue;
    }

    if (!inString) {
      if (char === "，") {
        result += ",";
        continue;
      }
      if (char === "：") {
        result += ":";
        continue;
      }
    }

    result += char;
  }

  return result;
}

function stripTrailingCommasBeforeClosers(raw: string): string {
  return raw.replace(/,\s*([}\]])/g, "$1");
}

function insertMissingCommasBetweenTokens(raw: string): string {
  const pattern = /("(?:\\.|[^"\\])*"|\btrue\b|\bfalse\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[}\]])(\s+)(?=("|\{|\[|-?\d|\btrue\b|\bfalse\b|\bnull\b))/g;
  let fixed = raw;

  for (let round = 0; round < 6; round += 1) {
    const next = fixed.replace(pattern, "$1,$2");
    if (next === fixed) {
      break;
    }
    fixed = next;
  }

  return fixed;
}

function escapeSuspiciousQuotesInsideStrings(raw: string): string {
  if (!raw) {
    return raw;
  }

  let result = "";
  let inString = false;
  let escaped = false;

  const findNextNonWhitespace = (from: number): string => {
    for (let index = from; index < raw.length; index += 1) {
      const char = raw[index];
      if (!/\s/.test(char)) {
        return char;
      }
    }
    return "";
  };

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];

    if (!inString) {
      result += char;
      if (char === "\"") {
        inString = true;
      }
      continue;
    }

    if (escaped) {
      result += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      result += char;
      escaped = true;
      continue;
    }

    if (char === "\"") {
      const nextNonWhitespace = findNextNonWhitespace(index + 1);
      if (nextNonWhitespace && ![",", "}", "]", ":"].includes(nextNonWhitespace)) {
        result += "\\\"";
        continue;
      }

      result += char;
      inString = false;
      continue;
    }

    result += char;
  }

  return result;
}

function extractJsonErrorPosition(message: string): number | null {
  const match = message.match(/position\s+(\d+)/i);
  if (!match) {
    return null;
  }
  const value = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(value) ? value : null;
}

function insertCommaAtPosition(raw: string, position: number): string {
  if (position < 0 || position > raw.length) {
    return raw;
  }
  return `${raw.slice(0, position)},${raw.slice(position)}`;
}

function escapeQuoteAtPosition(raw: string, position: number): string {
  if (position < 0 || position >= raw.length || raw[position] !== "\"") {
    return raw;
  }
  if (position > 0 && raw[position - 1] === "\\") {
    return raw;
  }
  return `${raw.slice(0, position)}\\${raw.slice(position)}`;
}

function findPreviousUnescapedQuote(raw: string, position: number): number | null {
  for (let index = Math.min(position - 1, raw.length - 1); index >= 0; index -= 1) {
    if (raw[index] !== "\"") {
      continue;
    }
    if (index > 0 && raw[index - 1] === "\\") {
      continue;
    }
    return index;
  }
  return null;
}

function findPreviousNonWhitespaceChar(raw: string, position: number): string {
  for (let index = Math.min(position - 1, raw.length - 1); index >= 0; index -= 1) {
    const char = raw[index];
    if (!/\s/.test(char)) {
      return char;
    }
  }
  return "";
}

function isLikelyStringBoundaryQuote(raw: string, position: number): boolean {
  const previousNonWhitespace = findPreviousNonWhitespaceChar(raw, position);
  return previousNonWhitespace === ":"
    || previousNonWhitespace === ","
    || previousNonWhitespace === "{"
    || previousNonWhitespace === "[";
}

function buildErrorPositionRepairCandidates(raw: string, errorMessage: string): string[] {
  const position = extractJsonErrorPosition(errorMessage);
  if (position == null) {
    return [];
  }

  const candidates = new Set<string>();
  const isStringLiteralError = /string literal|control character/i.test(errorMessage);

  if (!isStringLiteralError) {
    candidates.add(insertCommaAtPosition(raw, position));
  }

  if (position < raw.length && raw[position] === "\"" && !isLikelyStringBoundaryQuote(raw, position)) {
    candidates.add(escapeQuoteAtPosition(raw, position));
  }

  const previousQuote = findPreviousUnescapedQuote(raw, position);
  if (previousQuote != null) {
    if (!isLikelyStringBoundaryQuote(raw, previousQuote)) {
      candidates.add(escapeQuoteAtPosition(raw, previousQuote));
    }
    if (!isStringLiteralError) {
      candidates.add(insertCommaAtPosition(raw, previousQuote + 1));
    }
  }

  candidates.delete(raw);
  return Array.from(candidates).filter(Boolean);
}

function sanitizeControlCharactersInsideJsonStrings(raw: string): string {
  if (!raw) {
    return raw;
  }

  let result = "";
  let inString = false;
  let escaped = false;

  for (const char of raw) {
    if (!inString) {
      result += char;
      if (char === "\"") {
        inString = true;
      }
      continue;
    }

    if (escaped) {
      result += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      result += char;
      escaped = true;
      continue;
    }

    if (char === "\"") {
      result += char;
      inString = false;
      continue;
    }

    const code = char.charCodeAt(0);
    if (code <= 0x1f) {
      if (char === "\n") {
        result += "\\n";
      } else if (char === "\r") {
        result += "\\r";
      } else if (char === "\t") {
        result += "\\t";
      } else {
        result += " ";
      }
      continue;
    }

    result += char;
  }

  return result;
}

function extractParseCandidate(raw: string): string {
  const withoutThink = raw.replace(/<think>[\s\S]*?<\/think>/gi, "");
  try {
    return extractJSONValue(withoutThink);
  } catch {
    return withoutThink.replace(/```json|```/gi, "").trim();
  }
}

function tryParseJsonCandidate(candidate: string): { parsed: unknown } | { error: string } {
  try {
    return {
      parsed: JSON.parse(candidate) as unknown,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function pushJsonRepairCandidate(
  candidates: Array<{ label: string; value: string }>,
  seen: Set<string>,
  label: string,
  value: string,
): void {
  if (!value || seen.has(value)) {
    return;
  }
  seen.add(value);
  candidates.push({ label, value });
}

function buildJsonRepairCandidates(source: string): Array<{ label: string; value: string }> {
  const candidates: Array<{ label: string; value: string }> = [];
  const seen = new Set<string>();
  const base = extractParseCandidate(source);

  pushJsonRepairCandidate(candidates, seen, "原始提取", base);

  const sanitized = sanitizeControlCharactersInsideJsonStrings(base);
  pushJsonRepairCandidate(candidates, seen, "控制字符清洗", sanitized);

  const normalizedQuotes = normalizeSmartQuotes(sanitized);
  pushJsonRepairCandidate(candidates, seen, "智能引号归一化", normalizedQuotes);

  const normalizedPunctuation = normalizeJsonPunctuationOutsideStrings(normalizedQuotes);
  pushJsonRepairCandidate(candidates, seen, "标点归一化", normalizedPunctuation);

  const withoutTrailingCommas = stripTrailingCommasBeforeClosers(normalizedPunctuation);
  pushJsonRepairCandidate(candidates, seen, "去除尾随逗号", withoutTrailingCommas);

  const withInsertedCommas = insertMissingCommasBetweenTokens(withoutTrailingCommas);
  pushJsonRepairCandidate(candidates, seen, "缺失逗号修复", withInsertedCommas);

  const withEscapedQuotes = escapeSuspiciousQuotesInsideStrings(withInsertedCommas);
  pushJsonRepairCandidate(candidates, seen, "字符串裸引号转义", withEscapedQuotes);

  // 裸引号修复后，字符串边界可能恢复正常，此时再清洗一次控制字符。
  const resanitizedAfterQuoteEscape = sanitizeControlCharactersInsideJsonStrings(withEscapedQuotes);
  pushJsonRepairCandidate(candidates, seen, "二次控制字符清洗", resanitizedAfterQuoteEscape);

  const repunctuatedAfterResanitize = normalizeJsonPunctuationOutsideStrings(resanitizedAfterQuoteEscape);
  pushJsonRepairCandidate(candidates, seen, "二次标点归一化", repunctuatedAfterResanitize);

  const withoutTrailingCommasAfterResanitize = stripTrailingCommasBeforeClosers(repunctuatedAfterResanitize);
  pushJsonRepairCandidate(candidates, seen, "二次去除尾随逗号", withoutTrailingCommasAfterResanitize);

  const withInsertedCommasAfterResanitize = insertMissingCommasBetweenTokens(withoutTrailingCommasAfterResanitize);
  pushJsonRepairCandidate(candidates, seen, "二次缺失逗号修复", withInsertedCommasAfterResanitize);

  const truncatedFixed = tryFixTruncatedJson(withInsertedCommasAfterResanitize);
  pushJsonRepairCandidate(candidates, seen, "截断补全", truncatedFixed);

  return candidates;
}

function tryParseStructuredJsonValue(source: string): { parsed: unknown } | { error: string } {
  const attempts: string[] = [];
  const seenCandidateValues = new Set<string>();
  const candidates = buildJsonRepairCandidates(source);

  for (const candidate of candidates) {
    if (seenCandidateValues.has(candidate.value)) {
      continue;
    }
    seenCandidateValues.add(candidate.value);
    const result = tryParseJsonCandidate(candidate.value);
    if ("parsed" in result) {
      return result;
    }
    attempts.push(`${candidate.label}后仍失败：${result.error}`);

    for (const extraCandidate of buildErrorPositionRepairCandidates(candidate.value, result.error)) {
      for (const nestedCandidate of buildJsonRepairCandidates(extraCandidate)) {
        if (seenCandidateValues.has(nestedCandidate.value)) {
          continue;
        }
        seenCandidateValues.add(nestedCandidate.value);
        const nestedResult = tryParseJsonCandidate(nestedCandidate.value);
        if ("parsed" in nestedResult) {
          return nestedResult;
        }
        attempts.push(`按报错位置定点修复/${nestedCandidate.label}后仍失败：${nestedResult.error}`);
      }
    }
  }

  return {
    error: ["JSON 解析失败：", ...attempts].join("\n"),
  };
}

class StructuredRepairError extends Error {
  readonly repairedRaw: string;
  readonly nextValidationError: string;

  constructor(message: string, input: { repairedRaw: string; nextValidationError: string }) {
    super(message);
    this.name = "StructuredRepairError";
    this.repairedRaw = input.repairedRaw;
    this.nextValidationError = input.nextValidationError;
  }
}

function formatZodErrors(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length ? issue.path.join(".") : "(root)";
      return `- ${path}: ${issue.message}`;
    })
    .join("\n");
}

function extractValidationPaths(validationError: string): string[] {
  return Array.from(
    new Set(
      validationError
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith("- "))
        .map((line) => {
          const colonIndex = line.indexOf(":");
          return colonIndex > 2 ? line.slice(2, colonIndex).trim() : "";
        })
        .filter(Boolean),
    ),
  );
}

function schemaAllowsTopLevelArray<T>(schema: ZodType<T>): boolean {
  const probe = schema.safeParse([]);
  if (probe.success) {
    return true;
  }
  return probe.error.issues.some((issue) => issue.path.length === 0 && issue.code !== "invalid_type");
}

function logStructuredInvokeEvent(input: {
  event: string;
  label: string;
  provider?: LLMProvider;
  model?: string;
  taskType?: TaskType;
  latencyMs?: number;
  rawChars?: number;
  repairAttempt?: number;
}): void {
  console.info(
    [
      "[structured.invoke]",
      `event=${input.event}`,
      `label=${input.label}`,
      `provider=${input.provider ?? "default"}`,
      `model=${input.model ?? "default"}`,
      `taskType=${input.taskType ?? "planner"}`,
      typeof input.repairAttempt === "number" ? `repairAttempt=${input.repairAttempt}` : "",
      typeof input.latencyMs === "number" ? `latencyMs=${input.latencyMs}` : "",
      typeof input.rawChars === "number" ? `rawChars=${input.rawChars}` : "",
    ].filter(Boolean).join(" "),
  );
}

function isRetryableStructuredInvokeError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (isTransientLlmTransportError(error)) {
    return true;
  }
  const message = error.message.toLowerCase();
  return [
    "fetch failed",
    "network error",
    "socket hang up",
    "econnreset",
    "eai_again",
    "etimedout",
    "timeout",
    "temporarily unavailable",
  ].some((fragment) => message.includes(fragment));
}

async function delayMs(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function shouldUseJsonObjectResponseFormat<T>(
  provider: LLMProvider,
  model: string | undefined,
  schema: ZodType<T>,
): boolean {
  if (!getJsonCapability(provider, model).supportsJsonObject) {
    return false;
  }
  return !schemaAllowsTopLevelArray(schema);
}

async function repairWithLlm<T>(
  input: Pick<StructuredInvokeInput<T>, "provider" | "model" | "maxTokens" | "taskType" | "label" | "schema" | "promptMeta">,
  rawContent: string,
  validationError: string,
  repairAttempt: number,
): Promise<T> {
  logStructuredInvokeEvent({
    event: "repair_start",
    label: input.label,
    provider: input.provider,
    model: input.model,
    taskType: input.taskType,
    repairAttempt,
  });
  const llm = await getLLM(input.provider, {
    fallbackProvider: "deepseek",
    model: input.model,
    temperature: 0.15,
    maxTokens: input.maxTokens,
    taskType: input.taskType ?? "planner",
    promptMeta: input.promptMeta ? {
      ...input.promptMeta,
      repairUsed: true,
      repairAttempts: repairAttempt,
    } : undefined,
  });

  const repairSystem = [
    "你是 JSON 修复器。",
    "你的任务是：只输出严格合法的 JSON 值，且必须通过给定的结构校验。",
    "最终输出可能是 JSON 对象，也可能是 JSON 数组；必须与目标结构一致。",
    "不要输出任何解释、Markdown 或额外字段。",
    "如果校验错误提示某个字段缺失，必须直接使用错误路径里的字段名作为 JSON 键名，不要翻译成中文别名。",
    "如果目标结构顶层是数组，就直接输出数组本身，不要再外包一层对象。",
    "如果原始 JSON 多包了一层无关包装键，例如 data、result、output、xxxProjection、xxxList 等，必须去掉包装层，把真正目标结构提升到顶层。",
    "如果缺失必填字符串字段，必须补出非空字符串；可根据原始 JSON 中已有内容做最小、保守、语义一致的补全，不能输出空字符串、null 或 undefined。",
    "如果目标结构顶层需要多个兄弟字段，例如 expansion、decomposition、constraints，必须一次性补齐所有必填顶层字段，不能只返回其中一部分。",
    "如果必填字段是对象或数组，必须输出合法对象或数组，不能用空字符串、null、undefined 占位。",
  ].join("\n");

  const validationPaths = extractValidationPaths(validationError);

  const repairHuman = [
    `校验失败：${input.label}`,
    validationError,
    ...(validationPaths.length > 0 ? [
      "",
      `至少需要修复这些路径：${validationPaths.join(", ")}`,
    ] : []),
    "",
    "原始模型输出（可能包含多余文字/markdown/截断）：",
    rawContent,
    "",
    "请修复后只输出最终 JSON。",
  ].join("\n");

  const startedAt = Date.now();
  const result = await llm.invoke([new SystemMessage(repairSystem), new HumanMessage(repairHuman)]);
  const repairedRaw = toText(result.content);
  logStructuredInvokeEvent({
    event: "repair_done",
    label: input.label,
    provider: input.provider,
    model: input.model,
    taskType: input.taskType,
    repairAttempt,
    latencyMs: Date.now() - startedAt,
    rawChars: repairedRaw.length,
  });
  const repairParse = tryParseStructuredJsonValue(repairedRaw);
  if ("error" in repairParse) {
    throw new StructuredRepairError(`[${input.label}] JSON repair 后仍无法解析。错误：${repairParse.error}`, {
      repairedRaw,
      nextValidationError: repairParse.error,
    });
  }

  const final = input.schema.safeParse(repairParse.parsed);
  if (!final.success) {
    throw new StructuredRepairError(`[${input.label}] JSON repair 后仍未通过 Schema 校验。错误：${formatZodErrors(final.error)}`, {
      repairedRaw,
      nextValidationError: `Zod 校验错误：\n${formatZodErrors(final.error)}`,
    });
  }
  return final.data;
}

export async function parseStructuredLlmRawContentDetailed<T>(
  input: StructuredInvokeRawParseInput<T>,
): Promise<StructuredInvokeResult<T>> {
  const initialParse = tryParseStructuredJsonValue(input.rawContent);
  const parseErrorMessage = "error" in initialParse ? initialParse.error : "";
  const parsed = "parsed" in initialParse ? initialParse.parsed : null;

  const maxRepairAttempts = input.maxRepairAttempts ?? 1;
  if (parseErrorMessage) {
    let repairRaw = input.rawContent;
    let currentValidationError = parseErrorMessage;
    for (let attempt = 1; attempt <= maxRepairAttempts; attempt += 1) {
      try {
        return {
          data: await repairWithLlm(input, repairRaw, currentValidationError, attempt),
          repairUsed: true,
          repairAttempts: attempt,
        };
      } catch (repairError) {
        if (repairError instanceof StructuredRepairError) {
          repairRaw = repairError.repairedRaw;
          currentValidationError = repairError.nextValidationError;
        }
        if (attempt >= maxRepairAttempts) {
          throw repairError;
        }
      }
    }
    throw new Error(`[${input.label}] JSON 解析失败且修复未成功。`);
  }

  const first = input.schema.safeParse(parsed);
  if (first.success) {
    return {
      data: first.data,
      repairUsed: false,
      repairAttempts: 0,
    };
  }

  let zodError: ZodError = first.error;
  let repairRaw = input.rawContent;
  let currentValidationError = `Zod 校验错误：\n${formatZodErrors(zodError)}`;

  for (let attempt = 1; attempt <= maxRepairAttempts; attempt += 1) {
    try {
      return {
        data: await repairWithLlm(input, repairRaw, currentValidationError, attempt),
        repairUsed: true,
        repairAttempts: attempt,
      };
    } catch (error) {
      if (error instanceof StructuredRepairError) {
        repairRaw = error.repairedRaw;
        currentValidationError = error.nextValidationError;
      }
      if (attempt >= maxRepairAttempts) {
        throw error;
      }
      if (error instanceof z.ZodError) {
        zodError = error as ZodError;
      }
    }
  }

  throw new Error(`[${input.label}] LLM 输出经修复后仍未通过 Schema 校验。错误：${formatZodErrors(zodError)}`);
}

export async function invokeStructuredLlmDetailed<T>(input: StructuredInvokeInput<T>): Promise<StructuredInvokeResult<T>> {
  const llm = await getLLM(input.provider, {
    fallbackProvider: "deepseek",
    model: input.model,
    temperature: input.temperature ?? 0.3,
    maxTokens: input.maxTokens,
    taskType: input.taskType ?? "planner",
    promptMeta: input.promptMeta,
  });

  const capabilityProvider = input.provider ?? "minimax";
  const cap = getJsonCapability(capabilityProvider, input.model);

  const invokeOptions: Record<string, unknown> = {};
  if (cap.supportsJsonObject && shouldUseJsonObjectResponseFormat(capabilityProvider, input.model, input.schema)) {
    invokeOptions.response_format = { type: "json_object" };
  }

  const messages = buildInvokeMessages(input);
  logStructuredInvokeEvent({
    event: "invoke_start",
    label: input.label,
    provider: input.provider,
    model: input.model,
    taskType: input.taskType,
  });
  let rawContent = "";
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const startedAt = Date.now();
    try {
      const result = await llm.invoke(messages, invokeOptions);
      rawContent = toText(result.content);
      logStructuredInvokeEvent({
        event: "invoke_done",
        label: input.label,
        provider: input.provider,
        model: input.model,
        taskType: input.taskType,
        latencyMs: Date.now() - startedAt,
        rawChars: rawContent.length,
      });
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      logStructuredInvokeEvent({
        event: attempt >= 2 || !isRetryableStructuredInvokeError(error) ? "invoke_failed" : "invoke_retry",
        label: input.label,
        provider: input.provider,
        model: input.model,
        taskType: input.taskType,
        latencyMs: Date.now() - startedAt,
        repairAttempt: attempt,
      });
      if (attempt >= 2 || !isRetryableStructuredInvokeError(error)) {
        throw error;
      }
      await delayMs(600 * attempt);
    }
  }

  if (lastError) {
    throw lastError;
  }

  return parseStructuredLlmRawContentDetailed({
    rawContent,
    schema: input.schema,
    provider: input.provider,
    model: input.model,
    temperature: input.temperature,
    maxTokens: input.maxTokens,
    taskType: input.taskType,
    label: input.label,
    maxRepairAttempts: input.maxRepairAttempts,
    promptMeta: input.promptMeta,
  });
}

export async function invokeStructuredLlm<T>(input: StructuredInvokeInput<T>): Promise<T> {
  const result = await invokeStructuredLlmDetailed(input);
  return result.data;
}
