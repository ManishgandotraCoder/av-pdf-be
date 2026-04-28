const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

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
const INDEX_PATH = path.join(STORAGE_DIR, 'index.json');

async function ensureDirs() {
  await fs.mkdir(PDF_DIR, { recursive: true });
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

function assertValidPdfBuffer(bytes) {
  if (!Buffer.isBuffer(bytes)) throw new Error('Invalid buffer.');
  if (bytes.length < 5) throw new Error('Empty PDF (too small).');
  if (bytes.toString('ascii', 0, 5) !== '%PDF-') {
    throw new Error('Not a valid PDF (missing %PDF- header).');
  }
}

async function listPdfs() {
  const { items } = await readIndex();
  return items
    .slice()
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .map(({ id, name, size, createdAt, updatedAt }) => ({ id, name, size, createdAt, updatedAt }));
}

async function getMeta(id) {
  const { items } = await readIndex();
  return items.find((it) => it.id === id) ?? null;
}

async function getBytes(id) {
  return await fs.readFile(pdfPath(id));
}

async function putNew({ name, bytes }) {
  const id = newId();
  const now = Date.now();
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  assertValidPdfBuffer(buf);
  const meta = {
    id,
    name: String(name ?? 'document.pdf'),
    size: buf.byteLength,
    createdAt: now,
    updatedAt: now
  };

  await ensureDirs();
  await fs.writeFile(pdfPath(id), buf);

  const index = await readIndex();
  index.items.push(meta);
  await writeIndex(index);
  return meta;
}

async function updateBytes(id, bytes) {
  const index = await readIndex();
  const it = index.items.find((x) => x.id === id);
  if (!it) return null;

  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  assertValidPdfBuffer(buf);
  await fs.writeFile(pdfPath(id), buf);
  it.size = buf.byteLength;
  it.updatedAt = Date.now();
  await writeIndex(index);
  return it;
}

async function deletePdf(id) {
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
  return true;
}

module.exports = {
  listPdfs,
  getMeta,
  getBytes,
  putNew,
  updateBytes,
  deletePdf
};

