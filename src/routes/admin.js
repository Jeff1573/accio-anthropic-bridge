"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const { readJsonBody } = require("../middleware/body-parser");
const { writeJson, CORS_HEADERS } = require("../http");
const { fetchAccountsOverview, fetchAccountsQuota } = require("../account-quota");
const {
  detectActiveStorage,
  readGatewayState,
  listSnapshots,
  snapshotActiveCredentials,
  activateSnapshot,
  deleteSnapshot,
  readSnapshotAuthPayload,
  writeSnapshotAuthPayload
} = require("../auth-state");
const { writeAccountToFile, findStoredAccountAuthPayload } = require("../accounts-file");
const log = require("../logger");

const execFileAsync = promisify(execFile);

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function maskToken(token) {
  if (!token) {
    return null;
  }

  const text = String(token);
  return text.length > 8 ? `${text.slice(0, 8)}***` : "***";
}

function getSnapshotEntry(alias) {
  return listSnapshots().find((entry) => entry.alias === String(alias || "").trim()) || null;
}

function resolveSnapshotAuthPayload(alias, accountsPath) {
  const filePayload = readSnapshotAuthPayload(alias);

  if (filePayload) {
    return {
      payload: filePayload,
      source: "snapshot"
    };
  }

  const snapshotEntry = getSnapshotEntry(alias);
  const gatewayUser = snapshotEntry && snapshotEntry.metadata && snapshotEntry.metadata.gatewayUser
    ? snapshotEntry.metadata.gatewayUser
    : null;
  const storedPayload = findStoredAccountAuthPayload(accountsPath, {
    alias,
    accountId: gatewayUser && gatewayUser.id ? String(gatewayUser.id) : null,
    userId: gatewayUser && gatewayUser.id ? String(gatewayUser.id) : null,
    name: gatewayUser && gatewayUser.name ? String(gatewayUser.name) : null
  });

  if (!storedPayload) {
    return {
      payload: null,
      source: null
    };
  }

  return {
    payload: storedPayload,
    source: "accounts-file"
  };
}

async function requestGatewayJson(gatewayManager, pathname, options = {}) {
  const response = await fetch(`${gatewayManager.baseUrl}${pathname}`, {
    method: options.method || "GET",
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(Number(options.timeoutMs || 8000))
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};

  if (!response.ok) {
    const error = new Error(`Gateway request failed for ${pathname}: ${response.status}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
}

function isGatewayConnectionError(error) {
  const message = error && error.message ? String(error.message) : String(error || "");
  return /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|socket hang up/i.test(message);
}

async function waitForGatewayReachable(baseUrl, waitMs = 20000, pollMs = 500) {
  const deadline = Date.now() + waitMs;
  let lastGateway = null;

  while (Date.now() < deadline) {
    const gateway = await readGatewayState(baseUrl);
    lastGateway = gateway;

    if (gateway && gateway.reachable) {
      return gateway;
    }

    await delayMs(pollMs);
  }

  return lastGateway;
}

async function requestGatewayJsonWithAutostart(gatewayManager, pathname, options = {}) {
  try {
    return await requestGatewayJson(gatewayManager, pathname, options);
  } catch (error) {
    if (!isGatewayConnectionError(error)) {
      throw error;
    }

    log.warn("gateway request failed before autostart retry", {
      pathname,
      baseUrl: gatewayManager.baseUrl,
      error: error && error.message ? error.message : String(error)
    });

    await gatewayManager.ensureStarted();
    const gateway = await waitForGatewayReachable(
      gatewayManager.baseUrl,
      Number(gatewayManager.waitMs || 20000),
      Number(gatewayManager.pollMs || 500)
    );

    if (!gateway || !gateway.reachable) {
      const retryError = new Error(`Gateway did not become reachable after launching Accio for ${pathname}`);
      retryError.type = "gateway_unreachable";
      throw retryError;
    }

    return requestGatewayJson(gatewayManager, pathname, options);
  }
}

function buildBridgeBaseUrl(req, config) {
  const forwardedProto = req && req.headers && req.headers["x-forwarded-proto"]
    ? String(req.headers["x-forwarded-proto"]).split(",")[0].trim()
    : "";
  const protocol = forwardedProto || "http";
  const host = req && req.headers && req.headers.host
    ? String(req.headers.host)
    : `127.0.0.1:${config.port}`;
  return `${protocol}://${host}`;
}

function buildAccountLoginCallbackUrl(req, config, flowId) {
  const url = new URL("/admin/api/accounts/callback", buildBridgeBaseUrl(req, config));
  url.searchParams.set("flowId", String(flowId));
  return url.toString();
}

function rewriteGatewayLoginUrl(loginUrl, callbackUrl) {
  if (!loginUrl) {
    return null;
  }

  const parsed = new URL(String(loginUrl));
  parsed.searchParams.set("return_url", callbackUrl);
  return parsed.toString();
}

function buildGatewayAuthCallbackQuery(payload, options = {}) {
  const query = new URLSearchParams();
  query.set("accessToken", String(payload.accessToken || ""));
  query.set("refreshToken", String(payload.refreshToken || ""));
  query.set("expiresAt", String(payload.expiresAtRaw || payload.expiresAt || ""));

  if (payload.cookie) {
    query.set("cookie", String(payload.cookie));
  }

  if (options.includeState && payload.state) {
    query.set("state", String(payload.state));
  }

  return query.toString();
}

function extractAuthCallbackPayloadFromSearchParams(searchParams) {
  const accessToken = searchParams.get("accessToken") ? String(searchParams.get("accessToken")).trim() : "";
  const refreshToken = searchParams.get("refreshToken") ? String(searchParams.get("refreshToken")).trim() : "";
  const expiresAtRaw = searchParams.get("expiresAt") ? String(searchParams.get("expiresAt")).trim() : "";
  const cookie = searchParams.get("cookie") ? String(searchParams.get("cookie")) : null;
  const state = searchParams.get("state") ? String(searchParams.get("state")).trim() : null;
  const expiresAtMs = expiresAtRaw ? Number(expiresAtRaw) * 1000 : 0;

  if (!accessToken || !refreshToken || !expiresAtRaw) {
    throw new Error("Missing required auth callback parameters");
  }

  return {
    accessToken,
    refreshToken,
    expiresAtRaw,
    expiresAtMs: Number.isFinite(expiresAtMs) && expiresAtMs > 0 ? expiresAtMs : null,
    cookie,
    state,
    capturedAt: new Date().toISOString(),
    source: "gateway-auth-callback"
  };
}


function deriveUpstreamGatewayBaseUrl(config) {
  const candidate = config && config.directLlmBaseUrl ? String(config.directLlmBaseUrl).trim() : "";
  if (candidate) {
    try {
      const parsed = new URL(candidate);
      return `${parsed.protocol}//${parsed.host}`;
    } catch {
      // Fall through to the default prod gateway.
    }
  }

  return "https://phoenix-gw.alibaba.com";
}

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

function extractCnaFromCookie(rawCookie) {
  if (!rawCookie) {
    return "";
  }

  const text = String(rawCookie);
  const match = text.match(/(?:^|%3B\s*|;\s*)cna(?:=|%3D)([^;%]+)/i);
  return match ? decodeURIComponent(match[1]) : "";
}

async function refreshAuthPayloadViaUpstream(config, authPayload, context = {}) {
  if (!authPayload || !authPayload.accessToken || !authPayload.refreshToken) {
    throw new Error("Auth payload is missing accessToken or refreshToken");
  }

  const upstreamBaseUrl = deriveUpstreamGatewayBaseUrl(config);
  const utdid = readAccioUtdid(config);
  const cna = extractCnaFromCookie(authPayload.cookie);
  const requestBody = {
    utdid,
    version: "0.0.0",
    accessToken: String(authPayload.accessToken),
    refreshToken: String(authPayload.refreshToken)
  };
  const response = await fetch(`${upstreamBaseUrl}/api/auth/refresh_token`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-language": config && config.language ? String(config.language) : "zh",
      "x-utdid": utdid,
      "x-app-version": "0.0.0",
      "x-os": process.platform,
      "x-cna": cna
    },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(15000)
  });
  const responseText = await response.text();

  let payload;
  try {
    payload = responseText ? JSON.parse(responseText) : {};
  } catch (error) {
    throw new Error(`Upstream refresh returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!response.ok || !payload || payload.success !== true || !payload.data || !payload.data.accessToken || !payload.data.refreshToken || !payload.data.expiresAt) {
    const message = payload && payload.message ? String(payload.message) : `HTTP ${response.status}`;
    throw new Error(`Upstream refresh failed: ${message}`);
  }

  const expiresAtMs = Number(payload.data.expiresAt) * 1000;
  const refreshed = {
    ...authPayload,
    accessToken: String(payload.data.accessToken),
    refreshToken: String(payload.data.refreshToken),
    expiresAtRaw: String(payload.data.expiresAt),
    expiresAtMs: Number.isFinite(expiresAtMs) && expiresAtMs > 0 ? expiresAtMs : null,
    refreshedAt: new Date().toISOString(),
    refreshBoundUserId: payload.data.userId ? String(payload.data.userId) : null,
    source: "upstream-refresh"
  };

  log.info("auth payload upstream refresh succeeded", {
    alias: context.alias || null,
    flowId: context.flowId || null,
    previousUserId: context.previousUserId || null,
    expectedUserId: authPayload && authPayload.user && authPayload.user.id ? String(authPayload.user.id) : null,
    boundUserId: refreshed.refreshBoundUserId,
    upstreamBaseUrl,
    accessToken: maskToken(refreshed.accessToken),
    refreshToken: maskToken(refreshed.refreshToken)
  });

  return refreshed;
}

async function requestGatewayText(gatewayManager, pathname, options = {}) {
  const response = await fetch(`${gatewayManager.baseUrl}${pathname}`, {
    method: options.method || "GET",
    headers: {
      ...(options.headers || {})
    },
    body: options.body || undefined,
    redirect: options.redirect || "manual",
    signal: AbortSignal.timeout(Number(options.timeoutMs || 15000))
  });
  const text = await response.text();

  if (!response.ok) {
    const error = new Error(`Gateway request failed for ${pathname}: ${response.status}`);
    error.status = response.status;
    error.body = text;
    throw error;
  }

  return {
    status: response.status,
    text,
    location: response.headers.get("location") || null
  };
}

async function requestGatewayTextWithAutostart(gatewayManager, pathname, options = {}) {
  try {
    return await requestGatewayText(gatewayManager, pathname, options);
  } catch (error) {
    if (!isGatewayConnectionError(error)) {
      throw error;
    }

    log.warn("gateway text request failed before autostart retry", {
      pathname,
      baseUrl: gatewayManager.baseUrl,
      error: error && error.message ? error.message : String(error)
    });

    await gatewayManager.ensureStarted();
    const gateway = await waitForGatewayReachable(
      gatewayManager.baseUrl,
      Number(gatewayManager.waitMs || 20000),
      Number(gatewayManager.pollMs || 500)
    );

    if (!gateway || !gateway.reachable) {
      const retryError = new Error(`Gateway did not become reachable after launching Accio for ${pathname}`);
      retryError.type = "gateway_unreachable";
      throw retryError;
    }

    return requestGatewayText(gatewayManager, pathname, options);
  }
}

async function forwardGatewayAuthCallback(gatewayManager, payload, options = {}) {
  const query = buildGatewayAuthCallbackQuery(payload, options);
  return requestGatewayTextWithAutostart(gatewayManager, `/auth/callback?${query}`, {
    method: "GET",
    headers: {
      accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8"
    },
    timeoutMs: Number(options.timeoutMs || 15000)
  });
}

async function waitForGatewayAuthenticatedUser(baseUrl, expectedUserId = "", waitMs = 15000, pollMs = 500) {
  const deadline = Date.now() + waitMs;
  let lastGateway = null;

  while (Date.now() < deadline) {
    const gateway = await readGatewayState(baseUrl);
    lastGateway = gateway;
    const currentUserId = extractGatewayUserId(gateway);

    if (gateway && gateway.reachable && gateway.authenticated && (!expectedUserId || currentUserId === String(expectedUserId))) {
      return gateway;
    }

    await delayMs(pollMs);
  }

  return lastGateway;
}

function renderAccountCallbackPage(title, body, tone = "ok") {
  const accent = tone === "error" ? "#c43c3c" : "#1a8a5a";
  const accentSoft = tone === "error" ? "rgba(196,60,60,0.1)" : "rgba(26,138,90,0.1)";
  const icon = tone === "error" ? "\u274C" : "\u2705";
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
@keyframes fadeSlideUp {
  from { opacity: 0; transform: translateY(16px); }
  to { opacity: 1; transform: translateY(0); }
}
body { margin: 0; background: linear-gradient(175deg, #faf8f5, #ede7df); color: #1a1816; font-family: -apple-system,BlinkMacSystemFont,"SF Pro Display","PingFang SC","Noto Sans SC",sans-serif; display: grid; place-items: center; min-height: 100vh; -webkit-font-smoothing: antialiased; }
main { width: min(520px, calc(100vw - 32px)); background: rgba(255,254,252,0.92); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border: 1px solid rgba(24,22,20,0.08); border-radius: 22px; padding: 28px; box-shadow: 0 16px 48px rgba(56,40,28,0.1); animation: fadeSlideUp 0.5s ease-out; }
.icon { font-size: 36px; margin-bottom: 12px; }
.badge { display: inline-flex; align-items: center; gap: 6px; padding: 5px 12px; border-radius: 999px; background: ${accentSoft}; color: ${accent}; letter-spacing: 0.1em; text-transform: uppercase; font-size: 11px; font-weight: 600; margin-bottom: 12px; }
h1 { margin: 0 0 10px; font-size: 26px; font-weight: 700; letter-spacing: -0.03em; line-height: 1.15; }
p { margin: 0; color: #8a8279; font-size: 14px; line-height: 1.7; }
.countdown { margin-top: 16px; color: #8a8279; font-size: 12px; }
</style>
</head>
<body>
<main>
  <div class="icon">${icon}</div>
  <div class="badge">Accio Bridge</div>
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(body)}</p>
  <div class="countdown">\u8FD9\u4E2A\u9875\u9762\u5C06\u5728 2 \u79D2\u540E\u81EA\u52A8\u5173\u95ED...</div>
</main>
<script>
setTimeout(() => { try { window.close(); } catch {} }, 2000);
</script>
</body>
</html>`;
}

async function openExternalUrl(url) {
  const target = String(url || "").trim();

  if (!target) {
    return false;
  }

  if (process.platform === "darwin") {
    await execFileAsync("open", [target]);
    return true;
  }

  if (process.platform === "win32") {
    await execFileAsync("cmd", ["/c", "start", "", target]);
    return true;
  }

  if (process.platform === "linux") {
    await execFileAsync("xdg-open", [target]);
    return true;
  }

  return false;
}

async function requestDesktopHelperLaunch(config) {
  const helperUrl = String(config.desktopHelperUrl || '').trim();

  if (!helperUrl) {
    return { ok: false, skipped: true, reason: 'desktop_helper_not_configured' };
  }

  const normalized = helperUrl.replace(/\/$/, '');
  const timeoutMs = Number(config.desktopHelperTimeoutMs || 15000);

  log.info('snapshot switch desktop helper begin', { helperUrl: normalized, timeoutMs });

  try {
    const response = await fetch(`${normalized}/launch-accio`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'snapshot-switch' }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      const error = new Error((payload && payload.error) || `Desktop helper launch failed: ${response.status}`);
      error.status = response.status;
      throw error;
    }

    log.info('snapshot switch desktop helper launched', { helperUrl: normalized, payload });
    return { ok: true, helperUrl: normalized, payload };
  } catch (error) {
    log.warn('snapshot switch desktop helper failed', {
      helperUrl: normalized,
      error: error && error.message ? error.message : String(error)
    });
    return { ok: false, helperUrl: normalized, error: error && error.message ? error.message : String(error) };
  }
}


const ACCOUNT_LOGIN_FLOW_TTL_MS = 10 * 60 * 1000;
const pendingAccountLogins = new Map();

function extractGatewayUserId(gateway) {
  return gateway && gateway.user && gateway.user.id ? String(gateway.user.id) : "";
}

function summarizeGatewayState(gateway) {
  return {
    reachable: Boolean(gateway && gateway.reachable),
    authenticated: Boolean(gateway && gateway.authenticated),
    userId: gateway && gateway.user && gateway.user.id ? String(gateway.user.id) : null,
    userName: gateway && gateway.user && gateway.user.name ? String(gateway.user.name) : null,
    status: gateway && gateway.status != null ? gateway.status : null,
    error: gateway && gateway.error ? String(gateway.error) : null
  };
}

function prunePendingAccountLogins(now = Date.now()) {
  for (const [flowId, flow] of pendingAccountLogins.entries()) {
    if (now - flow.createdAtMs >= ACCOUNT_LOGIN_FLOW_TTL_MS) {
      pendingAccountLogins.delete(flowId);
    }
  }
}

function createPendingAccountLogin(previousUserId, extras = {}) {
  prunePendingAccountLogins();
  const flow = {
    id: crypto.randomUUID(),
    previousUserId: previousUserId || "",
    preservedAlias: extras.preservedAlias || null,
    preservedKind: extras.preservedKind || null,
    preservedCapturedAt: extras.preservedCapturedAt || null,
    createdAtMs: Date.now()
  };
  pendingAccountLogins.set(flow.id, flow);
  return flow;
}

function getPendingAccountLogin(flowId) {
  prunePendingAccountLogins();
  return pendingAccountLogins.get(flowId) || null;
}

function deletePendingAccountLogin(flowId) {
  pendingAccountLogins.delete(flowId);
}

function logPendingAccountLoginState(flow, state, meta = {}) {
  if (!flow) {
    return;
  }

  if (flow.lastLoggedState === state) {
    return;
  }

  flow.lastLoggedState = state;
  log.info("account login flow state", {
    flowId: flow.id,
    previousUserId: flow.previousUserId || null,
    state,
    ...meta
  });
}

function deriveSnapshotAliasFromGatewayUser(user) {
  const userId = user && user.id ? String(user.id).trim() : "";
  const userName = user && user.name ? String(user.name).trim() : "";
  const normalizedName = userName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (normalizedName && userId) {
    return `acct-${normalizedName}-${userId}`;
  }

  if (userId) {
    return `acct-${userId}`;
  }

  if (normalizedName) {
    return `acct-${normalizedName}`;
  }

  return `acct-${Date.now()}`;
}

function normalizeAccioProcessName(appPath) {
  const base = path.basename(String(appPath || "Accio.app"));
  return base.endsWith(".app") ? base.slice(0, -4) : base;
}

async function delayMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getGatewayPort(baseUrl) {
  try {
    const url = new URL(String(baseUrl || 'http://127.0.0.1:4097'));
    return url.port ? String(url.port) : (url.protocol === 'https:' ? '443' : '80');
  } catch {
    return '4097';
  }
}

async function isGatewayPortListening(baseUrl) {
  const port = getGatewayPort(baseUrl);
  try {
    await execFileAsync('lsof', ['-tiTCP:' + port, '-sTCP:LISTEN']);
    return true;
  } catch {
    return false;
  }
}

async function stopAccioForSnapshot(config, processName) {
  const appContentsPrefix = String(config.appPath || '').replace(/\.app\/?$/, '.app/Contents/');
  const baseUrl = config.baseUrl;

  log.info('snapshot switch stop begin', {
    appPath: config.appPath,
    processName,
    baseUrl,
    appContentsPrefix
  });

  if (process.platform === 'darwin') {
    await execFileAsync('osascript', ['-e', 'tell application id "com.accio.desktop" to quit']).catch(() => {});
    await delayMs(800);
    await execFileAsync('pkill', ['-x', processName]).catch(() => {});
    if (appContentsPrefix) {
      await execFileAsync('pkill', ['-f', appContentsPrefix]).catch(() => {});
    }
  } else if (process.platform === 'win32') {
    await execFileAsync('taskkill', ['/im', processName + '.exe', '/t', '/f']).catch(() => {});
  } else {
    await execFileAsync('pkill', ['-x', processName]).catch(() => {});
  }

  const deadline = Date.now() + 12000;
  let forced = false;

  while (Date.now() < deadline) {
    const listening = await isGatewayPortListening(baseUrl);
    if (!listening) {
      log.info('snapshot switch stop confirmed', { baseUrl, processName, forced });
      return { forced };
    }

    if (!forced && Date.now() + 4000 >= deadline) {
      forced = true;
      if (process.platform === 'darwin') {
        await execFileAsync('pkill', ['-9', '-x', processName]).catch(() => {});
        if (appContentsPrefix) {
          await execFileAsync('pkill', ['-9', '-f', appContentsPrefix]).catch(() => {});
        }
      } else if (process.platform === 'win32') {
        await execFileAsync('taskkill', ['/im', processName + '.exe', '/t', '/f']).catch(() => {});
      } else {
        await execFileAsync('pkill', ['-9', '-x', processName]).catch(() => {});
      }
    }

    await delayMs(400);
  }

  log.warn('snapshot switch stop timed out', { baseUrl, processName, forced });
  return { forced, timedOut: true };
}

async function startAccioForSnapshot(config, processName) {
  log.info('snapshot switch start begin', {
    appPath: config.appPath,
    baseUrl: config.baseUrl,
    processName
  });

  if (process.platform === 'darwin') {
    await execFileAsync('open', [config.appPath]);
    return;
  }

  if (process.platform === 'win32') {
    await execFileAsync('cmd', ['/c', 'start', '', config.appPath]);
    return;
  }

  throw new Error('Automatic Accio restart is not implemented for this platform');
}

async function restartAccioForSnapshot(config, expectedUserId, options = {}) {
  const processName = normalizeAccioProcessName(config.appPath);
  const stopResult = options.stopResult || null;
  let desktopHelperLaunch = null;

  log.info("snapshot switch restart begin", {
    appPath: config.appPath,
    baseUrl: config.baseUrl,
    processName,
    expectedUserId: expectedUserId || null,
    preStopped: Boolean(stopResult)
  });

  await delayMs(800);

  try {
    await startAccioForSnapshot(config, processName);
  } catch (error) {
    log.warn('snapshot switch local start failed', {
      processName,
      error: error && error.message ? error.message : String(error)
    });
  }

  const deadline = Date.now() + 30000;
  const helperAttemptAt = Date.now() + 6000;
  let helperAttempted = false;
  let lastGateway = null;

  while (Date.now() < deadline) {
    const gateway = await readGatewayState(config.baseUrl);
    lastGateway = gateway;
    const currentUserId = extractGatewayUserId(gateway);

    log.debug("snapshot switch restart poll", {
      expectedUserId: expectedUserId || null,
      currentUserId: currentUserId || null,
      gateway: summarizeGatewayState(gateway),
      helperAttempted
    });

    if (gateway.reachable && (!expectedUserId || currentUserId === expectedUserId)) {
      log.info("snapshot switch restart matched", {
        expectedUserId: expectedUserId || null,
        currentUserId: currentUserId || null,
        gateway: summarizeGatewayState(gateway),
        stopResult,
        desktopHelperLaunch
      });
      return { gateway, matched: !expectedUserId || currentUserId === expectedUserId, stopResult, desktopHelperLaunch };
    }

    if (!helperAttempted && Date.now() >= helperAttemptAt) {
      helperAttempted = true;
      desktopHelperLaunch = await requestDesktopHelperLaunch(config);
    }

    await delayMs(500);
  }

  log.warn("snapshot switch restart timed out", {
    expectedUserId: expectedUserId || null,
    gateway: summarizeGatewayState(lastGateway),
    stopResult,
    desktopHelperLaunch
  });
  return { gateway: lastGateway, matched: false, stopResult, desktopHelperLaunch };
}


async function buildAdminState(config, authProvider) {
  const gateway = await readGatewayState(config.baseUrl);
  const storage = detectActiveStorage();
  const snapshots = listSnapshots().map((entry) => {
    const storedAuthPayload = !entry.hasAuthCallback
      ? findStoredAccountAuthPayload(config.accountsPath, {
          alias: entry.alias,
          accountId: entry.metadata && entry.metadata.gatewayUser && entry.metadata.gatewayUser.id
            ? String(entry.metadata.gatewayUser.id)
            : null,
          userId: entry.metadata && entry.metadata.gatewayUser && entry.metadata.gatewayUser.id
            ? String(entry.metadata.gatewayUser.id)
            : null,
          name: entry.metadata && entry.metadata.gatewayUser && entry.metadata.gatewayUser.name
            ? String(entry.metadata.gatewayUser.name)
            : null
        })
      : null;

    return {
      alias: entry.alias,
      kind: entry.kind,
      dir: entry.dir,
      capturedAt: entry.metadata && entry.metadata.capturedAt ? entry.metadata.capturedAt : null,
      gatewayUser: entry.metadata && entry.metadata.gatewayUser ? entry.metadata.gatewayUser : null,
      artifactCount: entry.metadata && Array.isArray(entry.metadata.artifacts) ? entry.metadata.artifacts.length : 0,
      hasFullAuthState: Boolean(entry.metadata && Array.isArray(entry.metadata.artifacts) && entry.metadata.artifacts.length > 1),
      hasStoredAuthCallback: Boolean(storedAuthPayload),
      hasAuthCallback: Boolean(entry.hasAuthCallback || storedAuthPayload),
      authPayloadCapturedAt: entry.authPayloadCapturedAt || (storedAuthPayload && storedAuthPayload.capturedAt ? storedAuthPayload.capturedAt : null),
      authPayloadUser: entry.authPayloadUser || (storedAuthPayload && storedAuthPayload.user ? storedAuthPayload.user : null)
    };
  });
  const currentGatewayUserId = gateway && gateway.user && gateway.user.id ? String(gateway.user.id) : "";
  const currentSnapshots = currentGatewayUserId
    ? snapshots.filter((snapshot) => snapshot.gatewayUser && String(snapshot.gatewayUser.id || "") === currentGatewayUserId)
    : [];
  const currentSnapshot = currentSnapshots.length > 0
    ? currentSnapshots.slice().sort((left, right) => String(right.capturedAt || "").localeCompare(String(left.capturedAt || "")))[0]
    : null;
  const accounts = authProvider.getConfiguredAccounts().map((account) => ({
    id: account.id,
    name: account.name,
    source: account.source,
    enabled: account.enabled,
    hasToken: Boolean(account.accessToken),
    tokenPreview: maskToken(account.accessToken),
    expiresAt: account.expiresAt || null,
    invalidUntil: authProvider.getInvalidUntil(account.id),
    lastFailure: authProvider.getLastFailure(account.id) || null
  }));

  return {
    ok: true,
    bridge: {
      port: config.port,
      transportMode: config.transportMode,
      authMode: config.authMode,
      accountsPath: config.accountsPath,
      sessionStorePath: config.sessionStorePath,
      appPath: config.appPath
    },
    gateway,
    storage,
    snapshots,
    currentSnapshot,
    auth: authProvider.getSummary(),
    accounts
  };
}

function writeHtml(res, statusCode, html) {
  res.writeHead(statusCode, {
    ...CORS_HEADERS,
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html)
  });
  res.end(html);
}

function renderAdminPage(config) {
  const title = escapeHtml(`Accio Bridge Manager · ${config.port}`);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
:root {
  --bg: #f7f4f0;
  --panel: rgba(255,254,252,0.92);
  --panel-hover: rgba(255,254,252,1);
  --ink: #1a1816;
  --ink-secondary: #4a443e;
  --muted: #8a8279;
  --line: rgba(24,22,20,0.08);
  --line-strong: rgba(24,22,20,0.15);
  --accent: #c25a32;
  --accent-soft: rgba(194,90,50,0.1);
  --accent-deep: #a04428;
  --good: #1a8a5a;
  --good-soft: rgba(26,138,90,0.1);
  --warn: #b87a1a;
  --warn-soft: rgba(184,122,26,0.1);
  --bad: #c43c3c;
  --bad-soft: rgba(196,60,60,0.1);
  --shadow-sm: 0 2px 8px rgba(56,40,28,0.06);
  --shadow-md: 0 8px 24px rgba(56,40,28,0.08);
  --shadow-lg: 0 16px 48px rgba(56,40,28,0.1);
  --radius-sm: 10px;
  --radius-md: 16px;
  --radius-lg: 22px;
  --radius-xl: 28px;
  --transition-fast: 0.15s cubic-bezier(0.4,0,0.2,1);
  --transition-normal: 0.25s cubic-bezier(0.4,0,0.2,1);
}
* { box-sizing: border-box; margin: 0; }
html, body { margin: 0; min-height: 100%; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "PingFang SC", "Noto Sans SC", sans-serif;
  font-size: 14px;
  line-height: 1.6;
  color: var(--ink);
  background: linear-gradient(175deg, #faf8f5 0%, #f2ede6 50%, #ede7df 100%);
  -webkit-font-smoothing: antialiased;
}
button { font: inherit; cursor: pointer; }

/* ── Animations ── */
@keyframes fadeSlideUp {
  from { opacity: 0; transform: translateY(12px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes spin {
  to { transform: rotate(360deg); }
}
@keyframes pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(26,138,90,0.4); }
  50% { box-shadow: 0 0 0 6px rgba(26,138,90,0); }
}
@keyframes pulseWarn {
  0%, 100% { box-shadow: 0 0 0 0 rgba(184,122,26,0.4); }
  50% { box-shadow: 0 0 0 6px rgba(184,122,26,0); }
}
@keyframes slideIn {
  from { opacity: 0; transform: translateY(-8px); }
  to { opacity: 1; transform: translateY(0); }
}

/* ── Shell ── */
.shell {
  width: min(1180px, calc(100vw - 32px));
  margin: 0 auto;
  padding: 12px 0 16px;
  animation: fadeSlideUp 0.5s ease-out;
}

/* ── Topbar ── */
.topbar {
  display: flex;
  flex-direction: row;
  gap: 10px;
  align-items: stretch;
  margin-bottom: 10px;
}
.titleBlock,
.statusCard,
.panel {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-md);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
}
.titleBlock {
  flex: 1;
  padding: 14px 18px;
  animation: fadeSlideUp 0.4s ease-out;
}
.kicker {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent-deep);
  letter-spacing: 0.1em;
  text-transform: uppercase;
  font-size: 11px;
  font-weight: 600;
}
.titleBlock h1 {
  margin: 8px 0 4px;
  font-size: clamp(20px, 2.2vw, 26px);
  font-weight: 700;
  letter-spacing: -0.03em;
  line-height: 1.1;
}
.titleBlock p {
  margin: 0;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.5;
  max-width: 52ch;
}

/* ── Status Card ── */
.statusCard {
  flex: 1;
  padding: 12px 14px;
  animation: fadeSlideUp 0.5s ease-out 0.1s both;
}
.statusHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.statusBadge {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  border-radius: 999px;
  background: rgba(255,255,255,0.8);
  border: 1px solid var(--line);
  font-size: 13px;
  font-weight: 500;
}
.btn-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: rgba(255,255,255,0.6);
  color: var(--muted);
  font-size: 16px;
  cursor: pointer;
  transition: all var(--transition-fast);
}
.btn-icon:hover {
  background: rgba(255,255,255,1);
  color: var(--ink);
  border-color: var(--line-strong);
}
.btn-icon.spinning {
  animation: spin 0.8s linear infinite;
  pointer-events: none;
}
.dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--muted);
  flex-shrink: 0;
  transition: background var(--transition-normal);
}
.dot.good { background: var(--good); animation: pulse 2s ease-in-out infinite; }
.dot.warn { background: var(--warn); animation: pulseWarn 2s ease-in-out infinite; }
.dot.bad { background: var(--bad); }
.kv {
  display: grid;
  grid-template-columns: 88px 1fr;
  gap: 4px 8px;
  margin-top: 8px;
  font-size: 12px;
}
.kv dt { color: var(--muted); font-weight: 500; }
.kv dd { margin: 0; word-break: break-word; color: var(--ink-secondary); }

/* ── Action Panel (topbar slot) ── */
.actionPanel {
  flex: 1;
  padding: 14px 16px;
  animation: fadeSlideUp 0.4s ease-out 0.2s both;
}

/* ── Snapshot Panel (full-width) ── */
.snapshotPanel {
  padding: 14px 16px;
  animation: fadeSlideUp 0.4s ease-out 0.25s both;
}
.panel {
  padding: 14px 16px;
  animation: fadeSlideUp 0.4s ease-out 0.15s both;
}
.panel h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.02em;
}
.panelSub {
  margin-top: 3px;
  color: var(--muted);
  font-size: 11px;
  line-height: 1.5;
}

/* ── Action List ── */
.actionList {
  display: grid;
  gap: 6px;
  margin-top: 10px;
}
.btn {
  position: relative;
  width: 100%;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  padding: 9px 12px;
  text-align: left;
  background: rgba(255,255,255,0.7);
  color: var(--ink);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: transform var(--transition-fast), background var(--transition-fast), box-shadow var(--transition-fast), border-color var(--transition-fast);
}
.btn:hover {
  transform: translateY(-1px);
  background: rgba(255,255,255,0.95);
  box-shadow: var(--shadow-sm);
  border-color: var(--line-strong);
}
.btn:active {
  transform: translateY(0);
  box-shadow: none;
}
.btn.primary {
  background: linear-gradient(135deg, #d06840 0%, var(--accent) 50%, var(--accent-deep) 100%);
  color: #fff;
  border: none;
  font-weight: 600;
  box-shadow: 0 4px 14px rgba(194,90,50,0.25);
}
.btn.primary:hover {
  background: linear-gradient(135deg, #c25a32 0%, var(--accent-deep) 100%);
  box-shadow: 0 6px 20px rgba(194,90,50,0.3);
}
.btn.warn {
  background: var(--warn-soft);
  color: #7b4a0b;
  border-color: rgba(184,122,26,0.15);
}
.btn.warn:hover {
  background: rgba(184,122,26,0.15);
}
.btn.danger-confirm {
  background: var(--bad-soft);
  color: var(--bad);
  border-color: rgba(196,60,60,0.2);
  font-weight: 600;
}
.btn:disabled {
  opacity: .5;
  cursor: not-allowed;
  transform: none;
  box-shadow: none;
}
.btn.loading {
  color: transparent !important;
  pointer-events: none;
}
.btn.loading::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: 18px;
  height: 18px;
  margin: -9px 0 0 -9px;
  border: 2px solid rgba(0,0,0,0.2);
  border-top-color: currentColor;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}
.btn.primary.loading::after {
  border-color: rgba(255,255,255,0.3);
  border-top-color: #fff;
}

/* ── Messages ── */
.message {
  margin-top: 8px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  display: none;
  font-size: 12px;
  line-height: 1.5;
  position: relative;
  animation: slideIn 0.25s ease-out;
}
.message.show { display: flex; align-items: start; gap: 8px; }
.message .msg-icon { flex-shrink: 0; font-size: 14px; line-height: 1.55; }
.message .msg-text { flex: 1; }
.message .msg-close {
  flex-shrink: 0;
  background: none;
  border: none;
  padding: 0 2px;
  font-size: 16px;
  cursor: pointer;
  opacity: 0.5;
  color: inherit;
  line-height: 1;
}
.message .msg-close:hover { opacity: 1; }
.message.info { background: rgba(24,22,20,0.05); color: var(--ink-secondary); }
.message.ok { background: var(--good-soft); color: #145a3b; }
.message.warn { background: var(--warn-soft); color: #73470f; }
.message.error { background: var(--bad-soft); color: #771f1f; }

/* ── Section ── */
.sectionHeader {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 12px;
}

/* ── Snapshot List ── */
.list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 8px;
  margin-top: 10px;
}
.item {
  display: flex;
  flex-direction: column;
  gap: 0;
  padding: 12px 14px;
  border-radius: var(--radius-md);
  background: rgba(255,255,255,0.7);
  border: 1px solid var(--line);
  transition: all var(--transition-fast);
  position: relative;
  overflow: hidden;
}
.item::before {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 3px;
  background: transparent;
  transition: background var(--transition-fast);
}
.item:hover {
  background: rgba(255,255,255,0.95);
  box-shadow: var(--shadow-sm);
  border-color: var(--line-strong);
  transform: translateY(-1px);
}
.item:active { transform: translateY(0); }
.item.current-item {
  border-color: rgba(26,138,90,0.3);
  background: rgba(26,138,90,0.04);
}
.item.current-item::before { background: var(--good); }
.itemAvatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--accent-soft), rgba(194,90,50,0.2));
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 15px;
  font-weight: 700;
  color: var(--accent-deep);
  flex-shrink: 0;
  margin-bottom: 8px;
  letter-spacing: -0.02em;
}
.item.current-item .itemAvatar {
  background: linear-gradient(135deg, var(--good-soft), rgba(26,138,90,0.2));
  color: var(--good);
}
.itemTitleRow {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
  margin-bottom: 2px;
}
.itemTitle {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
  word-break: break-all;
}
.pill {
  display: inline-flex;
  align-items: center;
  padding: 2px 6px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  background: rgba(24,22,20,0.06);
  color: var(--muted);
}
.pill.current {
  background: var(--good-soft);
  color: #145a3b;
}
.pill.warn {
  background: var(--warn-soft);
  color: #7b4a0b;
}
.pill.accent {
  background: var(--accent-soft);
  color: var(--accent-deep);
}
.itemMeta {
  color: var(--muted);
  font-size: 11px;
  line-height: 1.45;
  word-break: break-word;
  margin-bottom: 2px;
}
.itemMeta.hint {
  color: var(--warn);
  font-style: italic;
}
.itemSpacer { flex: 1; }
.actionRow {
  display: flex;
  flex-direction: row;
  gap: 6px;
  margin-top: 10px;
}
.actionRow .btn {
  flex: 1;
  padding: 6px 8px;
  font-size: 11px;
  text-align: center;
  border-radius: var(--radius-sm);
}

/* ── Empty State ── */
.empty {
  padding: 20px 16px;
  border-radius: var(--radius-sm);
  border: 1px dashed var(--line-strong);
  color: var(--muted);
  font-size: 12px;
  line-height: 1.55;
  background: rgba(255,255,255,0.4);
  text-align: center;
}
.empty-icon {
  display: block;
  font-size: 24px;
  margin-bottom: 6px;
  opacity: 0.5;
}

/* ── Side Notes ── */
.sideNotes {
  display: grid;
  gap: 6px;
  margin-top: 10px;
}
.note {
  padding: 7px 10px;
  border-radius: var(--radius-sm);
  background: rgba(24,22,20,0.04);
  color: var(--muted);
  font-size: 11px;
  line-height: 1.5;
  border-left: 3px solid var(--line-strong);
}
.note.note-info {
  border-left-color: var(--accent);
  background: var(--accent-soft);
  color: var(--ink-secondary);
}

/* ── Scrollbar ── */
::-webkit-scrollbar { width: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: rgba(24,22,20,0.15); border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: rgba(24,22,20,0.25); }

/* ── Responsive ── */
@media (max-width: 680px) {
  .topbar {
    flex-direction: column;
  }
}
@media (max-width: 720px) {
  .shell {
    width: min(100vw, calc(100vw - 20px));
    padding-top: 10px;
    padding-bottom: 18px;
  }
  .list {
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  }
}
</style>
</head>
<body>
<div class="shell">
  <section class="topbar">
    <div class="titleBlock">
      <div class="kicker">\u25C6 Accio Manager</div>
      <h1>Accio \u8D26\u53F7\u4E0E\u5FEB\u7167</h1>
      <p>\u67E5\u770B\u7F51\u5173\u72B6\u6001\u3001\u7BA1\u7406\u591A\u8D26\u53F7\u767B\u5F55\u4E0E\u5FEB\u7167\u5207\u6362\u3002</p>
    </div>
    <aside class="statusCard">
      <div class="statusHeader">
        <div class="statusBadge"><span class="dot" id="gateway-dot"></span><span id="gateway-summary">\u6B63\u5728\u68C0\u67E5\u672C\u5730\u7F51\u5173\u72B6\u6001</span></div>
        <button class="btn-icon" id="refresh-btn" title="\u5237\u65B0\u72B6\u6001">\u21BB</button>
      </div>
      <dl class="kv" id="overview-kv"></dl>
    </aside>
    <aside class="panel actionPanel">
      <h2>\u8D26\u53F7\u64CD\u4F5C</h2>
      <div class="panelSub">\u65B0\u589E\u8D26\u53F7\u3001\u4FDD\u5B58\u5FEB\u7167\u3001\u767B\u51FA\u5F53\u524D\u8D26\u53F7\u3002</div>
      <div class="actionList">
        <button class="btn primary" id="account-login-btn">\uFF0B \u6DFB\u52A0\u8D26\u53F7\u767B\u5F55</button>
        <button class="btn" id="capture-current-btn">\u4FDD\u5B58\u5F53\u524D\u8D26\u53F7</button>
        <button class="btn warn" id="logout-btn">\u767B\u51FA\u5F53\u524D Accio</button>
      </div>
      <div id="action-message" class="message info"></div>
      <div id="current-account-note" class="note note-info" style="display:none"></div>
    </aside>
  </section>

  <section class="panel snapshotPanel">
    <div class="sectionHeader">
      <div>
        <h2>\u5DF2\u8BB0\u5F55\u8D26\u53F7</h2>
        <div class="panelSub">\u672C\u673A\u5DF2\u4FDD\u5B58\u7684\u8D26\u53F7\u3002\u70B9\u51FB\u201C\u5207\u6362\u201D\u5373\u53EF\u5207\u6362\u767B\u5F55\u8EAB\u4EFD\u3002</div>
      </div>
    </div>
    <div class="list" id="snapshot-list"></div>
  </section>
</div>
<script>
const els = {
  gatewayDot: document.getElementById('gateway-dot'),
  gatewaySummary: document.getElementById('gateway-summary'),
  overviewKv: document.getElementById('overview-kv'),
  snapshotList: document.getElementById('snapshot-list'),
  actionMessage: document.getElementById('action-message'),
  currentAccountNote: document.getElementById('current-account-note'),
  refreshBtn: document.getElementById('refresh-btn'),
  logoutBtn: document.getElementById('logout-btn'),
  accountLoginBtn: document.getElementById('account-login-btn'),
  snapshotBtn: document.getElementById('capture-current-btn')
};
const desktopBridge = typeof window !== 'undefined' && window.accioBridgeDesktop ? window.accioBridgeDesktop : null;
const isElectronShell = String(navigator.userAgent || '').includes('Electron/') || Boolean(desktopBridge);
let messageTimer = null;
const MSG_ICONS = { info: '\u2139\uFE0F', ok: '\u2705', warn: '\u26A0\uFE0F', error: '\u274C' };
function setMessage(type, text) {
  if (messageTimer) { clearTimeout(messageTimer); messageTimer = null; }
  els.actionMessage.className = 'message show ' + type;
  els.actionMessage.innerHTML = '<span class="msg-icon">' + (MSG_ICONS[type] || '') + '</span><span class="msg-text">' + text + '</span><button class="msg-close" onclick="clearMessage()">\u00D7</button>';
  if (type === 'ok') { messageTimer = setTimeout(function() { clearMessage(); }, 6000); }
}
function clearMessage() {
  if (messageTimer) { clearTimeout(messageTimer); messageTimer = null; }
  els.actionMessage.className = 'message info';
  els.actionMessage.innerHTML = '';
}
async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || 'GET',
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((payload && payload.error && payload.error.message) || payload.error || 'Request failed');
  return payload;
}
function formatTime(value) {
  if (!value) return '—';
  try { return new Date(value).toLocaleString(); } catch { return String(value); }
}
function badgeState(gateway) {
  if (!gateway || !gateway.reachable) return ['bad', '网关不可达'];
  if (gateway.authenticated) return ['good', '网关已登录'];
  return ['warn', '网关在线但未登录'];
}
function renderKv(target, rows) {
  target.innerHTML = rows.map(([k, v]) => '<dt>' + k + '</dt><dd>' + v + '</dd>').join('');
}
function renderCurrentAccountNote(data) {
  if (!els.currentAccountNote) {
    return;
  }

  const gatewayUser = data.gateway && data.gateway.user ? data.gateway.user : null;
  const currentSnapshot = data.currentSnapshot || null;
  const canCapture = Boolean(data.gateway && data.gateway.reachable && data.gateway.authenticated && gatewayUser && gatewayUser.id);

  if (els.snapshotBtn) {
    els.snapshotBtn.disabled = !canCapture;
  }

  function showNote(text) {
    els.currentAccountNote.textContent = text;
    els.currentAccountNote.style.display = '';
  }
  function hideNote() {
    els.currentAccountNote.textContent = '';
    els.currentAccountNote.style.display = 'none';
  }

  if (!gatewayUser || !gatewayUser.id) {
    if (els.snapshotBtn) els.snapshotBtn.textContent = '保存当前账号';
    showNote('当前没有识别到已登录账号，"保存当前账号"不可用。');
    return;
  }

  if (!currentSnapshot) {
    if (els.snapshotBtn) els.snapshotBtn.textContent = '保存当前账号';
    showNote('当前账号还没有本地记录，点击"保存当前账号"新建记录。');
    return;
  }

  if (currentSnapshot.hasFullAuthState) {
    if (els.snapshotBtn) els.snapshotBtn.textContent = '更新当前账号';
    hideNote();
    return;
  }

  if (els.snapshotBtn) els.snapshotBtn.textContent = '补全当前账号';
  showNote('旧式快照 ' + currentSnapshot.alias + '，建议重新走"添加账号登录"补齐完整凭证。');
}
function renderSnapshots(data) {
  const snapshots = data.snapshots || [];
  const currentUserId = data.gateway && data.gateway.user && data.gateway.user.id ? String(data.gateway.user.id) : '';
  if (snapshots.length === 0) {
    els.snapshotList.innerHTML = '<div class="empty"><span class="empty-icon">\uD83D\uDCCB</span>还没有已记录账号。点击左侧"添加账号登录"完成第一个 Accio 登录吧！</div>';
    return;
  }

  els.snapshotList.innerHTML = snapshots.map((item) => {
    const userId = item.gatewayUser && item.gatewayUser.id ? String(item.gatewayUser.id) : '';
    const userName = item.gatewayUser && item.gatewayUser.name ? String(item.gatewayUser.name) : '';
    const displayName = userName || userId || item.alias;
    const subLabel = userName && userId ? userId : (userName ? '' : '');
    const avatarChar = displayName ? displayName.charAt(0).toUpperCase() : '?';
    const current = currentUserId && userId && currentUserId === userId;
    const itemClass = current ? 'item current-item' : 'item';
    const statusPill = item.hasFullAuthState && item.hasAuthCallback
      ? '<span class="pill current">完整</span>'
      : (!item.hasFullAuthState ? '<span class="pill warn">旧快照</span>' : '<span class="pill warn">仅文件</span>');
    return '<div class="' + itemClass + '">'
      + '<div class="itemAvatar">' + avatarChar + '</div>'
      + '<div class="itemTitleRow">'
      + '<h3 class="itemTitle">' + displayName + '</h3>'
      + (current ? '<span class="pill current">当前</span>' : '')
      + statusPill
      + '</div>'
      + (subLabel ? '<div class="itemMeta">' + subLabel + '</div>' : '')
      + '<div class="itemMeta">' + item.alias + '</div>'
      + '<div class="itemMeta">' + formatTime(item.capturedAt) + ' &middot; ' + String(item.artifactCount || 0) + ' 个文件</div>'
      + (!item.hasFullAuthState ? '<div class="itemMeta hint">旧格式快照，建议重新登录</div>' : '')
      + (!item.hasAuthCallback ? '<div class="itemMeta hint">缺少原生回调，建议重新登录</div>' : '')
      + '<div class="itemSpacer"></div>'
      + '<div class="actionRow"><button class="btn" data-activate-snapshot="' + item.alias + '">切换</button><button class="btn" data-delete-snapshot="' + item.alias + '">删除</button></div>'
      + '</div>';
  }).join('');
}
function renderState(data) {
  const [dotClass, summary] = badgeState(data.gateway);
  els.gatewayDot.className = 'dot ' + dotClass;
  els.gatewaySummary.textContent = summary + (data.gateway && data.gateway.user && data.gateway.user.id ? ' · ' + data.gateway.user.id : '');
  renderKv(els.overviewKv, [
    ['当前用户', data.gateway && data.gateway.user ? ((data.gateway.user.id || 'unknown') + (data.gateway.user.name ? ' (' + data.gateway.user.name + ')' : '')) : '未登录'],
    ['已记录账号', String((data.snapshots || []).length)],
    ['当前账号快照', data.currentSnapshot ? (data.currentSnapshot.alias + (data.currentSnapshot.hasFullAuthState ? ' · 完整' : ' · 旧格式') + (data.currentSnapshot.hasAuthCallback ? ' · 原生回调' : ' · 仅文件')) : '无'],
    ['活动存储', data.storage && data.storage.kind ? data.storage.kind : 'none'],
    ['网关地址', data.gateway && data.gateway.baseUrl ? data.gateway.baseUrl : '—'],
    ['应用路径', data.bridge && data.bridge.appPath ? data.bridge.appPath : '—']
  ]);
  renderCurrentAccountNote(data);
  renderSnapshots(data);
}
async function refreshState(message) {
  const payload = await api('/admin/api/state');
  renderState(payload);
  if (message) setMessage('ok', message);
}
async function withAction(button, fn) {
  const prev = button.textContent;
  button.disabled = true;
  button.classList.add('loading');
  try { await fn(); } finally { button.disabled = false; button.classList.remove('loading'); button.textContent = prev; }
}

async function sendDesktopCommand(command, params = {}) {
  if (!isElectronShell) {
    return false;
  }

  if (desktopBridge && command === 'launch-accio' && typeof desktopBridge.launchAccio === 'function') {
    await desktopBridge.launchAccio(params);
    return true;
  }

  const search = new URLSearchParams(params);
  const target = 'accio-bridge://' + command + (search.toString() ? ('?' + search.toString()) : '');
  window.open(target, '_blank', 'noopener,noreferrer');
  return true;
}

async function waitForGatewayUser(expectedUserId, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastState = null;

  while (Date.now() < deadline) {
    const payload = await api('/admin/api/state');
    lastState = payload;
    renderState(payload);

    const currentUserId = payload && payload.gateway && payload.gateway.user && payload.gateway.user.id
      ? String(payload.gateway.user.id)
      : '';

    if (currentUserId && (!expectedUserId || currentUserId === String(expectedUserId))) {
      return payload;
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  return lastState;
}

let activeLoginFlowId = null;

async function pollAccountLogin(flowId) {
  const deadline = Date.now() + 5 * 60 * 1000;
  let lastState = '';
  let refreshCountdown = 0;
  while (Date.now() < deadline) {
    const payload = await api('/admin/api/accounts/login-status?flowId=' + encodeURIComponent(flowId));

    if (payload.gatewayState) {
      const currentText = payload.gatewayState.userId
        ? (payload.gatewayState.userId + (payload.gatewayState.userName ? ' (' + payload.gatewayState.userName + ')' : ''))
        : (payload.gatewayState.authenticated ? '已登录但未返回用户ID' : '未登录');
      renderKv(els.overviewKv, [
        ['当前用户', currentText],
        ['已记录账号', els.snapshotList.children ? String(els.snapshotList.children.length) : '—'],
        ['活动存储', '同步中'],
        ['网关地址', payload.gatewayState.baseUrl || '—'],
        ['应用路径', '—']
      ]);
    }

    if (payload.completed) {
      return payload;
    }

    if (payload.state && payload.state !== lastState) {
      const detail = payload.currentUserId ? (' 当前识别账号: ' + payload.currentUserId) : '';
      setMessage(payload.state === 'waiting_new_account' ? 'warn' : 'info', (payload.message || '等待登录状态更新。') + detail);
      lastState = payload.state;
    }

    refreshCountdown += 1;
    if (refreshCountdown >= 3) {
      refreshCountdown = 0;
      refreshState().catch(() => {});
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error('等待新账号登录超时。');
}

async function observeAccountLogin(flowId) {
  try {
    const result = await pollAccountLogin(flowId);
    await refreshState();
    if (result && result.state === 'login_failed') {
      setMessage('error', result.note || '桥接层未能完成账号接管。');
    } else if (result && result.state === 'same_account_returned') {
      setMessage('warn', result.note || '你登录回了当前账号，没有新增账号。');
    } else {
      setMessage('ok', (result && result.note) || ('新账号已记录：' + ((result && result.alias) || 'acct-auto')));
    }
  } catch (error) {
    setMessage('error', error && error.message ? error.message : String(error));
  } finally {
    if (activeLoginFlowId === flowId) {
      activeLoginFlowId = null;
      els.accountLoginBtn.disabled = false;
      els.accountLoginBtn.textContent = '\uFF0B 添加账号登录';
      els.accountLoginBtn.classList.remove('loading');
    }
  }
}

els.refreshBtn.addEventListener('click', async () => {
  els.refreshBtn.classList.add('spinning');
  clearMessage();
  try { await refreshState('界面状态已刷新。'); } catch (e) { setMessage('error', e.message || String(e)); }
  els.refreshBtn.classList.remove('spinning');
});
els.logoutBtn.addEventListener('click', () => withAction(els.logoutBtn, async () => { clearMessage(); await api('/admin/api/gateway/logout', { method: 'POST', body: {} }); await refreshState(); setMessage('warn', '已请求 Accio 登出。'); }));
els.snapshotBtn.addEventListener('click', () => withAction(els.snapshotBtn, async () => { clearMessage(); const actionLabel = els.snapshotBtn.textContent || '保存当前账号'; const payload = await api('/admin/api/snapshots', { method: 'POST', body: {} }); await refreshState(); setMessage('ok', actionLabel + '已完成：' + (payload.alias || 'acct-auto')); }));
els.accountLoginBtn.addEventListener('click', async () => {
  if (activeLoginFlowId) {
    setMessage('info', '当前已有一个账号登录流程在等待完成。请先完成当前登录，或等待它超时。');
    return;
  }

  clearMessage();
  els.accountLoginBtn.disabled = true;
  els.accountLoginBtn.classList.add('loading');
  els.accountLoginBtn.textContent = '等待登录完成...';

  try {
    const payload = await api('/admin/api/accounts/login', { method: 'POST', body: {} });
    if (!payload.loginUrl) {
      throw new Error('未收到登录链接。');
    }

    activeLoginFlowId = payload.flowId;
    const preservedNote = payload.preservedAlias
      ? (' 当前账号快照已预先记录/刷新：' + payload.preservedAlias + '。')
      : '';
    setMessage(payload.loginOpened ? 'info' : 'warn', (payload.loginOpened
      ? '已在本机打开 Accio 登录页。完成新账号登录后，系统会自动记录到列表。'
      : '登录流程已创建，但本机未能自动打开登录页，请手动使用返回的链接完成登录。') + preservedNote);
    observeAccountLogin(payload.flowId);
  } catch (error) {
    activeLoginFlowId = null;
    els.accountLoginBtn.disabled = false;
    els.accountLoginBtn.classList.remove('loading');
    els.accountLoginBtn.textContent = '\uFF0B 添加账号登录';
    setMessage('error', error && error.message ? error.message : String(error));
  }
});
document.addEventListener('click', async (event) => {
  const activate = event.target.closest('[data-activate-snapshot]');
  if (activate) {
    const alias = activate.getAttribute('data-activate-snapshot');
    await withAction(activate, async () => {
      clearMessage();
      const payload = await api('/admin/api/snapshots/activate', { method: 'POST', body: { alias } });
      await refreshState();

      if (payload && payload.manualRelaunchRequired && payload.expectedUserId && isElectronShell) {
        await sendDesktopCommand('launch-accio');
        setMessage('warn', '快照已恢复，正在通过桌面壳拉起 Accio，并等待目标账号上线...');
        const state = await waitForGatewayUser(payload.expectedUserId, 30000);
        const currentUserId = state && state.gateway && state.gateway.user && state.gateway.user.id
          ? String(state.gateway.user.id)
          : '';

        if (currentUserId && currentUserId === String(payload.expectedUserId)) {
          setMessage('ok', 'Accio 已重新打开，当前账号已切换到 ' + currentUserId + '。');
        } else {
          setMessage('warn', payload.note || '快照已恢复，但仍未确认目标账号。请手动打开 Accio 后再刷新状态。');
        }
        return;
      }

      setMessage(payload && payload.switched ? 'ok' : 'warn', payload.note || ('已切换到账号 ' + alias + '。'));
    });
    return;
  }

  const remove = event.target.closest('[data-delete-snapshot]');
  if (!remove) {
    return;
  }

  const aliasToDelete = remove.getAttribute('data-delete-snapshot');
  if (remove.dataset.confirmDelete) {
    delete remove.dataset.confirmDelete;
    await withAction(remove, async () => {
      clearMessage();
      await api('/admin/api/snapshots/delete', { method: 'POST', body: { alias: aliasToDelete } });
      await refreshState();
      setMessage('ok', '已删除账号记录：' + aliasToDelete);
    });
    return;
  }

  remove.dataset.confirmDelete = '1';
  const prevText = remove.textContent;
  remove.textContent = '确认删除？';
  remove.classList.add('danger-confirm');
  setTimeout(() => {
    if (remove.dataset.confirmDelete) {
      delete remove.dataset.confirmDelete;
      remove.textContent = prevText;
      remove.classList.remove('danger-confirm');
    }
  }, 3000);
});
refreshState().catch((error) => setMessage('error', error.message || String(error)));
</script>
</body>
</html>`;
}

/**
 * Renders the replacement `/admin` page as a read-only account board.
 *
 * @param {object} config Runtime configuration object.
 * @returns {string} HTML document string.
 */
function renderAdminAccountsPage(config) {
  const title = escapeHtml(`Accio 账号看板 · ${config.port}`);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
:root {
  --bg: #f3efe7;
  --panel: rgba(255,255,252,0.88);
  --panel-strong: #fffdfa;
  --ink: #181511;
  --muted: #756d63;
  --line: rgba(24,21,17,0.09);
  --line-strong: rgba(24,21,17,0.18);
  --accent: #9f492c;
  --accent-soft: rgba(159,73,44,0.1);
  --good: #1d7d55;
  --good-soft: rgba(29,125,85,0.11);
  --warn: #a76b12;
  --warn-soft: rgba(167,107,18,0.12);
  --bad: #b33838;
  --bad-soft: rgba(179,56,56,0.12);
  --shadow: 0 18px 50px rgba(53,38,25,0.08);
  --radius-lg: 26px;
  --radius-md: 18px;
  --radius-sm: 12px;
}
* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "PingFang SC", "Noto Sans SC", sans-serif;
  color: var(--ink);
  background:
    radial-gradient(circle at top left, rgba(159,73,44,0.12), transparent 28%),
    radial-gradient(circle at top right, rgba(29,125,85,0.09), transparent 20%),
    linear-gradient(180deg, #fbf8f2 0%, #f3efe7 45%, #ece6db 100%);
  -webkit-font-smoothing: antialiased;
}
button { font: inherit; }
.shell {
  width: min(1240px, calc(100vw - 28px));
  margin: 0 auto;
  padding: 28px 0 36px;
}
.hero {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 18px;
  align-items: end;
  margin-bottom: 18px;
}
.heroMain {
  background: linear-gradient(135deg, rgba(255,253,250,0.94), rgba(247,240,232,0.84));
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow);
  padding: 22px 24px;
}
.eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 5px 12px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.hero h1 {
  margin: 14px 0 10px;
  font-size: clamp(28px, 4vw, 44px);
  line-height: 1.02;
  letter-spacing: -0.04em;
}
.hero p {
  margin: 0;
  max-width: 58ch;
  color: var(--muted);
  font-size: 14px;
  line-height: 1.7;
}
.toolbar {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 260px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow);
  padding: 18px;
}
.toolbarLabel {
  color: var(--muted);
  font-size: 12px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.toolbarStrong {
  font-size: 14px;
  font-weight: 600;
}
.toolbarMeta {
  color: var(--muted);
  font-size: 13px;
}
.btn {
  border: 1px solid var(--line);
  background: rgba(255,255,255,0.82);
  color: var(--ink);
  border-radius: 999px;
  padding: 10px 14px;
  cursor: pointer;
  transition: transform .15s ease, border-color .15s ease, background .15s ease;
}
.btn:hover {
  transform: translateY(-1px);
  background: #fff;
  border-color: var(--line-strong);
}
.btn:disabled {
  cursor: wait;
  opacity: .7;
  transform: none;
}
.boardMeta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
}
.boardMetaText {
  color: var(--muted);
  font-size: 13px;
}
.notice {
  display: none;
  margin-bottom: 14px;
  padding: 11px 14px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  background: rgba(255,255,255,0.74);
  color: var(--ink);
  font-size: 13px;
}
.notice.show { display: block; }
.notice.ok { background: var(--good-soft); color: #175840; border-color: rgba(29,125,85,0.16); }
.notice.error { background: var(--bad-soft); color: #7f2323; border-color: rgba(179,56,56,0.18); }
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(290px, 1fr));
  gap: 16px;
}
.card {
  display: grid;
  gap: 14px;
  background: linear-gradient(180deg, rgba(255,253,250,0.96), rgba(249,244,237,0.9));
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow);
  padding: 18px;
}
.cardHeader {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 12px;
}
.cardTitle {
  display: grid;
  gap: 4px;
}
.cardTitle h2 {
  margin: 0;
  font-size: 20px;
  line-height: 1.1;
  letter-spacing: -0.03em;
  word-break: break-word;
}
.cardSub {
  color: var(--muted);
  font-size: 12px;
  word-break: break-word;
}
.stack {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  background: rgba(24,21,17,0.06);
  color: var(--muted);
}
.pill.good { background: var(--good-soft); color: var(--good); }
.pill.warn { background: var(--warn-soft); color: var(--warn); }
.pill.bad { background: var(--bad-soft); color: var(--bad); }
.metrics {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.metric {
  padding: 12px;
  border-radius: var(--radius-sm);
  background: rgba(255,255,255,0.68);
  border: 1px solid var(--line);
}
.metricLabel {
  color: var(--muted);
  font-size: 12px;
}
.metricValue {
  margin-top: 6px;
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.04em;
}
.metaList {
  display: grid;
  gap: 8px;
}
.metaRow {
  display: grid;
  grid-template-columns: 92px 1fr;
  gap: 8px;
  font-size: 13px;
}
.metaLabel {
  color: var(--muted);
}
.metaValue {
  color: var(--ink);
  word-break: break-word;
}
.tokenBox {
  padding: 14px;
  border-radius: var(--radius-sm);
  background: #171412;
  color: #f8f5ee;
  border: 1px solid rgba(255,255,255,0.08);
}
.tokenTop {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
}
.tokenHint {
  color: rgba(248,245,238,0.68);
  font-size: 12px;
}
.copyBtn {
  border: none;
  border-radius: 999px;
  background: linear-gradient(135deg, #c56a48, #9f492c);
  color: #fff;
  padding: 8px 12px;
  cursor: pointer;
}
.copyBtn:disabled {
  opacity: .55;
  cursor: not-allowed;
}
.tokenValue {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-all;
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
  font-size: 12px;
  line-height: 1.65;
}
.tokenPreview {
  color: rgba(248,245,238,0.74);
  font-size: 11px;
  margin-top: 10px;
}
.errorBox {
  padding: 11px 12px;
  border-radius: var(--radius-sm);
  background: var(--bad-soft);
  border: 1px solid rgba(179,56,56,0.14);
  color: #7f2323;
  font-size: 13px;
  line-height: 1.6;
}
.empty {
  padding: 24px;
  text-align: center;
  border: 1px dashed var(--line-strong);
  border-radius: var(--radius-md);
  color: var(--muted);
  background: rgba(255,255,255,0.56);
}
@media (max-width: 860px) {
  .hero {
    grid-template-columns: 1fr;
  }
}
</style>
</head>
<body>
<div class="shell">
  <section class="hero">
    <div class="heroMain">
      <div class="eyebrow">Accio Board</div>
      <h1>账号信息看板</h1>
      <p>这里只显示本地账号信息和积分状态，不再提供授权登录、快照切换或任何写操作。每个账号一张卡片，支持直接复制 accessToken。</p>
    </div>
    <aside class="toolbar">
      <div class="toolbarLabel">数据状态</div>
      <div class="toolbarStrong" id="summary-text">正在加载账号信息...</div>
      <div class="toolbarMeta" id="summary-meta">请稍候</div>
      <button class="btn" id="refresh-btn">刷新数据</button>
    </aside>
  </section>

  <div class="boardMeta">
    <div class="boardMetaText" id="board-meta-text">等待数据...</div>
  </div>

  <div class="notice" id="page-notice"></div>
  <section class="grid" id="account-grid"></section>
</div>
<script>
const els = {
  summaryText: document.getElementById('summary-text'),
  summaryMeta: document.getElementById('summary-meta'),
  boardMetaText: document.getElementById('board-meta-text'),
  refreshBtn: document.getElementById('refresh-btn'),
  pageNotice: document.getElementById('page-notice'),
  accountGrid: document.getElementById('account-grid')
};

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function setNotice(type, text) {
  if (!text) {
    els.pageNotice.className = 'notice';
    els.pageNotice.textContent = '';
    return;
  }

  els.pageNotice.className = 'notice show ' + type;
  els.pageNotice.textContent = text;
}

function metricValue(value, fallback) {
  return value == null || value === '' ? (fallback || '—') : String(value);
}

function createMetaRow(label, value) {
  return '<div class="metaRow"><div class="metaLabel">' + escapeHtml(label) + '</div><div class="metaValue">' + escapeHtml(value || '—') + '</div></div>';
}

function createStatusPill(account) {
  if (account.status === 'ok') {
    return '<span class="pill good">额度正常</span>';
  }

  if (account.status === 'skipped') {
    return '<span class="pill warn">已跳过</span>';
  }

  return '<span class="pill bad">异常</span>';
}

function createSessionPill(account) {
  if (account.sessionStatus === 'ok') {
    return '<span class="pill good">会话正常</span>';
  }

  if (account.sessionStatus === 'skipped') {
    return '<span class="pill warn">会话跳过</span>';
  }

  if (account.sessionError && account.sessionError.type === 'user_not_activated') {
    return '<span class="pill warn">未激活</span>';
  }

  if (account.sessionError && account.sessionError.type === 'authentication_error') {
    return '<span class="pill bad">未授权</span>';
  }

  return '<span class="pill bad">会话异常</span>';
}

function renderCards(accounts) {
  if (!Array.isArray(accounts) || accounts.length === 0) {
    els.accountGrid.innerHTML = '<div class="empty">当前没有可展示的账号。</div>';
    return;
  }

  els.accountGrid.innerHTML = accounts.map((account) => {
    const enabledPill = account.enabled ? '<span class="pill good">启用</span>' : '<span class="pill warn">禁用</span>';
    const tokenDisabled = !account.accessToken ? ' disabled' : '';
    const quotaErrorBlock = account.error
      ? '<div class="errorBox">' + escapeHtml(account.error.message || '未知错误') + '</div>'
      : '';
    const sessionErrorBlock = account.sessionError
      ? '<div class="errorBox">' + escapeHtml('会话探测：' + (account.sessionError.message || '未知错误')) + '</div>'
      : '';

    return '<article class="card">'
      + '<div class="cardHeader">'
      + '<div class="cardTitle">'
      + '<h2>' + escapeHtml(account.name || account.id || '未命名账号') + '</h2>'
      + '<div class="cardSub">' + escapeHtml(account.id || '—') + '</div>'
      + '</div>'
      + '<div class="stack">' + createStatusPill(account) + createSessionPill(account) + enabledPill + '</div>'
      + '</div>'
      + '<div class="metrics">'
      + '<div class="metric"><div class="metricLabel">已用百分比</div><div class="metricValue">' + escapeHtml(metricValue(account.usagePercentText, '—')) + '</div></div>'
      + '<div class="metric"><div class="metricLabel">可用百分比</div><div class="metricValue">' + escapeHtml(metricValue(account.availablePercentText, '—')) + '</div></div>'
      + '</div>'
      + '<div class="metaList">'
      + createMetaRow('来源', account.source || '—')
      + createMetaRow('额度来源', account.quotaSource || '—')
      + createMetaRow('会话状态', account.sessionStatusText || '—')
      + createMetaRow('会话来源', account.sessionProbeSource || '—')
      + createMetaRow('过期时间', account.expiresAtText || '—')
      + createMetaRow('刷新剩余', account.refreshCountdownText || '—')
      + createMetaRow('刷新时刻', account.refreshAtText || '—')
      + '</div>'
      + quotaErrorBlock
      + sessionErrorBlock
      + '<div class="tokenBox">'
      + '<div class="tokenTop">'
      + '<div class="tokenHint">accessToken</div>'
      + '<button class="copyBtn" data-copy-token="' + escapeHtml(account.accessToken || '') + '"' + tokenDisabled + '>复制 Token</button>'
      + '</div>'
      + '<pre class="tokenValue">' + escapeHtml(account.accessToken || '该账号没有 accessToken') + '</pre>'
      + '<div class="tokenPreview">预览：' + escapeHtml(account.accessTokenPreview || '—') + '</div>'
      + '</div>'
      + '</article>';
  }).join('');
}

async function api(path) {
  const response = await fetch(path, {
    method: 'GET',
    headers: { 'content-type': 'application/json' }
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error((payload && payload.error && payload.error.message) || '请求失败');
  }

  return payload;
}

async function copyText(text) {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'readonly');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

function renderOverview(payload) {
  const accounts = Array.isArray(payload.accounts) ? payload.accounts : [];
  const quotaOkCount = accounts.filter((item) => item.status === 'ok').length;
  const sessionOkCount = accounts.filter((item) => item.sessionStatus === 'ok').length;
  els.summaryText.textContent = '共 ' + accounts.length + ' 个账号，' + quotaOkCount + ' 个额度正常，' + sessionOkCount + ' 个会话正常';
  els.summaryMeta.textContent = '最近刷新：' + (payload.fetchedAt ? new Date(payload.fetchedAt).toLocaleString() : '—');
  els.boardMetaText.textContent = '额度缓存 TTL：' + String(payload.quotaCacheTtlMs || 0) + 'ms · 会话缓存 TTL：' + String(payload.sessionCacheTtlMs || 0) + 'ms';
  renderCards(accounts);
}

async function loadOverview(showNotice) {
  els.refreshBtn.disabled = true;

  try {
    const payload = await api('/admin/api/accounts/overview');
    renderOverview(payload);
    if (showNotice) {
      setNotice('ok', '账号信息已刷新。');
      setTimeout(() => setNotice('', ''), 3000);
    } else {
      setNotice('', '');
    }
  } catch (error) {
    els.summaryText.textContent = '账号信息加载失败';
    els.summaryMeta.textContent = error && error.message ? error.message : String(error);
    els.boardMetaText.textContent = '请检查只读接口返回';
    els.accountGrid.innerHTML = '<div class="empty">加载失败，请稍后重试。</div>';
    setNotice('error', error && error.message ? error.message : String(error));
  } finally {
    els.refreshBtn.disabled = false;
  }
}

els.refreshBtn.addEventListener('click', () => {
  loadOverview(true);
});

document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-copy-token]');

  if (!button) {
    return;
  }

  const token = button.getAttribute('data-copy-token') || '';

  if (!token) {
    setNotice('error', '该账号没有可复制的 accessToken。');
    return;
  }

  const previousText = button.textContent;
  button.disabled = true;

  try {
    await copyText(token);
    button.textContent = '已复制';
    setNotice('ok', 'accessToken 已复制到剪贴板。');
    setTimeout(() => {
      button.textContent = previousText;
      button.disabled = false;
    }, 1200);
  } catch (error) {
    button.disabled = false;
    setNotice('error', '复制失败：' + (error && error.message ? error.message : String(error)));
  }
});

loadOverview(false);
</script>
</body>
</html>`;
}


async function handleAdminPage(req, res, config) {
  writeHtml(res, 200, renderAdminAccountsPage(config));
}

async function handleAdminState(req, res, config, authProvider) {
  writeJson(res, 200, await buildAdminState(config, authProvider));
}

/**
 * Handles the account quota probe endpoint for all configured file accounts.
 *
 * @param {import("node:http").IncomingMessage} req Incoming HTTP request.
 * @param {import("node:http").ServerResponse} res Outgoing HTTP response.
 * @param {object} config Runtime configuration object.
 * @param {object} [options] Optional test hooks forwarded to the quota fetcher.
 * @returns {Promise<void>} Resolves after the JSON response has been written.
 */
async function handleAdminAccountsQuota(req, res, config, options = {}) {
  const payload = await fetchAccountsQuota(config, options);
  writeJson(res, 200, payload);
}

/**
 * Handles the read-only account overview endpoint used by the replacement admin page.
 *
 * @param {import("node:http").IncomingMessage} req Incoming HTTP request.
 * @param {import("node:http").ServerResponse} res Outgoing HTTP response.
 * @param {object} config Runtime configuration object.
 * @param {object} [options] Optional test hooks forwarded to the overview fetcher.
 * @returns {Promise<void>} Resolves after the JSON response has been written.
 */
async function handleAdminAccountsOverview(req, res, config, options = {}) {
  const payload = await fetchAccountsOverview(config, options);
  writeJson(res, 200, payload);
}

async function handleAdminSnapshotCreate(req, res, config) {
  const body = await readJsonBody(req, req.bridgeContext && req.bridgeContext.bodyParser ? req.bridgeContext.bodyParser : {});
  const gateway = await readGatewayState(config.baseUrl);
  const alias = body && body.alias ? String(body.alias).trim() : deriveSnapshotAliasFromGatewayUser(gateway.user || null);
  const result = snapshotActiveCredentials(alias, { gatewayUser: gateway.user || null });
  writeJson(res, 200, {
    ok: true,
    alias: result.alias,
    dir: result.dir,
    kind: result.metadata.kind,
    capturedAt: result.metadata.capturedAt
  });
}

async function handleAdminSnapshotActivate(req, res, config, gatewayManager) {
  const body = await readJsonBody(req, req.bridgeContext && req.bridgeContext.bodyParser ? req.bridgeContext.bodyParser : {});
  const alias = body && body.alias ? String(body.alias).trim() : "";
  if (!alias) {
    writeJson(res, 400, { error: { type: "invalid_request_error", message: "alias is required" } });
    return;
  }

  const gatewayBefore = await readGatewayState(config.baseUrl);
  const resolvedAuth = resolveSnapshotAuthPayload(alias, config.accountsPath);
  const authPayload = resolvedAuth.payload;
  const authPayloadSource = resolvedAuth.source;
  log.info("snapshot switch requested", {
    alias,
    gatewayBefore: summarizeGatewayState(gatewayBefore),
    hasAuthCallback: Boolean(authPayload),
    authPayloadSource: authPayloadSource || null
  });

  if (authPayload && authPayload.accessToken && authPayload.refreshToken && (authPayload.expiresAtRaw || authPayload.expiresAtMs)) {
    const expectedUserId = authPayload.user && authPayload.user.id
      ? String(authPayload.user.id)
      : "";
    const currentGatewayUserId = extractGatewayUserId(gatewayBefore);

    if (gatewayBefore && gatewayBefore.reachable && gatewayBefore.authenticated && expectedUserId && currentGatewayUserId === expectedUserId) {
      if (authPayloadSource === "accounts-file") {
        writeSnapshotAuthPayload(alias, authPayload);
      }

      writeJson(res, 200, {
        ok: true,
        alias,
        switched: true,
        currentUserId: currentGatewayUserId,
        expectedUserId,
        appRestarted: false,
        manualRelaunchRequired: false,
        usedAuthCallback: true,
        authPayloadSource: authPayloadSource || null,
        note: `当前已经是账号 ${expectedUserId}，无需切换。`
      });
      return;
    }

    let primedAuthPayload;
    try {
      primedAuthPayload = await refreshAuthPayloadViaUpstream(config, authPayload, {
        alias,
        previousUserId: currentGatewayUserId || null
      });
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      log.warn("snapshot switch upstream refresh failed", {
        alias,
        error: message,
        expectedUserId: expectedUserId || null
      });
      writeJson(res, 502, {
        ok: false,
        alias,
        error: {
          type: "upstream_refresh_failed",
          message: `未能用目标账号 refreshToken 建立上游绑定：${message}`
        }
      });
      return;
    }

    if (gatewayBefore && gatewayBefore.reachable && gatewayBefore.authenticated) {
      await requestGatewayJson(gatewayManager, "/auth/logout", { method: "POST", body: {} }).catch((error) => {
        log.warn("snapshot switch logout before callback replay failed", {
          alias,
          error: error && error.message ? error.message : String(error)
        });
      });
    }

    await forwardGatewayAuthCallback(gatewayManager, primedAuthPayload, { includeState: false, timeoutMs: 20000 });
    const gatewayAfter = await waitForGatewayAuthenticatedUser(config.baseUrl, expectedUserId, 20000, 500);
    const currentUserId = extractGatewayUserId(gatewayAfter);
    const switched = Boolean(gatewayAfter && gatewayAfter.reachable && gatewayAfter.authenticated && (!expectedUserId || currentUserId === expectedUserId));

    if (switched) {
      const refreshedAuth = {
        ...primedAuthPayload,
        user: gatewayAfter && gatewayAfter.user ? gatewayAfter.user : primedAuthPayload.user || null,
        source: "gateway-auth-callback"
      };
      snapshotActiveCredentials(alias, {
        gatewayUser: refreshedAuth.user,
        notes: "refreshed after gateway auth callback replay",
        authPayload: refreshedAuth
      });
      writeSnapshotAuthPayload(alias, refreshedAuth);
      writeAccountToFile(config.accountsPath, alias, refreshedAuth.accessToken, {
        user: refreshedAuth.user,
        expiresAtMs: refreshedAuth.expiresAtMs,
        expiresAtRaw: refreshedAuth.expiresAtRaw,
        source: "gateway-auth-callback",
        authPayload: refreshedAuth
      });
    }

    writeJson(res, 200, {
      ok: true,
      alias,
      switched,
      currentUserId: currentUserId || null,
      expectedUserId: expectedUserId || null,
      appRestarted: false,
      manualRelaunchRequired: false,
      usedAuthCallback: true,
      authPayloadSource: authPayloadSource || null,
      note: switched
        ? "已通过原生回调凭证切换账号。"
        : "已重放该账号的原生回调凭证，但尚未确认切换到目标账号。请重新登录该账号以刷新记录。"
    });
    return;
  }

  const processName = normalizeAccioProcessName(config.appPath);
  const stopResult = gatewayBefore && gatewayBefore.reachable
    ? await stopAccioForSnapshot(config, processName)
    : { skipped: true, reason: "gateway_not_reachable", processName };

  log.info("snapshot switch pre-stop result", {
    alias,
    processName,
    stopResult
  });

  const result = activateSnapshot(alias);
  const expectedUserId = result.metadata && result.metadata.gatewayUser && result.metadata.gatewayUser.id
    ? String(result.metadata.gatewayUser.id)
    : "";

  log.info("snapshot restored to active storage", {
    alias: result.alias,
    kind: result.kind,
    destination: result.destination,
    expectedUserId: expectedUserId || null,
    snapshotUser: result.metadata && result.metadata.gatewayUser ? result.metadata.gatewayUser : null,
    stopResult
  });

  const restart = await restartAccioForSnapshot(config, expectedUserId, { stopResult });
  const currentUserId = extractGatewayUserId(restart.gateway);
  const switched = Boolean(expectedUserId && currentUserId && currentUserId === expectedUserId);

  const artifactCount = result.metadata && Array.isArray(result.metadata.artifacts) ? result.metadata.artifacts.length : 0;
  const legacySnapshot = artifactCount <= 1;
  const appRestarted = Boolean(restart && restart.gateway && restart.gateway.reachable);
  const manualRelaunchRequired = Boolean(!switched && !legacySnapshot && !appRestarted);

  log.info("snapshot switch result", {
    alias: result.alias,
    switched,
    expectedUserId: expectedUserId || null,
    currentUserId: currentUserId || null,
    artifactCount,
    legacySnapshot,
    appRestarted,
    manualRelaunchRequired,
    gatewayAfter: summarizeGatewayState(restart.gateway)
  });

  writeJson(res, 200, {
    ok: true,
    alias: result.alias,
    kind: result.kind,
    destination: result.destination,
    switched,
    currentUserId: currentUserId || null,
    expectedUserId: expectedUserId || null,
    artifactCount,
    legacySnapshot,
    appRestarted,
    manualRelaunchRequired,
    usedAuthCallback: false,
    note: switched
      ? "已恢复快照并重启 Accio，当前账号已切换。"
      : legacySnapshot
        ? "该快照是旧格式，只保存了少量登录信息。请重新登录该账号并重新记录后，再执行切换。"
        : manualRelaunchRequired
          ? "当前环境未能自动重新拉起 Accio，但快照已经恢复。请手动打开 Accio，4097 恢复后即会按该快照登录。"
          : "快照已恢复，并已尝试重启 Accio，但尚未确认切换到目标账号。"
  });
}


async function handleAdminSnapshotDelete(req, res) {
  const body = await readJsonBody(req, req.bridgeContext && req.bridgeContext.bodyParser ? req.bridgeContext.bodyParser : {});
  const alias = body && body.alias ? String(body.alias).trim() : "";
  if (!alias) {
    writeJson(res, 400, { error: { type: "invalid_request_error", message: "alias is required" } });
    return;
  }
  const result = deleteSnapshot(alias);
  writeJson(res, 200, { ok: true, alias: result.alias });
}

async function handleAdminGatewayLogin(req, res, gatewayManager) {
  const payload = await requestGatewayJsonWithAutostart(gatewayManager, "/auth/login", { method: "POST", body: {} });
  writeJson(res, 200, { ok: true, loginUrl: payload && payload.loginUrl ? String(payload.loginUrl) : null });
}

async function handleAdminGatewayLogout(req, res, gatewayManager) {
  await requestGatewayJson(gatewayManager, "/auth/logout", { method: "POST", body: {} });
  writeJson(res, 200, { ok: true });
}

async function handleAdminCaptureAccount(req, res, config, gatewayManager) {
  const body = await readJsonBody(req, req.bridgeContext && req.bridgeContext.bodyParser ? req.bridgeContext.bodyParser : {});
  const accountId = body && body.accountId ? String(body.accountId).trim() : "";
  if (!accountId) {
    writeJson(res, 400, { error: { type: "invalid_request_error", message: "accountId is required" } });
    return;
  }
  const result = await gatewayManager.waitForGatewayToken();
  const accountsPath = writeAccountToFile(config.accountsPath, accountId, result.token);
  writeJson(res, 200, { ok: true, accountId, accountsPath, tokenPreview: maskToken(result.token) });
}

async function handleAdminAccountLogin(req, res, config, gatewayManager) {
  await readJsonBody(req, req.bridgeContext && req.bridgeContext.bodyParser ? req.bridgeContext.bodyParser : {});

  const gateway = await readGatewayState(config.baseUrl);
  const previousUserId = extractGatewayUserId(gateway);
  let preservedSnapshot = null;

  if (gateway && gateway.reachable && gateway.authenticated && gateway.user) {
    const preservedAlias = deriveSnapshotAliasFromGatewayUser(gateway.user);
    preservedSnapshot = snapshotActiveCredentials(preservedAlias, {
      gatewayUser: gateway.user,
      notes: "auto-captured before add-account login flow"
    });
    log.info("current account snapshot preserved before add-account login", {
      alias: preservedSnapshot.alias,
      previousUserId: previousUserId || null,
      gateway: summarizeGatewayState(gateway)
    });
    await requestGatewayJsonWithAutostart(gatewayManager, "/auth/logout", { method: "POST", body: {} });
  }

  const flow = createPendingAccountLogin(previousUserId, {
    preservedAlias: preservedSnapshot ? preservedSnapshot.alias : null,
    preservedKind: preservedSnapshot && preservedSnapshot.metadata ? preservedSnapshot.metadata.kind : null,
    preservedCapturedAt: preservedSnapshot && preservedSnapshot.metadata ? preservedSnapshot.metadata.capturedAt : null
  });

  try {
    const payload = await requestGatewayJsonWithAutostart(gatewayManager, "/auth/login", { method: "POST", body: {} });
    const gatewayLoginUrl = payload && payload.loginUrl ? String(payload.loginUrl) : null;
    const callbackUrl = buildAccountLoginCallbackUrl(req, config, flow.id);
    const loginUrl = rewriteGatewayLoginUrl(gatewayLoginUrl, callbackUrl);
    let loginOpened = false;

    flow.loginUrl = loginUrl;
    flow.gatewayLoginUrl = gatewayLoginUrl;
    flow.callbackUrl = callbackUrl;

    if (loginUrl) {
      loginOpened = await openExternalUrl(loginUrl).catch(() => false);
    }

    writeJson(res, 200, {
      ok: true,
      flowId: flow.id,
      previousUserId: previousUserId || null,
      preservedAlias: flow.preservedAlias,
      loginUrl,
      loginOpened
    });
  } catch (error) {
    deletePendingAccountLogin(flow.id);
    throw error;
  }
}

async function handleAdminAccountCallback(req, res, config, url, gatewayManager) {
  const flowId = url.searchParams.get("flowId") ? String(url.searchParams.get("flowId")).trim() : "";
  if (!flowId) {
    writeHtml(res, 400, renderAccountCallbackPage("登录回调缺少 flowId", "请返回管理台重新发起“添加账号登录”。", "error"));
    return;
  }

  const flow = getPendingAccountLogin(flowId);
  if (!flow) {
    writeHtml(res, 404, renderAccountCallbackPage("登录流程已失效", "这个登录流程已经过期或不存在，请回到管理台重新发起。", "error"));
    return;
  }

  if (Date.now() - flow.createdAtMs >= ACCOUNT_LOGIN_FLOW_TTL_MS) {
    logPendingAccountLoginState(flow, "expired");
    deletePendingAccountLogin(flowId);
    writeHtml(res, 410, renderAccountCallbackPage("登录流程已过期", "请返回管理台重新发起“添加账号登录”。", "error"));
    return;
  }

  let authPayload;
  try {
    authPayload = extractAuthCallbackPayloadFromSearchParams(url.searchParams);
  } catch (error) {
    writeHtml(res, 400, renderAccountCallbackPage("登录参数不完整", error && error.message ? error.message : String(error), "error"));
    return;
  }

  flow.callbackReceivedAtMs = Date.now();
  flow.capturedAuth = authPayload;
  logPendingAccountLoginState(flow, "callback_received", {
    previousUserId: flow.previousUserId || null
  });

  try {
    const primedAuthPayload = await refreshAuthPayloadViaUpstream(config, authPayload, {
      flowId,
      previousUserId: flow.previousUserId || null
    });
    flow.capturedAuth = primedAuthPayload;
    await forwardGatewayAuthCallback(gatewayManager, primedAuthPayload, { includeState: true, timeoutMs: 20000 });
    const gateway = await waitForGatewayAuthenticatedUser(config.baseUrl, "", 20000, 500);
    const currentUserId = extractGatewayUserId(gateway);

    if (!gateway || !gateway.reachable || !gateway.authenticated || !currentUserId) {
      throw new Error("Gateway did not become authenticated after auth callback");
    }

    const sameAccount = Boolean(flow.previousUserId && currentUserId === flow.previousUserId);
    const alias = sameAccount && flow.preservedAlias
      ? flow.preservedAlias
      : deriveSnapshotAliasFromGatewayUser(gateway.user || null);
    const persistedAuth = {
      ...primedAuthPayload,
      user: gateway.user || null,
      source: "gateway-auth-callback"
    };
    const snapshot = snapshotActiveCredentials(alias, {
      gatewayUser: gateway.user || null,
      notes: sameAccount ? "captured again after logging back into the same account" : "captured from bridge auth callback",
      authPayload: persistedAuth
    });

    writeSnapshotAuthPayload(alias, persistedAuth);
    writeAccountToFile(config.accountsPath, alias, persistedAuth.accessToken, {
      user: gateway.user || null,
      expiresAtMs: persistedAuth.expiresAtMs,
      expiresAtRaw: persistedAuth.expiresAtRaw,
      source: "gateway-auth-callback",
      authPayload: persistedAuth
    });

    const finalResult = {
      ok: true,
      completed: true,
      state: sameAccount ? "same_account_returned" : "completed",
      alias,
      kind: snapshot.metadata.kind,
      capturedAt: snapshot.metadata.capturedAt,
      user: gateway.user || null,
      currentUserId,
      hasAuthCallback: true,
      note: sameAccount
        ? `你登录回了当前账号，已更新该账号的完整凭证记录：${alias}`
        : `新账号登录成功，已记录为 ${alias}。后续切换将优先使用原生回调凭证。`,
      gatewayState: { ...summarizeGatewayState(gateway), baseUrl: config.baseUrl }
    };

    flow.finalResult = finalResult;
    logPendingAccountLoginState(flow, finalResult.state, {
      currentUserId,
      alias,
      gateway: summarizeGatewayState(gateway)
    });

    writeHtml(res, 200, renderAccountCallbackPage("Accio 登录已完成", finalResult.note, "ok"));
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    flow.finalResult = {
      ok: false,
      completed: true,
      state: "login_failed",
      note: `登录回调已收到，但桥接层未能完成账号接管：${message}`,
      gatewayState: { ...(await readGatewayState(config.baseUrl)), baseUrl: config.baseUrl }
    };
    logPendingAccountLoginState(flow, "login_failed", {
      error: message
    });
    writeHtml(res, 500, renderAccountCallbackPage("Accio 登录接管失败", message, "error"));
  }
}

async function handleAdminAccountLoginStatus(req, res, config, url) {
  const flowId = url.searchParams.get("flowId") ? String(url.searchParams.get("flowId")).trim() : "";
  if (!flowId) {
    writeJson(res, 400, { error: { type: "invalid_request_error", message: "flowId is required" } });
    return;
  }

  const flow = getPendingAccountLogin(flowId);
  if (!flow) {
    log.warn("account login flow missing", { flowId: flowId || null });
    writeJson(res, 404, { error: { type: "not_found_error", message: "login flow not found or expired" } });
    return;
  }

  if (Date.now() - flow.createdAtMs >= ACCOUNT_LOGIN_FLOW_TTL_MS) {
    logPendingAccountLoginState(flow, "expired");
    deletePendingAccountLogin(flowId);
    writeJson(res, 410, { error: { type: "expired_error", message: "login flow expired" } });
    return;
  }

  if (flow.finalResult) {
    const payload = flow.finalResult;
    deletePendingAccountLogin(flowId);
    writeJson(res, 200, payload);
    return;
  }

  if (flow.callbackReceivedAtMs) {
    writeJson(res, 200, {
      ok: true,
      completed: false,
      state: "finalizing_login",
      message: "登录回调已收到，桥接层正在接管并记录该账号。",
      gatewayState: { ...(await readGatewayState(config.baseUrl)), baseUrl: config.baseUrl }
    });
    return;
  }

  const gateway = await readGatewayState(config.baseUrl);
  const currentUserId = extractGatewayUserId(gateway);

  if (!gateway || !gateway.reachable) {
    logPendingAccountLoginState(flow, "waiting_gateway", {
      gateway: summarizeGatewayState(gateway)
    });
    writeJson(res, 200, { ok: true, completed: false, state: "waiting_gateway", message: "正在等待本地网关恢复。", gatewayState: { ...summarizeGatewayState(gateway), baseUrl: config.baseUrl } });
    return;
  }

  if (!gateway.authenticated || !currentUserId) {
    logPendingAccountLoginState(flow, "waiting_login", {
      gateway: summarizeGatewayState(gateway)
    });
    writeJson(res, 200, { ok: true, completed: false, state: "waiting_login", message: "登录页已打开，等待你在 Accio 完成账号登录。", gatewayState: { ...summarizeGatewayState(gateway), baseUrl: config.baseUrl } });
    return;
  }

  if (flow.previousUserId && currentUserId === flow.previousUserId) {
    logPendingAccountLoginState(flow, "same_account_returned", {
      currentUserId,
      preservedAlias: flow.preservedAlias || null,
      gateway: summarizeGatewayState(gateway)
    });
    deletePendingAccountLogin(flowId);
    writeJson(res, 200, {
      ok: true,
      completed: true,
      state: "same_account_returned",
      currentUserId,
      alias: flow.preservedAlias || deriveSnapshotAliasFromGatewayUser(gateway.user || null),
      kind: flow.preservedKind || null,
      capturedAt: flow.preservedCapturedAt || null,
      user: gateway.user || null,
      note: flow.preservedAlias
        ? `你登录回了当前账号，已保留并更新该账号快照：${flow.preservedAlias}`
        : "你登录回了当前账号，没有新增账号。",
      gatewayState: { ...summarizeGatewayState(gateway), baseUrl: config.baseUrl }
    });
    return;
  }

  const derivedAlias = deriveSnapshotAliasFromGatewayUser(gateway.user || null);
  const result = snapshotActiveCredentials(derivedAlias, { gatewayUser: gateway.user || null });
  logPendingAccountLoginState(flow, "completed", {
    currentUserId,
    alias: result.alias,
    gateway: summarizeGatewayState(gateway)
  });
  deletePendingAccountLogin(flowId);
  writeJson(res, 200, {
    ok: true,
    completed: true,
    alias: result.alias,
    kind: result.metadata.kind,
    capturedAt: result.metadata.capturedAt,
    user: gateway.user || null,
    currentUserId,
    gatewayState: { ...summarizeGatewayState(gateway), baseUrl: config.baseUrl }
  });
}

module.exports = {
  handleAdminPage,
  handleAdminState,
  handleAdminAccountsOverview,
  handleAdminAccountsQuota,
  handleAdminSnapshotCreate,
  handleAdminSnapshotActivate,
  handleAdminSnapshotDelete,
  handleAdminGatewayLogin,
  handleAdminGatewayLogout,
  handleAdminCaptureAccount,
  handleAdminAccountLogin,
  handleAdminAccountCallback,
  handleAdminAccountLoginStatus
};
