import type { LLMProvider } from "@ai-novel/shared/types/llm";
import { ChatOpenAI } from "@langchain/openai";
import { prisma } from "../db/prisma";
import type { PromptInvocationMeta } from "../prompting/core/promptTypes";
import { resolveModelTemperature } from "./capabilities";
import { attachLLMDebugLogging } from "./debugLogging";
import { resolveModel, type TaskType } from "./modelRouter";
import {
  getProviderEnvApiKey,
  getProviderEnvModel,
  isBuiltInProvider,
  providerRequiresApiKey,
  PROVIDERS,
  resolveProviderBaseUrl,
} from "./providers";
import { collectErrorMessages, isTransientLlmTransportError } from "./transientErrors";

interface LLMOptions {
  model?: string;
  temperature?: number;
  apiKey?: string;
  baseURL?: string;
  maxTokens?: number;
  fallbackProvider?: LLMProvider;
  taskType?: TaskType;
  promptMeta?: PromptInvocationMeta;
}

export interface ProviderSecret {
  key?: string;
  model?: string;
  baseURL?: string;
  displayName?: string;
}

export interface ResolvedLLMClientOptions {
  provider: LLMProvider;
  providerName: string;
  model: string;
  temperature: number;
  apiKey?: string;
  baseURL: string;
  maxTokens?: number;
  taskType?: TaskType;
  promptMeta?: PromptInvocationMeta;
}

const providerSecrets = new Map<LLMProvider, ProviderSecret>();
const LLM_TIMEOUT_PATCHED = Symbol("LLM_TIMEOUT_PATCHED");
const PLANNER_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

type PatchableChatOpenAI = ChatOpenAI & {
  [LLM_TIMEOUT_PATCHED]?: boolean;
};

function isMissingTableError(error: unknown): boolean {
  return (
    typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: string }).code === "P2021"
  );
}

function normalizeOptionalText(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeProviderSecret(secret: ProviderSecret): ProviderSecret {
  return {
    key: normalizeOptionalText(secret.key),
    model: normalizeOptionalText(secret.model),
    baseURL: normalizeOptionalText(secret.baseURL),
    displayName: normalizeOptionalText(secret.displayName),
  };
}

function getLLMTimeoutMs(taskType?: TaskType): number {
  if (taskType === "planner") {
    return PLANNER_TIMEOUT_MS;
  }
  return DEFAULT_TIMEOUT_MS;
}

function isBodyTimeoutError(error: unknown): boolean {
  return isTransientLlmTransportError(error);
}

function buildGracefulTimeoutError(
  error: unknown,
  input: ResolvedLLMClientOptions,
  timeoutMs: number,
): Error {
  if (!isBodyTimeoutError(error)) {
    return error instanceof Error ? error : new Error(String(error));
  }
  const timeoutMinutes = Math.max(1, Math.round(timeoutMs / 60000));
  const promptName = input.promptMeta?.promptId ? `（${input.promptMeta.promptId}）` : "";
  const detail = collectErrorMessages(error).join(" / ").slice(0, 160);
  const detailSuffix = detail ? ` 原因：${detail}` : "";
  const gracefulError = new Error(
    `${input.providerName} 的模型响应超时或连接中断${promptName}。当前任务已等待约 ${timeoutMinutes} 分钟，后端已优雅中止本次调用，请稍后重试或缩短单次输出长度。${detailSuffix}`,
  );
  (gracefulError as Error & { cause?: unknown }).cause = error;
  return gracefulError;
}

function wrapStreamWithTimeoutHandling<TChunk>(
  stream: AsyncIterable<TChunk>,
  input: ResolvedLLMClientOptions,
  timeoutMs: number,
): AsyncIterable<TChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      try {
        for await (const chunk of stream) {
          yield chunk;
        }
      } catch (error) {
        throw buildGracefulTimeoutError(error, input, timeoutMs);
      }
    },
  };
}

function attachTimeoutErrorHandling(
  llm: ChatOpenAI,
  input: ResolvedLLMClientOptions,
  timeoutMs: number,
): ChatOpenAI {
  const patchable = llm as PatchableChatOpenAI;
  if (patchable[LLM_TIMEOUT_PATCHED]) {
    return llm;
  }

  const originalInvoke = llm.invoke.bind(llm);
  const originalBatch = llm.batch.bind(llm);
  const originalStream = llm.stream.bind(llm);

  patchable.invoke = (async (...args: Parameters<ChatOpenAI["invoke"]>) => {
    try {
      return await originalInvoke(...args);
    } catch (error) {
      throw buildGracefulTimeoutError(error, input, timeoutMs);
    }
  }) as ChatOpenAI["invoke"];

  patchable.batch = (async (...args: Parameters<ChatOpenAI["batch"]>) => {
    try {
      return await originalBatch(...args);
    } catch (error) {
      throw buildGracefulTimeoutError(error, input, timeoutMs);
    }
  }) as ChatOpenAI["batch"];

  patchable.stream = (async (...args: Parameters<ChatOpenAI["stream"]>) => {
    try {
      const stream = await originalStream(...args);
      return wrapStreamWithTimeoutHandling(stream, input, timeoutMs) as Awaited<ReturnType<ChatOpenAI["stream"]>>;
    } catch (error) {
      throw buildGracefulTimeoutError(error, input, timeoutMs);
    }
  }) as ChatOpenAI["stream"];

  Object.defineProperty(patchable, LLM_TIMEOUT_PATCHED, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  });

  return llm;
}

function toProviderSecret(item: {
  key?: string | null;
  model?: string | null;
  baseURL?: string | null;
  displayName?: string | null;
}): ProviderSecret {
  return normalizeProviderSecret({
    key: item.key ?? undefined,
    model: item.model ?? undefined,
    baseURL: item.baseURL ?? undefined,
    displayName: item.displayName ?? undefined,
  });
}

export async function loadProviderApiKeys(): Promise<void> {
  try {
    const keys = await prisma.aPIKey.findMany({
      where: { isActive: true },
    });
    providerSecrets.clear();
    for (const item of keys) {
      providerSecrets.set(item.provider as LLMProvider, toProviderSecret(item));
    }
  } catch (error) {
    if (isMissingTableError(error)) {
      return;
    }
    throw error;
  }
}

export function setProviderSecretCache(provider: LLMProvider, secret: ProviderSecret | null): void {
  if (!secret) {
    providerSecrets.delete(provider);
    return;
  }
  providerSecrets.set(provider, normalizeProviderSecret(secret));
}

async function resolveProviderSecret(provider: LLMProvider): Promise<ProviderSecret | undefined> {
  const cached = providerSecrets.get(provider);
  if (cached) {
    return cached;
  }
  try {
    const secret = await prisma.aPIKey.findUnique({
      where: { provider },
    });
    if (!secret || !secret.isActive) {
      return undefined;
    }
    const value = toProviderSecret(secret);
    providerSecrets.set(provider, value);
    return value;
  } catch (error) {
    if (isMissingTableError(error)) {
      return undefined;
    }
    throw error;
  }
}

export async function resolveLLMClientOptions(
  provider?: LLMProvider,
  options: LLMOptions = {},
): Promise<ResolvedLLMClientOptions> {
  let resolvedProvider = provider ?? options.fallbackProvider ?? "deepseek";
  let resolvedModel = normalizeOptionalText(options.model);
  let resolvedTemperature: number | undefined = options.temperature;
  let resolvedMaxTokens: number | undefined = options.maxTokens;

  if (options.taskType) {
    const hasExplicitProvider = provider != null;
    const hasExplicitModel = options.model != null;
    const shouldUseRouteProvider = !hasExplicitProvider;
    const shouldUseRouteModel = !hasExplicitModel;
    const route = await resolveModel(options.taskType, {
      ...(shouldUseRouteProvider ? {} : { provider: resolvedProvider }),
      ...(options.model != null ? { model: options.model } : {}),
      ...(options.temperature != null ? { temperature: options.temperature } : {}),
      ...(options.maxTokens != null ? { maxTokens: options.maxTokens } : {}),
    });
    if (shouldUseRouteProvider) {
      resolvedProvider = route.provider;
    }
    if (shouldUseRouteModel) {
      resolvedModel = normalizeOptionalText(route.model);
    }
    if (options.temperature == null) {
      resolvedTemperature = route.temperature;
    }
    if (options.maxTokens == null) {
      resolvedMaxTokens = route.maxTokens;
    }
  }

  const dbSecret = await resolveProviderSecret(resolvedProvider);
  const providerName = isBuiltInProvider(resolvedProvider)
    ? PROVIDERS[resolvedProvider].name
    : dbSecret?.displayName ?? resolvedProvider;
  const apiKey = normalizeOptionalText(options.apiKey)
    ?? dbSecret?.key
    ?? getProviderEnvApiKey(resolvedProvider);

  if (!apiKey && providerRequiresApiKey(resolvedProvider)) {
    throw new Error(`未配置 ${providerName} 的 API Key。`);
  }

  const model = resolvedModel
    ?? dbSecret?.model
    ?? getProviderEnvModel(resolvedProvider)
    ?? (isBuiltInProvider(resolvedProvider) ? PROVIDERS[resolvedProvider].defaultModel : undefined);
  if (!model) {
    throw new Error(`未配置 ${providerName} 的默认模型。`);
  }

  const baseURL = resolveProviderBaseUrl(
    resolvedProvider,
    options.baseURL ?? dbSecret?.baseURL,
    dbSecret?.baseURL,
  );
  if (!baseURL) {
    throw new Error(`未配置 ${providerName} 的 API URL。`);
  }

  const temperature = resolveModelTemperature(resolvedProvider, model, resolvedTemperature);

  return {
    provider: resolvedProvider,
    providerName,
    model,
    temperature,
    apiKey,
    baseURL,
    maxTokens: resolvedMaxTokens,
    taskType: options.taskType,
    promptMeta: options.promptMeta,
  };
}

export async function getLLM(provider?: LLMProvider, options: LLMOptions = {}): Promise<ChatOpenAI> {
  const resolved = await resolveLLMClientOptions(provider, options);
  const timeoutMs = getLLMTimeoutMs(resolved.taskType);

  const llm = new ChatOpenAI({
    apiKey: resolved.apiKey ?? "ollama",
    model: resolved.model,
    modelName: resolved.model,
    temperature: resolved.temperature,
    maxTokens: resolved.maxTokens,
    timeout: timeoutMs,
    configuration: {
      baseURL: resolved.baseURL,
    },
  });

  const loggedLLM = attachLLMDebugLogging(llm, {
    provider: resolved.provider,
    model: resolved.model,
    temperature: resolved.temperature,
    maxTokens: resolved.maxTokens,
    taskType: resolved.taskType,
    baseURL: resolved.baseURL,
    promptMeta: resolved.promptMeta,
  });

  return attachTimeoutErrorHandling(loggedLLM, resolved, timeoutMs);
}
