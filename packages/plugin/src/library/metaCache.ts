/** Device-local cache of book metadata + cover thumbnails for the Library (IndexedDB, never synced). */
export interface CachedMeta { key: string; title?: string; author?: string; cover?: Blob | null; pages?: number; at: number }

const DB = 'octavo-meta', STORE = 'meta'
let dbp: Promise<IDBDatabase> | null = null
function db(): Promise<IDBDatabase> {
  return (dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'key' })
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'))
  }))
}
const run = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
  const d = await db()
  return new Promise((resolve, reject) => {
    const r = fn(d.transaction(STORE, mode).objectStore(STORE))
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'))
  })
}
export const metaKey = (path: string, mtime: number, size: number) => `${path}|${mtime}|${size}`
export const metaCache = {
  get: (key: string) => run('readonly', s => s.get(key) as IDBRequest<CachedMeta | undefined>),
  put: (m: CachedMeta) => run('readwrite', s => s.put(m)),
}
