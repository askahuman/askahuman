// devicekey owns ONE per-origin ECDSA P-256 signing keypair, used to sign every
// decision so a stolen (copyable) session key cannot forge an approval. The
// PRIVATE key is generated non-extractable and lives in IndexedDB via structured
// clone — usable for signing across page reloads, never readable or copyable.
// Only the PUBLIC key (SPKI) ever crosses the wire. Best-effort and never throws
// to the caller: a browser without WebCrypto or IndexedDB yields null and the
// phone falls back to unsigned decisions (compat). Styled after sw.ts's
// openBadgeDB IndexedDB helper and push.ts's best-effort tone.
//
// Residual risk (see docs/decisions/architecture/0021): same-origin XSS on the
// live unlocked device can still USE (not read/copy) the non-extractable key in
// place. The win is turning "copy a string, forge anywhere, forever" into "must
// run code on the victim's unlocked device."

import { b64Encode } from './b64.ts';

const DB = 'aah-devicekey';
const STORE = 'kv';
const KEY = 'ecdsa-p256';

/** StoredKey is the IndexedDB record: the non-extractable private CryptoKey plus
 *  the base64 SPKI of its public half (cached so we needn't re-export on load). */
interface StoredKey {
  priv: CryptoKey;
  spki: string;
}

/** DeviceKey is this origin's signer: its public SPKI (base64) for the agent and
 *  a sign() over the canonical decision message (base64 raw r||s, 64 bytes). The
 *  message is Uint8Array<ArrayBuffer> so it satisfies crypto.subtle's
 *  BufferSource (a plain Uint8Array is typed over ArrayBufferLike). */
export interface DeviceKey {
  spkiB64: string;
  sign(msg: Uint8Array<ArrayBuffer>): Promise<string>;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function readKey(db: IDBDatabase): Promise<StoredKey | undefined> {
  return new Promise((resolve, reject) => {
    const r = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
    r.onsuccess = () => resolve(r.result as StoredKey | undefined);
    r.onerror = () => reject(r.error);
  });
}

function writeKey(db: IDBDatabase, value: StoredKey): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * signMessage signs msg with priv and returns base64 of the raw IEEE-P1363 r||s
 * (64 bytes for P-256) — the exact form the agent's ecdsa.Verify expects (NOT
 * DER). Exported so a unit test can exercise this wire-critical raw-64 encoding
 * without needing IndexedDB; DeviceKey.sign delegates to it.
 */
export async function signMessage(priv: CryptoKey, msg: Uint8Array<ArrayBuffer>): Promise<string> {
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, priv, msg);
  return b64Encode(new Uint8Array(sig));
}

/**
 * loadOrCreateDeviceKey returns this origin's device signer, creating and
 * persisting one on first use. Returns null (never throws) when WebCrypto or
 * IndexedDB is unavailable, so the phone degrades to unsigned decisions (compat).
 * The private key is generated non-extractable; per the WebCrypto spec the public
 * half is always exportable, so exportKey('spki', publicKey) works while the
 * private key can never be exported.
 */
export async function loadOrCreateDeviceKey(): Promise<DeviceKey | null> {
  try {
    if (typeof indexedDB === 'undefined') return null;
    if (typeof crypto === 'undefined' || !crypto.subtle) return null;

    const db = await openDB();
    const existing = await readKey(db);
    if (existing) return signerFrom(existing);

    const kp = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      false, // non-extractable: the private key can never be read/copied.
      ['sign', 'verify'],
    );
    const spkiBuf = await crypto.subtle.exportKey('spki', kp.publicKey);
    const stored: StoredKey = { priv: kp.privateKey, spki: b64Encode(new Uint8Array(spkiBuf)) };
    await writeKey(db, stored);
    return signerFrom(stored);
  } catch {
    return null; // best-effort: never break decisions over a storage/crypto fault.
  }
}

/** signerFrom wraps a StoredKey as a DeviceKey. */
function signerFrom(s: StoredKey): DeviceKey {
  return { spkiB64: s.spki, sign: (msg) => signMessage(s.priv, msg) };
}
