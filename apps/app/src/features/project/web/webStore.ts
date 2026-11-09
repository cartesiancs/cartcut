/**
 * What a browser build keeps between visits: IndexedDB, one database.
 *
 *  - `mediaHandles`: a `FileSystemFileHandle` per media file a saved project
 *    names, filed under the file's identity (`webMediaLinks.ts#identityKey`).
 *    Chrome and Edge can structured-clone a handle into IndexedDB; reopened,
 *    it asks the user once and reads the file where it is, so a project's
 *    media comes back without being found again.
 *  - `autosave`: the browser's Auto Save rings, one record per ring key, each
 *    holding the archive bytes of its newest recovery point
 *    (`webAutosave.ts`). The desktop app keeps the same rings on disk.
 *
 * Every call answers a fallback rather than throwing: a private window, a
 * browser with storage switched off, or a quota reached must cost the feature,
 * never the save or the open it serves.
 */

const DB_NAME = "cartcut-web";
const DB_VERSION = 1;
export const MEDIA_HANDLES = "mediaHandles";
export const AUTOSAVE = "autosave";

let opening: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  if (opening == null) {
    opening = new Promise((resolve) => {
      let request: IDBOpenDBRequest;
      try {
        request = indexedDB.open(DB_NAME, DB_VERSION);
      } catch {
        resolve(null);
        return;
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(MEDIA_HANDLES)) {
          db.createObjectStore(MEDIA_HANDLES);
        }
        if (!db.objectStoreNames.contains(AUTOSAVE)) {
          db.createObjectStore(AUTOSAVE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    });
  }
  return opening;
}

function run<T>(
  store: string,
  mode: IDBTransactionMode,
  act: (objects: IDBObjectStore) => IDBRequest<T>,
  fallback: T,
): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve) => {
        if (db == null) {
          resolve(fallback);
          return;
        }
        try {
          const request = act(db.transaction(store, mode).objectStore(store));
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => resolve(fallback);
        } catch {
          resolve(fallback);
        }
      }),
  );
}

export function idbGet<T>(store: string, key: string): Promise<T | undefined> {
  return run<T | undefined>(store, "readonly", (objects) => objects.get(key), undefined);
}

export function idbPut(store: string, key: string, value: unknown): Promise<boolean> {
  return run<IDBValidKey | null>(
    store,
    "readwrite",
    (objects) => objects.put(value, key) as IDBRequest<IDBValidKey | null>,
    null,
  ).then((result) => result != null);
}

export function idbDelete(store: string, key: string): Promise<void> {
  return run<undefined>(store, "readwrite", (objects) => objects.delete(key), undefined).then(() => undefined);
}

export function idbAll<T>(store: string): Promise<T[]> {
  return run<T[]>(store, "readonly", (objects) => objects.getAll(), []);
}
