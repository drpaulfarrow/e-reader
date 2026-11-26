// Storage: IndexedDB for books (metadata, PDF bytes, parsed model),
// localStorage for small things that must be written synchronously
// (reading position, settings).

const DB = 'folio';
let dbp = null;

function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const rq = indexedDB.open(DB, 1);
      rq.onupgradeneeded = () => {
        const d = rq.result;
        d.createObjectStore('books', { keyPath: 'id' });
        d.createObjectStore('files');
        d.createObjectStore('models');
      };
      rq.onsuccess = () => resolve(rq.result);
      rq.onerror = () => reject(rq.error);
    });
  }
  return dbp;
}

async function tx(stores, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(stores, mode);
    let result;
    t.oncomplete = () => resolve(result);
    t.onerror = t.onabort = () => reject(t.error || new Error('Storage error'));
    result = fn(t);
  });
}
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const listBooks = async () => {
  const d = await db();
  const all = await req(d.transaction('books').objectStore('books').getAll());
  return all.sort((a, b) => (b.lastRead || b.added) - (a.lastRead || a.added));
};
export const getBook = async (id) => req((await db()).transaction('books').objectStore('books').get(id));
export const getFile = async (id) => req((await db()).transaction('files').objectStore('files').get(id));
export const getModel = async (id) => req((await db()).transaction('models').objectStore('models').get(id));
export const putBook = (book) => tx(['books'], 'readwrite', (t) => { t.objectStore('books').put(book); });
export const putFile = (id, file) => tx(['files'], 'readwrite', (t) => { t.objectStore('files').put(file, id); });
export const putModel = (id, model) => tx(['models'], 'readwrite', (t) => { t.objectStore('models').put(model, id); });

export const addBook = (book, file, model) => tx(['books', 'files', 'models'], 'readwrite', (t) => {
  t.objectStore('books').put(book);
  t.objectStore('files').put(file, book.id);
  t.objectStore('models').put(model, book.id);
});

export const deleteBook = (id) => {
  try { localStorage.removeItem('folio:pos:' + id); } catch { /* ignore */ }
  return tx(['books', 'files', 'models'], 'readwrite', (t) => {
    t.objectStore('books').delete(id);
    t.objectStore('files').delete(id);
    t.objectStore('models').delete(id);
  });
};

const ls = {
  get(k, def) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch { return def; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* quota or private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

export const getPos = (id) => ls.get('folio:pos:' + id, null);
export const setPos = (id, pos) => ls.set('folio:pos:' + id, pos);
export const getSettings = () => ({ size: 17, theme: 'auto', font: 'serif', ...ls.get('folio:settings', {}) });
export const setSettings = (s) => ls.set('folio:settings', s);
export const getOpen = () => ls.get('folio:open', null);
export const setOpen = (id) => (id ? ls.set('folio:open', id) : ls.del('folio:open'));

export function persist() {
  try { navigator.storage?.persist?.(); } catch { /* optional */ }
}
