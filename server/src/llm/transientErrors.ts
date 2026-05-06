type ErrorLike = {
  code?: unknown;
  errno?: unknown;
  status?: unknown;
  statusCode?: unknown;
  http_code?: unknown;
  type?: unknown;
  message?: unknown;
  name?: unknown;
  cause?: unknown;
  error?: unknown;
  response?: unknown;
  errors?: unknown;
};

function isRecord(value: unknown): value is ErrorLike {
  return typeof value === "object" && value !== null;
}

export function collectErrorMessages(error: unknown, depth = 0): string[] {
  if (!error || depth > 6) {
    return [];
  }
  if (typeof error === "string") {
    return [error];
  }
  if (!isRecord(error)) {
    return [];
  }

  const ownMessages = [
    typeof error.name === "string" ? error.name : "",
    typeof error.type === "string" ? error.type : "",
    typeof error.message === "string" ? error.message : "",
  ].filter(Boolean);
  const nested = collectErrorMessages(error.cause, depth + 1);
  const nestedError = collectErrorMessages(error.error, depth + 1);
  const nestedResponse = collectErrorMessages(error.response, depth + 1);
  const children = Array.isArray(error.errors)
    ? error.errors.flatMap((item) => collectErrorMessages(item, depth + 1))
    : [];

  return [...ownMessages, ...nested, ...nestedError, ...nestedResponse, ...children];
}

export function collectErrorCodes(error: unknown, depth = 0): string[] {
  if (!error || depth > 6 || !isRecord(error)) {
    return [];
  }

  const ownCodes = [error.code, error.errno, error.status, error.statusCode, error.http_code]
    .filter((value) => typeof value === "string" || typeof value === "number")
    .map(String);
  const nested = collectErrorCodes(error.cause, depth + 1);
  const nestedError = collectErrorCodes(error.error, depth + 1);
  const nestedResponse = collectErrorCodes(error.response, depth + 1);
  const children = Array.isArray(error.errors)
    ? error.errors.flatMap((item) => collectErrorCodes(item, depth + 1))
    : [];

  return [...ownCodes, ...nested, ...nestedError, ...nestedResponse, ...children];
}

function collectHttpStatuses(error: unknown): number[] {
  return collectErrorCodes(error)
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isFinite(value));
}

export function isTransientLlmTransportError(error: unknown): boolean {
  const codes = collectErrorCodes(error).map((code) => code.toUpperCase());
  if (codes.some((code) => [
    "UND_ERR_BODY_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_SOCKET",
    "ETIMEDOUT",
    "ECONNRESET",
    "EPIPE",
    "EAI_AGAIN",
    "ENOTFOUND",
  ].includes(code))) {
    return true;
  }

  const statuses = collectHttpStatuses(error);
  if (statuses.some((status) => status === 408 || status === 409 || status === 425 || status === 429 || status >= 500)) {
    return true;
  }

  const messages = collectErrorMessages(error).map((message) => message.toLowerCase());
  return messages.some((message) => [
    "und_err_body_timeout",
    "und_err_headers_timeout",
    "body timeout",
    "headers timeout",
    "connect timeout",
    "read etimedout",
    "etimedout",
    "fetch failed",
    "network error",
    "socket hang up",
    "terminated",
    "temporarily unavailable",
    "server_error",
    "unknown error, 500",
  ].some((fragment) => message.includes(fragment)));
}
