// Unit tests for the per-device signing key. The vitest/node env provides
// crypto.subtle but NO indexedDB, so loadOrCreateDeviceKey returns null (compat
// path); the wire-critical raw-64 sign path is exercised directly via
// signMessage + crypto.subtle.verify. The Go interop vector
// (backend/pkg/wire TestDeviceSigInteropVector) proves the cross-language leg.

import { describe, expect, it } from 'vitest';

import { b64Decode } from '../src/lib/b64.ts';
import { loadOrCreateDeviceKey, signMessage } from '../src/lib/devicekey.ts';
import { decisionSigningMessage } from '../src/lib/wire.ts';

describe('device signing key', () => {
  it('returns null when IndexedDB is unavailable (compat fallback)', async () => {
    // Node has crypto.subtle but no indexedDB: the phone must degrade to
    // unsigned decisions rather than throwing.
    expect(typeof indexedDB).toBe('undefined');
    expect(await loadOrCreateDeviceKey()).toBeNull();
  });

  it('signs the canonical message as raw-64 r||s that WebCrypto verifies', async () => {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    const msg = decisionSigningMessage('0123456789abcdef', 'req_1', { approved: true });

    const sigB64 = await signMessage(kp.privateKey, msg);
    const sig = b64Decode(sigB64);
    expect(sig.length).toBe(64); // raw IEEE-P1363 r||s, not DER

    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, kp.publicKey, sig, msg);
    expect(ok).toBe(true);

    // A one-bit tamper must fail to verify.
    sig[0] ^= 0x01;
    const bad = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, kp.publicKey, sig, msg);
    expect(bad).toBe(false);
  });
});
