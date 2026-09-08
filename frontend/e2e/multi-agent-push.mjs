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
async function resizeViewport(viewport) {
  await page.setViewportSize(viewport);
  // The DevTools resize acknowledgement can precede visualViewport's event. Wait
  // for the fixed app shell to adopt its observed height before measuring it.
  await page.waitForFunction((height) => {
    const vv = window.visualViewport;
    const observed = Math.round(vv ? vv.height * (vv.scale || 1) : innerHeight);
    return observed === height && parseFloat(document.documentElement.style.getPropertyValue('--app-vvh')) === height;
  }, viewport.height);
}
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
async function clickNotification(scope) {
  for (const worker of context.serviceWorkers()) {
    if (await worker.evaluate(() => self.registration.scope) !== scope) continue;
    return worker.evaluate(async () => {
      // Exercise the built worker's real click handler and native message ports /
      // navigation. A synthetic event has no OS gesture, so only focus is stubbed.
      const [client] = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const proto = Object.getPrototypeOf(client);
      const focus = Object.getOwnPropertyDescriptor(proto, 'focus');
      Object.defineProperty(proto, 'focus', { configurable: true, value: async function () { return this; } });
      try {
        const pending = [];
        const event = new Event('notificationclick');
        Object.defineProperties(event, {
          notification: { value: { close() {} } },
          waitUntil: { value: (task) => pending.push(task) },
        });
        self.dispatchEvent(event);
        await Promise.all(pending);
      } finally {
        if (focus) Object.defineProperty(proto, 'focus', focus);
        else delete proto.focus;
      }
    });
  }
  throw new Error('room worker not found');
}
async function holdAppHydration() {
  return page.evaluate(async () => {
    const component = document.querySelector('astro-island[component-url*="/App."]').getAttribute('component-url');
    // Delay only App's module execution in this disposable test cache. Worker
    // delivery and navigation stay native, and the saved roster remains real.
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      const key = (await cache.keys()).find((request) => new URL(request.url).pathname === component);
      if (!key) continue;
      const original = await (await cache.match(key)).text();
      const gate = 'await new Promise((resolve) => { window.__releaseAppHydration = resolve; window.__appHydrationHeld = true; });\n';
      await cache.put(key, new Response(gate + original, { headers: { 'Content-Type': 'application/javascript' } }));
      return { name, key: key.url, original };
    }
    throw new Error('App is not precached');
  });
}
async function restoreAppModule(saved) {
  await page.evaluate(async ({ name, key, original }) => {
    await (await caches.open(name)).put(key, new Response(original, { headers: { 'Content-Type': 'application/javascript' } }));
  }, saved);
}
try {
  await page.goto(h.origin + '/app/');
  const a = await pair('notification-agent-a');
  await page.getByRole('button', { name: 'Enable notifications' }).waitFor();
  assert.deepEqual(await readFixture('events', []), [], 'pairing must not request permission or subscribe');
  await resizeViewport({ width: 320, height: 568 });
  const button = page.getByRole('button', { name: 'Enable notifications' });
  const rect = await button.boundingBox();
  assert.ok(rect && rect.height >= 44 && rect.y >= 0 && rect.y + rect.height <= 568, `44px notification control must fit the settled 320×568 viewport: ${JSON.stringify(rect)}`);
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
  await resizeViewport({ width: 390, height: 844 });
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
  // The real wake-worker handler must select B through an acknowledged message,
  // without navigating an app which is already hydrated.
  assert.ok(context.serviceWorkers().some((worker) => worker.url() === h.origin + '/sw.js?mode=push'));
  await page.getByTestId(`roster-chip-${roomA}`).click();
  const navigations = [];
  const navigated = (frame) => { if (frame === page.mainFrame()) navigations.push(frame.url()); };
  page.on('framenavigated', navigated);
  await clickNotification(scopeB);
  await page.waitForFunction((room) => document.querySelector(`[data-testid="roster-chip-${room}"]`)?.getAttribute('aria-pressed') === 'true', roomB);
  assert.equal(await active(), 'true');
  assert.deepEqual(navigations, [], 'acknowledged room selection must not navigate or reload the app');
  page.off('framenavigated', navigated);
  await page.goto(h.origin + '/app/#wake=' + roomA);
  await page.waitForFunction((room) => document.querySelector(`[data-testid="roster-chip-${room}"]`)?.getAttribute('aria-pressed') === 'true', roomA);
  assert.equal(new URL(page.url()).hash, '');
  await page.goto(h.origin + '/app/#wake=0000000000000000');
  await page.waitForFunction(() => location.hash === '');
  assert.equal(await page.locator('[data-testid^="roster-chip-"]').count(), 2);
  checks.push('native wake-worker click is acknowledged without navigation; cold-launch opaque fragment selects the right saved agent; unknown room does not create a session');

  await page.getByTestId(`roster-chip-${roomA}`).click();
  const savedModule = await holdAppHydration();
  try {
    await page.reload({ waitUntil: 'commit' });
    await page.waitForFunction(() => window.__appHydrationHeld === true);
    assert.equal(await page.locator('[data-testid^="roster-chip-"]').count(), 0, 'App has not restored the roster or installed its message listener yet');
    await clickNotification(scopeB);
    assert.equal(new URL(page.url()).hash, '#wake=' + roomB, 'the app shell durably retains the click across delayed React hydration');
    await restoreAppModule(savedModule);
    await page.waitForFunction(() => window.__appHydrationHeld === true);
    await page.evaluate(() => window.__releaseAppHydration());
    await page.waitForFunction((room) => document.querySelector(`[data-testid="roster-chip-${room}"]`)?.getAttribute('aria-pressed') === 'true', roomB);
    assert.equal(new URL(page.url()).hash, '');
    await ready(2);
  } finally { await restoreAppModule(savedModule); }
  checks.push('a B notification arriving before App hydration survives as an opaque fragment, then selects B from the saved A-active roster and clears the fragment');

  await page.getByTestId(`roster-remove-${roomA}`).click();
  await ready(1);
  await page.waitForFunction(async (scope) => !(await navigator.serviceWorker.getRegistrations()).some((r) => r.scope === scope), scopeA);
  assert.ok(await page.evaluate(async (scope) => (await navigator.serviceWorker.getRegistrations()).some((r) => r.scope === scope), scopeB));
  assert.equal(await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL), shell);
  assert.deepEqual((await readFixture('subscriptions', {}))[scopeB], subscriptions[scopeB]);
  await page.reload(); await ready(1);
  checks.push('forget removes only its room subscription/registration, preserves the sibling and shell, and remains removed after reload');

  await resizeViewport({ width: 320, height: 568 });
  await context.setOffline(true);
  for (const permission of ['denied', 'default']) {
    await fixture('permission', permission);
    await page.reload();
    await page.getByTestId('offline-badge').waitFor();
    const status = page.getByTestId('push-status');
    await status.waitFor();
    assert.doesNotMatch(await status.innerText(), /Notifications set up/);
    if (permission === 'denied') {
      assert.match(await status.innerText(), /blocked/);
      await shot('offline-denied-320');
    } else {
      const enable = page.getByRole('button', { name: 'Enable notifications' });
      await enable.scrollIntoViewIfNeeded();
      const rect = await enable.boundingBox();
      assert.ok(rect && rect.height >= 44 && rect.y >= 0 && rect.y + rect.height <= 568, `44px notification control must fit the settled 320×568 viewport: ${JSON.stringify(rect)}`);
      await shot('offline-permission-320');
      await enable.click();
      assert.equal((await readFixture('events', [])).filter((e) => e.type === 'permission').at(-1).gesture, true);
      await page.getByRole('button', { name: 'Retry notifications' }).waitFor();
      assert.doesNotMatch(await status.innerText(), /Notifications set up/);
    }
    const retry = page.getByTestId('retry-button');
    await retry.scrollIntoViewIfNeeded();
    assert.ok((await retry.boundingBox()).height >= 44);
  }
  await fixture('unsupported', true); await page.reload();
  await page.getByTestId('offline-badge').waitFor();
  await page.getByTestId('push-status').getByText(/unavailable here/).waitFor();
  await fixture('unsupported', false); await context.setOffline(false);
  await page.reload(); await ready(1);
  checks.push('restored unavailable relay retains denied, permission, failed, and unsupported notification disclosure at 320 × 568; enable and reconnect controls remain usable');
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
  console.error(JSON.stringify({ url: page.url(), body: await page.locator('body').innerText(), sessions: await page.evaluate(() => JSON.parse(localStorage.getItem('aah:sessions:v1') || '[]').map(({ room, vapid }) => ({ room, hasVapid: Boolean(vapid) }))), errors }, null, 2));
  throw error;
} finally { await h.cleanup(); }
