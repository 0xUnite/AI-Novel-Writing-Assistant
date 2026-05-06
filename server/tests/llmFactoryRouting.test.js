const test = require("node:test");
const assert = require("node:assert/strict");

const { prisma } = require("../dist/db/prisma.js");
const { resolveLLMClientOptions, setProviderSecretCache } = require("../dist/llm/factory.js");

test("resolveLLMClientOptions uses the routed provider when only model is explicitly supplied", async () => {
  const originalFindUnique = prisma.modelRouteConfig.findUnique;

  prisma.modelRouteConfig.findUnique = async () => ({
    taskType: "repair",
    provider: "minimax",
    model: "MiniMax-M2.7",
    temperature: 0.4,
    maxTokens: null,
  });

  setProviderSecretCache("minimax", { key: "test-minimax-key" });
  setProviderSecretCache("deepseek", null);

  try {
    const resolved = await resolveLLMClientOptions(undefined, {
      taskType: "repair",
      model: "MiniMax-M2.7-highspeed",
      fallbackProvider: "deepseek",
    });

    assert.equal(resolved.provider, "minimax");
    assert.equal(resolved.model, "MiniMax-M2.7-highspeed");
    assert.equal(resolved.providerName, "MiniMax");
    assert.equal(resolved.apiKey, "test-minimax-key");
  } finally {
    prisma.modelRouteConfig.findUnique = originalFindUnique;
    setProviderSecretCache("minimax", null);
  }
});
