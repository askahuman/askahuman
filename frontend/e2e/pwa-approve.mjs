// pwa-approve.mjs — the "human with a phone", automated.
//
// Unlike pwa-live.mjs (which spawns `agent ask` itself), this driver pairs against an
// EXISTING agent session: it reads the pairing deep-link that an MCP `agent serve` printed
// (teed to a log by scripts/mcp-serve-test.sh), opens the REAL PWA in headless Chromium as
// role B, and answers the request. Used by scripts/agent-e2e.sh so a real agent CLI
// (codex / cursor-agent) drives the agent side while this drives the phone side.
//
// Input (one of):
//   PAIR_LINK=http://localhost:8081/app#p=<payload>  full deep link
//   PAIR_PAYLOAD=<base64url>                          just the fragment payload
//   PAIR_LOG=/path/to/log                             poll this log for the `link:` line
// env: WEB_ORIGIN (default http://localhost:8081), KIND (yesno|choice|text), SHOT (png path)
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const WEB_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:8081';
const KIND = process.env.KIND ?? 'yesno';
const SHOT = process.env.SHOT ?? new URL('./pwa-approve.png', import.meta.url).pathname;
const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
const log = (m) => console.log(m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Resolve the pairing payload from an explicit link/payload or by tailing a log file.
async function resolvePayload() {
  if (process.env.PAIR_PAYLOAD) return process.env.PAIR_PAYLOAD;
  if (process.env.PAIR_LINK) return new URL(process.env.PAIR_LINK).hash.replace(/^#p=/, '');
  const logPath = process.env.PAIR_LOG;
  if (!logPath) fail('need PAIR_PAYLOAD, PAIR_LINK, or PAIR_LOG');
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    let txt = '';
    try { txt = readFileSync(logPath, 'utf8'); } catch { /* not yet */ }
    const m = txt.match(/link:\s*\S*#p=(\S+)/);
    if (m) return m[1];
    await sleep(400);
  }
  fail(`no pairing link in ${logPath} within timeout`);
}

const payload = await resolvePayload();
log(`pair payload captured (${payload.slice(0, 24)}…)`);

const browser = await chromium.launch();
const context = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await context.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.error('  [pwa console.error]', m.text()); });
// PAIR_MODE=query uses "?p=" (scan-safe, what the QR encodes); default "#p=" (fragment).
const url = process.env.PAIR_MODE === 'query' ? `${WEB_ORIGIN}/app?p=${payload}` : `${WEB_ORIGIN}/app#p=${payload}`;
log(`pwa: goto ${url}`);
await page.goto(url, { waitUntil: 'domcontentloaded' });

try {
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
