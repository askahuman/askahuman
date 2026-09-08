// Run after bun run build: node e2e/session-recovery.mjs
// Needs Go, Bun and Playwright Chromium (or CHROME_EXECUTABLE). Binds only local
// ports 19080–19082; override RECOVERY_PORT when these are occupied.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { setup } from './recovery-harness.mjs';

const h = await setup();
const results = [];
const input = { title: 'Recovery test approval', summary: 'Approve this harmless test only.', response_kind: 'yesno', expires_in_s: 30 };
const contextOptions = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
async function visit(context) {
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  await page.goto(`${h.origin}/app/`);
  await page.getByTestId('code-input').waitFor();
  return page;
}
async function submit(page, agent) {
  await page.getByTestId('code-input').fill(await agent.code());
  await page.getByTestId('code-submit').click();
}
function resultOf(message) {
  assert.equal(message.error, undefined);
  assert.notEqual(message.result?.isError, true);
  return JSON.parse(message.result.content.find((item) => item.type === 'text').text);
}
async function shot(page, name) {
  if (!process.env.RECOVERY_SHOTS) return;
  await mkdir(process.env.RECOVERY_SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(process.env.RECOVERY_SHOTS, `${name}.png`) });
}

try {
  // Independent tabs each issue concurrent first-use calls. Gate key generation
  // until every tab has observed an empty database, forcing the historical race.
  {
    const context = await h.browser.newContext(contextOptions);
    const pages = await Promise.all(Array.from({ length: 4 }, () => visit(context)));
    await Promise.all(pages.map((page) => page.evaluate(async () => {
      const { loadOrCreateDeviceKey } = await import('/__recovery/devicekey.js');
      const generate = crypto.subtle.generateKey.bind(crypto.subtle);
      const waiting = [];
      let allowed = false;
      window.releaseGeneration = () => { allowed = true; waiting.splice(0).forEach((resolve) => resolve()); };
      crypto.subtle.generateKey = async (...args) => {
        window.keyGenerationReady = true;
        if (!allowed) await new Promise((resolve) => waiting.push(resolve));
        return generate(...args);
      };
      window.signers = Promise.all(Array.from({ length: 12 }, () => loadOrCreateDeviceKey()));
    })));
    await Promise.all(pages.map((page) => page.waitForFunction(() => window.keyGenerationReady)));
    await Promise.all(pages.map((page) => page.evaluate(() => window.releaseGeneration())));
    const keys = (await Promise.all(pages.map((page) => page.evaluate(async () => (await window.signers).map((key) => key?.spkiB64))))).flat();
    assert.ok(keys.every(Boolean));
    assert.equal(new Set(keys).size, 1, 'all pages must adopt the persisted winner');
    await pages[0].reload();
    const restored = await pages[0].evaluate(async () => {
      const { loadOrCreateDeviceKey } = await import('/__recovery/devicekey.js');
      const signer = await loadOrCreateDeviceKey();
      const message = new TextEncoder().encode('retained device signer');
      const signature = Uint8Array.from(atob(await signer.sign(message)), (c) => c.charCodeAt(0));
      const publicKey = await crypto.subtle.importKey('spki', Uint8Array.from(atob(signer.spkiB64), (c) => c.charCodeAt(0)), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      return { key: signer.spkiB64, verified: await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, signature, message) };
    });
    assert.equal(restored.key, keys[0]);
    assert.equal(restored.verified, true);
    results.push('48 concurrent first-use calls across four tabs adopt one signer; reload signs with the same key');
    await context.close();
  }

  {
    const context = await h.browser.newContext(contextOptions);
    const page = await visit(context);
    const agent = await h.mcp();
    const response = agent.tool('request_approval', input);
    await submit(page, agent);
    await page.getByTestId('yesno-card').waitFor();
    assert.equal(h.cutAgent(), 1, 'only the real agent socket is interrupted');
    await page.getByTestId('retry-button').waitFor();
    // The phone socket remains connected. No Retry click or page reload.
    await page.getByTestId('yesno-card').waitFor();
    await shot(page, 'agent-recovered');
    await page.getByTestId('approve-button').click();
    assert.equal(resultOf(await response).approved, true);
    const restoredResponse = agent.tool('request_approval', { ...input, title: 'Reload preserves pairing and signer' });
    await page.getByTestId('yesno-card').waitFor();
    await page.reload();
    await page.getByTestId('yesno-card').waitFor();
    await page.getByTestId('decline-button').click();
    assert.equal(resultOf(await restoredResponse).approved, false);
    results.push('agent-only reconnect restores its unanswered card automatically; strict signed approve and post-reload decline reach MCP');
    agent.kill();
    await context.close();
  }

  {
    const context = await h.browser.newContext(contextOptions);
    const page = await visit(context);
    const bad = await h.mcp('failed-handshake');
    h.tamperConfirmation(true);
    await bad.tool('start_pairing');
    await submit(page, bad);
    await page.getByRole('alert').filter({ hasText: 'Pairing failed' }).waitFor();
    assert.match(await page.getByTestId('code-error').innerText(), /new code/);
    assert.equal(await page.getByTestId('pair-waiting').count(), 0);
    assert.equal(await page.getByTestId('yesno-card').count(), 0);
    await shot(page, 'pairing-failure-visible');
    bad.kill();
    h.tamperConfirmation(false);
    const good = await h.mcp('fresh-handshake');
    const response = good.tool('request_approval', input);
    await submit(page, good);
    await page.getByTestId('yesno-card').waitFor();
    assert.equal(await page.locator('[data-testid^="roster-chip-"]').count(), 1, 'failed attempt is removed, paired session survives');
    await page.getByTestId('decline-button').click();
    assert.equal(resultOf(await response).approved, false);
    results.push('tampered pairing confirmation shows an accessible failure; a fresh code replaces it and completes pairing');
    good.kill();
    await context.close();
  }

  for (const target of ['/app/', '/app']) {
    const context = await h.browser.newContext(contextOptions);
    const page = await visit(context);
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    const manifest = await page.evaluate(async () => (await fetch('/manifest.webmanifest')).json());
    assert.equal(manifest.start_url, '/app/');
    assert.equal(manifest.id, '/app');
    await context.setOffline(true);
    await page.goto(h.origin + target, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('code-input').waitFor();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByTestId('code-input').waitFor();
    await shot(page, `offline-${target === '/app/' ? 'slash' : 'legacy'}`);
    await context.setOffline(false);
    await page.reload();
    await page.getByTestId('code-input').waitFor();
    results.push(`${target} opens and reloads offline, then recovers online; installed app identity is retained`);
    await context.close();
  }
  console.log(JSON.stringify({ passed: results.length, checks: results }, null, 2));
} finally {
  await h.cleanup();
}
