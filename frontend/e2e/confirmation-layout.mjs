// Real built PWA, signed receipts, Go agent and relay. Run after bun run build.
// Phone fixture tests separately verify touch and keyboard preview scrolling.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { setup, until } from './recovery-harness.mjs';

const h = await setup();
const checks = [];
async function visible(page, locator, height) {
  const box = await locator.boundingBox();
  assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= page.viewportSize().width + 1 && box.y + box.height <= height + 1, `Receipt context stays visible: ${JSON.stringify(box)}`);
}
async function shot(page, name) {
  if (!process.env.CONFIRMATION_SHOTS) return;
  await mkdir(process.env.CONFIRMATION_SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(process.env.CONFIRMATION_SHOTS, `${process.env.RECOVERY_BROWSER || 'chromium'}-${name}.png`) });
}
try {
  for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }]) {
    const context = await h.browser.newContext({ viewport, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(10000);
    const agent = await h.mcp('receipt-layout-test');
    await page.goto(h.origin + '/app/');
    await agent.tool('start_pairing');
    await page.getByTestId('code-input').fill(await agent.code());
    await page.getByTestId('code-submit').click();
    await page.getByTestId('listening-badge').waitFor();
    for (const kind of ['emoji', 'multiline-choice', 'unbroken-choice']) {
      let answer = kind === 'multiline-choice' ? 'Keep\n'.repeat(49) + 'FINAL KEEP!' : 'K'.repeat(246) + 'FINAL KEEP';
      const request = agent.tool('request_approval', {
        title: 'Harmless receipt layout test', summary: 'Check the exact received answer.',
        response_kind: kind === 'emoji' ? 'text' : 'choice', expires_in_s: 30,
        ...(kind === 'emoji' ? { max_len: 4096 } : { options: [answer] }),
      });
      if (kind === 'emoji') {
        await page.getByTestId('text-input').waitFor();
        const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('aah:sessions:v1'))[0]);
        // Hash/signature encodings have fixed lengths; fill the exact final
        // admissible UTF-8 byte without depending on test-private signing keys.
        const decision = { kind: 'decision', protocol: 2, room: saved.room, id: saved.request.id,
          request_hash: 'A'.repeat(44), response_kind: 'text', result: { text: '' }, sig: 'A'.repeat(88) };
        const budget = 16 * 1024 - 1 - Buffer.byteLength(JSON.stringify(decision));
        answer = '😀'.repeat(Math.floor(budget / 4)) + 'a'.repeat(budget % 4);
        await page.getByTestId('text-input').fill(answer);
        await page.getByTestId('text-send').click();
      } else {
        assert.equal([...answer].length, 256, 'exercise the maximum admitted choice label');
        await page.getByTestId('choice-option').click();
      }
      const response = await request;
      assert.notEqual(response.result?.isError, true, JSON.stringify(response.error));
      const output = JSON.parse(response.result.content.find(item => item.type === 'text').text);
      assert.equal(output[kind === 'emoji' ? 'text' : 'choice'], answer);
      await page.getByTestId('confirmed-screen').waitFor();
      // The previous 2600ms auto-dismiss made long answers impossible to read.
      await page.waitForTimeout(2800);
      assert.ok(await page.getByTestId('confirmed-screen').isVisible(), 'receipt stays open for reading');
      await shot(page, `${viewport.width}-${kind}`);
      await visible(page, page.getByText('Answer received by agent', { exact: true }), viewport.height);
      await visible(page, page.getByText('receipt verified from receipt-layout-test', { exact: true }), viewport.height);
      const preview = page.getByRole('region', { name: 'Received answer' });
      const done = page.getByRole('button', { name: 'Done', exact: true });
      assert.equal(await preview.textContent(), `${kind === 'emoji' ? 'Reply' : 'Choice'}: ${answer}`);
      await visible(page, preview, viewport.height);
      await visible(page, done, viewport.height);
      assert.ok((await done.boundingBox()).height >= 44, 'Done is a usable touch target');
      await page.evaluate(async () => {
        document.documentElement.style.setProperty('--app-vvh', '350px');
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
      });
      await visible(page, page.getByText('Answer received by agent', { exact: true }), 350);
      await visible(page, page.getByText('receipt verified from receipt-layout-test', { exact: true }), 350);
      await visible(page, preview, 350);
      await visible(page, done, 350);
      await preview.focus();
      await page.keyboard.press('End');
      // Native WebKit animates keyboard scrolling; wait for its actual end.
      await until(() => preview.evaluate(el => el.scrollTop + el.clientHeight >= el.scrollHeight - 2), 2000);
      await shot(page, `${viewport.width}-${kind}-keyboard`);
      await page.evaluate(() => document.documentElement.style.removeProperty('--app-vvh'));
      if (kind !== 'multiline-choice') {
        await done.click();
        await page.getByTestId('listening-badge').waitFor();
      } // A new authenticated request must also replace the retained receipt.
      checks.push(`${viewport.width}: verified ${kind} receipt retained past 2600ms; complete answer/context/Done fit normal and 350px heights`);
    }
    assert.deepEqual(errors, []);
    agent.kill();
    await context.close();
  }
  console.log(JSON.stringify({ engine: process.env.RECOVERY_BROWSER || 'chromium', passed: checks.length, checks }, null, 2));
} finally { await h.cleanup(); }
