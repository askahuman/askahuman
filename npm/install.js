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
const crypto = require("crypto");
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

// Redirect host allowlist: github.com (release link) + the asset CDN
// (*.githubusercontent.com — GitHub rotates the subdomain, so match the
// suffix) + the AAH_BINARY_BASEURL host when a mirror is configured.
function hostAllowed(host) {
  if (host === "github.com") return true;
  if (host === "githubusercontent.com" || host.endsWith(".githubusercontent.com")) return true;
  if (process.env.AAH_BINARY_BASEURL) {
    try {
      return host === new URL(process.env.AAH_BINARY_BASEURL).host;
    } catch {
      return false;
    }
  }
  return false;
}

// parseChecksum reads goreleaser's checksums.txt ("<64-hex>␠␠<file>" per line,
// whitespace-tolerant) and returns the lowercased digest for `name`, or "".
// ref. .goreleaser.yaml checksum block (sha256, name_template checksums.txt).
function parseChecksum(text, name) {
  for (const line of text.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2 && parts[1] === name && /^[0-9a-fA-F]{64}$/.test(parts[0])) {
      return parts[0].toLowerCase();
    }
  }
  return "";
}

function download(u, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 10) return reject(new Error("too many redirects"));
    let parsed;
    try {
      parsed = new URL(u);
    } catch {
      return reject(new Error(`invalid URL ${u}`));
    }
    // Transport hardening: https only — no http:// (kills a downgrade-on-redirect MITM).
    if (parsed.protocol !== "https:") {
      return reject(new Error(`refusing non-https URL ${u}`));
    }
    https
      .get(u, { headers: { "User-Agent": "@askahuman/mcp-installer" } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          let next;
          try {
            next = new URL(res.headers.location, u);
          } catch {
            return reject(new Error(`invalid redirect location ${res.headers.location}`));
          }
          if (!hostAllowed(next.host)) {
            return reject(new Error(`refusing redirect to non-allowlisted host ${next.host}`));
          }
          return resolve(download(next.toString(), dest, redirects + 1));
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

// downloadText fetches a small text resource (checksums.txt) through the same
// hardened path and returns its body. Rejects on any non-200.
function downloadText(u) {
  return new Promise((resolve, reject) => {
    const tmp = path.join(os.tmpdir(), `aah-${process.pid}-checksums-${Date.now()}.txt`);
    download(u, tmp)
      .then(() => {
        try {
          const body = fs.readFileSync(tmp, "utf8");
          resolve(body);
        } catch (e) {
          reject(e);
        } finally {
          try {
            fs.unlinkSync(tmp);
          } catch {}
        }
      })
      .catch(reject);
  });
}

function sha256File(file) {
  const h = crypto.createHash("sha256");
  h.update(fs.readFileSync(file));
  return h.digest("hex");
}

// expectedDigest resolves the pinned sha256 for `asset`, fail-closed:
//   (a) AAH_BINARY_SHA256 env  — out-of-band pin (air-gapped / self-rebuilt mirror)
//   (b) ${base}/checksums.txt  — TLS-TOFU on the release tag (goreleaser default)
// Returns "" when neither yields a digest, which the caller treats as failure.
async function expectedDigest() {
  const pin = process.env.AAH_BINARY_SHA256;
  // A set-but-malformed pin must fail closed, not silently fall back to
  // checksums.txt — the operator asked to pin, honoring a weaker source instead
  // would defeat the intent. Only an *unset* pin falls back.
  if (pin !== undefined && pin !== "") {
    if (!/^[0-9a-fA-F]{64}$/.test(pin.trim())) {
      fail("AAH_BINARY_SHA256 set but not a valid 64-hex sha256");
    }
    return pin.trim().toLowerCase();
  }
  const text = await downloadText(`${base}/checksums.txt`);
  return parseChecksum(text, asset);
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

// self-check (house style: one runnable assert, no framework): the checksums.txt
// parser must return the digest for the matching file and "" for a miss.
(() => {
  const hex = "a".repeat(64);
  const line = `${hex}  ${asset}`;
  if (parseChecksum(line, asset) !== hex) throw new Error("parseChecksum self-check failed: match");
  if (parseChecksum(line, "other.tar.gz") !== "") throw new Error("parseChecksum self-check failed: miss");
})();

// self-check (house style): the redirect host-allowlist must allow github.com +
// the asset CDN suffix + the configured mirror host, and deny everything else —
// including a suffix-spoof like "githubusercontent.com.evil.com".
(() => {
  for (const h of ["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"]) {
    if (!hostAllowed(h)) throw new Error(`hostAllowed self-check failed: should allow ${h}`);
  }
  for (const h of ["evil.com", "githubusercontent.com.evil.com"]) {
    if (hostAllowed(h)) throw new Error(`hostAllowed self-check failed: should deny ${h}`);
  }
  // mirror host: allowed only while AAH_BINARY_BASEURL points at it; restore env after.
  const saved = process.env.AAH_BINARY_BASEURL;
  process.env.AAH_BINARY_BASEURL = "https://mirror.example.com/dl";
  try {
    if (!hostAllowed("mirror.example.com")) throw new Error("hostAllowed self-check failed: should allow mirror host");
    if (hostAllowed("evil.com")) throw new Error("hostAllowed self-check failed: should deny non-mirror host");
  } finally {
    if (saved === undefined) delete process.env.AAH_BINARY_BASEURL;
    else process.env.AAH_BINARY_BASEURL = saved;
  }
})();

if (process.env.AAH_SKIP_DOWNLOAD) {
  console.log("@askahuman/mcp: AAH_SKIP_DOWNLOAD set, skipping binary download.");
  process.exit(0);
}

(async () => {
  fs.mkdirSync(binDir, { recursive: true });
  const tmp = path.join(os.tmpdir(), `aah-${process.pid}-${asset}`);
  try {
    console.log(`@askahuman/mcp: downloading ${asset} ...`);
    await download(url, tmp);
    // Integrity gate (fail-closed): verify sha256 BEFORE extract+chmod, so a
    // tampered archive never reaches disk as an executable.
    const want = await expectedDigest();
    if (!want) fail("could not determine expected sha256 (no checksums.txt and no AAH_BINARY_SHA256)");
    const got = sha256File(tmp);
    if (got !== want) fail(`sha256 mismatch for ${asset}: got ${got}, want ${want}`);
    console.log("@askahuman/mcp: sha256 verified.");
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
