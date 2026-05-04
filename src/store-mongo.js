const { Readable } = require('node:stream');
const { ObjectId } = require('mongodb');

const { getDb, getBucket } = require('./mongo');

function bufferToStream(buf) {
  return Readable.from(buf);
}

function assertValidPdfBuffer(bytes) {
  if (!Buffer.isBuffer(bytes)) throw new Error('Invalid buffer.');
  if (bytes.length < 5) throw new Error('Empty PDF (too small).');
  if (bytes.toString('ascii', 0, 5) !== '%PDF-') {
    throw new Error('Not a valid PDF (missing %PDF- header).');
  }
}

async function metaCollection() {
  const db = await getDb();
  const col = db.collection('pdfs');
  await col.createIndex({ updatedAt: -1 });
  return col;
}

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

async function resolveRootIdFromSourceMongo(col, sourceId) {
  const seen = new Set();
  let curId = sourceId;
  while (curId && !seen.has(curId)) {
    seen.add(curId);
    const m = await col.findOne({ id: curId }, { projection: { parentId: 1, rootId: 1, id: 1 } });
    if (!m) return sourceId;
    if (m.rootId) return m.rootId;
    if (!m.parentId) return m.id;
    curId = m.parentId;
  }
  return sourceId;
}

async function listPdfs() {
  const col = await metaCollection();
  const items = await col
    .find({}, { projection: { _id: 0, fileId: 0, share: 0, editorState: 0 } })
    .sort({ updatedAt: -1 })
    .toArray();
  return items;
}

async function getMeta(id) {
  const col = await metaCollection();
  const doc = await col.findOne({ id }, { projection: { _id: 0 } });
  return doc ?? null;
}

async function getBytes(id) {
  const col = await metaCollection();
  const doc = await col.findOne({ id }, { projection: { fileId: 1 } });
  if (!doc || !doc.fileId) {
    const err = new Error('Not found.');
    err.code = 'ENOENT';
    throw err;
  }

  const bucket = await getBucket();
  const chunks = [];
  await new Promise((resolve, reject) => {
    const dl = bucket.openDownloadStream(new ObjectId(String(doc.fileId)));
    dl.on('data', (c) => chunks.push(c));
    dl.on('error', reject);
    dl.on('end', resolve);
  });
  return Buffer.concat(chunks);
}

async function putNew({ id, name, bytes, parentProposalId }) {
  const col = await metaCollection();
  const now = Date.now();
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  assertValidPdfBuffer(buf);

  let parentId;
  let rootId = String(id);
  const src = typeof parentProposalId === 'string' && parentProposalId.trim() ? parentProposalId.trim() : '';
  if (src) {
    parentId = src;
    rootId = await resolveRootIdFromSourceMongo(col, src);
  }

  const meta = {
    id: String(id),
    name: String(name ?? 'document.pdf'),
    size: buf.byteLength,
    createdAt: now,
    updatedAt: now,
    rootId,
    ...(parentId ? { parentId } : {})
  };

  const bucket = await getBucket();
  const fileId = await new Promise((resolve, reject) => {
    const ul = bucket.openUploadStream(`${meta.id}.pdf`, {
      contentType: 'application/pdf',
      metadata: { id: meta.id }
    });
    ul.on('error', reject);
    ul.on('finish', () => resolve(ul.id));
    bufferToStream(buf).pipe(ul);
  });

  await col.insertOne({ ...meta, fileId: String(fileId) });
  return meta;
}

async function updateBytes(id, bytes) {
  const col = await metaCollection();
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  assertValidPdfBuffer(buf);

  const existing = await col.findOne({ id }, { projection: { _id: 0 } });
  if (!existing) return null;

  const bucket = await getBucket();
  const fileId = await new Promise((resolve, reject) => {
    const ul = bucket.openUploadStream(`${id}.pdf`, {
      contentType: 'application/pdf',
      metadata: { id }
    });
    ul.on('error', reject);
    ul.on('finish', () => resolve(ul.id));
    bufferToStream(buf).pipe(ul);
  });

  // Best-effort delete of old file (don’t fail update if it’s already gone)
  if (existing.fileId) {
    try {
      await bucket.delete(new ObjectId(String(existing.fileId)));
    } catch {
      // ignore
    }
  }

  const updatedAt = Date.now();
  await col.updateOne(
    { id },
    {
      $set: {
        size: buf.byteLength,
        updatedAt,
        fileId: String(fileId)
      }
    }
  );

  return {
    id: existing.id,
    name: existing.name,
    size: buf.byteLength,
    createdAt: existing.createdAt,
    updatedAt
  };
}

async function deletePdf(id) {
  const col = await metaCollection();
  const existing = await col.findOne({ id }, { projection: { fileId: 1 } });
  if (!existing) return false;

  const bucket = await getBucket();
  if (existing.fileId) {
    try {
      await bucket.delete(new ObjectId(String(existing.fileId)));
    } catch {
      // ignore
    }
  }
  await col.deleteOne({ id });
  return true;
}

async function getFurniture(id) {
  const col = await metaCollection();
  const doc = await col.findOne({ id }, { projection: { _id: 0, pageFurniture: 1 } });
  if (!doc) return null;
  return doc.pageFurniture ?? null;
}

async function setFurniture(id, pageFurniture) {
  const col = await metaCollection();
  const existing = await col.findOne({ id }, { projection: { _id: 1 } });
  if (!existing) return null;
  await col.updateOne(
    { id },
    {
      $set: {
        pageFurniture: pageFurniture ?? null,
        updatedAt: Date.now()
      }
    }
  );
  return pageFurniture ?? null;
}

async function getEditorState(id) {
  const col = await metaCollection();
  const doc = await col.findOne({ id }, { projection: { _id: 0, editorState: 1 } });
  return doc?.editorState ?? null;
}

async function setEditorState(id, editorState) {
  const col = await metaCollection();
  const existing = await col.findOne({ id }, { projection: { _id: 1 } });
  if (!existing) return null;
  await col.updateOne(
    { id },
    {
      $set: {
        editorState: editorState ?? null,
        updatedAt: Date.now()
      }
    }
  );
  return editorState ?? null;
}

async function getRejection(id) {
  const col = await metaCollection();
  const doc = await col.findOne({ id }, { projection: { _id: 0, rejection: 1 } });
  if (!doc) return null;
  return doc.rejection ?? null;
}

async function setRejection(id, rejection) {
  const col = await metaCollection();
  const existing = await col.findOne({ id }, { projection: { _id: 1 } });
  if (!existing) return null;
  await col.updateOne(
    { id },
    {
      $set: {
        rejection: rejection ?? null,
        updatedAt: Date.now()
      }
    }
  );
  return rejection ?? null;
}

async function getShare(id) {
  const col = await metaCollection();
  const doc = await col.findOne({ id }, { projection: { _id: 0, share: 1 } });
  if (!doc) return null;
  return doc.share ?? null;
}

async function setShare(id, share) {
  const col = await metaCollection();
  const existing = await col.findOne({ id }, { projection: { _id: 1 } });
  if (!existing) return null;
  await col.updateOne(
    { id },
    {
      $set: {
        share: share ?? null,
        updatedAt: Date.now()
      }
    }
  );
  return share ?? null;
}

async function listProposalVersions(proposalId) {
  const col = await metaCollection();
  const items = await col
    .find({}, { projection: { _id: 0, id: 1, name: 1, createdAt: 1, updatedAt: 1, parentId: 1, rootId: 1 } })
    .toArray();
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
  const col = await metaCollection();
  const items = await col.find({}, { projection: { id: 1, parentId: 1, rootId: 1 } }).toArray();
  const byId = new Map(items.map((i) => [i.id, i]));
  const toDelete = [];
  for (const it of items) {
    if (it.id === rootId) continue;
    if (getRootIdOfItem(it, byId) === rootId) toDelete.push(it.id);
  }
  for (const delId of toDelete) {
    await deletePdf(delId);
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

