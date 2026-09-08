// Per-pair anti-rollback state. IndexedDB readwrite transactions serialize
// allocation across tabs; whole-roster localStorage snapshots are not trusted
// to preserve counters. This store contains only public hashes and counters.
import { canonicalBase64, hash, pairBinding } from './protocol.ts';

export interface ProtocolLedger {
  observeRequest(sequence: number, digest: string): Promise<boolean>;
  currentRequest(sequence: number, digest: string): Promise<boolean>;
  nextPush(): Promise<number>;
  currentPush(sequence: number): Promise<boolean>;
  forget(): Promise<void>;
}
export type ProtocolLedgerLoader = (
  scope: string,
  restored: boolean,
) => Promise<ProtocolLedger>;
export const protocolScope = (
  room: string,
  agent: string,
  phone: string,
): string => hash(pairBinding(room, agent, phone));
interface RecordState {
  request: number;
  digest: string;
  push: number;
}
const DB = 'aah:protocol:v2';
const STORE = 'pairings';
const MAX_PAIRINGS = 256;
const missing = () =>
  new Error(
    'Pairing sequence storage is missing or unavailable. Re-pair this agent.',
  );
function valid(s: RecordState): boolean {
  return (
    !!s &&
    Number.isSafeInteger(s.request) &&
    s.request >= 0 &&
    Number.isSafeInteger(s.push) &&
    s.push >= 0 &&
    (s.request === 0 ? s.digest === '' : canonicalBase64(s.digest, 32))
  );
}
function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(missing());
    }, 5000);
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onerror = () => {
      clearTimeout(timer);
      settled = true;
      reject(missing());
    };
    request.onblocked = () => {
      clearTimeout(timer);
      settled = true;
      reject(missing());
    };
    request.onsuccess = () => {
      clearTimeout(timer);
      if (settled) request.result.close();
      else {
        settled = true;
        resolve(request.result);
      }
    };
  });
}
// No asynchronous work occurs inside the transaction: read/compare/write is
// one atomic operation and resolves only after the browser reports its transaction committed.
async function transaction<T>(
  scope: string,
  op: (
    store: IDBObjectStore,
    record: RecordState | undefined,
    finish: (value: T) => void,
  ) => void,
): Promise<T> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    let result: T;
    const store = tx.objectStore(STORE);
    const timer = setTimeout(() => {
      try {
        tx.abort();
      } catch {
        /* already completed */
      }
      db.close();
      reject(missing());
    }, 5000);
    tx.oncomplete = () => {
      clearTimeout(timer);
      db.close();
      resolve(result);
    };
    tx.onabort = tx.onerror = () => {
      clearTimeout(timer);
      db.close();
      reject(missing());
    };
    const request = store.get(scope);
    request.onsuccess = () => {
      try {
        op(store, request.result as RecordState | undefined, (value) => {
          result = value;
        });
      } catch {
        tx.abort();
      }
    };
  });
}
export const loadProtocolLedger: ProtocolLedgerLoader = async (
  scope,
  restored,
) => {
  await transaction<void>(scope, (store, record, finish) => {
    if (record !== undefined) {
      if (!valid(record)) throw missing();
      finish();
      return;
    }
    if (restored) throw missing();
    const count = store.count();
    count.onsuccess = () => {
      if (count.result >= MAX_PAIRINGS) {
        store.transaction.abort();
        return;
      }
      store.put({ request: 0, digest: '', push: 0 }, scope);
      finish();
    };
  });
  const read = <T>(fn: (s: RecordState) => T): Promise<T> =>
    transaction<T>(scope, (store, record, finish) => {
      if (!record || !valid(record)) throw missing();
      const result = fn(record);
      store.put(record, scope);
      finish(result);
    });
  return {
    observeRequest: (sequence, digest) =>
      read((s) => {
        if (
          !Number.isSafeInteger(sequence) ||
          sequence <= 0 ||
          !canonicalBase64(digest, 32)
        )
          throw missing();
        if (
          sequence < s.request ||
          (sequence === s.request && digest !== s.digest)
        )
          return false;
        s.request = sequence;
        s.digest = digest;
        return true;
      }),
    currentRequest: (sequence, digest) =>
      read((s) => sequence === s.request && digest === s.digest),
    nextPush: () =>
      read((s) => {
        if (s.push >= Number.MAX_SAFE_INTEGER) throw missing();
        return ++s.push;
      }),
    currentPush: (sequence) => read((s) => s.push === sequence),
    forget: () =>
      transaction<void>(scope, (store, _record, finish) => {
        store.delete(scope);
        finish();
      }),
  };
};
