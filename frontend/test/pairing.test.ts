// Unit test for the Pairing state machine: drive role-B Pairing against a
// scripted role-A peer (the agent) built from the real crypto Handshake, and
// assert it reaches "paired" with a session key that matches the peer's.

import { describe, expect, it } from 'vitest';

import { Handshake } from '../src/lib/crypto.ts';
import { Pairing, type PairingSend } from '../src/lib/pairing.ts';

const b64 = {
  encode(bytes: Uint8Array): string {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  },
  decode(s: string): Uint8Array {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  },
};
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

/** scriptedAgent is a role-A peer: it starts, finishes on our pake, and exposes
 *  its pake + confirm so the test can hand them to the role-B Pairing. */
function scriptedAgent(code: string) {
  const a = Handshake.newA(code);
  const pake = a.start();
  return {
    pakeB64: b64.encode(pake),
    finish(peerPakeB64: string) {
      const res = a.finish(b64.decode(peerPakeB64));
      return { confirmB64: b64.encode(res.confirm), sessionKey: res.sessionKey };
    },
    verify(peerConfirmB64: string) {
      return a.confirmPeer(b64.decode(peerConfirmB64));
    },
  };
}

describe('Pairing (role B) against a scripted agent', () => {
  it('reaches paired with the matching session key', () => {
    const code = 'TST-CODE';
    const agent = scriptedAgent(code);

    const outbound: { pake: string[]; confirm: string[] } = { pake: [], confirm: [] };
    const send: PairingSend = {
      sendPake: (b) => (outbound.pake.push(b), true),
      sendConfirm: (b) => (outbound.confirm.push(b), true),
    };

    let pairedKey: Uint8Array | null = null;
    const phases: string[] = [];
    const pairing = new Pairing(code, send, {
      onPhase: (p) => phases.push(p),
      onPaired: (k) => (pairedKey = k),
    });

    // 1. phone starts -> sends its pake.
    pairing.start();
    expect(pairing.currentPhase()).toBe('awaiting_peer_pake');
    expect(outbound.pake).toHaveLength(1);

    // 2. agent receives phone pake, finishes, sends its pake + confirm.
    const agentRes = agent.finish(outbound.pake[0]!);

    // 3. phone receives agent pake -> finishes -> sends confirm.
    pairing.onPeerPake(agent.pakeB64);
    expect(pairing.currentPhase()).toBe('awaiting_peer_confirm');
    expect(outbound.confirm).toHaveLength(1);

    // 4. cross-verify confirms; phone verifies agent confirm -> paired.
    expect(agent.verify(outbound.confirm[0]!)).toBe(true);
    pairing.onPeerConfirm(agentRes.confirmB64);

    expect(pairing.currentPhase()).toBe('paired');
    expect(pairedKey).not.toBeNull();
    expect(hex(pairedKey!)).toBe(hex(agentRes.sessionKey));
    expect(phases).toContain('paired');
  });

  it('buffers a peer confirm that races ahead of our finish', () => {
    const code = 'RACE-1';
    const agent = scriptedAgent(code);
    const outbound: { pake: string[]; confirm: string[] } = { pake: [], confirm: [] };
    const pairing = new Pairing(
      code,
      { sendPake: (b) => (outbound.pake.push(b), true), sendConfirm: (b) => (outbound.confirm.push(b), true) },
      {},
    );
    pairing.start();
    const agentRes = agent.finish(outbound.pake[0]!);

    // Confirm arrives BEFORE we process the agent's pake.
    pairing.onPeerConfirm(agentRes.confirmB64);
    expect(pairing.currentPhase()).toBe('awaiting_peer_pake');
    // Now the pake arrives; the buffered confirm is verified and we pair.
    pairing.onPeerPake(agent.pakeB64);
    expect(pairing.currentPhase()).toBe('paired');
  });

  it('fails on a confirmation mismatch (wrong code / MITM)', () => {
    const agent = scriptedAgent('RIGHT');
    const outbound: { pake: string[]; confirm: string[] } = { pake: [], confirm: [] };
    let err: Error | null = null;
    const pairing = new Pairing(
      'WRONG', // phone has the wrong code
      { sendPake: (b) => (outbound.pake.push(b), true), sendConfirm: (b) => (outbound.confirm.push(b), true) },
      { onError: (e) => (err = e) },
    );
    pairing.start();
    const agentRes = agent.finish(outbound.pake[0]!);
    pairing.onPeerPake(agent.pakeB64);
    pairing.onPeerConfirm(agentRes.confirmB64);

    expect(pairing.currentPhase()).toBe('failed');
    expect(err).not.toBeNull();
    expect((err as unknown as Error).message).toMatch(/mismatch/);
  });

  it('fails on an invalid peer pake element', () => {
    let err: Error | null = null;
    const pairing = new Pairing(
      'CODE',
      { sendPake: () => true, sendConfirm: () => true },
      { onError: (e) => (err = e) },
    );
    pairing.start();
    // All-0xFF is not a canonical ristretto255 encoding -> fromBytes throws.
    pairing.onPeerPake(b64.encode(new Uint8Array(32).fill(0xff)));
    expect(pairing.currentPhase()).toBe('failed');
    expect(err).not.toBeNull();
  });
});
