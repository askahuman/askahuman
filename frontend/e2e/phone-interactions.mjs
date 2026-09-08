// Regression checks against the real React screen components in a fixed PWA
// shell. Uses browser touch input for scrolling, not locator auto-scrolling.
// Run from frontend: node e2e/phone-interactions.mjs
// Optional: CHROME_EXECUTABLE=/path/to/chrome PHONE_SHOTS=/tmp/phone-shots
// This intentionally does not test pairing, the relay, or signed decisions.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const frontend = fileURLToPath(new URL('../', import.meta.url));
const out = await mkdtemp(join(tmpdir(), 'aah-phone-test-'));
execFileSync('bun', ['build', 'e2e/fixtures/phone-interactions.tsx', '--target=browser', `--outfile=${join(out, 'fixture.js')}`], { cwd: frontend, stdio: 'pipe' });
const fixture = await readFile(join(out, 'fixture.js'));
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
* { box-sizing: border-box; } html, body { margin: 0; overscroll-behavior: none; touch-action: pan-y; }
body { position: fixed; inset: 0; overflow: hidden; background: #08090c; user-select: none; -webkit-user-select: none; }
button, input { font: inherit; } button:focus-visible, [tabindex]:focus-visible { outline: 3px solid #fff; outline-offset: -3px; }
</style></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>`;
const server = createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/fixture.js' ? 'text/javascript' : 'text/html');
  res.end(req.url === '/fixture.js' ? fixture : html);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
const results = [];
const base = { kind: 'request', id: 'phone-test', title: 'Review this request', summary: 'Read the complete context before answering.', response: { kind: 'yesno' } };
const longTitle = `${'A'.repeat(480)} KEEP THE BACKUPS`;
const warning = ' WARNING: permanently delete all production backups.';
const longSummary = 'Review the complete request. '.repeat(150).slice(0, 4096 - warning.length) + warning;

async function render(page, kind, changes = {}, confirmation) {
  const req = { ...base, response: { kind }, ...changes };
  const version = await page.evaluate(({ kind, req, confirmation }) => window.phoneTest.render(kind, req, confirmation), { kind, req, confirmation });
  await page.locator(`[data-render-version="${version}"]`).waitFor();
}
async function answers(page) {
  // A committed swipe intentionally defers its callback for 330 ms.
  await page.waitForTimeout(400);
  return page.evaluate(() => window.phoneTest.answers);
}
async function pointer(page, type, x, y = 180, pointerId = 1, extra = {}) {
  await page.getByTestId('yesno-card').dispatchEvent(type, { pointerId, pointerType: 'touch', isPrimary: pointerId === 1, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y, ...extra });
}
async function touchScroll(page, region, direction = 'down') {
  const box = await region.boundingBox();
  assert.ok(box && box.height > 80, 'scroll region remains usable');
  const x = box.x + box.width / 2;
  const low = Math.min(box.y + box.height - 24, page.viewportSize().height - 28);
  const high = Math.max(box.y + 24, low - 320);
  const from = direction === 'down' ? low : high;
  const to = direction === 'down' ? high : low;
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: from }] });
    for (let i = 1; i <= 12; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: from + (to - from) * i / 12 }] });
      await page.waitForTimeout(12);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(100);
  } finally {
    await cdp.detach();
  }
}
async function touchSwipe(page, from, to) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from, y: 180 }] });
    for (let i = 1; i <= 12; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from + (to - from) * i / 12, y: 180 }] });
      await page.waitForTimeout(12);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally {
    await cdp.detach();
  }
}
async function inViewport(page, locator) {
  const box = await locator.boundingBox();
  assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= page.viewportSize().width + 1 && box.y + box.height <= page.viewportSize().height + 1, `control within viewport: ${JSON.stringify(box)}`);
}
async function shot(page, name) {
  if (!process.env.PHONE_SHOTS) return;
  await mkdir(process.env.PHONE_SHOTS, { recursive: true });
  await page.screenshot({ path: join(process.env.PHONE_SHOTS, `${name}.png`) });
}

try {
  browser = await chromium.launch(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : { channel: 'chromium' });
  for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(origin);
    await page.waitForFunction(() => Boolean(window.phoneTest));
    const size = `${viewport.width}x${viewport.height}`;

    for (const ending of ['pointercancel', 'lostpointercapture', 'second-pointer', 'blur', 'vertical']) {
      await render(page, 'yesno');
      await pointer(page, 'pointerdown', 70);
      if (ending === 'vertical') await pointer(page, 'pointermove', 80, 240);
      await pointer(page, 'pointermove', 220);
      if (ending === 'second-pointer') await pointer(page, 'pointerdown', 140, 180, 2);
      else if (ending === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')));
      else if (ending !== 'vertical') await pointer(page, ending, 220);
      // Even a later pointerup must not revive an interrupted gesture.
      await pointer(page, 'pointerup', 220);
      assert.deepEqual(await answers(page), [], `${ending} must send nothing`);
      assert.equal(await page.getByTestId('yesno-card').evaluate((el) => getComputedStyle(el).transform), 'matrix(1, 0, 0, 1, 0, 0)');
      results.push(`${size}: ${ending} resets without answering`);
    }

    for (const [from, to, expected] of [[70, 220, true], [240, 70, false]]) {
      await render(page, 'yesno');
      await pointer(page, 'pointerdown', from);
      await pointer(page, 'pointermove', to);
      await pointer(page, 'pointerup', to);
      await pointer(page, 'lostpointercapture', to);
      assert.deepEqual(await answers(page), [expected]);
      await render(page, 'yesno');
      await touchSwipe(page, from, to);
      assert.deepEqual(await answers(page), [expected], 'completed browser touch swipe answers');
    }
    await render(page, 'yesno');
    await page.getByRole('button', { name: 'APPROVE', exact: true }).focus();
    await page.keyboard.press('Enter');
    assert.deepEqual(await answers(page), [true]);
    await render(page, 'yesno');
    await pointer(page, 'pointerdown', 70);
    await pointer(page, 'pointermove', 220);
    await pointer(page, 'pointerup', 220);
    await render(page, 'yesno', { id: 'replacement' });
    assert.deepEqual(await answers(page), [], 'unmount cancels delayed decision');
    results.push(`${size}: completed swipes and keyboard approve work; unmount cancels deferred answer`);

    await render(page, 'yesno', { title: longTitle, summary: longSummary });
    assert.equal(await page.getByTestId('request-title').textContent(), longTitle);
    assert.equal(await page.getByTestId('request-summary').textContent(), longSummary);
    const card = page.getByTestId('yesno-card');
    const before = await card.evaluate((el) => el.scrollTop);
    await touchScroll(page, card);
    assert.ok(await card.evaluate((el) => el.scrollTop) > before, 'yes/no context scrolls by touch');
    assert.deepEqual(await answers(page), [], 'reading by touch cannot answer');
    await card.focus();
    await page.keyboard.press('End');
    await page.waitForTimeout(250);
    const atBottom = await card.evaluate((el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 2);
    assert.ok(atBottom, 'keyboard reaches final warning');
    await inViewport(page, page.getByTestId('approve-button'));
    await shot(page, `full-summary-${size}`);
    results.push(`${size}: complete long title/summary, touch reading, keyboard reachability, and visible actions`);

    const prefix = 'Shared option context '.repeat(5);
    const options = Array.from({ length: 32 }, (_, i) => i < 2 ? `${prefix}${i === 0 ? 'DELETE' : 'KEEP'} production backups` : `Option ${i + 1}: ${i === 31 ? 'KEEP all production backups' : 'review separately'}`);
    await render(page, 'choice', { response: { kind: 'choice', options } });
    const choices = page.getByTestId('choice-option');
    assert.equal(await choices.count(), options.length);
    for (let i = 0; i < 2; i++) assert.equal(await choices.nth(i).locator('span').first().textContent(), options[i]);
    const scroll = page.getByTestId('choice-scroll');
    let touchedBottom = false;
    for (let i = 0; i < 30; i++) {
      await touchScroll(page, scroll);
      const state = await scroll.evaluate((el) => ({ top: el.scrollTop, height: el.clientHeight, total: el.scrollHeight }));
      if (state.top + state.height >= state.total - 2) { touchedBottom = true; break; }
    }
    assert.ok(touchedBottom, 'touch reaches final admitted choice');
    await inViewport(page, choices.last());
    assert.deepEqual(await answers(page), [], 'scrolling choices cannot select one');
    await shot(page, `last-choice-${size}`);
    const box = await choices.last().boundingBox();
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    assert.deepEqual(await answers(page), [options.at(-1)]);
    await render(page, 'choice', { response: { kind: 'choice', options } });
    await page.getByTestId('choice-scroll').focus();
    for (let i = 0; i < options.length; i++) await page.keyboard.press('Tab');
    assert.ok(await choices.last().evaluate((el) => document.activeElement === el));
    await inViewport(page, choices.last());
    await page.keyboard.press('Enter');
    assert.deepEqual(await answers(page), [options.at(-1)]);
    results.push(`${size}: all 32 choices and distinguishing suffixes preserved; final choice reached by touch and keyboard`);

    await render(page, 'text', { title: longTitle, summary: longSummary, response: { kind: 'text', max_len: 200 } });
    await page.evaluate(() => document.documentElement.style.setProperty('--app-vvh', '350px'));
    const textbox = page.getByRole('textbox', { name: 'Your reply' });
    const send = page.getByRole('button', { name: 'Send reply' });
    assert.ok(await send.isEnabled(), 'an explicit empty text reply is valid');
    await send.click();
    assert.deepEqual(await answers(page), ['']);
    await render(page, 'text', { title: longTitle, summary: longSummary, response: { kind: 'text', max_len: 200 } });
    await textbox.fill('Checked the complete request');
    await inViewport(page, textbox);
    await inViewport(page, send);
    const sendBox = await send.boundingBox();
    assert.ok(sendBox.y + sendBox.height <= 350, 'send control stays above simulated keyboard');
    await page.getByTestId('text-request').focus();
    await page.keyboard.press('End');
    await page.waitForTimeout(250);
    assert.ok(await page.getByTestId('text-request').evaluate((el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 2));
    await shot(page, `keyboard-text-${size}`);
    await textbox.focus();
    await page.keyboard.press('Enter');
    assert.deepEqual(await answers(page), ['Checked the complete request']);
    await page.evaluate(() => document.documentElement.style.removeProperty('--app-vvh'));
    results.push(`${size}: named text controls remain reachable at 350px visual height; Enter replies`);

    for (const [name, detail] of [
      ['emoji', 'Reply: ' + '😀'.repeat(4000) + '\nFINAL REPLY'],
      ['multiline', 'Reply: ' + 'line\n'.repeat(817) + 'FINAL REPLY'],
      ['long-choice', 'Choice: ' + 'C'.repeat(246) + 'FINAL KEEP'],
    ]) {
      await render(page, 'confirmed', {}, { label: 'Answer received by agent', detail });
      const label = page.getByText('Answer received by agent', { exact: true });
      const provenance = page.getByText('receipt verified from test agent', { exact: true });
      const preview = page.getByRole('region', { name: 'Received answer' });
      const done = page.getByRole('button', { name: 'Done', exact: true });
      assert.equal(await preview.textContent(), detail, 'complete received answer remains available');
      assert.ok(await preview.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), 'unbroken content wraps without horizontal clipping');
      for (const control of [label, provenance, preview, done]) await inViewport(page, control);
      assert.ok((await done.boundingBox()).height >= 44, 'Done is a usable touch target');
      if (await preview.evaluate((el) => el.scrollHeight > el.clientHeight)) {
        await touchScroll(page, preview);
        assert.ok(await preview.evaluate((el) => el.scrollTop) > 0, 'received answer scrolls by touch');
      }
      for (const height of [viewport.height, 350]) {
        await page.evaluate((height) => document.documentElement.style.setProperty('--app-vvh', `${height}px`), height);
        await preview.focus();
        await page.keyboard.press('End');
        await page.waitForTimeout(250);
        assert.ok(await preview.evaluate((el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 2), 'keyboard reaches the complete answer suffix');
        for (const control of [label, provenance, preview, done]) {
          await inViewport(page, control);
          const box = await control.boundingBox();
          assert.ok(box.y + box.height <= height + 1, 'receipt context stays above the keyboard');
        }
        await shot(page, `receipt-${name}-${size}-${height}`);
      }
      await page.evaluate(() => document.documentElement.style.removeProperty('--app-vvh'));
      assert.deepEqual(await answers(page), [], 'reading a receipt sends nothing');
      await done.focus();
      await page.keyboard.press('Enter');
      assert.deepEqual(await answers(page), ['done'], 'Done is keyboard accessible');
      results.push(`${size}: ${name} receipt keeps status and provenance visible; full answer is touch/keyboard readable at normal and 350px visual heights`);
    }

    for (const [kind, message] of [['yesno', 'New approval request: Review this request'], ['confirmed', 'Approved. Receipt verified from test agent.'], ['offline', 'Disconnected. Reconnecting to your agent.'], ['listening', 'Connected. Listening for requests.']]) {
      await render(page, kind);
      await page.getByRole('status').filter({ hasText: message }).waitFor();
    }
    assert.deepEqual(errors, [], 'no browser runtime errors');
    results.push(`${size}: request, result, connection state live regions populated`);
    await context.close();
  }
  console.log(JSON.stringify({ passed: results.length, checks: results }, null, 2));
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(out, { recursive: true, force: true });
}
