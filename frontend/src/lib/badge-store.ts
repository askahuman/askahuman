// Read and update in one transaction: different room workers can receive a
// push concurrently, and a separate read/write pair would lose increments.
export async function updateBadgeCount(value: number | 'increment'): Promise<number | null> {
  if (value !== 'increment' && (!Number.isSafeInteger(value) || value < 0)) return null;
  let db: IDBDatabase | undefined;
  try {
    db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('aah-badge', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return await new Promise<number>((resolve, reject) => {
      const tx = db!.transaction('kv', 'readwrite');
      const store = tx.objectStore('kv');
      const req = store.get('count');
      let count = 0;
      req.onsuccess = () => {
        const previous = Number.isSafeInteger(req.result) && req.result >= 0 ? req.result : 0;
        count = value === 'increment' ? Math.min(previous + 1, Number.MAX_SAFE_INTEGER) : value;
        store.put(count, 'count');
      };
      tx.oncomplete = () => resolve(count);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  } catch {
    return null; // A storage failure must not suppress the visible notification.
  } finally {
    db?.close();
  }
}
