const express = require('express');
const cors = require('cors');
const multer = require('multer');
const crypto = require('node:crypto');

const { getMongoUri } = require('./mongo');
const usingMongo = Boolean(getMongoUri());
const store = usingMongo ? require('./store-mongo') : require('./store');

const DEFAULT_JSON_LIMIT = '100mb';
const DEFAULT_EDITOR_STATE_LIMIT = '150mb';
const DEFAULT_PDF_UPLOAD_MAX_MB = 200;
const uploadMaxMb = Number(process.env.PDF_UPLOAD_MAX_MB ?? DEFAULT_PDF_UPLOAD_MAX_MB);
const uploadMaxBytes = Number.isFinite(uploadMaxMb) && uploadMaxMb > 0 ? Math.floor(uploadMaxMb * 1024 * 1024) : 200 * 1024 * 1024;

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: uploadMaxBytes }
});

app.use(cors());
app.use(express.json({ limit: process.env.API_JSON_LIMIT ?? DEFAULT_JSON_LIMIT }));

app.get('/', (_req, res) =>
  res.json({
    ok: true,
    name: 'avyro-editor-backend',
    hint: 'Use GET /api/health to verify the deployment; do not reuse old preview hashes in the hostname.',
    healthPath: '/api/health'
  })
);

function isLikelyPdfUpload(file) {
  if (!file) return false;
  const mt = String(file.mimetype ?? '').toLowerCase();
  if (mt === 'application/pdf') return true;
  // Some browsers report octet-stream even for PDFs.
  if (mt === 'application/octet-stream' || mt === 'binary/octet-stream') return true;
  return false;
}

/** Strip large editor payload from PDF metadata responses (use GET /editor-state instead). */
function metaForClient(meta) {
  if (!meta || typeof meta !== 'object') return meta;
  const { editorState: _omit, ...rest } = meta;
  return rest;
}

// For PUT of raw PDF bytes.
app.use(
  '/api/pdfs/:id',
  express.raw({
    type: ['application/pdf', 'application/octet-stream'],
    limit: '100mb'
  })
);
app.use(
  '/api/proposals/overwrite/:id',
  express.raw({
    type: ['application/pdf', 'application/octet-stream'],
    limit: '100mb'
  })
);

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/pdfs', async (_req, res) => {
  try {
    res.json(await store.listPdfs());
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Failed to list PDFs.' });
  }
});

app.post('/api/pdfs', upload.single('file'), async (req, res) => {
  const file = req.file ?? null;
  if (!file) return res.status(400).json({ error: 'Missing file.' });
  if (!isLikelyPdfUpload(file)) {
    return res.status(400).json({ error: 'Only PDF upload supported (application/pdf or octet-stream).' });
  }

  try {
    const meta = usingMongo
      ? await store.putNew({ id: crypto.randomUUID(), name: file.originalname, bytes: file.buffer })
      : await store.putNew({ name: file.originalname, bytes: file.buffer });
    res.json(meta);
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'Upload failed.' });
  }
});

app.get('/api/pdfs/:id/meta', async (req, res) => {
  try {
    const meta = await store.getMeta(req.params.id);
    if (!meta) return res.status(404).json({ error: 'Not found.' });
    res.json(metaForClient(meta));
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Failed to load meta.' });
  }
});

app.get('/api/pdfs/:id', async (req, res) => {
  try {
    const meta = await store.getMeta(req.params.id);
    if (!meta) return res.status(404).json({ error: 'Not found.' });
    const bytes = await store.getBytes(req.params.id);
    if (bytes.length < 5 || bytes.toString('ascii', 0, 5) !== '%PDF-') {
      return res
        .status(500)
        .json({ error: 'Stored file is not a valid PDF. Delete and re-upload this document.' });
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(meta.name)}"`);
    res.send(bytes);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Failed to load PDF.' });
  }
});

app.put('/api/pdfs/:id', async (req, res) => {
  const bytes = req.body;
  if (!bytes || !(bytes instanceof Buffer) || bytes.length === 0) {
    return res.status(400).json({ error: 'Missing PDF bytes.' });
  }
  // quick sanity check
  if (bytes.length < 5 || bytes.toString('ascii', 0, 5) !== '%PDF-') {
    return res.status(400).json({ error: 'Invalid PDF bytes.' });
  }

  try {
    const meta = await store.updateBytes(req.params.id, bytes);
    if (!meta) return res.status(404).json({ error: 'Not found.' });
    res.json(meta);
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'Failed to save PDF.' });
  }
});

app.delete('/api/pdfs/:id', async (req, res) => {
  try {
    const ok = await store.deletePdf(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Not found.' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Failed to delete PDF.' });
  }
});

app.get('/api/pdfs/:id/furniture', async (req, res) => {
  try {
    const meta = await store.getMeta(req.params.id);
    if (!meta) return res.status(404).json({ error: 'Not found.' });
    const pageFurniture = await store.getFurniture(req.params.id);
    return res.json({ pageFurniture: pageFurniture ?? null });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : 'Failed to load page furniture.' });
  }
});

app.put('/api/pdfs/:id/furniture', async (req, res) => {
  try {
    const meta = await store.getMeta(req.params.id);
    if (!meta) return res.status(404).json({ error: 'Not found.' });
    const body = req.body ?? {};
    const hasObjectBody = body && typeof body === 'object';
    if (!hasObjectBody) return res.status(400).json({ error: 'Invalid furniture payload.' });
    const pageFurniture = Object.prototype.hasOwnProperty.call(body, 'pageFurniture') ? body.pageFurniture : null;
    await store.setFurniture(req.params.id, pageFurniture);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(400).json({ error: e instanceof Error ? e.message : 'Failed to save page furniture.' });
  }
});

const editorStateJson = express.json({
  limit: process.env.EDITOR_STATE_JSON_LIMIT ?? DEFAULT_EDITOR_STATE_LIMIT
});

app.get('/api/pdfs/:id/editor-state', async (req, res) => {
  try {
    const meta = await store.getMeta(req.params.id);
    if (!meta) return res.status(404).json({ error: 'Not found.' });
    const editorState = await store.getEditorState(req.params.id);
    return res.json({ editorState: editorState ?? null });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : 'Failed to load editor state.' });
  }
});

app.put('/api/pdfs/:id/editor-state', editorStateJson, async (req, res) => {
  try {
    const meta = await store.getMeta(req.params.id);
    if (!meta) return res.status(404).json({ error: 'Not found.' });
    const body = req.body ?? {};
    const hasObjectBody = body && typeof body === 'object';
    if (!hasObjectBody) return res.status(400).json({ error: 'Invalid editor state payload.' });
    const editorState = Object.prototype.hasOwnProperty.call(body, 'editorState') ? body.editorState : null;
    await store.setEditorState(req.params.id, editorState);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(400).json({ error: e instanceof Error ? e.message : 'Failed to save editor state.' });
  }
});

// Compatibility endpoints for proposal-version flows used by the editor frontend.
app.post('/api/proposals/save-as-new', upload.single('file'), async (req, res) => {
  const file = req.file ?? null;
  if (!file) return res.status(400).json({ error: 'Missing file.' });
  if (!isLikelyPdfUpload(file)) {
    return res.status(400).json({ error: 'Only PDF upload supported (application/pdf or octet-stream).' });
  }
  try {
    const sourceProposalId = String(req.body?.sourceProposalId ?? '').trim();
    const editedBy = String(req.body?.editedBy ?? 'Editor').trim() || 'Editor';
    const timestamp = Date.now();
    const baseName = String(req.body?.name ?? file.originalname ?? 'proposal.pdf').trim() || 'proposal.pdf';
    const meta = usingMongo
      ? await store.putNew({
          id: crypto.randomUUID(),
          name: baseName,
          bytes: file.buffer,
          parentProposalId: sourceProposalId || undefined
        })
      : await store.putNew({
          name: baseName,
          bytes: file.buffer,
          parentProposalId: sourceProposalId || undefined
        });
    return res.json({
      ...meta,
      versionId: `${meta.id}:${timestamp}`,
      timestamp,
      editedBy,
      parentProposalId: sourceProposalId || meta.id
    });
  } catch (e) {
    return res.status(400).json({ error: e instanceof Error ? e.message : 'Failed to save new proposal version.' });
  }
});

app.post('/api/proposals/overwrite/:id', async (req, res) => {
  const bytes = req.body;
  if (!bytes || !(bytes instanceof Buffer) || bytes.length === 0) {
    return res.status(400).json({ error: 'Missing PDF bytes.' });
  }
  if (bytes.length < 5 || bytes.toString('ascii', 0, 5) !== '%PDF-') {
    return res.status(400).json({ error: 'Invalid PDF bytes.' });
  }
  try {
    const meta = await store.updateBytes(req.params.id, bytes);
    if (!meta) return res.status(404).json({ error: 'Not found.' });
    return res.json(meta);
  } catch (e) {
    return res.status(400).json({ error: e instanceof Error ? e.message : 'Failed to overwrite proposal.' });
  }
});

app.get('/api/proposal/:id', async (req, res) => {
  try {
    const meta = await store.getMeta(req.params.id);
    if (!meta) return res.status(404).json({ error: 'Not found.' });
    return res.json({
      id: meta.id,
      name: meta.name,
      derivedFrom: null,
      rejection: (await store.getRejection(req.params.id)) ?? null,
      derivedFromDetails: null
    });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : 'Failed to load proposal.' });
  }
});

app.post('/api/proposals/:id/reject', async (req, res) => {
  try {
    const meta = await store.getMeta(req.params.id);
    if (!meta) return res.status(404).json({ error: 'Not found.' });
    const level = req.body?.level === 'client' ? 'client' : 'internal';
    const rejectedBy = String(req.body?.rejectedBy ?? 'Editor').trim() || 'Editor';
    const reason = String(req.body?.reason ?? '').trim();
    const rejection = {
      proposalId: req.params.id,
      level,
      reason,
      rejectedBy,
      rejectedAt: Date.now()
    };
    await store.setRejection(req.params.id, rejection);
    return res.json(rejection);
  } catch (e) {
    return res.status(400).json({ error: e instanceof Error ? e.message : 'Failed to reject proposal.' });
  }
});

app.get('/api/proposals/:id/rejection', async (req, res) => {
  try {
    const meta = await store.getMeta(req.params.id);
    if (!meta) return res.status(404).json({ error: 'Not found.' });
    const rejection = await store.getRejection(req.params.id);
    // "No rejection yet" is a normal state; return 200 to avoid noisy 404 logs in the client.
    return res.json(rejection ?? null);
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : 'Failed to load rejection status.' });
  }
});

const SHARE_ROLES = new Set(['viewer', 'commenter', 'editor']);

function normalizeShareUsers(users) {
  if (!Array.isArray(users)) return [];
  const out = [];
  const seen = new Set();
  for (const u of users) {
    if (!u || typeof u !== 'object') continue;
    const email = String(u.email ?? '')
      .trim()
      .toLowerCase();
    const role = SHARE_ROLES.has(u.role) ? u.role : 'viewer';
    if (!email || seen.has(email)) continue;
    seen.add(email);
    out.push({ email, role });
  }
  return out;
}

function buildShareUrl(linkBaseUrl, proposalId, token) {
  const base = String(linkBaseUrl ?? '')
    .trim()
    .replace(/\/$/, '');
  const encId = encodeURIComponent(proposalId);
  const encTok = encodeURIComponent(token);
  if (base) return `${base}/edit/${encId}?share=${encTok}`;
  return `/edit/${encId}?share=${encTok}`;
}

app.get('/api/share/by-proposal/:id', async (req, res) => {
  try {
    const proposalId = String(req.params.id ?? '').trim();
    if (!proposalId) return res.status(400).json({ error: 'Missing id.' });
    const meta = await store.getMeta(proposalId);
    if (!meta) return res.status(404).json({ error: 'Not found.' });
    const share = await store.getShare(proposalId);
    return res.json(share ?? null);
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : 'Failed to load share.' });
  }
});

app.post('/api/share/generate-link', async (req, res) => {
  try {
    const proposalId = String(req.body?.proposalId ?? '').trim();
    if (!proposalId) return res.status(400).json({ error: 'Missing proposalId.' });
    const meta = await store.getMeta(proposalId);
    if (!meta) return res.status(404).json({ error: 'Not found.' });

    const accessType = req.body?.accessType === 'public' ? 'public' : 'restricted';
    const sharedBy = String(req.body?.sharedBy ?? '').trim() || undefined;
    const derivedFrom =
      req.body?.derivedFrom &&
      typeof req.body.derivedFrom === 'object' &&
      String(req.body.derivedFrom.id ?? '').trim()
        ? {
            id: String(req.body.derivedFrom.id).trim(),
            name: String(req.body.derivedFrom.name ?? '').trim() || 'Proposal'
          }
        : null;

    const linkBaseUrl = String(req.body?.linkBaseUrl ?? process.env.EDITOR_PUBLIC_URL ?? '').trim();

    const now = Date.now();
    const prev = (await store.getShare(proposalId)) ?? {};
    const linkToken =
      typeof prev.linkToken === 'string' && prev.linkToken.length > 8
        ? prev.linkToken
        : crypto.randomBytes(24).toString('base64url');

    /** @type {Record<string, unknown>} */
    const record = {
      id: `${proposalId}:share`,
      proposalId,
      accessType,
      users: normalizeShareUsers(prev.users),
      linkToken,
      createdAt: typeof prev.createdAt === 'number' ? prev.createdAt : now,
      updatedAt: now,
      derivedFrom: derivedFrom ?? prev.derivedFrom ?? null
    };
    if (sharedBy) record.sharedBy = sharedBy;
    else if (typeof prev.sharedBy === 'string' && prev.sharedBy.trim()) record.sharedBy = prev.sharedBy.trim();

    await store.setShare(proposalId, record);
    const url = buildShareUrl(linkBaseUrl, proposalId, linkToken);
    return res.json({ ...record, url });
  } catch (e) {
    return res.status(400).json({ error: e instanceof Error ? e.message : 'Failed to generate share link.' });
  }
});

app.post('/api/share/add-user', async (req, res) => {
  try {
    const proposalId = String(req.body?.proposalId ?? '').trim();
    const email = String(req.body?.email ?? '')
      .trim()
      .toLowerCase();
    const role = SHARE_ROLES.has(req.body?.role) ? req.body.role : 'viewer';
    if (!proposalId) return res.status(400).json({ error: 'Missing proposalId.' });
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Valid email is required.' });
    }
    const meta = await store.getMeta(proposalId);
    if (!meta) return res.status(404).json({ error: 'Not found.' });

    const now = Date.now();
    const prev = (await store.getShare(proposalId)) ?? {};
    const linkToken =
      typeof prev.linkToken === 'string' && prev.linkToken.length > 8
        ? prev.linkToken
        : crypto.randomBytes(24).toString('base64url');

    const users = normalizeShareUsers(prev.users);
    const idx = users.findIndex((u) => u.email === email);
    if (idx >= 0) users[idx] = { email, role };
    else users.push({ email, role });

    /** @type {Record<string, unknown>} */
    const record = {
      id: `${proposalId}:share`,
      proposalId,
      accessType: prev.accessType === 'public' ? 'public' : 'restricted',
      users,
      linkToken,
      createdAt: typeof prev.createdAt === 'number' ? prev.createdAt : now,
      updatedAt: now,
      derivedFrom: prev.derivedFrom ?? null
    };
    if (typeof prev.sharedBy === 'string' && prev.sharedBy.trim()) record.sharedBy = prev.sharedBy.trim();

    await store.setShare(proposalId, record);
    return res.json(record);
  } catch (e) {
    return res.status(400).json({ error: e instanceof Error ? e.message : 'Failed to add share user.' });
  }
});

app.get('/api/proposals/:id/versions', async (req, res) => {
  try {
    const id = String(req.params.id ?? '').trim();
    if (!id) return res.status(400).json({ error: 'Missing id.' });
    const versions = await store.listProposalVersions(id);
    res.json(versions);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Failed to load versions.' });
  }
});

app.post('/api/proposals/:id/clear-versions', async (req, res) => {
  try {
    const id = String(req.params.id ?? '').trim();
    if (!id) return res.status(400).json({ error: 'Missing id.' });
    const meta = await store.getMeta(id);
    if (!meta) return res.status(404).json({ error: 'Not found.' });
    const rootId = meta.rootId || meta.id;
    const deletedIds = await store.deleteDerivedPdfs(rootId);
    res.json({ ok: true, rootId, deletedIds });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Failed to clear versions.' });
  }
});

/**
 * CRM Asset Library proxy.
 *
 * When CRM_API_BASE_URL is unset, returns crmConfigured:false so the editor can show a local-only library.
 * When set, fetches:
 *   GET {CRM_API_BASE_URL}{CRM_ASSET_LIBRARY_PREFIX}/categories
 *   GET {CRM_API_BASE_URL}{CRM_ASSET_LIBRARY_PREFIX}/assets
 * Optional CRM_API_KEY is sent as Authorization: Bearer …
 *
 * CRM JSON may use { categories } / { assets } or { data: { … } } or a bare assets array.
 */
function normalizeCrmCategories(payload) {
  const raw = Array.isArray(payload?.categories)
    ? payload.categories
    : Array.isArray(payload?.data?.categories)
      ? payload.data.categories
      : [];
  return raw
    .map((c) => ({
      id: String(c?.id ?? c?.slug ?? '').trim(),
      name: String(c?.name ?? c?.label ?? '').trim()
    }))
    .filter((c) => c.id && c.name);
}

function crmFirstNonEmptyString(...vals) {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

/** Turn CRM-relative paths and protocol-relative URLs into absolute URLs the editor can load. */
function resolveCrmMediaUrl(base, raw) {
  if (raw == null) return undefined;
  const s = String(raw).trim();
  if (!s) return undefined;
  const low = s.toLowerCase();
  if (low.startsWith('http://') || low.startsWith('https://') || low.startsWith('data:') || low.startsWith('blob:'))
    return s;
  if (s.startsWith('//')) return `https:${s}`;
  if (!base) return s;
  if (s.startsWith('/')) return `${base}${s}`;
  return `${base}/${s}`;
}

function normalizeCrmAssets(payload, base) {
  const raw = Array.isArray(payload?.assets)
    ? payload.assets
    : Array.isArray(payload?.data?.assets)
      ? payload.data.assets
      : Array.isArray(payload)
        ? payload
        : [];
  return raw
    .map((a, idx) => {
      const id = String(a?.id ?? a?.assetId ?? `idx_${idx}`).trim() || `idx_${idx}`;
      const name = String(a?.name ?? a?.title ?? a?.filename ?? 'Asset').trim() || 'Asset';
      let kind = String(a?.kind ?? a?.type ?? 'other').toLowerCase();
      if (kind === 'photo' || kind === 'picture') kind = 'image';
      if (!['image', 'video', 'template', 'other'].includes(kind)) kind = 'other';
      const categoryId =
        a?.categoryId != null
          ? String(a.categoryId).trim()
          : a?.category?.id != null
            ? String(a.category.id).trim()
            : undefined;
      const rawUrl = crmFirstNonEmptyString(
        a?.url,
        a?.src,
        a?.downloadUrl,
        a?.videoUrl,
        a?.fileUrl,
        a?.mediaUrl,
        a?.href,
        a?.link,
        a?.path,
        typeof a?.file === 'string' ? a.file : undefined,
        a?.media?.url,
        a?.media?.src,
        a?.file?.url
      );
      const rawPreview = crmFirstNonEmptyString(
        a?.previewUrl,
        a?.thumbnailUrl,
        a?.poster,
        a?.thumbnail,
        a?.preview,
        a?.media?.previewUrl,
        a?.media?.thumbnailUrl
      );
      const url = rawUrl !== undefined ? resolveCrmMediaUrl(base, rawUrl) : undefined;
      const previewUrl = rawPreview !== undefined ? resolveCrmMediaUrl(base, rawPreview) : undefined;
      const mimeType = typeof a?.mimeType === 'string' ? a.mimeType : undefined;
      return { id, name, kind, categoryId: categoryId || undefined, url, previewUrl, mimeType };
    })
    .filter((a) => a.id);
}

app.get('/api/crm/asset-library', async (_req, res) => {
  const base = String(process.env.CRM_API_BASE_URL ?? '')
    .trim()
    .replace(/\/$/, '');
  if (!base) {
    return res.json({ crmConfigured: false, categories: [], assets: [] });
  }

  const prefix = String(process.env.CRM_ASSET_LIBRARY_PREFIX ?? '/asset-library')
    .trim()
    .replace(/\/$/, '');
  /** @type {Record<string, string>} */
  const headers = { Accept: 'application/json' };
  const apiKey = String(process.env.CRM_API_KEY ?? '').trim();
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const catUrl = `${base}${prefix}/categories`;
  const assetUrl = `${base}${prefix}/assets`;

  try {
    const [catRes, assetRes] = await Promise.all([fetch(catUrl, { headers }), fetch(assetUrl, { headers })]);

    let categories = [];
    if (catRes.ok) {
      categories = normalizeCrmCategories(await catRes.json());
    } else if (catRes.status !== 404) {
      const t = await catRes.text();
      return res.status(502).json({
        error: `CRM categories request failed (${catRes.status}): ${t.slice(0, 240)}`
      });
    }

    if (!assetRes.ok) {
      const t = await assetRes.text();
      return res.status(502).json({
        error: `CRM assets request failed (${assetRes.status}): ${t.slice(0, 240)}`
      });
    }

    const assets = normalizeCrmAssets(await assetRes.json(), base);
    return res.json({ crmConfigured: true, categories, assets });
  } catch (e) {
    return res.status(502).json({
      error: e instanceof Error ? e.message : 'CRM asset library request failed.'
    });
  }
});

app.use((err, _req, res, next) => {
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      error: `File is too large. Max upload size is ${Math.floor(uploadMaxBytes / (1024 * 1024))}MB.`
    });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request payload too large.' });
  }
  return next(err);
});

module.exports = app;

if (require.main === module) {
  const port = Number(process.env.PORT ?? 5050);
  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`avyro-editor backend listening on http://localhost:${port}`);
  });
}

