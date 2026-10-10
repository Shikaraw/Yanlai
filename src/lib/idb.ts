/**
 * Tiny promise wrapper over IndexedDB.
 *
 * Why not localStorage: chat history with base64 image attachments blows past
 * the ~5MB quota quickly, and losing the write is silent. IndexedDB has no such
 * practical ceiling and gives us real transactions.
 */

const DB_NAME = 'yanlai'
const DB_VERSION = 1

export const STORES = {
  kv: 'kv',
  chats: 'chats',
  wrongbook: 'wrongbook',
  flashcards: 'flashcards',
  kb: 'kb',
  chunks: 'chunks',
  stats: 'stats',
  artifacts: 'artifacts',
} as const

export type StoreName = (typeof STORES)[keyof typeof STORES]

let dbPromise: Promise<IDBDatabase> | null = null
let unavailable = false

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB unavailable'))
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      for (const s of Object.values(STORES)) {
        if (!db.objectStoreNames.contains(s)) {
          const keyPath = s === 'kv' ? 'key' : s === 'kb' ? 'id' : 'id'
          db.createObjectStore(s, { keyPath })
        }
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

async function tx<T>(store: StoreName, mode: IDBTransactionMode, fn: (os: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await open()
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(store, mode)
    const req = fn(t.objectStore(store))
    let result: T
    req.onsuccess = () => { result = req.result as T }
    t.oncomplete = () => resolve(result)
    req.onerror = () => reject(req.error)
    t.onerror = () => reject(t.error)
    t.onabort = () => reject(t.error)
  })
}

/* ---------------------------------------------------------------- */
/* graceful degradation: if IDB is blocked (private mode, etc.) fall */
/* back to in-memory maps so the app still runs for the session.     */
/* ---------------------------------------------------------------- */
const memFallback = new Map<string, Map<string, any>>()
function mem(store: StoreName) {
  if (!memFallback.has(store)) memFallback.set(store, new Map())
  return memFallback.get(store)!
}

export async function idbGet<T = any>(store: StoreName, id: string): Promise<T | undefined> {
  if (unavailable) return mem(store).get(id)
  try {
    return await tx<T>(store, 'readonly', (os) => os.get(id))
  } catch {
    unavailable = true
    return mem(store).get(id)
  }
}

export async function idbGetAll<T = any>(store: StoreName): Promise<T[]> {
  if (unavailable) return [...mem(store).values()]
  try {
    return (await tx<T[]>(store, 'readonly', (os) => os.getAll())) || []
  } catch {
    unavailable = true
    return [...mem(store).values()]
  }
}

export async function idbPut(store: StoreName, value: any, idOverride?: string): Promise<void> {
  const withKey = store === 'kv' ? value : { ...value, id: idOverride || value.id }
  if (unavailable) {
    mem(store).set(store === 'kv' ? withKey.key : withKey.id, withKey)
    return
  }
  try {
    await tx(store, 'readwrite', (os) => os.put(withKey))
  } catch {
    unavailable = true
    mem(store).set(store === 'kv' ? withKey.key : withKey.id, withKey)
  }
}

export async function idbPutMany(store: StoreName, values: any[]): Promise<void> {
  if (!values.length) return
  if (unavailable) {
    for (const v of values) mem(store).set(v.id, v)
    return
  }
  try {
    const db = await open()
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction(store, 'readwrite')
      const os = t.objectStore(store)
      for (const v of values) os.put(v)
      t.oncomplete = () => resolve()
      t.onerror = () => reject(t.error)
      t.onabort = () => reject(t.error)
    })
  } catch {
    unavailable = true
    for (const v of values) mem(store).set(v.id, v)
  }
}

export async function idbDel(store: StoreName, id: string): Promise<void> {
  if (unavailable) {
    mem(store).delete(id)
    return
  }
  try {
    await tx(store, 'readwrite', (os) => os.delete(id))
  } catch {
    mem(store).delete(id)
  }
}

export async function idbClear(store: StoreName): Promise<void> {
  if (unavailable) {
    mem(store).clear()
    return
  }
  try {
    await tx(store, 'readwrite', (os) => os.clear())
  } catch {
    mem(store).clear()
  }
}

export async function kvGet<T = any>(key: string, fallback?: T): Promise<T> {
  const row = await idbGet<{ key: string; value: T }>('kv', key)
  return row?.value ?? (fallback as T)
}

export async function kvSet(key: string, value: any): Promise<void> {
  await idbPut('kv', { key, value })
}

/** Rough storage estimate for the settings screen. */
export async function storageEstimate() {
  try {
    if (navigator.storage?.estimate) {
      const { usage = 0, quota = 0 } = await navigator.storage.estimate()
      return { usage, quota }
    }
  } catch {}
  return { usage: 0, quota: 0 }
}
