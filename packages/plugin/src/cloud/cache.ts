/** Device-local book cache (IndexedDB). Never synced; can always be rebuilt from the cloud. */
const DB = 'octavo-cache', STORE = 'books'

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' })
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

interface Entry { id: string; blob: Blob; size: number; opened: number }

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open()
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode)
    const r = fn(t.objectStore(STORE))
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  }).finally(() => db.close()) as Promise<T>
}

export const bookCache = {
  async get(id: string): Promise<Blob | null> {
    const e = await tx<Entry | undefined>('readonly', s => s.get(id))
    if (!e) return null
    void tx('readwrite', s => s.put({ ...e, opened: Date.now() }))
    return e.blob
  },
  async put(id: string, blob: Blob, capBytes = 2 * 1024 ** 3): Promise<void> {
    await tx('readwrite', s => s.put({ id, blob, size: blob.size, opened: Date.now() } satisfies Entry))
    const all = await tx<Entry[]>('readonly', s => s.getAll())
    let total = all.reduce((a, e) => a + e.size, 0)
    for (const e of all.sort((a, b) => a.opened - b.opened)) {
      if (total <= capBytes) break
      if (e.id === id) continue
      await tx('readwrite', s => s.delete(e.id))
      total -= e.size
    }
  },
  async usage(): Promise<{ count: number; bytes: number }> {
    const all = await tx<Entry[]>('readonly', s => s.getAll())
    return { count: all.length, bytes: all.reduce((a, e) => a + e.size, 0) }
  },
  async clear(): Promise<void> { await tx('readwrite', s => s.clear()) },
}
