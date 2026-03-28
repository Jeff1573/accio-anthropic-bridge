"use strict";

const path = require("node:path");
const { spawn } = require("node:child_process");

const electronBinary = require("electron");
const cwd = __dirname;
const env = { ...process.env, ACCIO_DESKTOP_NODE_PATH: process.execPath };

delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronBinary, [path.join(cwd, ".")], {
  cwd,
  env,
  stdio: "inherit"
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code == null ? 0 : code);
});

child.on("error", (error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
