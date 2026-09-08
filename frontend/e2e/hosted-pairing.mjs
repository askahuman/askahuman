// Test the real pairing component at a routed synthetic hosted origin. Every
// request is intercepted locally; no live service or WebSocket is contacted.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = await mkdtemp(join(tmpdir(), 'aah-hosted-pair-'));
let browser;
try {
  execFileSync('bun', ['build', 'e2e/fixtures/hosted-pairing.tsx', '--target=browser', `--outfile=${join(out, 'fixture.js')}`], { cwd: root, stdio: 'pipe' });
  const js = await readFile(join(out, 'fixture.js'));
  browser = await chromium.launch(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : { channel: 'chromium' });
  for (const [origin, hosted] of [['https://ask-a-human.ai', true], ['https://self-host.example', false]]) {
    const context = await browser.newContext({ viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
    await context.route('**/*', route => {
      if (new URL(route.request().url()).origin !== origin) return route.abort();
      return route.fulfill(new URL(route.request().url()).pathname === '/fixture.js'
        ? { contentType: 'application/javascript', body: js }
        : { contentType: 'text/html', body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0}body{background:#08090c}</style><div id="root"></div><script type="module" src="/fixture.js"></script>' });
    });
    await context.addInitScript(() => localStorage.setItem('relay_url', 'wss://custom.example/ws'));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/app/');
    await page.getByTestId('code-input').fill('ABCDE-23456');
    if (!hosted) await page.getByTestId('advanced-toggle').click();
    await page.getByTestId('relay-input').waitFor();
    await page.getByTestId('code-submit').click();
    if (hosted) {
      await page.getByRole('alert').filter({ hasText: 'own app installation' }).waitFor();
      assert.deepEqual(await page.evaluate(() => window.pairingSubmissions), []);
      assert.equal(await page.getByTestId('pair-waiting').count(), 0);
      await page.getByRole('button', { name: 'Use hosted relay' }).click();
      await page.getByTestId('code-submit').click();
    }
    await page.getByTestId('pair-waiting').waitFor();
    const calls = await page.evaluate(() => window.pairingSubmissions);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].relay, hosted ? 'wss://ask-a-human.ai/ws' : 'wss://custom.example/ws');
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log('Hosted override rejected before pairing; saved setting is recoverable; self-hosted override retained.');
} finally {
  await browser?.close();
  await rm(out, { recursive: true, force: true });
}
