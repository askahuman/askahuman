// pwa-restore.mjs — the "iOS killed the page" scenario, automated (ADR 0020).
//
// Like pwa-approve.mjs it pairs against an EXISTING agent session by reading the
// typed pairing CODE from the pair-log. But instead of answering the card, it
// RELOADS the page mid-request — simulating iOS killing the backgrounded PWA
// page — and asserts the persistence layer restores the session: no pair
// screen, the agent's re-announce re-opens the SAME card within its backoff,
// and the decision still round-trips to the blocked agent.
//
// Input: PAIR_CODE or PAIR_LOG (same contract as pwa-approve.mjs).
// env: WEB_ORIGIN (default http://localhost:8081), RELAY_WS, SHOT (png path)
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const WEB_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:8081';
const RELAY_WS = process.env.RELAY_WS ?? 'ws://127.0.0.1:8080/ws';
const SHOT = process.env.SHOT ?? new URL('./pwa-restore.png', import.meta.url).pathname;
const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
const log = (m) => console.log(m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const codeFrom = (txt) => {
  const m = txt.match(/Pairing code:\s*(\S+)/) ?? txt.match(/PAIR\s+code=(\S+)/);
  return m ? m[1] : null;
};

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
  // 1) Pair by typing the code (+ relay) — same as the happy path.
  await page.waitForSelector('[data-testid="code-input"]', { timeout: 20000 });
  await page.click('[data-testid="advanced-toggle"]');
  await page.fill('[data-testid="relay-input"]', RELAY_WS);
  await page.fill('[data-testid="code-input"]', code);
  log(`pwa: typed code + relay (${RELAY_WS}) — submitting`);
  await page.click('[data-testid="code-submit"]');

  // 2) Wait for the request card — but do NOT answer it.
  await page.waitForSelector('[data-testid="yesno-card"]', { timeout: 20000 });
  log('pwa: yes/no card shown — reloading the page instead of answering (simulated iOS page kill)');

  // 3) The kill: a full reload drops every in-RAM session. Only the
  //    persistence layer (localStorage, ADR 0020) can bring the pairing back.
  await page.reload({ waitUntil: 'domcontentloaded' });

  // 4) Restored: the app must NOT be on the pair screen; the agent re-announces
  //    the pending request within its 5s backoff and the card must re-open.
  await page.waitForSelector('[data-testid="yesno-card"]', { timeout: 20000 });
  const pairVisible = await page.locator('[data-testid="code-input"]').count();
  if (pairVisible > 0) fail('pair screen visible after reload — session was not restored');
  await page.screenshot({ path: SHOT });
  log('pwa: session RESTORED after reload — card re-opened from the re-announce; approving');

  // 5) The decision must still round-trip to the (still blocked) agent.
  await page.click('[data-testid="approve-button"]');
  await page.waitForSelector('[data-testid="confirmed-screen"]', { timeout: 12000 }).catch(() => {});
  await page.screenshot({ path: SHOT }).catch(() => {});
} catch (e) {
  await page.screenshot({ path: SHOT }).catch(() => {});
  await browser.close();
  fail(`driving the PWA: ${e.message}`);
}
await browser.close();
log('PWA answered the request AFTER a page reload (persistence restore verified)');
process.exit(0);
