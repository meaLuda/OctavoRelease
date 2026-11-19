/** Device-local book cache (IndexedDB). Never synced; can always be rebuilt from the cloud. */
const DB = 'octavo-cache', STORE = 'books'

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' })
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'))
  })
}

interface Entry { id: string; blob: Blob; size: number; opened: number }

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open()
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode)
    const r = fn(t.objectStore(STORE))
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'))
  }).finally(() => db.close()) as Promise<T>
}

export const bookCache = {
  async get(id: string): Promise<Blob | null> {
    // private mode or blocked storage: no cache, the book is downloaded instead
    const e = await tx('readonly', s => s.get(id) as IDBRequest<Entry | undefined>).catch(() => undefined)
    if (!e) return null
    void tx('readwrite', s => s.put({ ...e, opened: Date.now() }))
    return e.blob
  },
  /**
   * Keep a copy on this device. Room is made first (oldest opened go), and when the device's own storage limit is lower
   * than the cap (iOS) a failed save empties the rest of the cache and tries once more. A copy that still cannot be kept
   * is not an error: the book opens anyway and is downloaded again next time.
   */
  async put(id: string, blob: Blob, capBytes = 2 * 1024 ** 3): Promise<boolean> {
    const save = () => tx('readwrite', s => s.put({ id, blob, size: blob.size, opened: Date.now() } satisfies Entry))
    try {
      const all = (await tx('readonly', s => s.getAll() as IDBRequest<Entry[]>)).filter(e => e.id !== id)
      let total = all.reduce((a, e) => a + e.size, 0) + blob.size
      for (const e of all.sort((a, b) => a.opened - b.opened)) {
        if (total <= capBytes) break
        await tx('readwrite', s => s.delete(e.id))
        total -= e.size
      }
      try { await save() } catch {
        for (const e of all) await tx('readwrite', s => s.delete(e.id)).catch(() => {})
        await save()
      }
      return true
    } catch (e) { console.warn('Octavo: could not keep a cloud book on this device', e); return false }
  },
  async usage(): Promise<{ count: number; bytes: number }> {
    const all = await tx('readonly', s => s.getAll() as IDBRequest<Entry[]>)
    return { count: all.length, bytes: all.reduce((a, e) => a + e.size, 0) }
  },
  async remove(id: string): Promise<void> { await tx('readwrite', s => s.delete(id)).catch(() => {}) },
  async clear(): Promise<void> { await tx('readwrite', s => s.clear()) },
}
