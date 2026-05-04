const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

let vercelBlob = null;
async function getVercelBlob() {
  if (!process.env.VERCEL) return null;
  // If the token isn't configured, don't attempt to use the SDK.
  // (Otherwise @vercel/blob throws "No token found".)
  if (!process.env.BLOB_READ_WRITE_TOKEN || !process.env.BLOB_READ_WRITE_TOKEN.trim()) return null;
  if (vercelBlob) return vercelBlob;
  // Lazy-load so local dev doesn't require env vars / SDK behavior.
  // eslint-disable-next-line global-require
  vercelBlob = require('@vercel/blob');
  return vercelBlob;
}

/** Local dev: ./storage — Vercel: writable OS temp dir (instances are ephemeral). */
const STORAGE_DIR = (() => {
  if (process.env.STORAGE_PATH && process.env.STORAGE_PATH.trim()) {
    return path.resolve(process.env.STORAGE_PATH);
  }
  if (process.env.VERCEL) {
    return path.join(os.tmpdir(), 'avyro-editor-backend-storage');
  }
  return path.join(__dirname, '..', 'storage');
})();
const PDF_DIR = path.join(STORAGE_DIR, 'pdfs');
const EDITOR_STATE_DIR = path.join(STORAGE_DIR, 'editor-states');
const INDEX_PATH = path.join(STORAGE_DIR, 'index.json');

const BLOB_PREFIX = 'pdfs/';
const BLOB_META_PREFIX = 'meta/';

async function ensureDirs() {
  await fs.mkdir(PDF_DIR, { recursive: true });
}

async function ensureEditorStateDir() {
  await fs.mkdir(EDITOR_STATE_DIR, { recursive: true });
}

function editorStatePath(id) {
  return path.join(EDITOR_STATE_DIR, `${id}.json`);
}

async function readIndex() {
  await ensureDirs();
  try {
    const raw = await fs.readFile(INDEX_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { items: [] };
    if (!Array.isArray(parsed.items)) return { items: [] };
    return { items: parsed.items };
  } catch (e) {
    if (e && typeof e === 'object' && e.code === 'ENOENT') return { items: [] };
    throw e;
  }
}

async function writeIndex(index) {
  await ensureDirs();
  const tmp = `${INDEX_PATH}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(index, null, 2), 'utf8');
  await fs.rename(tmp, INDEX_PATH);
}

function newId() {
  return crypto.randomUUID();
}

function pdfPath(id) {
  return path.join(PDF_DIR, `${id}.pdf`);
}

/** Root id for a version chain (walks parentId when rootId is missing). */
function getRootIdOfItem(item, byId) {
  if (!item) return '';
  if (item.rootId) return item.rootId;
  let cur = item;
  const seen = new Set();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    if (!cur.parentId) return cur.id;
    cur = byId.get(cur.parentId);
  }
  return item.id;
}

async function resolveRootIdFromSource(sourceId) {
  const m = await getMeta(sourceId);
  if (!m) return sourceId;
  if (m.rootId) return m.rootId;
  if (m.parentId) return resolveRootIdFromSource(m.parentId);
  return m.id;
}

function assertValidPdfBuffer(bytes) {
  if (!Buffer.isBuffer(bytes)) throw new Error('Invalid buffer.');
  if (bytes.length < 5) throw new Error('Empty PDF (too small).');
  if (bytes.toString('ascii', 0, 5) !== '%PDF-') {
    throw new Error('Not a valid PDF (missing %PDF- header).');
  }
}

function normalizeListRow(it) {
  const o = {
    id: it.id,
    name: it.name,
    size: it.size,
    createdAt: it.createdAt,
    updatedAt: it.updatedAt
  };
  if (it.parentId) o.parentId = it.parentId;
  if (it.rootId && it.rootId !== it.id) o.rootId = it.rootId;
  return o;
}

async function listPdfs() {
  const blob = await getVercelBlob();
  if (blob) {
    const { list } = blob;
    const out = await list({ prefix: BLOB_META_PREFIX });
    const items = [];
    for (const b of out.blobs ?? []) {
      try {
        const res = await fetch(b.url);
        if (!res.ok) continue;
        const meta = await res.json();
        if (meta && typeof meta.id === 'string') items.push(meta);
      } catch {
        // ignore broken metadata
      }
    }
    return items
      .slice()
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .map(normalizeListRow);
  }

  const { items } = await readIndex();
  return items
    .slice()
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .map(normalizeListRow);
}

async function getMeta(id) {
  const blob = await getVercelBlob();
  if (blob) {
    const { head } = blob;
    try {
      const h = await head(`${BLOB_META_PREFIX}${id}.json`);
      const res = await fetch(h.url);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  const { items } = await readIndex();
  return items.find((it) => it.id === id) ?? null;
}

async function getEditorState(id) {
  const blob = await getVercelBlob();
  if (blob) {
    const meta = await getMeta(id);
    return meta?.editorState ?? null;
  }

  try {
    const raw = await fs.readFile(editorStatePath(id), 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    if (e && typeof e === 'object' && e.code === 'ENOENT') return null;
    throw e;
  }
}

async function setEditorState(id, editorState) {
  const blob = await getVercelBlob();
  if (blob) {
    const { put, head } = blob;
    let meta;
    try {
      const h = await head(`${BLOB_META_PREFIX}${id}.json`);
      const res = await fetch(h.url);
      if (!res.ok) return null;
      meta = await res.json();
    } catch {
      return null;
    }
    if (!meta) return null;
    meta.editorState = editorState ?? null;
    meta.updatedAt = Date.now();
    await put(`${BLOB_META_PREFIX}${id}.json`, JSON.stringify(meta), {
      access: 'public',
      contentType: 'application/json',
      addRandomSuffix: false
    });
    return editorState ?? null;
  }

  const index = await readIndex();
  const it = index.items.find((x) => x.id === id);
  if (!it) return null;
  it.updatedAt = Date.now();
  await writeIndex(index);

  if (editorState == null) {
    try {
      await fs.unlink(editorStatePath(id));
    } catch {
      // ignore
    }
    return null;
  }
  await ensureEditorStateDir();
  await fs.writeFile(editorStatePath(id), JSON.stringify(editorState), 'utf8');
  return editorState;
}

async function getBytes(id) {
  const blob = await getVercelBlob();
  if (blob) {
    const { head } = blob;
    const h = await head(`${BLOB_PREFIX}${id}.pdf`);
    const res = await fetch(h.url);
    if (!res.ok) {
      const err = new Error('Not found.');
      err.code = 'ENOENT';
      throw err;
    }
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  }

  return await fs.readFile(pdfPath(id));
}

async function putNew({ name, bytes, parentProposalId }) {
  const id = newId();
  const now = Date.now();
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  assertValidPdfBuffer(buf);
  let parentId;
  let rootId = id;
  const src = typeof parentProposalId === 'string' && parentProposalId.trim() ? parentProposalId.trim() : '';
  if (src) {
    parentId = src;
    rootId = await resolveRootIdFromSource(src);
  }
  const meta = {
    id,
    name: String(name ?? 'document.pdf'),
    size: buf.byteLength,
    createdAt: now,
    updatedAt: now,
    rootId,
    ...(parentId ? { parentId } : {})
  };

  const blob = await getVercelBlob();
  if (blob) {
    const { put } = blob;
    // Store PDF
    await put(`${BLOB_PREFIX}${id}.pdf`, buf, {
      access: 'public',
      contentType: 'application/pdf',
      addRandomSuffix: false
    });
    // Store metadata json
    await put(`${BLOB_META_PREFIX}${id}.json`, JSON.stringify(meta), {
      access: 'public',
      contentType: 'application/json',
      addRandomSuffix: false
    });
    return meta;
  }

  await ensureDirs();
  await fs.writeFile(pdfPath(id), buf);

  const index = await readIndex();
  index.items.push(meta);
  await writeIndex(index);
  return meta;
}

async function updateBytes(id, bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  assertValidPdfBuffer(buf);

  const blob = await getVercelBlob();
  if (blob) {
    const { put } = blob;
    const meta = await getMeta(id);
    if (!meta) return null;
    meta.size = buf.byteLength;
    meta.updatedAt = Date.now();
    await put(`${BLOB_PREFIX}${id}.pdf`, buf, {
      access: 'public',
      contentType: 'application/pdf',
      addRandomSuffix: false
    });
    await put(`${BLOB_META_PREFIX}${id}.json`, JSON.stringify(meta), {
      access: 'public',
      contentType: 'application/json',
      addRandomSuffix: false
    });
    return meta;
  }

  const index = await readIndex();
  const it = index.items.find((x) => x.id === id);
  if (!it) return null;
  await fs.writeFile(pdfPath(id), buf);
  it.size = buf.byteLength;
  it.updatedAt = Date.now();
  await writeIndex(index);
  return it;
}

async function deletePdf(id) {
  const blob = await getVercelBlob();
  if (blob) {
    const { del } = blob;
    const meta = await getMeta(id);
    if (!meta) return false;
    await Promise.allSettled([del(`${BLOB_PREFIX}${id}.pdf`), del(`${BLOB_META_PREFIX}${id}.json`)]);
    return true;
  }

  const index = await readIndex();
  const nextItems = index.items.filter((x) => x.id !== id);
  if (nextItems.length === index.items.length) return false;
  index.items = nextItems;
  await writeIndex(index);
  try {
    await fs.unlink(pdfPath(id));
  } catch {
    // ignore
  }
  try {
    await fs.unlink(editorStatePath(id));
  } catch {
    // ignore
  }
  return true;
}

async function getFurniture(id) {
  const blob = await getVercelBlob();
  if (blob) {
    const meta = await getMeta(id);
    if (!meta) return null;
    return meta.pageFurniture ?? null;
  }

  const { items } = await readIndex();
  const it = items.find((x) => x.id === id);
  if (!it) return null;
  return it.pageFurniture ?? null;
}

async function setFurniture(id, pageFurniture) {
  const blob = await getVercelBlob();
  if (blob) {
    const { put } = blob;
    const meta = await getMeta(id);
    if (!meta) return null;
    meta.pageFurniture = pageFurniture ?? null;
    meta.updatedAt = Date.now();
    await put(`${BLOB_META_PREFIX}${id}.json`, JSON.stringify(meta), {
      access: 'public',
      contentType: 'application/json',
      addRandomSuffix: false
    });
    return meta.pageFurniture;
  }

  const index = await readIndex();
  const it = index.items.find((x) => x.id === id);
  if (!it) return null;
  it.pageFurniture = pageFurniture ?? null;
  it.updatedAt = Date.now();
  await writeIndex(index);
  return it.pageFurniture;
}

async function getRejection(id) {
  const blob = await getVercelBlob();
  if (blob) {
    const meta = await getMeta(id);
    if (!meta) return null;
    return meta.rejection ?? null;
  }

  const { items } = await readIndex();
  const it = items.find((x) => x.id === id);
  if (!it) return null;
  return it.rejection ?? null;
}

async function setRejection(id, rejection) {
  const blob = await getVercelBlob();
  if (blob) {
    const { put } = blob;
    const meta = await getMeta(id);
    if (!meta) return null;
    meta.rejection = rejection ?? null;
    meta.updatedAt = Date.now();
    await put(`${BLOB_META_PREFIX}${id}.json`, JSON.stringify(meta), {
      access: 'public',
      contentType: 'application/json',
      addRandomSuffix: false
    });
    return meta.rejection;
  }

  const index = await readIndex();
  const it = index.items.find((x) => x.id === id);
  if (!it) return null;
  it.rejection = rejection ?? null;
  it.updatedAt = Date.now();
  await writeIndex(index);
  return it.rejection;
}

async function getShare(id) {
  const blob = await getVercelBlob();
  if (blob) {
    const meta = await getMeta(id);
    if (!meta) return null;
    return meta.share ?? null;
  }

  const { items } = await readIndex();
  const it = items.find((x) => x.id === id);
  if (!it) return null;
  return it.share ?? null;
}

async function setShare(id, share) {
  const blob = await getVercelBlob();
  if (blob) {
    const { put } = blob;
    const meta = await getMeta(id);
    if (!meta) return null;
    meta.share = share ?? null;
    meta.updatedAt = Date.now();
    await put(`${BLOB_META_PREFIX}${id}.json`, JSON.stringify(meta), {
      access: 'public',
      contentType: 'application/json',
      addRandomSuffix: false
    });
    return meta.share;
  }

  const index = await readIndex();
  const it = index.items.find((x) => x.id === id);
  if (!it) return null;
  it.share = share ?? null;
  it.updatedAt = Date.now();
  await writeIndex(index);
  return it.share;
}

async function loadAllMetaRows() {
  const blob = await getVercelBlob();
  if (blob) {
    const { list } = blob;
    const out = await list({ prefix: BLOB_META_PREFIX });
    const items = [];
    for (const b of out.blobs ?? []) {
      try {
        const res = await fetch(b.url);
        if (!res.ok) continue;
        const meta = await res.json();
        if (meta && typeof meta.id === 'string') items.push(meta);
      } catch {
        // ignore
      }
    }
    return items;
  }
  const { items } = await readIndex();
  return items;
}

async function listProposalVersions(proposalId) {
  const items = await loadAllMetaRows();
  const byId = new Map(items.map((i) => [i.id, i]));
  const start = byId.get(proposalId);
  if (!start) return [];
  const rootId = getRootIdOfItem(start, byId);
  const chain = items.filter((i) => getRootIdOfItem(i, byId) === rootId);
  chain.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return chain.map((it) => ({
    id: it.id,
    proposalId: it.id,
    versionName: it.name,
    createdAt: it.createdAt ?? it.updatedAt ?? 0,
    createdBy: typeof it.lastEditedBy === 'string' && it.lastEditedBy.trim() ? it.lastEditedBy.trim() : 'Editor'
  }));
}

async function deleteDerivedPdfs(rootId) {
  const blob = await getVercelBlob();
  const items = await loadAllMetaRows();
  const byId = new Map(items.map((i) => [i.id, i]));
  const toDelete = [];
  for (const it of items) {
    if (it.id === rootId) continue;
    if (getRootIdOfItem(it, byId) === rootId) toDelete.push(it.id);
  }

  if (blob) {
    const { del } = blob;
    for (const delId of toDelete) {
      await Promise.allSettled([del(`${BLOB_PREFIX}${delId}.pdf`), del(`${BLOB_META_PREFIX}${delId}.json`)]);
    }
    return toDelete;
  }

  const index = await readIndex();
  const nextItems = index.items.filter((it) => !toDelete.includes(it.id));
  if (nextItems.length !== index.items.length) {
    index.items = nextItems;
    await writeIndex(index);
  }
  for (const delId of toDelete) {
    try {
      await fs.unlink(pdfPath(delId));
    } catch {
      // ignore
    }
    try {
      await fs.unlink(editorStatePath(delId));
    } catch {
      // ignore
    }
  }
  return toDelete;
}

module.exports = {
  listPdfs,
  getMeta,
  getBytes,
  putNew,
  updateBytes,
  deletePdf,
  getFurniture,
  setFurniture,
  getEditorState,
  setEditorState,
  getRejection,
  setRejection,
  getShare,
  setShare,
  listProposalVersions,
  deleteDerivedPdfs
};

