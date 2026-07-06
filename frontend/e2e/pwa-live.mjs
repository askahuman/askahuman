// pwa-live.mjs — full-stack live E2E against the system running in kind.
//
// Spawns the real `agent ask` (role A), reads the typed pairing CODE it prints, drives
// the REAL PWA in headless Chromium (role B) to TYPE the code + answer the request, and
// asserts the agent receives the decision. Nothing is mocked: relay + web run in kind, the
// agent is the real binary, the browser runs the real bundle. There is no deep link:
// the phone derives the relay room from the typed code alone (App: roomFromCode).
//
// Usage: node e2e/pwa-live.mjs
//   env: AGENT_BIN (default ../bin/agent), RELAY_WS (default ws://127.0.0.1:8080/ws),
//        WEB_ORIGIN (default http://localhost:8081), KIND (yesno|choice|text)
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const AGENT_BIN = process.env.AGENT_BIN ?? new URL('../bin/agent', import.meta.url).pathname.replace('/frontend/', '/');
const RELAY_WS = process.env.RELAY_WS ?? 'ws://127.0.0.1:8080/ws';     // agent dials this
const PUBLIC_RELAY = process.env.PUBLIC_RELAY ?? '';                    // advertised to the phone (e.g. wss proxy)
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:8081';
const KIND = process.env.KIND ?? 'yesno';
const SHOT = new URL('./pwa-card.png', import.meta.url).pathname;

const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
const log = (m) => console.log(m);

// 1) Spawn the agent (role A). It prints `PAIR code=<CODE> room=<room> relay=<url>` to
//    stderr (display.PrintCode), pairs once the phone types the code, sends one request,
//    then prints the decision JSON to stdout. No --web flag exists anymore.
const args = ['ask', '--relay', RELAY_WS, '--print-pair',
  '--kind', KIND, '--title', 'Production deploy', '--summary', 'Deploy v2.3.1 to prod? (live E2E)',
  '--category', 'deploy'];
if (PUBLIC_RELAY) args.push('--public-relay', PUBLIC_RELAY);
if (KIND === 'choice') args.push('--options', 'Proceed,Hold');
if (KIND === 'text') args.push('--placeholder', 'amount');

log(`agent: ${AGENT_BIN} ${args.join(' ')}`);
const agent = spawn(AGENT_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderr = '';
agent.stdout.on('data', (d) => { stdout += d; });

const code = await new Promise((resolve, reject) => {
  const to = setTimeout(() => reject(new Error('timeout waiting for PAIR code line')), 15000);
  agent.stderr.on('data', (d) => {
    stderr += d;
    const m = stderr.match(/PAIR\s+code=(\S+)/);
    if (m) { clearTimeout(to); resolve(m[1]); }
  });
  agent.on('exit', (c) => { clearTimeout(to); reject(new Error(`agent exited early (${c})\n${stderr}`)); });
}).catch(fail);

log(`pairing code captured (${code})`);

// 2) Drive the real PWA as the phone (role B). ignoreHTTPSErrors mimics a phone that has
//    the mkcert root CA installed (trusts the local TLS proxy). The PWA opens at /app/ and
//    the human TYPES the code into the pairing field — nothing secret is in the URL.
// channel 'chromium': the default headless SHELL build crashes its renderer on
// this app (macOS Metal shader compile aborts on the card's backdrop-filter
// blur over the canvas starfield); the full-Chromium new-headless mode renders
// it fine. ref. MTLCompilerService SIGABRT, 2026-07-03 e2e debugging.
const browser = await chromium.launch({ channel: 'chromium' });
const context = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await context.newPage();
// CSP regression-guard: any securitypolicyviolation while loading /app fails the run (m6-csp-egress).
// addInitScript runs before page scripts so load-time violations are captured too.
await page.addInitScript(() => {
  window.__cspViolations = [];
  addEventListener('securitypolicyviolation', (e) => {
    window.__cspViolations.push(`${e.violatedDirective} blocked ${e.blockedURI || e.sourceFile || 'inline'}`);
  });
});
page.on('console', (m) => { if (m.type() === 'error') console.error('  [pwa console.error]', m.text()); });
const url = `${WEB_ORIGIN}/app/`;
log(`pwa: goto ${url}`);
await page.goto(url, { waitUntil: 'domcontentloaded' });
const sec = await page.evaluate(() => ({ secure: window.isSecureContext }));
log(`pwa: secure context=${sec.secure}`);

// The phone must dial the SAME relay the agent advertises. The kind web bundle bakes no
// PUBLIC_RELAY_URL, so the PWA would default to same-origin /ws (no WS proxy at :8081);
// point it at the relay via the Advanced relay field (PUBLIC_RELAY if set, else RELAY_WS).
const phoneRelay = PUBLIC_RELAY || RELAY_WS;

try {
  // Type the pairing code (+ relay) and submit; the App derives the room and runs SPAKE2 as B.
  await page.waitForSelector('[data-testid="code-input"]', { timeout: 15000 });
  await page.click('[data-testid="advanced-toggle"]');
  await page.fill('[data-testid="relay-input"]', phoneRelay);
  await page.fill('[data-testid="code-input"]', code);
  log(`pwa: typed code + relay (${phoneRelay}) — submitting`);
  await page.click('[data-testid="code-submit"]');

  if (KIND === 'yesno') {
    await page.waitForSelector('[data-testid="yesno-card"]', { timeout: 15000 });
    await page.screenshot({ path: SHOT });
    log('pwa: yes/no card shown — clicking approve');
    await page.click('[data-testid="approve-button"]');
  } else if (KIND === 'choice') {
    await page.waitForSelector('[data-testid="choice-option"]', { timeout: 15000 });
    await page.screenshot({ path: SHOT });
    log('pwa: choice card shown — clicking first option');
    await page.locator('[data-testid="choice-option"]').first().click();
  } else {
    await page.waitForSelector('[data-testid="text-input"]', { timeout: 15000 });
    await page.fill('[data-testid="text-input"]', 'ok');
    await page.screenshot({ path: SHOT });
    log('pwa: text card shown — sending reply');
    await page.click('[data-testid="text-send"]');
  }
  // The PWA should reach the confirmed screen after sealing the decision.
  await page.waitForSelector('[data-testid="confirmed-screen"]', { timeout: 10000 }).catch(() => {});
} catch (e) {
  await page.screenshot({ path: SHOT }).catch(() => {});
  await browser.close();
  fail(`driving the PWA: ${e.message}`);
}

// 3) Proof = the agent received an authenticated decision and printed it to stdout.
//    Poll stdout for the decision line (robust to the agent's exit timing).
const decLine = await new Promise((resolve) => {
  const deadline = Date.now() + 12000;
  const tick = setInterval(() => {
    const l = stdout.trim().split('\n').filter(Boolean).find((s) => s.includes('"kind":"decision"'));
    if (l) { clearInterval(tick); resolve(l); }
    else if (Date.now() > deadline) { clearInterval(tick); resolve(''); }
  }, 100);
});
// Read the CSP-violation collector while the page is still alive (browser closes next).
const cspViolations = await page.evaluate(() => window.__cspViolations ?? []).catch(() => []);
agent.kill('SIGTERM');
await browser.close();

if (!decLine) fail(`no decision on agent stdout within timeout\nstdout:${stdout}\nstderr-tail:${stderr.slice(-300)}`);

let dec;
try { dec = JSON.parse(decLine); } catch { fail(`agent decision not JSON: ${JSON.stringify(decLine)}`); }
log(`agent decision: ${JSON.stringify(dec)}`);

const r = dec.result ?? {};
const ok = (KIND === 'yesno' && r.approved === true)
  || (KIND === 'choice' && r.choice === 'Proceed')
  || (KIND === 'text' && typeof r.text === 'string' && r.text.length > 0);
if (!ok) fail(`unexpected decision for kind=${KIND}: ${JSON.stringify(dec)}`);

if (cspViolations.length) fail(`CSP regression — securitypolicyviolation fired on /app:\n  ${cspViolations.join('\n  ')}`);

log(`\nPWA LIVE E2E PASSED (kind=${KIND}) — real browser typed the code + approved through the kind relay; screenshot: ${SHOT}`);
process.exit(0);
