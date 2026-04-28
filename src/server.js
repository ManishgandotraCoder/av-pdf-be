const express = require('express');
const cors = require('cors');
const multer = require('multer');

const store = require('./store');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());

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

// For PUT of raw PDF bytes.
app.use(
  '/api/pdfs/:id',
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
    const meta = await store.putNew({ name: file.originalname, bytes: file.buffer });
    res.json(meta);
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'Upload failed.' });
  }
});

app.get('/api/pdfs/:id/meta', async (req, res) => {
  try {
    const meta = await store.getMeta(req.params.id);
    if (!meta) return res.status(404).json({ error: 'Not found.' });
    res.json(meta);
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

module.exports = app;

if (require.main === module) {
  const port = Number(process.env.PORT ?? 5050);
  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`avyro-editor backend listening on http://localhost:${port}`);
  });
}

