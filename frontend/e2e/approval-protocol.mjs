// Actual built PWA + real stdio MCP agent + relay, in an isolated mobile browser.
// The adversary receives only a COPY of the test session key, never either
// private signer. It tampers encrypted frames and tries to forge acceptance.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { setup, wait } from './recovery-harness.mjs';
import { open, seal } from '../src/lib/crypto.ts';
import { b64Decode, b64Encode } from '../src/lib/b64.ts';
import {
  decisionHash,
  ackSigningMessage,
  requestHash,
  MAX_PLAINTEXT,
} from '../src/lib/protocol.ts';

const h = await setup({ modules: { protocol: 'src/lib/protocol-state.ts' } });
const checks = [];
const options = {
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
};
const base = {
  title: 'Harmless protocol test',
  summary: 'Reply to this test only.',
  response_kind: 'yesno',
  expires_in_s: 15,
};
function result(message) {
  assert.equal(message.error, undefined);
  assert.notEqual(message.result?.isError, true);
  return JSON.parse(message.result.content.find((c) => c.type === 'text').text);
}
async function connect(clockOffset = 0) {
  const context = await h.browser.newContext(options),
    page = await context.newPage();
  page.setDefaultTimeout(10000);
  if (clockOffset)
    await page.addInitScript((offset) => {
      const realNow = Date.now.bind(Date);
      Date.now = () => realNow() + offset;
    }, clockOffset);
  await page.goto(h.origin + '/app/');
  const agent = await h.mcp('protocol-browser-test');
  await agent.tool('start_pairing');
  await page.getByTestId('code-input').fill(await agent.code());
  await page.getByTestId('code-submit').click();
  await page.waitForFunction(() => {
    const entry = JSON.parse(
      localStorage.getItem('aah:sessions:v1') || '[]',
    )[0];
    return entry?.protocol === 2 && entry.agentSigner && entry.deviceSigner;
  });
  const entry = await page.evaluate(
    () => JSON.parse(localStorage.getItem('aah:sessions:v1'))[0],
  );
  return { context, page, agent, entry, key: b64Decode(entry.key) };
}
async function snapshot(page, name) {
  if (!process.env.PROTOCOL_SHOTS) return;
  await mkdir(process.env.PROTOCOL_SHOTS, { recursive: true });
  await page.screenshot({
    path: path.join(
      process.env.PROTOCOL_SHOTS,
      `${process.env.RECOVERY_BROWSER || 'chromium'}-${name}.png`,
    ),
  });
}
function transformBox(key, raw, fn) {
  const frame = JSON.parse(raw);
  if (!frame.box) return raw;
  try {
    const value = JSON.parse(new TextDecoder().decode(open(key, frame.box)));
    const next = fn(value);
    if (next === null) return null;
    return JSON.stringify({
      box: seal(key, new TextEncoder().encode(JSON.stringify(next))),
    });
  } catch {
    return raw;
  }
}
try {
  {
    const p = await connect();
    let changed = 0;
    h.transformAgentFrames((raw) =>
      transformBox(p.key, raw, (m) => {
        if (m.kind === 'request') {
          changed++;
          return {
            ...m,
            title: 'FORGED QUESTION',
            summary: 'Approve a different action',
          };
        }
        return m;
      }),
    );
    const response = p.agent.tool('request_approval', base);
    await wait(700);
    assert.ok(changed);
    assert.equal(
      await p.page.getByTestId('yesno-card').count(),
      0,
      'copied symmetric key cannot change the displayed signed question',
    );
    h.transformAgentFrames((raw) => raw);
    h.cutAgent();
    await p.page.getByTestId('yesno-card').waitFor();
    assert.match(
      await p.page.getByTestId('yesno-card').innerText(),
      /Harmless protocol test/,
    );
    await p.page.getByTestId('decline-button').click();
    assert.equal(result(await response).approved, false);
    await p.page.getByTestId('confirmed-screen').waitFor();
    assert.match(
      await p.page.locator('body').innerText(),
      /Answer received by agent/,
    );
    await snapshot(p.page, 'verified-decline');
    checks.push(
      'copied-key question substitution stays invisible; original signed question and declined MCP result recover',
    );
    p.agent.kill();
    await p.context.close();
  }
  {
    const p = await connect();
    let dropped = 0;
    h.transformAgentFrames((raw) =>
      transformBox(p.key, raw, (m) => {
        if (m.kind === 'ack') {
          dropped++;
          return null;
        }
        return m;
      }),
    );
    const response = p.agent.tool('request_approval', {
      ...base,
      expires_in_s: 2,
    });
    await p.page.getByTestId('yesno-card').waitFor();
    await p.page.getByTestId('approve-button').click();
    assert.equal(result(await response).approved, true);
    await p.page.getByTestId('pending-screen').waitFor();
    assert.equal(await p.page.getByTestId('confirmed-screen').count(), 0);
    await wait(100);
    assert.ok(dropped);
    const pending = await p.page.evaluate(
      () =>
        Object.values(
          JSON.parse(localStorage.getItem('aah:sessions:v1'))[0].decisions,
        )[0],
    );
    const attacker = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign', 'verify'],
    );
    const ack = {
      kind: 'ack',
      protocol: 2,
      room: p.entry.room,
      id: pending.id,
      request_hash: pending.request_hash,
      decision_hash: decisionHash(pending),
      status: 'accepted',
      sig: '',
    };
    ack.sig = b64Encode(
      new Uint8Array(
        await crypto.subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' },
          attacker.privateKey,
          ackSigningMessage(ack),
        ),
      ),
    );
    h.injectToPhone(
      JSON.stringify({
        box: seal(p.key, new TextEncoder().encode(JSON.stringify(ack))),
      }),
    );
    await wait(200);
    assert.equal(
      await p.page.getByTestId('confirmed-screen').count(),
      0,
      'attacker-signed receipt cannot claim acceptance',
    );
    await p.page.reload();
    await p.page.getByTestId('pending-screen').waitFor();
    await wait(2100);
    assert.equal(await p.page.getByTestId('confirmed-screen').count(), 0);
    await snapshot(p.page, 'receipt-uncertain-after-reload');
    h.transformAgentFrames((raw) => raw);
    await p.page.getByTestId('receipt-retry').click();
    await p.page.getByTestId('confirmed-screen').waitFor();
    assert.match(
      await p.page.locator('body').innerText(),
      /Answer received by agent/,
    );
    checks.push(
      'MCP commits without waiting for ack; forged receipt fails; lost ack stays uncertain across expiry/reload; exact retry recovers prior acceptance',
    );
    p.agent.kill();
    await p.context.close();
  }
  {
    const p = await connect();
    let tampered = 0;
    h.transformPhoneFrames((raw) =>
      transformBox(p.key, raw, (m) => {
        if (m.kind === 'decision') {
          tampered++;
          return {
            ...m,
            result: { ...m.result, text: 'unsigned injected instruction' },
          };
        }
        return m;
      }),
    );
    const response = p.agent.tool('request_approval', {
      ...base,
      expires_in_s: 2,
    });
    await p.page.getByTestId('yesno-card').waitFor();
    await p.page.getByTestId('decline-button').click();
    const outcome = await response;
    assert.equal(outcome.result?.isError, true);
    assert.match(JSON.stringify(outcome), /timed out/);
    assert.ok(tampered);
    assert.equal(await p.page.getByTestId('confirmed-screen').count(), 0);
    h.transformPhoneFrames((raw) => raw);
    checks.push(
      'unsigned extra result field is rejected by real MCP and never produces phone success',
    );
    p.agent.kill();
    await p.context.close();
  }
  {
    const p = await connect();
    for (const [text, limit] of [
      ['😀😀😀', 3],
      ['  🧭  ', 5],
      ['', 4096],
    ]) {
      const response = p.agent.tool('request_approval', {
        ...base,
        response_kind: 'text',
        max_len: limit,
      });
      await p.page.getByTestId('text-input').waitFor();
      await p.page.getByTestId('text-input').fill(text);
      await p.page.getByTestId('text-send').click();
      assert.equal(result(await response).text, text);
      await p.page.getByTestId('confirmed-screen').waitFor();
    }
    for (const [unit, name] of [
      ['😀', 'unicode'],
      ['\u0001', 'control'],
    ]) {
      const response = p.agent.tool('request_approval', {
        ...base,
        response_kind: 'text',
        max_len: 4096,
      });
      await p.page.getByTestId('text-input').waitFor();
      const oversized = unit.repeat(4096);
      await p.page.getByTestId('text-input').fill(oversized);
      await p.page.getByTestId('text-send').click();
      await p.page
        .getByRole('alert')
        .filter({ hasText: 'too large' })
        .waitFor();
      assert.equal(
        await p.page.getByTestId('text-input').inputValue(),
        oversized,
      );
      assert.equal(await p.page.getByTestId('pending-screen').count(), 0);
      const saved = await p.page.evaluate(
        () => JSON.parse(localStorage.getItem('aah:sessions:v1'))[0],
      );
      assert.equal(
        Object.values(saved.decisions).some((d) => d.id === saved.request.id),
        false,
      );
      await snapshot(p.page, `${name}-size-feedback`);
      // Exercise the exact last encodable byte through the real UI, signature,
      // relay limit and Go decoder, for both UTF-8 and escaped control scalars.
      const d = {
        kind: 'decision',
        protocol: 2,
        room: p.entry.room,
        id: saved.request.id,
        request_hash: requestHash(saved.request),
        response_kind: 'text',
        result: { text: '' },
        sig: 'A'.repeat(88),
      };
      const utf8 = (v) => new TextEncoder().encode(v).length;
      const budget = MAX_PLAINTEXT - 1 - utf8(JSON.stringify(d)),
        cost = utf8(JSON.stringify(unit)) - 2;
      const boundary =
        unit.repeat(Math.floor(budget / cost)) + 'a'.repeat(budget % cost);
      d.result.text = boundary;
      assert.equal(utf8(JSON.stringify(d)), MAX_PLAINTEXT - 1);
      await p.page.getByTestId('text-input').fill(boundary + 'a');
      await p.page.getByTestId('text-send').click();
      await p.page
        .getByRole('alert')
        .filter({ hasText: 'too large' })
        .waitFor();
      assert.equal(await p.page.getByTestId('pending-screen').count(), 0);
      await p.page.getByTestId('text-input').fill(boundary);
      await p.page.getByTestId('text-send').click();
      assert.equal(result(await response).text, boundary);
      await p.page.getByTestId('confirmed-screen').waitFor();
    }
    checks.push(
      'actual mobile controls preserve scalar limits, whitespace and empty replies; oversized four-byte and control-escaped text stays editable/unsent; exact 16 KiB boundary succeeds and one extra byte fails',
    );
    p.agent.kill();
    await p.context.close();
  }
  {
    const p = await connect();
    let oldFrame, oldRequest, currentFrame;
    h.transformAgentFrames((raw) =>
      transformBox(p.key, raw, (m) => {
        if (m.kind === 'request' && m.title === 'Older hidden question') {
          oldFrame = raw;
          oldRequest = m;
          return null;
        }
        if (m.kind === 'request') currentFrame = raw;
        return m;
      }),
    );
    const oldOutcome = await p.agent.tool('request_approval', {
      ...base,
      title: 'Older hidden question',
      expires_in_s: 1,
    });
    assert.equal(oldOutcome.result?.isError, true);
    assert.ok(oldFrame);
    const response = p.agent.tool('request_approval', {
      ...base,
      title: 'Current authenticated question',
      expires_in_s: 30,
    });
    await p.page.getByTestId('yesno-card').waitFor();
    h.injectToPhone(oldFrame);
    await wait(150);
    assert.match(
      await p.page.getByTestId('yesno-card').innerText(),
      /Current authenticated question/,
    );
    h.transformAgentFrames((raw) =>
      transformBox(p.key, raw, (m) => (m.kind === 'request' ? null : m)),
    );
    await p.page.evaluate((old) => {
      const entries = JSON.parse(localStorage.getItem('aah:sessions:v1'));
      entries[0].request = old;
      entries[0].seen = [];
      localStorage.setItem('aah:sessions:v1', JSON.stringify(entries));
    }, oldRequest);
    await p.page.reload();
    await p.page.getByTestId('listening-badge').waitFor();
    h.injectToPhone(oldFrame);
    await wait(150);
    assert.equal(await p.page.getByTestId('yesno-card').count(), 0);
    h.injectToPhone(currentFrame);
    await p.page.getByTestId('yesno-card').waitFor();
    assert.match(
      await p.page.getByTestId('yesno-card').innerText(),
      /Current authenticated question/,
    );
    h.transformAgentFrames((raw) => raw);
    await p.page.getByTestId('decline-button').click();
    assert.equal(result(await response).approved, false);
    await p.page.getByTestId('confirmed-screen').waitFor();
    checks.push(
      'recorded unseen older request cannot displace current card; stale roster reload obeys durable sequence high-water; identical current reannouncement remains answerable',
    );
    p.agent.kill();
    await p.context.close();
  }
  {
    const p = await connect();
    const scopeArgs = {
      room: p.entry.room,
      agent: p.entry.agentSigner,
      phone: p.entry.deviceSigner,
    };
    const pages = await Promise.all(
      Array.from({ length: 4 }, () => p.context.newPage()),
    );
    await Promise.all(
      pages.map((page) => page.goto(h.origin + '/__recovery/blank')),
    );
    const allocations = (
      await Promise.all(
        pages.map((page) =>
          page.evaluate(async ({ room, agent, phone }) => {
            const { loadProtocolLedger, protocolScope } =
              await import('/__recovery/protocol.js');
            const ledger = await loadProtocolLedger(
              protocolScope(room, agent, phone),
              true,
            );
            return Promise.all(
              Array.from({ length: 16 }, () => ledger.nextPush()),
            );
          }, scopeArgs),
        ),
      )
    )
      .flat()
      .sort((a, b) => a - b);
    assert.equal(new Set(allocations).size, 64);
    assert.ok(allocations.every((n, i) => n === allocations[0] + i));
    const latest = allocations.at(-1);
    const verified = await pages[0].evaluate(
      async ({ room, agent, phone, latest }) => {
        const { loadProtocolLedger, protocolScope } =
          await import('/__recovery/protocol.js');
        // Reopening as fresh cannot reset an existing counter either.
        const ledger = await loadProtocolLedger(
          protocolScope(room, agent, phone),
          false,
        );
        return {
          current: await ledger.currentPush(latest),
          old: await ledger.currentPush(latest - 1),
          next: await ledger.nextPush(),
        };
      },
      { ...scopeArgs, latest },
    );
    assert.deepEqual(verified, { current: true, old: false, next: latest + 1 });
    await p.page.reload();
    await p.page.getByTestId('listening-badge').waitFor();
    const next = await pages[1].evaluate(async ({ room, agent, phone }) => {
      const { loadProtocolLedger, protocolScope } =
        await import('/__recovery/protocol.js');
      return (
        await loadProtocolLedger(protocolScope(room, agent, phone), true)
      ).nextPush();
    }, scopeArgs);
    assert.equal(next, latest + 2);
    // Simulate lost protocol storage independently of the pinned signing key:
    // restoration must explain repair and must not open an authorization card.
    await pages[0].evaluate(async ({ room, agent, phone }) => {
      const { loadProtocolLedger, protocolScope } =
        await import('/__recovery/protocol.js');
      await (
        await loadProtocolLedger(protocolScope(room, agent, phone), true)
      ).forget();
    }, scopeArgs);
    await p.page.reload();
    await p.page
      .getByRole('alert')
      .filter({ hasText: 'start_pairing with reset:true' })
      .waitFor();
    assert.equal(await p.page.getByTestId('yesno-card').count(), 0);
    assert.equal(
      await p.page.evaluate(
        () =>
          JSON.parse(localStorage.getItem('aah:sessions:v1'))[0].agentSigner,
      ),
      p.entry.agentSigner,
    );
    checks.push(
      '64 concurrent push reservations across four tabs are unique and contiguous; reload cannot reset counter; lost ledger fails closed with retained pairing repair guidance',
    );
    p.agent.kill();
    await p.context.close();
  }
  {
    // The production ledger is bounded; Forget reclaims a slot. It cannot wrap
    // its counter back to a replayable low value at the safe-integer boundary.
    const context = await h.browser.newContext(options),
      page = await context.newPage();
    await page.goto(h.origin + '/__recovery/blank');
    const result = await page.evaluate(async () => {
      const { loadProtocolLedger } = await import('/__recovery/protocol.js');
      let first;
      for (let i = 0; i < 256; i++) {
        const ledger = await loadProtocolLedger(`test-limit-${i}`, false);
        first ??= ledger;
      }
      let capped = false,
        missing = false,
        exhausted = false;
      try {
        await loadProtocolLedger('test-over-limit', false);
      } catch {
        capped = true;
      }
      await first.forget();
      try {
        await loadProtocolLedger('test-limit-0', true);
      } catch {
        missing = true;
      }
      const replacement = await loadProtocolLedger('test-over-limit', false);
      await new Promise((resolve, reject) => {
        const open = indexedDB.open('aah:protocol:v2', 1);
        open.onsuccess = () => {
          const db = open.result,
            tx = db.transaction('pairings', 'readwrite');
          tx.objectStore('pairings').put(
            { request: 0, digest: '', push: Number.MAX_SAFE_INTEGER },
            'test-over-limit',
          );
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onabort = () => {
            db.close();
            reject(tx.error);
          };
        };
        open.onerror = () => reject(open.error);
      });
      try {
        await replacement.nextPush();
      } catch {
        exhausted = true;
      }
      return {
        capped,
        missing,
        exhausted,
        retained: await replacement.currentPush(Number.MAX_SAFE_INTEGER),
      };
    });
    assert.deepEqual(result, {
      capped: true,
      missing: true,
      exhausted: true,
      retained: true,
    });
    checks.push(
      'protocol ledger bounds retained pairings, Forget reclaims storage, and exhausted sequence never wraps',
    );
    await context.close();
  }
  {
    // Install skew before Session snapshots its clock function.
    const p = await connect(-60000);
    // A phone clock behind the agent can keep the card locally visible. The
    // actual agent deadline still wins, even for an otherwise authentic answer.
    const response = p.agent.tool('request_approval', {
      ...base,
      expires_in_s: 2,
    });
    await p.page.getByTestId('yesno-card').waitFor();
    await wait(2200);
    await p.page.getByTestId('approve-button').click();
    const outcome = await response;
    assert.equal(outcome.result?.isError, true);
    assert.match(JSON.stringify(outcome), /timed out/);
    await p.page.getByTestId('pending-screen').waitFor();
    await wait(250);
    assert.equal(await p.page.getByTestId('confirmed-screen').count(), 0);
    checks.push(
      'phone clock skew cannot turn a post-deadline signed answer into agent acceptance or phone success',
    );
    p.agent.kill();
    await p.context.close();
  }
  console.log(
    JSON.stringify(
      {
        engine: process.env.RECOVERY_BROWSER || 'chromium',
        passed: checks.length,
        checks,
      },
      null,
      2,
    ),
  );
} finally {
  await h.cleanup();
}
