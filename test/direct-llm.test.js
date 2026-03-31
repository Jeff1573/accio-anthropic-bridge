"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DirectLlmClient,
  UpstreamHttpError,
  UpstreamSseError,
  buildDirectRequestFromAnthropic,
  buildDirectRequestFromOpenAi,
  extractThinkingConfigFromAnthropic,
  mapRequestedModel,
  supportsThinkingForModel
} = require("../src/direct-llm");

test("mapRequestedModel uses external alias config", () => {
  assert.equal(mapRequestedModel("gpt-5"), "claude-opus-4-6");
  assert.equal(mapRequestedModel("claude-sonnet-4-6"), "claude-sonnet-4-6");
  assert.equal(mapRequestedModel("custom-model"), "custom-model");
  assert.equal(mapRequestedModel("gemini-3-pro-preview"), "gemini-3.1-pro-preview");
  assert.equal(mapRequestedModel("gemini-3-pro-preview"), "gemini-3.1-pro-preview");
});

test("buildDirectRequestFromAnthropic maps tool_result and aliased model", () => {
  const request = buildDirectRequestFromAnthropic({
    model: "gpt-5",
    messages: [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tool_1", name: "shell_echo", input: { text: "hi" } }]
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool_1", content: "hi" }]
      }
    ]
  });

  assert.equal(request.model, "claude-opus-4-6");
  assert.equal(request.requestBody.model, "claude-opus-4-6");
  assert.equal(request.requestBody.contents[1].parts[0].function_response.name, "shell_echo");
});

test("buildDirectRequestFromOpenAi maps tools into declarations", () => {
  const request = buildDirectRequestFromOpenAi({
    model: "claude-opus-4-6",
    tools: [
      {
        type: "function",
        function: {
          name: "lookup_weather",
          description: "Look up weather",
          parameters: { type: "object", properties: { city: { type: "string" } } }
        }
      }
    ],
    messages: [{ role: "user", content: "hello" }]
  });

  assert.equal(request.requestBody.tools[0].name, "lookup_weather");
  assert.match(request.requestBody.tools[0].parameters_json, /city/);
});

test("UpstreamHttpError preserves upstream status and sanitizes token", async () => {
  const originalFetch = global.fetch;
  const token = "s3c2db98-secret-token";

  global.fetch = async () => ({
    ok: false,
    status: 429,
    statusText: "Too Many Requests",
    async text() {
      return JSON.stringify({
        error: {
          type: "rate_limit_error",
          message: `quota exceeded for ${token}`
        }
      });
    }
  });

  const client = new DirectLlmClient({
    authMode: "env",
    authProvider: {
      resolveCredential() {
        return {
          accountId: "acct_primary",
          token,
          source: "env"
        };
      }
    },
    requestTimeoutMs: 1000,
    upstreamBaseUrl: "https://example.test/api/adk/llm"
  });

  await assert.rejects(
    () => client.run({ model: "claude-opus-4-6", requestBody: { model: "claude-opus-4-6" } }),
    (error) => {
      assert.ok(error instanceof UpstreamHttpError);
      assert.equal(error.status, 429);
      assert.equal(error.type, "rate_limit_error");
      assert.match(error.message, /quota exceeded/);
      assert.doesNotMatch(error.message, /secret-token/);
      assert.equal(error.details.upstream.status, 429);
      assert.doesNotMatch(JSON.stringify(error.details), /secret-token/);
      return true;
    }
  );

  global.fetch = originalFetch;
});

test("DirectLlmClient converts SSE logical errors into structured upstream errors", async () => {
  const originalFetch = global.fetch;
  const token = "invalid_test_token";

  global.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data:{"turn_complete":true,"error_code":"402","error_message":"unauthorized"}\n\n'
          )
        );
        controller.close();
      }
    })
  });

  const client = new DirectLlmClient({
    authMode: "env",
    authProvider: {
      resolveCredential() {
        return {
          accountId: "acct_primary",
          token,
          source: "env"
        };
      },
      invalidateAccount() {}
    },
    requestTimeoutMs: 1000,
    upstreamBaseUrl: "https://example.test/api/adk/llm"
  });

  await assert.rejects(
    () => client.run({ model: "claude-opus-4-6", requestBody: { model: "claude-opus-4-6" } }),
    (error) => {
      assert.ok(error instanceof UpstreamSseError);
      assert.equal(error.status, 401);
      assert.equal(error.type, "authentication_error");
      assert.equal(error.message, "unauthorized");
      assert.equal(error.details.upstream.status, 200);
      assert.equal(error.details.upstream.body.error_code, "402");
      return true;
    }
  );

  global.fetch = originalFetch;
});

test("UpstreamSseError collapses non-HTTP upstream codes into valid bridge status", () => {
  const error = new UpstreamSseError({
    turn_complete: true,
    error_code: "5015",
    error_message: "user not activated"
  });

  assert.equal(error.status, 502);
  assert.equal(error.type, "authentication_error");
  assert.equal(error.message, "user not activated");
});


test("extractThinkingConfigFromAnthropic preserves budget tokens", () => {
  const thinking = extractThinkingConfigFromAnthropic({
    thinking: { type: "enabled", budget_tokens: 2048 }
  });

  assert.deepEqual(thinking, { type: "enabled", budget_tokens: 2048 });
  assert.equal(supportsThinkingForModel("claude-opus-4-6"), true);
  assert.equal(supportsThinkingForModel("claude-haiku-4-5"), false);
});


test("DirectLlmClient resolves against gateway models and falls back to opus", async () => {
  const seenModels = [];
  const fetchImpl = async (url, options = {}) => {
    if (String(url).endsWith('/models')) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        async json() {
          return {
            data: [
              {
                provider: 'openai',
                modelList: [
                  { modelName: 'gpt-5.4', visible: true }
                ]
              },
              {
                provider: 'claude',
                modelList: [
                  { modelName: 'claude-opus-4-6', visible: true }
                ]
              }
            ]
          };
        }
      };
    }

    if (String(url).includes('/generateContent')) {
      const body = JSON.parse(options.body || '{}');
      seenModels.push(body.model);
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data:{"content":{"parts":[{"text":"ok"}]}}\n\n'));
            controller.close();
          }
        })
      };
    }

    throw new Error('Unexpected URL: ' + url);
  };

  const client = new DirectLlmClient({
    authMode: 'env',
    authProvider: {
      resolveCredential() {
        return {
          accountId: 'acct_primary',
          token: 'token_123',
          source: 'env'
        };
      }
    },
    requestTimeoutMs: 1000,
    modelsCacheTtlMs: 1000,
    localGatewayBaseUrl: 'http://127.0.0.1:4097',
    upstreamBaseUrl: 'https://example.test/api/adk/llm',
    fetchImpl
  });

  const first = await client.run({ model: 'gpt-5.4', requestBody: { model: 'gpt-5.4' } });
  const second = await client.run({ model: 'missing-model', requestBody: { model: 'missing-model' } });

  assert.equal(first.resolvedProviderModel, 'gpt-5.4');
  assert.equal(second.resolvedProviderModel, 'claude-opus-4-6');
  assert.deepEqual(seenModels, ['gpt-5.4', 'claude-opus-4-6']);
});
