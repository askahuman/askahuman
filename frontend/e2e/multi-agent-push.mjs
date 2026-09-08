// Run after bun run build. Uses independent real Go agents and native service
// workers, with a deterministic local PushManager service fixture. Live APNs /
// FCM delivery is an explicit separate device test, never claimed by this run.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { setup } from './recovery-harness.mjs';
import { installPushServiceFixture } from './push-service-fixture.mjs';

const h = await setup({ modules: { push: 'src/lib/push.ts', badge: 'src/lib/badge-store.ts' } });
const checks = [];
const options = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, permissions: ['notifications'] };
const context = await h.browser.newContext(options);
await context.addInitScript(installPushServiceFixture);
const page = await context.newPage();
page.setDefaultTimeout(15000);
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const requests = [];
page.on('request', (request) => requests.push(request.url()));
const fixture = async (key, value) => page.evaluate(([key, value]) => localStorage.setItem(`push-fixture:${key}`, JSON.stringify(value)), [key, value]);
const readFixture = async (key, fallback) => page.evaluate(([key, fallback]) => JSON.parse(localStorage.getItem(`push-fixture:${key}`) || JSON.stringify(fallback)), [key, fallback]);
const ready = (n) => page.getByTestId('push-status').getByText(`Notifications set up for ${n} ${n === 1 ? 'agent' : 'agents'}.`, { exact: true }).waitFor();
async function shot(name) {
  if (!process.env.PUSH_SHOTS) return;
  await mkdir(process.env.PUSH_SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(process.env.PUSH_SHOTS, name + '.png') });
}
async function pair(name) {
  const agent = await h.mcp(name);
  // Pair without submitting an approval request: a fake push endpoint must
  // never cause the agent to send an actual external wake-up in this test.
  await agent.tool('start_pairing');
  await page.getByTestId('code-input').fill(await agent.code());
  await page.getByTestId('code-submit').click();
  await page.getByTestId('listening-badge').waitFor();
  return agent;
}
try {
  await page.goto(h.origin + '/app/');
  const a = await pair('notification-agent-a');
  await page.getByRole('button', { name: 'Enable notifications' }).waitFor();
  assert.deepEqual(await readFixture('events', []), [], 'pairing must not request permission or subscribe');
  await page.setViewportSize({ width: 320, height: 568 });
  const button = page.getByRole('button', { name: 'Enable notifications' });
  const rect = await button.boundingBox();
  assert.ok(rect && rect.height >= 44 && rect.y >= 0 && rect.y + rect.height <= 568);
  await shot('permission-320');
  await button.click();
  await ready(1);
  const afterA = await readFixture('subscriptions', {});
  const [scopeA] = Object.keys(afterA);
  assert.equal((await readFixture('events', [])).filter((e) => e.type === 'permission')[0].gesture, true);
  const shell = await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL);
  const cachesBefore = await page.evaluate(() => caches.keys());
  await page.getByTestId('roster-add').click();
  const b = await pair('notification-agent-b');
  await ready(2);
  const subscriptions = await readFixture('subscriptions', {});
  const scopeB = Object.keys(subscriptions).find((scope) => scope !== scopeA);
  assert.ok(scopeB);
  assert.deepEqual(subscriptions[scopeA], afterA[scopeA], 'A remains bound to its original endpoint/key');
  assert.notDeepEqual(subscriptions[scopeA].key, subscriptions[scopeB].key, 'the two real agents use different VAPID keys');
  assert.notEqual(subscriptions[scopeA].endpoint, subscriptions[scopeB].endpoint);
  assert.equal((await readFixture('events', [])).filter((e) => e.type === 'permission').length, 1);
  assert.equal((await readFixture('events', [])).filter((e) => e.type === 'unsubscribe').length, 0);
  const registrations = await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).map((r) => ({ scope: r.scope, script: r.active?.scriptURL, state: r.active?.state })));
  for (const scope of [scopeA, scopeB]) {
    assert.ok(registrations.some((r) => r.scope === scope && r.script === h.origin + '/sw.js?mode=push' && r.state === 'activated'));
  }
  assert.equal(await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL), shell);
  assert.deepEqual(await page.evaluate(() => caches.keys()), cachesBefore, 'wake-only workers add no precache copies');
  assert.equal(requests.some((url) => url.includes('/app/_push/')), false, 'room scope is registration metadata, never a fetched URL');
  checks.push('two actual agents with different VAPID keys retain separate fixture subscriptions on activated native workers; one direct-gesture permission request; no extra shell caches or room URL requests');
  await page.setViewportSize({ width: 390, height: 844 });
  await shot('both-agents-390');

  await page.reload(); await ready(2);
  assert.deepEqual(await readFixture('subscriptions', {}), subscriptions);
  assert.equal((await readFixture('events', [])).filter((e) => e.type === 'subscribe').length, 2);
  checks.push('reload restores and re-delivers both existing subscriptions without replacing either endpoint');

  await fixture('fail', scopeB); await page.reload();
  await page.getByRole('button', { name: 'Retry notifications' }).waitFor();
  assert.match(await page.getByTestId('push-status').innerText(), /not set up for 1 agent/);
  await fixture('fail', ''); await page.getByRole('button', { name: 'Retry notifications' }).click(); await ready(2);
  for (const permission of ['denied', 'default']) {
    await fixture('permission', permission); await page.reload();
    const status = page.getByTestId('push-status');
    await status.waitFor();
    assert.doesNotMatch(await status.innerText(), /Notifications set up/);
    if (permission === 'denied') assert.match(await status.innerText(), /blocked/);
    else await page.getByRole('button', { name: 'Enable notifications' }).waitFor();
    assert.equal((await readFixture('events', [])).filter((e) => e.type === 'permission').length, 1);
  }
  await fixture('unsupported', true); await page.reload();
  await page.getByTestId('push-status').getByText(/unavailable here/).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Enable notifications' }).count(), 0);
  await fixture('unsupported', false); await fixture('permission', 'granted'); await page.reload(); await ready(2);
  checks.push('failed, denied, default, and unsupported states never claim setup; retries recover without changing the other subscription');

  const roomA = new URL(scopeA).pathname.split('/').at(-2), roomB = new URL(scopeB).pathname.split('/').at(-2);
  const active = async () => page.locator(`[data-testid="roster-chip-${roomB}"]`).getAttribute('aria-pressed');
  // A real wake-worker message must select B. Other senders and unknown rooms
  // cannot import a pairing or select a different agent.
  assert.ok(context.serviceWorkers().some((worker) => worker.url() === h.origin + '/sw.js?mode=push'));
  await page.getByTestId(`roster-chip-${roomA}`).click();
  for (const worker of context.serviceWorkers()) {
    if (await worker.evaluate(() => self.registration.scope) !== scopeB) continue;
    await worker.evaluate(async (room) => {
      for (const client of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) client.postMessage({ type: 'aah:push-open', room });
    }, roomB);
  }
  await page.waitForFunction((room) => document.querySelector(`[data-testid="roster-chip-${room}"]`)?.getAttribute('aria-pressed') === 'true', roomB);
  assert.equal(await active(), 'true');
  await page.goto(h.origin + '/app/#wake=' + roomA);
  await page.waitForFunction((room) => document.querySelector(`[data-testid="roster-chip-${room}"]`)?.getAttribute('aria-pressed') === 'true', roomA);
  assert.equal(new URL(page.url()).hash, '');
  await page.goto(h.origin + '/app/#wake=0000000000000000');
  await page.waitForFunction(() => location.hash === '');
  assert.equal(await page.locator('[data-testid^="roster-chip-"]').count(), 2);
  checks.push('same-origin wake-worker message and cold-launch opaque fragment select the right saved agent; unknown room does not create a session');

  await page.getByTestId(`roster-remove-${roomA}`).click();
  await ready(1);
  await page.waitForFunction(async (scope) => !(await navigator.serviceWorker.getRegistrations()).some((r) => r.scope === scope), scopeA);
  assert.ok(await page.evaluate(async (scope) => (await navigator.serviceWorker.getRegistrations()).some((r) => r.scope === scope), scopeB));
  assert.equal(await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL), shell);
  assert.deepEqual((await readFixture('subscriptions', {}))[scopeB], subscriptions[scopeB]);
  await page.reload(); await ready(1);
  checks.push('forget removes only its room subscription/registration, preserves the sibling and shell, and remains removed after reload');
  a.kill(); b.kill();

  const badgeContext = await h.browser.newContext();
  const tabs = await Promise.all(Array.from({ length: 4 }, () => badgeContext.newPage()));
  await Promise.all(tabs.map((tab) => tab.goto(h.origin + '/app/')));
  await tabs[0].evaluate(async () => (await import('/__recovery/badge.js')).updateBadgeCount(0));
  // Remove page controllers before using the same database in the concurrency
  // fixture so foreground authoritative-count messages cannot reset this test.
  await Promise.all(tabs.map((tab) => tab.goto(h.origin + '/')));
  const counts = (await Promise.all(tabs.map((tab) => tab.evaluate(async () => {
    const { updateBadgeCount } = await import('/__recovery/badge.js');
    return Promise.all(Array.from({ length: 12 }, () => updateBadgeCount('increment')));
  })))).flat();
  assert.equal(new Set(counts).size, 48); assert.equal(Math.max(...counts), 48);
  await badgeContext.close();
  checks.push('48 simultaneous badge increments across four tabs produce every count exactly once without lost updates');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: checks.length, checks, limits: ['PushManager service is deterministic; live FCM/APNs subscriptions and locked iPhone delivery require the documented device test.'] }, null, 2));
} catch (error) {
  await shot('failure');
  console.error(JSON.stringify({ body: await page.locator('body').innerText(), sessions: await page.evaluate(() => JSON.parse(localStorage.getItem('aah:sessions:v1') || '[]').map(({ room, vapid }) => ({ room, hasVapid: Boolean(vapid) }))), errors }, null, 2));
  throw error;
} finally { await h.cleanup(); }
