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

async function listPdfs() {
  const col = await metaCollection();
  const items = await col
    .find({}, { projection: { _id: 0, fileId: 0, share: 0 } })
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

async function putNew({ id, name, bytes }) {
  const col = await metaCollection();
  const now = Date.now();
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  assertValidPdfBuffer(buf);

  const meta = {
    id: String(id),
    name: String(name ?? 'document.pdf'),
    size: buf.byteLength,
    createdAt: now,
    updatedAt: now
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

module.exports = {
  listPdfs,
  getMeta,
  getBytes,
  putNew,
  updateBytes,
  deletePdf,
  getFurniture,
  setFurniture,
  getRejection,
  setRejection,
  getShare,
  setShare
};

