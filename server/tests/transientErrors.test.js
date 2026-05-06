const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isTransientLlmTransportError,
  collectErrorCodes,
  collectErrorMessages,
} = require("../dist/llm/transientErrors.js");

test("detects nested provider 500 stream failures as transient transport errors", () => {
  const error = {
    name: "APIError",
    message: "unknown error, 500 (1000)",
    error: {
      type: "server_error",
      message: "unknown error, 500 (1000)",
      http_code: "500",
    },
  };

  assert.equal(isTransientLlmTransportError(error), true);
  assert.ok(collectErrorCodes(error).includes("500"));
  assert.ok(collectErrorMessages(error).includes("server_error"));
});

test("does not mark ordinary validation errors as transient transport failures", () => {
  const error = new Error("LLM 未返回合法的 JSON 数组。");

  assert.equal(isTransientLlmTransportError(error), false);
});
