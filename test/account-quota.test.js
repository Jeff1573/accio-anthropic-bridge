"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  fetchAccountsQuota,
  formatQuotaCountdownText,
  formatQuotaRefreshTimeText,
  clearAccountQuotaCache
} = require("../src/account-quota");
const { handleAdminAccountsQuota } = require("../src/routes/admin");

/**
 * Creates a temporary runtime config backed by a generated accounts.json file.
 *
 * @param {object} payload Accounts file payload.
 * @returns {{config: object, cleanup: () => void}} Test config and cleanup callback.
 */
function createTempQuotaConfig(payload) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "accio-account-quota-"));
  const accountsPath = path.join(tempDir, "accounts.json");

  fs.writeFileSync(accountsPath, JSON.stringify(payload, null, 2));

  return {
    config: {
      accountsPath,
      accioHome: tempDir,
      language: "zh",
      directLlmBaseUrl: "https://phoenix-gw.alibaba.com/api/adk/llm",
      accountQuotaCacheTtlMs: 30000,
      accountQuotaTimeoutMs: 8000
    },
    cleanup() {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  };
}

/**
 * Builds a minimal fetch response object for quota endpoint tests.
 *
 * @param {object} payload JSON payload to expose via text().
 * @param {number} [status=200] HTTP status code.
 * @returns {object} Mocked fetch response.
 */
function createJsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(payload);
    }
  };
}

/**
 * Creates a writable response stub compatible with writeJson().
 *
 * @returns {object} Minimal response double that captures status, headers and body.
 */
function createResponseRecorder() {
  return {
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    statusCode: 0,
    headers: null,
    body: "",
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
      this.headersSent = true;
    },
    end(body) {
      this.body = body || "";
      this.writableEnded = true;
    }
  };
}

test.afterEach(() => {
  clearAccountQuotaCache();
});

test("formatQuotaCountdownText handles seconds, hours, and days", () => {
  assert.equal(formatQuotaCountdownText(0), "0秒");
  assert.equal(formatQuotaCountdownText(59), "59秒");
  assert.equal(formatQuotaCountdownText(3600), "1小时0分钟0秒");
  assert.equal(formatQuotaCountdownText(85557), "23小时45分钟57秒");
  assert.equal(formatQuotaCountdownText(90061), "1天1小时1分钟1秒");
});

test("formatQuotaRefreshTimeText returns local fixed-width time", () => {
  assert.equal(formatQuotaRefreshTimeText(new Date(2026, 2, 31, 10, 0, 0).getTime()), "2026-03-31 10:00:00");
});

test("fetchAccountsQuota parses upstream payload and returns live quota data", async () => {
  const { config, cleanup } = createTempQuotaConfig({
    accounts: [
      {
        id: "acct_primary",
        name: "主账号",
        accessToken: "token_live",
        cookie: "foo=bar; cna=test-cna"
      }
    ]
  });
  const seenRequests = [];
  let nowMs = new Date(2026, 2, 31, 10, 0, 0).getTime();

  try {
    const payload = await fetchAccountsQuota(config, {
      nowFn: () => nowMs,
      fetchImpl: async (url, options) => {
        seenRequests.push({
          url: String(url),
          headers: options.headers
        });
        return createJsonResponse({
          success: true,
          code: "200",
          message: "0",
          data: {
            usagePercent: 0,
            refreshCountdownSeconds: 85557
          }
        });
      }
    });

    assert.equal(payload.ok, true);
    assert.equal(payload.cacheTtlMs, 30000);
    assert.equal(payload.accounts[0].status, "ok");
    assert.equal(payload.accounts[0].source, "live");
    assert.equal(payload.accounts[0].usagePercent, 0);
    assert.equal(payload.accounts[0].usagePercentText, "0.00%");
    assert.equal(payload.accounts[0].refreshCountdownSeconds, 85557);
    assert.equal(payload.accounts[0].refreshCountdownText, "23小时45分钟57秒");
    assert.equal(payload.accounts[0].refreshAtText, "2026-04-01 09:45:57");
    assert.equal(payload.accounts[0].error, null);
    assert.equal(seenRequests.length, 1);
    assert.match(seenRequests[0].url, /\/api\/entitlement\/quota\?/);
    assert.match(seenRequests[0].url, /accessToken=token_live/);
    assert.match(seenRequests[0].url, /utdid=local-inspect/);
    assert.equal(seenRequests[0].headers["x-cna"], "test-cna");
  } finally {
    cleanup();
  }
});

test("fetchAccountsQuota reuses cached success payloads within TTL", async () => {
  const { config, cleanup } = createTempQuotaConfig({
    accounts: [
      {
        id: "acct_primary",
        name: "主账号",
        accessToken: "token_cache"
      }
    ]
  });
  let nowMs = new Date(2026, 2, 31, 10, 0, 0).getTime();
  let fetchCount = 0;

  try {
    const first = await fetchAccountsQuota(config, {
      nowFn: () => nowMs,
      fetchImpl: async () => {
        fetchCount += 1;
        return createJsonResponse({
          success: true,
          code: "200",
          message: "0",
          data: {
            usagePercent: 12.34,
            refreshCountdownSeconds: 120
          }
        });
      }
    });

    nowMs += 10 * 1000;

    const second = await fetchAccountsQuota(config, {
      nowFn: () => nowMs,
      fetchImpl: async () => {
        fetchCount += 1;
        return createJsonResponse({
          success: true,
          data: {
            usagePercent: 99,
            refreshCountdownSeconds: 1
          }
        });
      }
    });

    assert.equal(fetchCount, 1);
    assert.equal(first.accounts[0].source, "live");
    assert.equal(second.accounts[0].source, "cache");
    assert.equal(second.accounts[0].usagePercent, 12.34);
    assert.equal(second.accounts[0].refreshCountdownSeconds, 110);
  } finally {
    cleanup();
  }
});

test("fetchAccountsQuota refreshes upstream data after TTL expiry", async () => {
  const { config, cleanup } = createTempQuotaConfig({
    accounts: [
      {
        id: "acct_primary",
        name: "主账号",
        accessToken: "token_ttl"
      }
    ]
  });
  let nowMs = new Date(2026, 2, 31, 10, 0, 0).getTime();
  let fetchCount = 0;

  try {
    await fetchAccountsQuota(config, {
      nowFn: () => nowMs,
      fetchImpl: async () => {
        fetchCount += 1;
        return createJsonResponse({
          success: true,
          data: {
            usagePercent: 1,
            refreshCountdownSeconds: 30
          }
        });
      }
    });

    nowMs += 31 * 1000;

    const payload = await fetchAccountsQuota(config, {
      nowFn: () => nowMs,
      fetchImpl: async () => {
        fetchCount += 1;
        return createJsonResponse({
          success: true,
          data: {
            usagePercent: 2,
            refreshCountdownSeconds: 60
          }
        });
      }
    });

    assert.equal(fetchCount, 2);
    assert.equal(payload.accounts[0].source, "live");
    assert.equal(payload.accounts[0].usagePercent, 2);
    assert.equal(payload.accounts[0].refreshCountdownSeconds, 60);
  } finally {
    cleanup();
  }
});

test("fetchAccountsQuota skips disabled and missing-token accounts while tolerating per-account failures", async () => {
  const { config, cleanup } = createTempQuotaConfig({
    accounts: [
      {
        id: "acct_disabled",
        name: "禁用账号",
        accessToken: "token_disabled",
        enabled: false
      },
      {
        id: "acct_missing",
        name: "缺 token"
      },
      {
        id: "acct_ok",
        name: "正常账号",
        accessToken: "token_ok"
      },
      {
        id: "acct_bad",
        name: "失败账号",
        accessToken: "token_bad"
      }
    ]
  });

  try {
    const payload = await fetchAccountsQuota(config, {
      fetchImpl: async (url) => {
        if (String(url).includes("token_ok")) {
          return createJsonResponse({
            success: true,
            data: {
              usagePercent: 20,
              refreshCountdownSeconds: 90
            }
          });
        }

        return createJsonResponse({ success: false, data: {} }, 200);
      }
    });

    assert.equal(payload.ok, true);
    assert.equal(payload.accounts[0].status, "skipped");
    assert.equal(payload.accounts[0].error.type, "disabled");
    assert.equal(payload.accounts[1].status, "skipped");
    assert.equal(payload.accounts[1].error.type, "missing_access_token");
    assert.equal(payload.accounts[2].status, "ok");
    assert.equal(payload.accounts[2].source, "live");
    assert.equal(payload.accounts[3].status, "error");
    assert.equal(payload.accounts[3].source, "none");
    assert.equal(payload.accounts[3].error.type, "invalid_upstream_response");
  } finally {
    cleanup();
  }
});

test("fetchAccountsQuota allows empty x-cna when cookie has no cna", async () => {
  const { config, cleanup } = createTempQuotaConfig({
    accounts: [
      {
        id: "acct_primary",
        name: "主账号",
        accessToken: "token_no_cna",
        cookie: "foo=bar"
      }
    ]
  });
  const seenHeaders = [];

  try {
    await fetchAccountsQuota(config, {
      fetchImpl: async (url, options) => {
        seenHeaders.push(options.headers);
        return createJsonResponse({
          success: true,
          data: {
            usagePercent: 0,
            refreshCountdownSeconds: 1
          }
        });
      }
    });

    assert.equal(seenHeaders.length, 1);
    assert.equal(seenHeaders[0]["x-cna"], "");
  } finally {
    cleanup();
  }
});

test("handleAdminAccountsQuota writes a 200 JSON response", async () => {
  const { config, cleanup } = createTempQuotaConfig({
    accounts: [
      {
        id: "acct_primary",
        name: "主账号",
        accessToken: "token_handler"
      }
    ]
  });
  const res = createResponseRecorder();

  try {
    await handleAdminAccountsQuota({}, res, config, {
      fetchImpl: async () => createJsonResponse({
        success: true,
        data: {
          usagePercent: 3.21,
          refreshCountdownSeconds: 30
        }
      })
    });

    const body = JSON.parse(res.body);
    assert.equal(res.statusCode, 200);
    assert.equal(body.ok, true);
    assert.equal(body.accounts[0].usagePercent, 3.21);
  } finally {
    cleanup();
  }
});
