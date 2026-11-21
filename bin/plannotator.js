#!/usr/bin/env node
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(path.dirname(__filename), "..");
const sourceEntry = path.join(repoRoot, "apps", "cli", "server", "index.ts");

if (!fs.existsSync(sourceEntry)) {
  console.error(`Could not find Plannotator source entry at ${sourceEntry}`);
  process.exit(1);
}

const result = childProcess.spawnSync("bun", [sourceEntry, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  stdio: "inherit",
  windowsHide: true,
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

if (result.signal) process.kill(process.pid, result.signal);
else process.exit(result.status ?? 1);
