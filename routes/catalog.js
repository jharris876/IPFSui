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

import { writeAudit, readAuditForKey } from '../lib/audit.js';

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

    const cid =
      head.Metadata?.cid ||
      head?.$metadata?.httpHeaders?.['x-amz-meta-cid'] ||
      null;

    const uploader =
      head.Metadata?.uploader ||
      head?.$metadata?.httpHeaders?.['x-amz-meta-uploader'] ||
      null;

    const gw = (process.env.FILEBASE_GATEWAY_URL || 'https://ipfs.filebase.io')
      .replace(/\/+$/, '');

    const url = cid ? `${gw}/ipfs/${cid}` : null;

    res.json({
      key,
      cid,
      url,
      uploader,
      contentType: head.ContentType || null,
      size: head.ContentLength || null,
    });
  } catch (err) {
    console.error('[catalog/item] error:', err);
    res.status(500).json({ error: 'failed to fetch item details' });
  }
});

// GET /api/catalog/history?key=...
// Returns audit history for a single key.
router.get('/history', async (req, res) => {
  try {
    const key = (req.query.key || '').toString();
    if (!key) {
      return res.status(400).json({ error: 'key required' });
    }

    const events = readAuditForKey(key);

    return res.json({
      key,
      events
    });
  } catch (err) {
    console.error('[catalog/history] error:', err);
    return res.status(500).json({ error: 'failed to read history' });
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

    if (newName.includes('/') || newName.trim() === '') {
      return res.status(400).json({ error: 'newName must be a plain filename (no slashes)' });
    }

    const slash = fromKey.lastIndexOf('/');
    const prefix = slash >= 0 ? fromKey.slice(0, slash + 1) : '';

    // detect auto/date/random prefixes
    const looksAuto = /^(\d{4}\/\d{2}\/\d{2}\/|[0-9a-fA-F-]{10,}\/)$/.test(prefix);

    // if it's auto → drop it, otherwise keep it
    const toKey = looksAuto ? newName : (prefix + newName);

    if (toKey === fromKey) {
      return res.json({
        ok: true,
        key: toKey,
        unchanged: true,
        lastModified: new Date().toISOString()
      });
    }

    const bucket = process.env.FILEBASE_BUCKET;

    // make sure source exists
    try {
      await s3.send(new HeadObjectCommand({
        Bucket: bucket,
        Key: fromKey
      }));
    } catch {
      return res.status(404).json({ error: 'source not found' });
    }

    // prevent overwrite
    try {
      await s3.send(new HeadObjectCommand({
        Bucket: bucket,
        Key: toKey
      }));
      return res.status(409).json({ error: 'destination already exists' });
    } catch {
      // ok, dest does not exist
    }

    const copySource = `/${bucket}/${encodeURI(fromKey)}`;

    await s3.send(new CopyObjectCommand({
      Bucket: bucket,
      Key: toKey,
      CopySource: copySource
    }));

    await s3.send(new DeleteObjectCommand({
      Bucket: bucket,
      Key: fromKey
    }));

    writeAudit({
      action: 'rename',
      key: toKey,       // new key
      fromKey,          // old key
      user: 'unknown'   // will be real user later
    });

    return res.json({
      key: toKey,
      lastModified: new Date().toISOString()
    });
  } catch (err) {
    console.error('[catalog/rename] error:', err);
    return res.status(500).json({ error: 'rename failed' });
  }
});

export default router;
