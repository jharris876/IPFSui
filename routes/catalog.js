// routes/catalog.js
import express from 'express';
import 'dotenv/config';
import {
  S3Client,
  ListObjectsV2Command,
  HeadObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand
} from '@aws-sdk/client-s3';


const router = express.Router();

// Filebase (S3-compatible) client
const s3 = new S3Client({
  region: process.env.FILEBASE_REGION,
  endpoint: process.env.FILEBASE_ENDPOINT, // e.g. https://s3.filebase.com
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.FILEBASE_ACCESS_KEY,
    secretAccessKey: process.env.FILEBASE_SECRET_KEY,
  },
});

// GET /api/catalog/list?prefix=&max=50&token=...
// Lists objects in the bucket with optional prefix and pagination.
router.get('/list', async (req, res) => {
  try {
    const prefix = (req.query.prefix || '').toString();
    const max    = Math.min(Number(req.query.max) || 50, 100); // cap page size
    const token  = req.query.token ? String(req.query.token) : undefined;

    const out = await s3.send(new ListObjectsV2Command({
      Bucket: process.env.FILEBASE_BUCKET,
      Prefix: prefix || undefined,
      MaxKeys: max,
      ContinuationToken: token,
    }));

    const items = (out.Contents || []).map(o => ({
      key: o.Key,
      size: Number(o.Size),
      lastModified: o.LastModified ? new Date(o.LastModified).toISOString() : null,
    }));

    res.json({
      prefix,
      items,
      isTruncated: !!out.IsTruncated,
      nextToken: out.NextContinuationToken || null,
    });
  } catch (err) {
    console.error('[catalog/list] error:', err);
    res.status(500).json({ error: 'failed to list objects' });
  }
});

// GET /api/catalog/item?key=... 
// Returns CID + gateway URL for a specific object key.
router.get('/item', async (req, res) => {
  try {
    const key = (req.query.key || '').toString();
    if (!key) return res.status(400).json({ error: 'key required' });

    const head = await s3.send(new HeadObjectCommand({
      Bucket: process.env.FILEBASE_BUCKET,
      Key: key,
    }));

    // Filebase exposes CID via metadata header
    const cid =
      head.Metadata?.cid ||
      head?.$metadata?.httpHeaders?.['x-amz-meta-cid'] ||
      null;

    const gw = (process.env.FILEBASE_GATEWAY_URL || 'https://ipfs.filebase.io')
      .replace(/\/+$/, '');

    const url = cid ? `${gw}/ipfs/${cid}` : null;

    res.json({
      key,
      cid,
      url,
      contentType: head.ContentType || null,
      size: head.ContentLength || null,
    });
  } catch (err) {
    console.error('[catalog/item] error:', err);
    res.status(500).json({ error: 'failed to fetch item details' });
  }
});

// POST /api/catalog/rename  { fromKey, newName }
// Renames within the same prefix ("folder"). Preserves metadata and tags.
router.post('/rename', express.json(), async (req, res) => {
  try {
    const { fromKey, newName } = req.body || {};
    if (!fromKey || !newName) {
      return res.status(400).json({ error: 'fromKey and newName are required' });
    }

    // basic validation: plain filename only
    if (newName.includes('/') || newName.trim() === '') {
      return res.status(400).json({ error: 'newName must be a plain filename (no slashes)' });
    }

    // keep same prefix as fromKey
    const slash = fromKey.lastIndexOf('/');
    const prefix = slash >= 0 ? fromKey.slice(0, slash + 1) : '';
    const toKey = prefix + newName;

    if (toKey === fromKey) {
      return res.json({ ok: true, key: toKey, unchanged: true });
    }

    // ensure source exists
    try {
      await s3.send(new HeadObjectCommand({
        Bucket: process.env.FILEBASE_BUCKET,
        Key: fromKey
      }));
    } catch {
      return res.status(404).json({ error: 'source not found' });
    }

    // prevent overwrite if destination exists
    try {
      await s3.send(new HeadObjectCommand({
        Bucket: process.env.FILEBASE_BUCKET,
        Key: toKey
      }));
      return res.status(409).json({ error: 'destination already exists' });
    } catch {
      // destination does not exist — proceed
    }

    // Copy (S3 "rename" = copy new key, then delete old)
    const copySource = `${process.env.FILEBASE_BUCKET}/${encodeURIComponent(fromKey)}`;
    await s3.send(new CopyObjectCommand({
      Bucket: process.env.FILEBASE_BUCKET,
      Key: toKey,
      CopySource: copySource,
      MetadataDirective: 'COPY',
      TaggingDirective: 'COPY'
    }));

    await s3.send(new DeleteObjectCommand({
      Bucket: process.env.FILEBASE_BUCKET,
      Key: fromKey
    }));

    // (Optional) write audit row here

    return res.json({ ok: true, key: toKey });
  } catch (err) {
    console.error('[catalog/rename] error:', err);
    return res.status(500).json({ error: 'rename failed' });
  }
});

export default router;
