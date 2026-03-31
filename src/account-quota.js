"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { loadAccountsFile } = require("./accounts-file");

const ACCOUNT_QUOTA_API_VERSION = "0.5.0"; // Upstream quota endpoint currently expects this app version.
const DEFAULT_UTDID = "local-inspect"; // Fallback identifier when the local Accio utdid file is unavailable.
const DEFAULT_ACCOUNT_QUOTA_CACHE_TTL_MS = 30 * 1000; // Keep short to avoid stale countdowns in admin polling.
const DEFAULT_ACCOUNT_QUOTA_TIMEOUT_MS = 8 * 1000; // Match lightweight admin diagnostics expectations.
const accountQuotaCache = new Map();

/**
 * Resolves the upstream Phoenix gateway origin from the configured direct LLM URL.
 *
 * @param {object} config Runtime configuration object.
 * @returns {string} Gateway origin without the trailing LLM path.
 */
function deriveUpstreamGatewayBaseUrl(config) {
  const candidate = config && config.directLlmBaseUrl ? String(config.directLlmBaseUrl).trim() : "";

  if (candidate) {
    try {
      const parsed = new URL(candidate);
      return `${parsed.protocol}//${parsed.host}`;
    } catch {
      // Fall through to the default production gateway when the configured URL is malformed.
    }
  }

  return "https://phoenix-gw.alibaba.com";
}

/**
 * Reads the local Accio utdid identifier from disk.
 *
 * @param {object} config Runtime configuration object.
 * @returns {string} Trimmed utdid string, or an empty string when unavailable.
 */
function readAccioUtdid(config) {
  const accioHome = config && config.accioHome ? String(config.accioHome).trim() : "";
  const utdidPath = accioHome ? path.join(accioHome, "utdid") : "";

  if (!utdidPath) {
    return "";
  }

  try {
    return fs.readFileSync(utdidPath, "utf8").trim();
  } catch {
    return "";
  }
}

/**
 * Extracts the cna cookie value used by Phoenix upstream requests.
 *
 * @param {string|null|undefined} rawCookie Raw cookie string from the stored account.
 * @returns {string} Decoded cna value, or an empty string when not present.
 */
function extractCnaFromCookie(rawCookie) {
  if (!rawCookie) {
    return "";
  }

  const text = String(rawCookie);
  const match = text.match(/(?:^|%3B\s*|;\s*)cna(?:=|%3D)([^;%]+)/i);
  return match ? decodeURIComponent(match[1]) : "";
}

/**
 * Normalizes one account entry from accounts.json for quota probing.
 *
 * @param {object} account Raw account object from the accounts file.
 * @param {number} index Original file order index.
 * @returns {{id: string, name: string, enabled: boolean, accessToken: string, cookie: string, source: string|null}} Normalized account fields.
 */
function normalizeQuotaAccount(account, index = 0) {
  const fallbackId = `acct_${index + 1}`;
  const id = String(account && (account.id || account.accountId || account.name || fallbackId));
  const name = String(account && (account.name || account.id || account.accountId || fallbackId));

  return {
    id,
    name,
    enabled: account && account.enabled !== false,
    accessToken: account && account.accessToken ? String(account.accessToken).trim() : "",
    cookie: account && account.cookie ? String(account.cookie) : "",
    source: account && account.source ? String(account.source) : null
  };
}

/**
 * Formats a numeric percentage for admin display while preserving the raw number separately.
 *
 * @param {number} usagePercent Upstream usage percentage value.
 * @returns {string} Percentage string with two decimal places.
 */
function formatUsagePercentText(usagePercent) {
  return `${Number(usagePercent).toFixed(2)}%`;
}

/**
 * Formats a remaining-second countdown into a compact Chinese string.
 *
 * @param {number} totalSeconds Remaining seconds.
 * @returns {string} Human-readable countdown text.
 */
function formatQuotaCountdownText(totalSeconds) {
  const safeSeconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));

  if (safeSeconds <= 0) {
    return "0秒";
  }

  const days = Math.floor(safeSeconds / 86400);
  const hours = Math.floor((safeSeconds % 86400) / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;
  const parts = [];

  if (days > 0) {
    parts.push(`${days}天`);
  }

  if (days > 0 || hours > 0) {
    parts.push(`${hours}小时`);
  }

  if (days > 0 || hours > 0 || minutes > 0) {
    parts.push(`${minutes}分钟`);
  }

  parts.push(`${seconds}秒`);
  return parts.join("");
}

/**
 * Pads a local time field to two digits for fixed-width datetime output.
 *
 * @param {number} value Date part value.
 * @returns {string} Two-digit string.
 */
function padTimePart(value) {
  return String(value).padStart(2, "0");
}

/**
 * Formats a timestamp into local `YYYY-MM-DD HH:mm:ss`.
 *
 * @param {number} timeMs Epoch milliseconds.
 * @returns {string|null} Local time string, or null when the timestamp is invalid.
 */
function formatQuotaRefreshTimeText(timeMs) {
  const date = new Date(Number(timeMs));

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return [
    date.getFullYear(),
    padTimePart(date.getMonth() + 1),
    padTimePart(date.getDate())
  ].join("-") + " " + [
    padTimePart(date.getHours()),
    padTimePart(date.getMinutes()),
    padTimePart(date.getSeconds())
  ].join(":");
}

/**
 * Formats an account token into a shorter preview string for compact UI badges.
 *
 * @param {string} accessToken Full access token string.
 * @returns {string|null} Preview string, or null when the token is empty.
 */
function formatAccessTokenPreview(accessToken) {
  const text = String(accessToken || "").trim();

  if (!text) {
    return null;
  }

  if (text.length <= 20) {
    return text;
  }

  return `${text.slice(0, 10)}...${text.slice(-8)}`;
}

/**
 * Builds the cache key for one account-token pair so token rotation invalidates the old cache line.
 *
 * @param {{id: string, accessToken: string}} account Normalized account descriptor.
 * @returns {string} Stable cache key.
 */
function buildAccountQuotaCacheKey(account) {
  return `${account.id}\n${account.accessToken}`;
}

/**
 * Removes expired cache entries before the next quota probe.
 *
 * @param {number} ttlMs Cache TTL in milliseconds.
 * @param {number} nowMs Current epoch milliseconds.
 * @returns {void}
 */
function pruneAccountQuotaCache(ttlMs, nowMs) {
  if (ttlMs <= 0) {
    accountQuotaCache.clear();
    return;
  }

  for (const [cacheKey, entry] of accountQuotaCache.entries()) {
    if (nowMs - entry.createdAtMs >= ttlMs) {
      accountQuotaCache.delete(cacheKey);
    }
  }
}

/**
 * Resolves a live success payload from a cached upstream response.
 *
 * @param {object} account Normalized account descriptor.
 * @param {number} usagePercent Upstream usage percentage.
 * @param {number} refreshDeadlineMs Absolute refresh timestamp in epoch milliseconds.
 * @param {number} nowMs Current epoch milliseconds.
 * @param {"live"|"cache"} source Data source marker.
 * @returns {object} Success payload for the admin API.
 */
function buildQuotaSuccessResult(account, usagePercent, refreshDeadlineMs, nowMs, source) {
  const refreshCountdownSeconds = Math.max(0, Math.ceil((refreshDeadlineMs - nowMs) / 1000));

  return {
    id: account.id,
    name: account.name,
    status: "ok",
    source,
    usagePercent,
    usagePercentText: formatUsagePercentText(usagePercent),
    refreshCountdownSeconds,
    refreshCountdownText: formatQuotaCountdownText(refreshCountdownSeconds),
    refreshAtText: formatQuotaRefreshTimeText(refreshDeadlineMs),
    error: null
  };
}

/**
 * Builds a non-success payload while keeping the response schema stable.
 *
 * @param {object} account Normalized account descriptor.
 * @param {"skipped"|"error"} status Result status.
 * @param {{type: string, message: string}} error Structured error descriptor.
 * @returns {object} Failure payload for the admin API.
 */
function buildQuotaErrorResult(account, status, error) {
  return {
    id: account.id,
    name: account.name,
    status,
    source: "none",
    usagePercent: null,
    usagePercentText: null,
    refreshCountdownSeconds: null,
    refreshCountdownText: null,
    refreshAtText: null,
    error
  };
}

/**
 * Builds one card DTO for the read-only admin overview page.
 *
 * @param {object} account Normalized account descriptor.
 * @param {object} quotaResult Matching quota probe result.
 * @returns {object} Aggregated account card payload.
 */
function buildAccountOverviewItem(account, quotaResult) {
  const expiresAt = account.expiresAt || null;
  const usagePercent = quotaResult && quotaResult.usagePercent != null ? Number(quotaResult.usagePercent) : null;
  const availablePercent = usagePercent == null ? null : Math.max(0, 100 - usagePercent);

  return {
    id: account.id,
    name: account.name,
    enabled: account.enabled,
    source: account.source,
    accessToken: account.accessToken || "",
    accessTokenPreview: formatAccessTokenPreview(account.accessToken),
    expiresAt,
    expiresAtText: expiresAt ? formatQuotaRefreshTimeText(expiresAt) : null,
    usagePercent,
    usagePercentText: usagePercent == null ? null : formatUsagePercentText(usagePercent),
    availablePercent,
    availablePercentText: availablePercent == null ? null : formatUsagePercentText(availablePercent),
    refreshCountdownSeconds: quotaResult ? quotaResult.refreshCountdownSeconds : null,
    refreshCountdownText: quotaResult ? quotaResult.refreshCountdownText : null,
    refreshAtText: quotaResult ? quotaResult.refreshAtText : null,
    quotaSource: quotaResult ? quotaResult.source : "none",
    status: quotaResult ? quotaResult.status : "error",
    error: quotaResult ? quotaResult.error : {
      type: "quota_result_missing",
      message: "额度结果缺失"
    }
  };
}

/**
 * Loads one fresh quota snapshot from the upstream endpoint.
 *
 * @param {object} config Runtime configuration object.
 * @param {{id: string, name: string, accessToken: string, cookie: string}} account Normalized account descriptor.
 * @param {{fetchImpl?: Function, timeoutMs?: number}} options Optional test hooks and overrides.
 * @returns {Promise<{usagePercent: number, refreshCountdownSeconds: number}>} Parsed upstream quota payload.
 * @throws {Error} When the upstream request or payload validation fails.
 */
async function requestAccountQuota(config, account, options = {}) {
  const fetchImpl = options.fetchImpl || global.fetch;

  if (typeof fetchImpl !== "function") {
    const error = new Error("global.fetch is not available");
    error.type = "quota_request_failed";
    throw error;
  }

  const timeoutMs = Math.max(
    1,
    Number(options.timeoutMs ?? config.accountQuotaTimeoutMs ?? DEFAULT_ACCOUNT_QUOTA_TIMEOUT_MS)
  );
  const utdid = readAccioUtdid(config) || DEFAULT_UTDID;
  const upstreamBaseUrl = deriveUpstreamGatewayBaseUrl(config);
  const url = new URL("/api/entitlement/quota", upstreamBaseUrl);

  url.searchParams.set("accessToken", account.accessToken);
  url.searchParams.set("utdid", utdid);
  url.searchParams.set("version", ACCOUNT_QUOTA_API_VERSION);

  let response;

  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        "x-language": config && config.language ? String(config.language) : "zh",
        "x-utdid": utdid,
        "x-app-version": ACCOUNT_QUOTA_API_VERSION,
        "x-os": process.platform,
        "x-cna": extractCnaFromCookie(account.cookie)
      },
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    const wrapped = new Error(`上游 quota 请求失败：${error && error.message ? error.message : String(error)}`);
    wrapped.type = "quota_request_failed";
    throw wrapped;
  }

  const responseText = await response.text();
  let payload;

  try {
    payload = responseText ? JSON.parse(responseText) : {};
  } catch (error) {
    const wrapped = new Error(`上游 quota 返回了无效 JSON：${error && error.message ? error.message : String(error)}`);
    wrapped.type = "invalid_upstream_response";
    throw wrapped;
  }

  if (!response.ok) {
    const wrapped = new Error(`上游 quota 请求失败：HTTP ${response.status}`);
    wrapped.type = "quota_request_failed";
    wrapped.details = payload;
    throw wrapped;
  }

  const data = payload && payload.data ? payload.data : null;
  const usagePercent = data && data.usagePercent != null ? Number(data.usagePercent) : NaN;
  const refreshCountdownSeconds = data && data.refreshCountdownSeconds != null ? Number(data.refreshCountdownSeconds) : NaN;

  if (payload.success !== true || !Number.isFinite(usagePercent) || !Number.isFinite(refreshCountdownSeconds)) {
    const wrapped = new Error("上游 quota 响应缺少有效的 usagePercent 或 refreshCountdownSeconds");
    wrapped.type = "invalid_upstream_response";
    wrapped.details = payload;
    throw wrapped;
  }

  return {
    usagePercent,
    refreshCountdownSeconds: Math.max(0, Math.floor(refreshCountdownSeconds))
  };
}

/**
 * Reads all configured file accounts and returns their quota view model for the admin route.
 *
 * @param {object} config Runtime configuration object.
 * @param {{fetchImpl?: Function, nowFn?: Function, cacheTtlMs?: number, timeoutMs?: number}} options Optional test hooks and overrides.
 * @returns {Promise<{ok: true, fetchedAt: string, cacheTtlMs: number, accounts: object[]}>} Stable admin API payload.
 */
async function fetchAccountsQuota(config, options = {}) {
  const nowFn = typeof options.nowFn === "function" ? options.nowFn : () => Date.now();
  const startedAtMs = nowFn();
  const cacheTtlMs = Math.max(
    0,
    Number(options.cacheTtlMs ?? config.accountQuotaCacheTtlMs ?? DEFAULT_ACCOUNT_QUOTA_CACHE_TTL_MS)
  );
  const timeoutMs = Math.max(
    1,
    Number(options.timeoutMs ?? config.accountQuotaTimeoutMs ?? DEFAULT_ACCOUNT_QUOTA_TIMEOUT_MS)
  );
  const state = loadAccountsFile(config.accountsPath);
  const results = [];

  pruneAccountQuotaCache(cacheTtlMs, startedAtMs);

  for (const [index, rawAccount] of state.accounts.entries()) {
    const account = normalizeQuotaAccount(rawAccount, index);

    if (!account.enabled) {
      results.push(buildQuotaErrorResult(account, "skipped", {
        type: "disabled",
        message: "账号已禁用，跳过查询"
      }));
      continue;
    }

    if (!account.accessToken) {
      results.push(buildQuotaErrorResult(account, "skipped", {
        type: "missing_access_token",
        message: "账号缺少 accessToken，跳过查询"
      }));
      continue;
    }

    const cacheKey = buildAccountQuotaCacheKey(account);
    const nowBeforeFetchMs = nowFn();
    const cached = accountQuotaCache.get(cacheKey);

    if (cached && cacheTtlMs > 0 && nowBeforeFetchMs - cached.createdAtMs < cacheTtlMs) {
      results.push(buildQuotaSuccessResult(
        account,
        cached.usagePercent,
        cached.refreshDeadlineMs,
        nowBeforeFetchMs,
        "cache"
      ));
      continue;
    }

    try {
      const fresh = await requestAccountQuota(config, account, {
        fetchImpl: options.fetchImpl,
        timeoutMs
      });
      const nowAfterFetchMs = nowFn();
      const refreshDeadlineMs = nowAfterFetchMs + fresh.refreshCountdownSeconds * 1000;

      if (cacheTtlMs > 0) {
        accountQuotaCache.set(cacheKey, {
          createdAtMs: nowAfterFetchMs,
          usagePercent: fresh.usagePercent,
          refreshDeadlineMs
        });
      }

      results.push(buildQuotaSuccessResult(
        account,
        fresh.usagePercent,
        refreshDeadlineMs,
        nowAfterFetchMs,
        "live"
      ));
    } catch (error) {
      results.push(buildQuotaErrorResult(account, "error", {
        type: error && error.type ? String(error.type) : "quota_request_failed",
        message: error && error.message ? String(error.message) : "额度查询失败"
      }));
    }
  }

  return {
    ok: true,
    fetchedAt: new Date(startedAtMs).toISOString(),
    cacheTtlMs,
    accounts: results
  };
}

/**
 * Builds the read-only admin overview payload by merging file account fields with quota probe results.
 *
 * @param {object} config Runtime configuration object.
 * @param {{fetchImpl?: Function, nowFn?: Function, cacheTtlMs?: number, timeoutMs?: number}} options Optional test hooks and overrides.
 * @returns {Promise<{ok: true, fetchedAt: string, quotaCacheTtlMs: number, accounts: object[]}>} Card-friendly overview payload.
 */
async function fetchAccountsOverview(config, options = {}) {
  const state = loadAccountsFile(config.accountsPath);
  const quotaPayload = await fetchAccountsQuota(config, options);
  const accounts = state.accounts.map((rawAccount, index) => {
    const normalized = normalizeQuotaAccount(rawAccount, index);
    const expiresAt = Number(rawAccount && rawAccount.expiresAt || 0) || null;
    const account = {
      ...normalized,
      expiresAt
    };

    return buildAccountOverviewItem(account, quotaPayload.accounts[index] || null);
  });

  return {
    ok: true,
    fetchedAt: quotaPayload.fetchedAt,
    quotaCacheTtlMs: quotaPayload.cacheTtlMs,
    accounts
  };
}

/**
 * Clears the in-memory quota cache. This is used by tests to isolate scenarios.
 *
 * @returns {void}
 */
function clearAccountQuotaCache() {
  accountQuotaCache.clear();
}

module.exports = {
  fetchAccountsOverview,
  fetchAccountsQuota,
  formatAccessTokenPreview,
  formatQuotaCountdownText,
  formatQuotaRefreshTimeText,
  clearAccountQuotaCache
};
