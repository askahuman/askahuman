// Real PAKE first, then two restored production SessionManagers with captured
// local transports. Native Web Locks, workers, IndexedDB and signing run in two
// pages; only the PushManager service is deterministic. No external push/Ask.
import assert from 'node:assert/strict';
import { setup } from './recovery-harness.mjs';
import { installPushServiceFixture } from './push-service-fixture.mjs';

const h = await setup({ modules: {
  manager: 'src/lib/manager.ts', push: 'src/lib/push.ts',
  crypto: 'src/lib/crypto.ts', b64: 'src/lib/b64.ts', protocol: 'src/lib/protocol.ts',
} });
const checks = [];
const context = await h.browser.newContext();
await context.addInitScript({ content: `if (typeof ServiceWorkerRegistration !== 'undefined') (${installPushServiceFixture.toString()})();` });
await context.addInitScript(() => {
  if (typeof ServiceWorkerRegistration === 'undefined') return;
  const descriptor = Object.getOwnPropertyDescriptor(ServiceWorkerRegistration.prototype, 'pushManager');
  Object.defineProperty(ServiceWorkerRegistration.prototype, 'pushManager', {
    configurable: true,
    get() {
      const manager = descriptor.get.call(this), scope = this.scope;
      return { ...manager, getSubscription: async () => {
        // Expiration/renewal is simulated only once the real provider owns its
        // lock. Delaying an older read must block this other page's rotation.
        if (window.rotateNative === scope) {
          window.rotateNative = null;
          const subscriptions = JSON.parse(localStorage.getItem('push-fixture:subscriptions') || '{}');
          delete subscriptions[scope];
          localStorage.setItem('push-fixture:subscriptions', JSON.stringify(subscriptions));
        }
        const snapshot = await manager.getSubscription();
        if (window.holdNative) {
          window.nativeHeld = true;
          await new Promise((resolve) => { window.releaseNative = resolve; });
          window.holdNative = false;
          window.nativeHeld = false;
        }
        return snapshot;
      } };
    },
  });
});
const a = await context.newPage();
const errors = [];
context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
a.on('pageerror', (error) => errors.push(error.message));
const setupManager = async (page, entry) => page.evaluate(async (entry) => {
  const { SessionManager } = await import('/__recovery/manager.js');
  window.pushEntry = entry;
  window.sentPushFrames = [];
  class CapturedSocket {
    constructor() { setTimeout(() => this.onopen?.({}), 0); }
    send(data) { window.sentPushFrames.push(JSON.parse(data)); }
    close() { this.onclose?.({}); }
  }
  window.manager = new SessionManager({ relayOptions: {
    wsFactory: () => new CapturedSocket(), setTimer: () => 0, clearTimer: () => {},
  } }, { load: () => [entry], save: () => {} });
  if (window.manager.restoreAll() !== 1) throw new Error('restore failed');
}, entry);
const readyManager = (page) => page.waitForFunction(() => window.manager.activeState().paired && window.manager.activeState().conn === 'open');
const reconcile = (page) => page.evaluate(() => window.manager.reconcilePushSubscription(window.pushEntry.room, window.pushEntry.vapid));
const pushes = (page) => page.evaluate(async () => {
  const { open } = await import('/__recovery/crypto.js');
  const { b64Decode } = await import('/__recovery/b64.js');
  const { verify, importSigner, pushSigningMessage } = await import('/__recovery/protocol.js');
  const signer = await importSigner(window.pushEntry.deviceSigner);
  return Promise.all(window.sentPushFrames.filter((f) => typeof f.box === 'string').map(async (frame) => {
    const message = JSON.parse(new TextDecoder().decode(open(b64Decode(window.pushEntry.key), frame.box)));
    if (message.kind !== 'push_sub') throw new Error('unexpected captured box');
    if (!(await verify(signer, pushSigningMessage(message), message.sig))) throw new Error('invalid push signature');
    return { sequence: message.push_seq, endpoint: message.subscription.endpoint };
  }));
});
const subscription = (page, scope) => page.evaluate((scope) => JSON.parse(localStorage.getItem('push-fixture:subscriptions') || '{}')[scope], scope);

try {
  const agent = await h.mcp('push-reconciliation');
  await agent.tool('start_pairing');
  await a.goto(h.origin + '/app/');
  await a.getByTestId('code-input').fill(await agent.code());
  await a.getByTestId('code-submit').click();
  await a.getByRole('button', { name: 'Enable notifications' }).click();
  await a.getByTestId('push-status').getByText('Notifications set up for 1 agent.', { exact: true }).waitFor();
  const entry = await a.evaluate(() => JSON.parse(localStorage.getItem('aah:sessions:v1'))[0]);
  const scope = `${h.origin}/app/_push/${entry.room}/`;
  // Leave the app to close its real socket/effects. Both fixture managers below
  // use the pairing established above and the actual shared IndexedDB ledger.
  await a.goto(h.origin + '/__recovery/blank');
  const b = await context.newPage();
  await b.goto(h.origin + '/__recovery/blank');
  await Promise.all([setupManager(a, entry), setupManager(b, entry)]);
  await Promise.all([readyManager(a), readyManager(b)]);
  assert.equal(await reconcile(a), true);
  const e1 = (await pushes(a)).at(-1);
  await b.evaluate((scope) => { window.rotateNative = scope; }, scope);
  assert.equal(await reconcile(b), true);
  const e2 = (await pushes(b)).at(-1);
  assert.notEqual(e2.endpoint, e1.endpoint);
  assert.ok(e2.sequence > e1.sequence);
  await a.evaluate(() => window.manager.retryAll());
  await a.waitForFunction(() => window.manager.pushStatus(window.pushEntry.room, window.pushEntry.vapid) === 'ready');
  const afterReconnect = (await pushes(a)).at(-1);
  assert.equal(afterReconnect.endpoint, e2.endpoint);
  assert.ok(afterReconnect.sequence > e2.sequence);
  checks.push('two restored pages verify real signed E1 -> E2 -> E2 frames using one native registration and the shared persistent sequence ledger');

  await a.evaluate(() => {
    window.holdNative = true;
    window.pendingPush = window.manager.reconcilePushSubscription(window.pushEntry.room, window.pushEntry.vapid);
  });
  await a.waitForFunction(() => window.nativeHeld);
  const beforeB = (await pushes(b)).length;
  await b.evaluate((scope) => {
    window.rotateNative = scope;
    window.pendingPush = window.manager.reconcilePushSubscription(window.pushEntry.room, window.pushEntry.vapid);
  }, scope);
  await b.waitForFunction(async () => (await navigator.locks.query()).pending.some((lock) => lock.name === `aah:push:${window.pushEntry.room}`));
  assert.equal((await pushes(b)).length, beforeB);
  assert.equal((await subscription(b, scope)).endpoint, e2.endpoint);
  const otherRoom = entry.room === '0000000000000000' ? '1111111111111111' : '0000000000000000';
  assert.equal(await b.evaluate(async (room) => {
    const { withPushSubscription } = await import('/__recovery/push.js');
    return withPushSubscription(window.pushEntry.vapid, room, async () => true, () => true);
  }, otherRoom), true);
  await a.evaluate(() => window.releaseNative());
  assert.deepEqual(await Promise.all([a.evaluate(() => window.pendingPush), b.evaluate(() => window.pendingPush)]), [true, true]);
  const older = (await pushes(a)).at(-1), newer = (await pushes(b)).at(-1);
  assert.equal(older.endpoint, e2.endpoint);
  assert.notEqual(newer.endpoint, older.endpoint);
  assert.ok(newer.sequence > older.sequence);
  assert.equal((await subscription(b, scope)).endpoint, newer.endpoint);
  checks.push('a delayed older native read holds the real cross-page lock through signing; newer rotation/signing waits and receives the higher sequence, while a sibling room proceeds');

  const count = (await pushes(a)).length;
  await a.evaluate((scope) => {
    localStorage.setItem('push-fixture:fail', JSON.stringify(scope));
    window.manager.retryAll();
  }, scope);
  await a.waitForFunction(() => window.manager.pushStatus(window.pushEntry.room, window.pushEntry.vapid) === 'failed');
  assert.equal((await pushes(a)).length, count);
  await a.evaluate(() => localStorage.removeItem('push-fixture:fail'));
  assert.equal(await reconcile(a), true);
  checks.push('native reconciliation failure on reconnect emits no signed fallback and reports failed; a later retry reads and delivers the current subscription');

  const stale = await context.newPage();
  await stale.goto(h.origin + '/__recovery/blank');
  await setupManager(stale, entry);
  await readyManager(stale);
  assert.equal(await reconcile(stale), true);
  const beforeStale = (await pushes(stale)).length;
  await a.evaluate(() => {
    window.holdNative = true;
    window.pendingPush = window.manager.reconcilePushSubscription(window.pushEntry.room, window.pushEntry.vapid);
  });
  await a.waitForFunction(() => window.nativeHeld);
  const beforeForget = (await pushes(a)).length;
  await b.evaluate(() => {
    // The OTHER live manager forgets the pairing. A still has its own entry,
    // retry intent and signer, so local generation checks cannot detect this.
    window.pendingForget = window.manager.remove(window.pushEntry.room);
  });
  await b.waitForFunction(async () => (await navigator.locks.query()).pending.some((lock) => lock.name === `aah:push:${window.pushEntry.room}`));
  assert.ok(await subscription(b, scope));
  await a.evaluate(() => window.releaseNative());
  assert.equal(await a.evaluate(() => window.pendingPush), false);
  await b.evaluate(() => window.pendingForget);
  assert.equal((await pushes(a)).length, beforeForget);
  assert.equal(Boolean(await subscription(b, scope)), false);
  assert.equal(await b.evaluate(async (scope) => (await navigator.serviceWorker.getRegistrations()).some((r) => r.scope === scope), scope), false);
  assert.ok(await subscription(b, `${h.origin}/app/_push/${otherRoom}/`));
  // This peer has not attempted a write since Forget: its in-memory pairing
  // and retry intent remain live, so only a durable validity read can stop it.
  assert.equal(await stale.evaluate(() => window.manager.activeState().paired), true);
  await stale.evaluate(() => window.manager.retryAll());
  await stale.waitForFunction(() => window.manager.pushStatus(window.pushEntry.room, window.pushEntry.vapid) === 'failed');
  assert.equal(await reconcile(stale), false);
  assert.equal((await pushes(stale)).length, beforeStale);
  assert.equal(Boolean(await subscription(b, scope)), false);
  assert.equal(await b.evaluate(async (scope) => (await navigator.serviceWorker.getRegistrations()).some((r) => r.scope === scope), scope), false);
  checks.push('a different live manager forgets while A is held; cleanup waits, then stale A cannot sign or recreate the removed registration and the sibling remains');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: checks.length, checks, limits: [
    'Push provider is deterministic and restored manager transports are captured locally; no external push is sent. Actual APNs/FCM and locked iPhone delivery remain device release checks.',
  ] }, null, 2));
} finally { await h.cleanup(); }
