"use strict";

const path = require("node:path");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { app, BrowserWindow, Menu, dialog, shell, clipboard } = require("electron");

const { loadEnvFile } = require("../src/env-file");
const { createConfig } = require("../src/runtime-config");

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(__dirname, "..");
const ENV_PATH = path.join(REPO_ROOT, ".env");

loadEnvFile(ENV_PATH);

const bridgeConfig = createConfig();
const BRIDGE_PORT = Number(bridgeConfig.port || process.env.PORT || 8082);
const BRIDGE_BASE_URL = `http://127.0.0.1:${BRIDGE_PORT}`;
const ADMIN_URL = `${BRIDGE_BASE_URL}/admin`;
const STATE_URL = `${BRIDGE_BASE_URL}/admin/api/state`;
const HEALTH_URL = `${BRIDGE_BASE_URL}/healthz`;
const START_TIMEOUT_MS = 30000;
const BRIDGE_NODE_PATH = process.env.ACCIO_DESKTOP_NODE_PATH || process.env.NODE || "node";
const START_POLL_MS = 500;

let mainWindow = null;
let bridgeProcess = null;
let bridgeOwned = false;
let quitting = false;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function encodeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}

function buildShellHtml(title, body, tone) {
  const accent = tone === "error" ? "#a33131" : "#b04f31";
  const shadow = tone === "error" ? "rgba(163,49,49,0.18)" : "rgba(176,79,49,0.18)";

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${encodeHtml(title)}</title>
<style>
:root {
  color-scheme: light;
  --bg: #f4efe8;
  --panel: rgba(255,255,255,0.82);
  --ink: #171514;
  --muted: #6f6259;
  --line: rgba(23,21,20,0.08);
  --accent: ${accent};
  --shadow: ${shadow};
}
* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; background:
  radial-gradient(circle at top left, rgba(176,79,49,0.14), transparent 34%),
  radial-gradient(circle at bottom right, rgba(23,21,20,0.08), transparent 28%),
  var(--bg); color: var(--ink); font-family: "SF Pro Display", "PingFang SC", "Hiragino Sans GB", sans-serif; }
body { display: grid; place-items: center; padding: 28px; }
main {
  width: min(760px, 100%);
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 28px;
  box-shadow: 0 28px 80px var(--shadow);
  overflow: hidden;
}
header { padding: 28px 30px 0; }
header small { display: block; color: var(--accent); letter-spacing: 0.14em; text-transform: uppercase; font-size: 12px; }
h1 { margin: 12px 0 0; font-size: clamp(28px, 4vw, 44px); line-height: 1.04; letter-spacing: -0.05em; }
section { padding: 22px 30px 30px; }
p { margin: 0; color: var(--muted); font-size: 15px; line-height: 1.72; }
.code {
  margin-top: 18px;
  padding: 16px 18px;
  border-radius: 18px;
  background: rgba(23,21,20,0.05);
  border: 1px solid var(--line);
  white-space: pre-wrap;
  word-break: break-word;
  font-family: "SFMono-Regular", ui-monospace, monospace;
  font-size: 13px;
  line-height: 1.6;
}
</style>
</head>
<body>
<main>
  <header>
    <small>Accio Bridge Desktop</small>
    <h1>${encodeHtml(title)}</h1>
  </header>
  <section>
    <p>${encodeHtml(body)}</p>
    <div class="code">Bridge: ${encodeHtml(BRIDGE_BASE_URL)}\nAdmin: ${encodeHtml(ADMIN_URL)}</div>
  </section>
</main>
</body>
</html>`;
}

function toDataUrl(html) {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

async function requestOk(url, timeoutMs) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      accept: "application/json, text/html;q=0.9, */*;q=0.1"
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }

  return response;
}

async function isBridgeReady() {
  try {
    await requestOk(STATE_URL, 1500);
    return true;
  } catch {
    return false;
  }
}

function pipeBridgeLogs(stream, label) {
  if (!stream) {
    return;
  }

  stream.on("data", (chunk) => {
    const lines = String(chunk).split(/\r?\n/).filter(Boolean);

    for (const line of lines) {
      process.stdout.write(`[bridge:${label}] ${line}\n`);
    }
  });
}

function startBridgeProcess() {
  if (bridgeProcess && bridgeProcess.exitCode == null) {
    return bridgeProcess;
  }

  bridgeProcess = spawn(BRIDGE_NODE_PATH, [path.join(REPO_ROOT, "src", "start.js")], {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  bridgeOwned = true;

  pipeBridgeLogs(bridgeProcess.stdout, "stdout");
  pipeBridgeLogs(bridgeProcess.stderr, "stderr");

  bridgeProcess.on("exit", (code, signal) => {
    const reason = signal ? `signal ${signal}` : `code ${code}`;
    process.stdout.write(`[bridge] child exited with ${reason}\n`);

    if (!quitting && mainWindow && !mainWindow.isDestroyed()) {
      const html = buildShellHtml(
        "Bridge 已退出",
        "桌面壳检测到本地 bridge 进程提前结束。可以从菜单重新打开，或先在终端里运行 npm start 查看具体报错。",
        "error"
      );
      mainWindow.loadURL(toDataUrl(html)).catch(() => {});
    }
  });

  bridgeProcess.on("error", (error) => {
    process.stderr.write(`[bridge] spawn failed: ${error instanceof Error ? error.stack : String(error)}\n`);
  });

  return bridgeProcess;
}

async function ensureBridgeReady() {
  if (await isBridgeReady()) {
    return { startedByDesktop: false };
  }

  startBridgeProcess();
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < START_TIMEOUT_MS) {
    try {
      if (await isBridgeReady()) {
        return { startedByDesktop: true };
      }

      await requestOk(HEALTH_URL, 1500);
    } catch (error) {
      lastError = error;
    }

    await delay(START_POLL_MS);
  }

  throw new Error(
    `Bridge did not become ready within ${START_TIMEOUT_MS}ms${lastError ? `: ${lastError.message}` : ""}`
  );
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 920,
    minWidth: 1080,
    minHeight: 760,
    show: false,
    backgroundColor: "#f4efe8",
    title: "Accio Bridge Desktop",
    autoHideMenuBar: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      spellcheck: false
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  return mainWindow;
}

async function loadInitialShell() {
  if (!mainWindow) {
    return;
  }

  const html = buildShellHtml(
    "正在准备管理台",
    "桌面壳会先检查本地 bridge 是否已经在线；如果没有，就自动从当前仓库目录拉起 bridge，然后把内置管理台加载进来。"
  );

  await mainWindow.loadURL(toDataUrl(html));
}

async function loadAdminConsole() {
  if (!mainWindow) {
    return;
  }

  await mainWindow.loadURL(ADMIN_URL);
}

async function showStartupError(error) {
  if (!mainWindow) {
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  const html = buildShellHtml("管理台启动失败", message, "error");
  await mainWindow.loadURL(toDataUrl(html));
}

async function stopBridgeProcess() {
  if (!bridgeOwned || !bridgeProcess || bridgeProcess.exitCode != null) {
    return;
  }

  const child = bridgeProcess;
  bridgeProcess = null;

  await new Promise((resolve) => {
    let finished = false;

    function done() {
      if (finished) {
        return;
      }
      finished = true;
      resolve();
    }

    const timer = setTimeout(() => {
      if (child.exitCode == null) {
        child.kill("SIGKILL");
      }
      done();
    }, 3000);

    child.once("exit", () => {
      clearTimeout(timer);
      done();
    });

    if (process.platform === "win32") {
      execFileAsync("taskkill", ["/pid", String(child.pid), "/t", "/f"]).catch(() => {}).finally(done);
      return;
    }

    child.kill("SIGTERM");
  });
}

function buildMenuTemplate() {
  return [
    {
      label: "Bridge",
      submenu: [
        {
          label: "重新加载管理台",
          accelerator: "CmdOrCtrl+R",
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.reload();
            }
          }
        },
        {
          label: "在浏览器中打开管理台",
          click: () => {
            shell.openExternal(ADMIN_URL).catch(() => {});
          }
        },
        {
          label: "复制管理台地址",
          click: () => {
            clipboard.writeText(ADMIN_URL);
          }
        },
        {
          label: "复制健康检查地址",
          click: () => {
            clipboard.writeText(HEALTH_URL);
          }
        },
        { type: "separator" },
        {
          label: "退出",
          role: "quit"
        }
      ]
    },
    {
      label: "Window",
      role: "windowMenu"
    }
  ];
}

async function boot() {
  createMainWindow();
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate()));
  await loadInitialShell();

  try {
    const result = await ensureBridgeReady();
    process.stdout.write(`[desktop] bridge ready at ${BRIDGE_BASE_URL} (startedByDesktop=${result.startedByDesktop})\n`);
    await loadAdminConsole();
  } catch (error) {
    await showStartupError(error);
    dialog.showErrorBox(
      "Accio Bridge Desktop",
      error instanceof Error ? error.message : String(error)
    );
  }
}

app.setName("Accio Bridge Desktop");
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    await boot();
  }
});

app.on("before-quit", () => {
  quitting = true;
});

app.whenReady()
  .then(boot)
  .catch(async (error) => {
    dialog.showErrorBox("Accio Bridge Desktop", error instanceof Error ? error.message : String(error));
    await stopBridgeProcess();
    app.exit(1);
  });

app.on("will-quit", (event) => {
  if (!bridgeOwned || !bridgeProcess || bridgeProcess.exitCode != null) {
    return;
  }

  event.preventDefault();
  stopBridgeProcess()
    .catch(() => {})
    .finally(() => {
      app.exit(0);
    });
});
