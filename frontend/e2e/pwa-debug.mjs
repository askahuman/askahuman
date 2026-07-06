// pwa-debug.mjs — instrumented one-shot: pair, then snapshot the DOM every
// second so a renderer crash can be located to the exact moment/state.
import { chromium } from 'playwright';

const WEB_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:8081';
const RELAY_WS = process.env.RELAY_WS ?? 'ws://127.0.0.1:8080/ws';
const code = process.env.PAIR_CODE;
if (!code) { console.error('need PAIR_CODE'); process.exit(1); }

const browser = await chromium.launch({
  headless: process.env.HEADED !== '1',
  ...(process.env.CHANNEL ? { channel: process.env.CHANNEL } : {}),
  args: process.env.LAUNCH_ARGS ? process.env.LAUNCH_ARGS.split(' ') : [],
});
const page = await (await browser.newContext()).newPage();
let crashed = false;
page.on('crash', () => { crashed = true; console.log('!!! PAGE CRASHED'); });
page.on('console', (m) => console.log(`  [console.${m.type()}]`, m.text().slice(0, 200)));
page.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0, 300)));

const snap = () =>
  page.evaluate(() => {
    const el = document.querySelector('[data-testid="yesno-card"]');
    const r = el?.getBoundingClientRect();
    return {
      card: !!el,
      rect: r ? [r.width, r.height] : null,
      screenText: document.body.innerText.replace(/\s+/g, ' ').slice(0, 120),
      stored: localStorage.getItem('aah:sessions:v1')?.length ?? 0,
      heapMB: Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1048576),
    };
  });

await page.goto(`${WEB_ORIGIN}/app/`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-testid="code-input"]', { timeout: 15000 });
await page.click('[data-testid="advanced-toggle"]');
await page.fill('[data-testid="relay-input"]', RELAY_WS);
await page.fill('[data-testid="code-input"]', code);
await page.click('[data-testid="code-submit"]');
console.log('t=0 submitted');

for (let t = 1; t <= 20 && !crashed; t++) {
  await new Promise((r) => setTimeout(r, 1000));
  try {
    console.log(`t=${t}`, JSON.stringify(await snap()));
  } catch (e) {
    console.log(`t=${t} SNAPSHOT FAILED: ${String(e).slice(0, 120)}`);
    break;
  }
}
await browser.close();
console.log(crashed ? 'RESULT: crashed' : 'RESULT: survived');
