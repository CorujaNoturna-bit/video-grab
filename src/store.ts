const DB_NAME = "video-grabber";
const STORE = "kv";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const req = fn(db.transaction(STORE, mode).objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      })
  );
}

export async function loadDir(): Promise<FileSystemDirectoryHandle | null> {
  const h = (await tx("readonly", (s) => s.get("dir"))) as FileSystemDirectoryHandle | undefined;
  return h ?? null;
}

export async function saveDir(h: FileSystemDirectoryHandle): Promise<void> {
  await tx("readwrite", (s) => s.put(h, "dir"));
}

export async function clearDir(): Promise<void> {
  await tx("readwrite", (s) => s.delete("dir"));
}

export async function pickDir(): Promise<FileSystemDirectoryHandle> {
  const h = (await (window as any).showDirectoryPicker({
    id: "video-grabber",
    mode: "readwrite",
  })) as FileSystemDirectoryHandle;
  await saveDir(h);
  return h;
}
