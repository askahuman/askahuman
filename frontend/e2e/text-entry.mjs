// Real reply and pairing controls: composition Enter cannot submit, while
// ordinary Enter, explicit buttons, and exact single-line paste remain usable.
// Chromium uses its native IME composition path. Both engines also exercise
// KeyboardEvent composition flags, including the legacy keyCode 229 boundary.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';

const frontend = fileURLToPath(new URL('../', import.meta.url));
const out = await mkdtemp(join(tmpdir(), 'aah-text-entry-'));
execFileSync('bun', ['build', 'e2e/fixtures/phone-interactions.tsx', '--target=browser', `--outfile=${join(out, 'fixture.js')}`], { cwd: frontend, stdio: 'pipe' });
execFileSync('bun', ['build', 'e2e/fixtures/hosted-pairing.tsx', '--target=browser', `--outfile=${join(out, 'pair.js')}`], { cwd: frontend, stdio: 'pipe' });
const fixtures = new Map([
  ['/fixture.js', await readFile(join(out, 'fixture.js'))],
  ['/pair.js', await readFile(join(out, 'pair.js'))],
]);
const server = createServer((req, res) => {
  const fixture = fixtures.get(req.url);
  res.setHeader('Content-Type', fixture ? 'text/javascript' : 'text/html');
  res.end(fixture ?? `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="${req.url === '/pair/' ? '/pair.js' : '/fixture.js'}"></script></body></html>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
const checks = [];
try {
  for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    browser = await engine.launch(name === 'chromium' && process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {});
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    await page.waitForFunction(() => Boolean(window.phoneTest));
    const input = page.getByRole('textbox', { name: 'Your reply' });
    const send = page.getByRole('button', { name: 'Send reply' });
    const received = () => page.evaluate(() => window.phoneTest.answers);
    const render = async () => {
      const version = await page.evaluate(() => window.phoneTest.render('text', {
        kind: 'request', id: 'synthetic-text-entry', title: 'Synthetic reply',
        summary: 'No external operation follows.', response: { kind: 'text', max_len: 4096 },
      }));
      await page.locator(`[data-render-version="${version}"]`).waitFor();
      await input.focus();
    };

    if (name === 'chromium') {
      await render();
      await input.evaluate(el => {
        window.compositionEnter = null;
        el.addEventListener('keydown', e => { if (e.key === 'Enter') window.compositionEnter = { trusted: e.isTrusted, composing: e.isComposing }; });
      });
      const cdp = await context.newCDPSession(page);
      try {
        await cdp.send('Input.imeSetComposition', { text: 'にほん', selectionStart: 3, selectionEnd: 3 });
        await page.keyboard.press('Enter');
        assert.deepEqual(await page.evaluate(() => window.compositionEnter), { trusted: true, composing: true });
        assert.deepEqual(await received(), [], 'native composition Enter must not send an unfinished reply');
        await cdp.send('Input.insertText', { text: '日本' });
        assert.equal(await input.inputValue(), '日本');
        assert.deepEqual(await received(), [], 'committing composition is not consent to send');
        await page.keyboard.press('Enter');
        assert.deepEqual(await received(), ['日本'], 'ordinary Enter sends the completed reply');
      } finally { await cdp.detach(); }
      checks.push('chromium: native active composition and commit send nothing; later Enter sends the final text');
    }

    for (const init of [{ isComposing: true, keyCode: 13 }, { isComposing: false, keyCode: 229 }]) {
      await render();
      await input.fill('Synthetic draft');
      await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', ...init });
      assert.deepEqual(await received(), [], 'IME Enter must not send');
      await input.fill('Completed reply 😀');
      await send.click();
      assert.deepEqual(await received(), ['Completed reply 😀'], 'explicit Send remains available after composition');
      checks.push(`${name}: composing=${init.isComposing}, keyCode=${init.keyCode} cannot send; explicit Send works`);
    }

    for (const value of ['', '  Reply with preserved spaces 😀  ']) {
      await render(); await input.fill(value); await page.keyboard.press('Enter');
      assert.deepEqual(await received(), [value], 'ordinary Enter preserves empty replies, Unicode, and whitespace');
    }
    checks.push(`${name}: ordinary Enter preserves empty replies, Unicode, and whitespace`);

    await render();
    const longReply = 'This synthetic reply must remain fully readable. '.repeat(24) + 'END-REPLY-7391';
    await page.evaluate(value => {
      const source = document.createElement('textarea');
      source.id = 'synthetic-copy-source'; source.value = value;
      document.body.appendChild(source); source.focus(); source.select();
    }, longReply);
    await page.keyboard.press('ControlOrMeta+C');
    await input.focus(); await page.keyboard.press('ControlOrMeta+V');
    assert.equal(await input.inputValue(), longReply, 'check actual input before sending; never normalize the expected reply');
    await send.click();
    assert.deepEqual(await received(), [longReply]);
    checks.push(`${name}: native single-line paste and Send preserve the complete long reply`);

    // The pairing fixture records attempts; it cannot open a relay connection.
    const codeInput = page.getByTestId('code-input');
    const submissions = () => page.evaluate(() => window.pairingSubmissions);
    const expectedPair = [{ code: 'ABCDE-23456', relay: origin.replace('http:', 'ws:') + '/ws' }];
    const openPairing = async () => {
      await page.goto(origin + '/pair/');
      await codeInput.waitFor();
      await codeInput.focus();
    };
    if (name === 'chromium') {
      await openPairing();
      await codeInput.fill('ABCDE-2345');
      await codeInput.evaluate(el => {
        el.setSelectionRange(el.value.length, el.value.length);
        window.compositionEnter = null;
        el.addEventListener('keydown', e => { if (e.key === 'Enter') window.compositionEnter = { trusted: e.isTrusted, composing: e.isComposing }; });
      });
      const cdp = await context.newCDPSession(page);
      try {
        await cdp.send('Input.imeSetComposition', { text: '6', selectionStart: 1, selectionEnd: 1 });
        assert.equal(await codeInput.inputValue(), 'ABCDE-23456', 'the formatter admits a complete code while its last symbol is still composing');
        await page.keyboard.press('Enter');
        assert.deepEqual(await page.evaluate(() => window.compositionEnter), { trusted: true, composing: true });
        assert.deepEqual(await submissions(), [], 'native composition Enter must not initiate pairing');
        assert.equal(await page.getByTestId('pair-waiting').count(), 0);
        await cdp.send('Input.insertText', { text: '6' });
        assert.equal(await codeInput.inputValue(), 'ABCDE-23456');
        assert.deepEqual(await submissions(), [], 'committing the final code symbol must not initiate pairing');
        await page.keyboard.press('Enter');
        assert.deepEqual(await submissions(), expectedPair, 'ordinary Enter submits the completed code');
      } finally { await cdp.detach(); }
      checks.push('chromium: native composition of a valid final code symbol cannot pair; later Enter submits once');
    }
    for (const init of [{ isComposing: true, keyCode: 13 }, { isComposing: false, keyCode: 229 }]) {
      await openPairing();
      await codeInput.fill('ABCDE-23456');
      await codeInput.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', ...init });
      assert.deepEqual(await submissions(), [], 'IME Enter must not initiate pairing');
      assert.equal(await page.getByTestId('pair-waiting').count(), 0);
      if (init.isComposing) await page.keyboard.press('Enter');
      else await page.getByTestId('code-submit').click();
      assert.deepEqual(await submissions(), expectedPair);
      checks.push(`${name}: pairing composing=${init.isComposing}, keyCode=${init.keyCode} cannot submit; deliberate submission works`);
    }
    assert.deepEqual(errors, []);
    await context.close(); await browser.close(); browser = null;
  }
  console.log(JSON.stringify({ checks }, null, 2));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  await rm(out, { recursive: true, force: true });
}
