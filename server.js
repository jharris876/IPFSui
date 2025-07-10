// server.js
import express from 'express';
import multer from 'multer';
import { create } from 'ipfs-http-client';
import path from 'path';
import { fileURLToPath } from 'url';
import httpProxy from 'http-proxy';

// Derive __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 1) Create the app
const app = express();

// ——— REQUEST LOGGER ———
app.use((req, res, next) => {
  console.log('[REQ]', req.method, req.originalUrl);
  next();
});

// 2) Connect to IPFS daemon
const ipfs = create({ url: 'http://localhost:5001/api/v0' });

// 3) Multer in-memory
const upload = multer({ storage: multer.memoryStorage() });

// Proxy /ipfs/* → your local IPFS gateway on :8080
const proxy = httpProxy.createProxyServer();
app.get('/ipfs/:cid', (req, res) => {
  proxy.web(
    req,
    res,
    { target: 'http://127.0.0.1:8080' },
    err => {
      console.error('[PROXY ERROR]', err);
      res.sendStatus(502);
    }
  );
});

// 4) Static UI
app.use(express.static(path.join(__dirname, 'public')));

// 5) Upload endpoint
app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  try {
    const { buffer, originalname } = req.file;
    const result = await ipfs.add({ path: originalname, content: buffer });
    return res.json({ cid: result.cid.toString() });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'IPFS upload failed' });
  }
});

// 6) Only start the server if this file is run directly
if (process.env.NODE_ENV !== 'test') {
  const port = process.env.PORT || 3000;
  app.listen(port, () =>
    console.log(`Server running on http://localhost:${port}`)
  );
}

// 7) Export the app for testing
export default app;