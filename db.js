const GMDB = (() => {
  const DB_NAME = "ghoulmusic-db";
  const VERSION = 1;
  let dbp;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("tracks")) {
          const s = db.createObjectStore("tracks", { keyPath: "id" });
          s.createIndex("addedAt", "addedAt");
          s.createIndex("lastPlayed", "lastPlayed");
        }
        if (!db.objectStoreNames.contains("playlists")) {
          db.createObjectStore("playlists", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("settings")) {
          db.createObjectStore("settings", { keyPath: "key" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }

  async function tx(store, mode="readonly") {
    const db = await open();
    return db.transaction(store, mode).objectStore(store);
  }

  function reqPromise(req) {
    return new Promise((resolve,reject)=>{req.onsuccess=()=>resolve(req.result); req.onerror=()=>reject(req.error)});
  }

  async function put(store, value) { return reqPromise((await tx(store,"readwrite")).put(value)); }
  async function get(store, key) { return reqPromise((await tx(store)).get(key)); }
  async function del(store, key) { return reqPromise((await tx(store,"readwrite")).delete(key)); }
  async function all(store) { return reqPromise((await tx(store)).getAll()); }
  async function clear(store) { return reqPromise((await tx(store,"readwrite")).clear()); }

  return { open, put, get, del, all, clear };
})();
