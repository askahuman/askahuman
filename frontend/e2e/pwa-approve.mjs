// pwa-approve.mjs — the "human with a phone", automated.
//
// Unlike pwa-live.mjs (which spawns `agent ask` itself), this driver pairs against an
// EXISTING agent session: it reads the typed pairing CODE that an MCP `agent serve` printed
// (teed to a log by scripts/mcp-serve-test.sh), opens the REAL PWA in headless Chromium as
// role B, TYPES the code into the pairing field, and answers the request. Used by
// scripts/agent-e2e.sh so a real agent CLI (codex / cursor-agent) drives the agent side
// while this drives the phone side. There is no deep link — the code is the only secret.
//
// Input (one of):
//   PAIR_CODE=ABCD-2345          the 8-char pairing code to type
//   PAIR_LOG=/path/to/log        poll this log for the `Pairing code:` / `PAIR code=` line
// env: WEB_ORIGIN (default http://localhost:8081), KIND (yesno|choice|text), SHOT (png path)
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const WEB_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:8081';
// The phone must dial the SAME relay the agent advertises. The kind web bundle bakes no
// PUBLIC_RELAY_URL, so the PWA would default to same-origin /ws (no WS proxy at :8081);
// point it at the relay via the Advanced relay field. Matches mcp-serve-test.sh's dial.
const RELAY_WS = process.env.RELAY_WS ?? 'ws://127.0.0.1:8080/ws';
const KIND = process.env.KIND ?? 'yesno';
const SHOT = process.env.SHOT ?? new URL('./pwa-approve.png', import.meta.url).pathname;
const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
const log = (m) => console.log(m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Match either the human line ("Pairing code: <CODE>", display.PrintCode) or the
// machine line ("PAIR code=<CODE>", ask --print-pair). The code is the XXXX-XXXX form.
const codeFrom = (txt) => {
  const m = txt.match(/Pairing code:\s*(\S+)/) ?? txt.match(/PAIR\s+code=(\S+)/);
  return m ? m[1] : null;
};

// Resolve the pairing code from PAIR_CODE or by tailing the pair-log.
async function resolveCode() {
  if (process.env.PAIR_CODE) return process.env.PAIR_CODE;
  const logPath = process.env.PAIR_LOG;
  if (!logPath) fail('need PAIR_CODE or PAIR_LOG');
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    let txt = '';
    try { txt = readFileSync(logPath, 'utf8'); } catch { /* not yet */ }
    const code = codeFrom(txt);
    if (code) return code;
    await sleep(400);
  }
  fail(`no pairing code in ${logPath} within timeout`);
}

const code = await resolveCode();
log(`pairing code captured (${code})`);

// channel 'chromium': the default headless SHELL build crashes its renderer on
// this app (macOS Metal shader compile aborts on the card's backdrop-filter
// blur over the canvas starfield); the full-Chromium new-headless mode renders
// it fine. ref. MTLCompilerService SIGABRT, 2026-07-03 e2e debugging.
const browser = await chromium.launch({ channel: 'chromium' });
const context = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await context.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.error('  [pwa console.error]', m.text()); });
const url = `${WEB_ORIGIN}/app/`;
log(`pwa: goto ${url}`);
await page.goto(url, { waitUntil: 'domcontentloaded' });

try {
  // Type the pairing code (+ relay) and submit; the App derives the room and runs SPAKE2 as B.
  await page.waitForSelector('[data-testid="code-input"]', { timeout: 20000 });
  await page.click('[data-testid="advanced-toggle"]');
  await page.fill('[data-testid="relay-input"]', RELAY_WS);
  await page.fill('[data-testid="code-input"]', code);
  log(`pwa: typed code + relay (${RELAY_WS}) — submitting`);
  await page.click('[data-testid="code-submit"]');

  if (KIND === 'yesno') {
    await page.waitForSelector('[data-testid="yesno-card"]', { timeout: 20000 });
    await page.screenshot({ path: SHOT });
    log('pwa: yes/no card shown — approving');
    await page.click('[data-testid="approve-button"]');
  } else if (KIND === 'choice') {
    await page.waitForSelector('[data-testid="choice-option"]', { timeout: 20000 });
    await page.screenshot({ path: SHOT });
    log('pwa: choice card shown — picking first option');
    await page.locator('[data-testid="choice-option"]').first().click();
  } else {
    await page.waitForSelector('[data-testid="text-input"]', { timeout: 20000 });
    await page.fill('[data-testid="text-input"]', 'ok');
    await page.screenshot({ path: SHOT });
    log('pwa: text card shown — replying');
    await page.click('[data-testid="text-send"]');
  }
  await page.waitForSelector('[data-testid="confirmed-screen"]', { timeout: 12000 }).catch(() => {});
  await page.screenshot({ path: SHOT }).catch(() => {});
} catch (e) {
  await page.screenshot({ path: SHOT }).catch(() => {});
  await browser.close();
  fail(`driving the PWA: ${e.message}`);
}
await browser.close();
log(`PWA answered the request (kind=${KIND}); screenshot: ${SHOT}`);
process.exit(0);
