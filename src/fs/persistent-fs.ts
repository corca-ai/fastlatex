const DB_NAME = 'latex-editor'
const DB_VERSION = 1
const STORE_NAME = 'files'

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function txStore(db: IDBDatabase, mode: IDBTransactionMode): IDBObjectStore {
  return db.transaction(STORE_NAME, mode).objectStore(STORE_NAME)
}

function reqPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export interface StoredFile {
  path: string
  content: string
}

/** Load all files from IndexedDB. Returns empty array if DB doesn't exist yet. */
export async function loadFiles(): Promise<StoredFile[]> {
  try {
    const db = await openDB()
    const store = txStore(db, 'readonly')
    const keys = await reqPromise(store.getAllKeys())
    const values = await reqPromise(store.getAll())
    db.close()

    const files: StoredFile[] = []
    for (let i = 0; i < keys.length; i++) {
      const path = keys[i]
      const content = values[i]
      if (typeof path === 'string' && typeof content === 'string') {
        files.push({ path, content })
      }
    }
    return files
  } catch {
    return []
  }
}

/** Save a single file to IndexedDB. */
export async function saveFile(path: string, content: string): Promise<void> {
  try {
    const db = await openDB()
    const store = txStore(db, 'readwrite')
    await reqPromise(store.put(content, path))
    db.close()
  } catch {
    // Silently fail — persistence is best-effort
  }
}

/** Delete a file from IndexedDB. */
export async function deleteStoredFile(path: string): Promise<void> {
  try {
    const db = await openDB()
    const store = txStore(db, 'readwrite')
    await reqPromise(store.delete(path))
    db.close()
  } catch {
    // Silently fail
  }
}
