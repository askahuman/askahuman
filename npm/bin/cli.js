#!/usr/bin/env node
// Thin shim: exec the downloaded `ask-a-human` binary, passing through argv and
// inheriting stdio (the MCP server speaks JSON-RPC over stdin/stdout). The
// binary is fetched by install.js into ../bin. ref. install.js
"use strict";

const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");

const binName = process.platform === "win32" ? "ask-a-human.exe" : "ask-a-human";
const binPath = path.join(__dirname, "..", "bin", binName);

if (!fs.existsSync(binPath)) {
  console.error(
    `@askahuman/mcp: binary not found at ${binPath}. ` +
      "Reinstall (npm i -g @askahuman/mcp) or run install.js to fetch it.",
  );
  process.exit(1);
}

// Default to `serve` so a bare `npx @askahuman/mcp` starts the MCP server.
const args = process.argv.slice(2);
if (args.length === 0) args.push("serve");

const res = spawnSync(binPath, args, { stdio: "inherit" });
if (res.error) {
  console.error(`@askahuman/mcp: ${res.error.message}`);
  process.exit(1);
}
process.exit(res.status === null ? 1 : res.status);
