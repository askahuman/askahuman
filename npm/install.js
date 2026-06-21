#!/usr/bin/env node
// postinstall: download the prebuilt `ask-a-human` binary matching this host
// from the GitHub Release tagged v<package.version>, then extract it into bin/.
// Asset naming must match .goreleaser.yaml: ask-a-human_<os>_<arch>.<ext>.
// Zero npm deps on purpose — uses node builtins + the OS tar/unzip.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const http = require("http");
const { execFileSync } = require("child_process");

const REPO = "askahuman/askahuman";
const { version } = require("./package.json");

const OS_MAP = { darwin: "darwin", linux: "linux", win32: "windows" };
const ARCH_MAP = { x64: "amd64", arm64: "arm64" };

function fail(msg) {
  console.error(`@askahuman/mcp: ${msg}`);
  console.error(
    "Install the binary manually from " +
      `https://github.com/${REPO}/releases or build from source (backend/cmd/agent), ` +
      "then point your MCP config at it directly.",
  );
  process.exit(1);
}

const goos = OS_MAP[process.platform];
const goarch = ARCH_MAP[process.arch];
if (!goos || !goarch) fail(`unsupported platform ${process.platform}/${process.arch}`);

const ext = goos === "windows" ? "zip" : "tar.gz";
const asset = `ask-a-human_${goos}_${goarch}.${ext}`;
const base = process.env.AAH_BINARY_BASEURL || `https://github.com/${REPO}/releases/download/v${version}`;
const url = `${base}/${asset}`;

const binDir = path.join(__dirname, "bin");
const binName = goos === "windows" ? "ask-a-human.exe" : "ask-a-human";
const binPath = path.join(binDir, binName);

if (process.env.AAH_SKIP_DOWNLOAD) {
  console.log("@askahuman/mcp: AAH_SKIP_DOWNLOAD set, skipping binary download.");
  process.exit(0);
}

function download(u, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 10) return reject(new Error("too many redirects"));
    const client = u.startsWith("http://") ? http : https;
    client
      .get(u, { headers: { "User-Agent": "@askahuman/mcp-installer" } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(download(res.headers.location, dest, redirects + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
        }
        const out = fs.createWriteStream(dest);
        res.pipe(out);
        out.on("finish", () => out.close(resolve));
        out.on("error", reject);
      })
      .on("error", reject);
  });
}

function extract(archive, destDir) {
  if (ext === "zip") {
    // Windows 10+ ships tar.exe (bsdtar) which reads zip; fall back to PowerShell.
    try {
      execFileSync("tar", ["-xf", archive, "-C", destDir], { stdio: "inherit" });
    } catch {
      execFileSync(
        "powershell",
        ["-NoProfile", "-Command", `Expand-Archive -Force -Path '${archive}' -DestinationPath '${destDir}'`],
        { stdio: "inherit" },
      );
    }
    return;
  }
  execFileSync("tar", ["-xzf", archive, "-C", destDir], { stdio: "inherit" });
}

(async () => {
  fs.mkdirSync(binDir, { recursive: true });
  const tmp = path.join(os.tmpdir(), `aah-${process.pid}-${asset}`);
  try {
    console.log(`@askahuman/mcp: downloading ${asset} ...`);
    await download(url, tmp);
    // ponytail: no integrity check on the downloaded archive. Upgrade path —
    // also fetch checksums.txt from the same release and verify sha256(tmp)
    // before extracting. ref. .goreleaser.yaml (checksum block).
    extract(tmp, binDir);
    if (!fs.existsSync(binPath)) fail(`binary ${binName} not found in archive`);
    if (goos !== "windows") fs.chmodSync(binPath, 0o755);
    console.log("@askahuman/mcp: installed.");
  } catch (e) {
    fail(`download/extract failed: ${e.message}`);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {}
  }
})();
