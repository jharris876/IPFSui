// routes/multipart.js
import express from 'express';
import 'dotenv/config';
import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  HeadObjectCommand
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const router = express.Router();

/**
 * S3 client (Filebase)
 */
const s3 = new S3Client({
  region: process.env.FILEBASE_REGION,
  endpoint: process.env.FILEBASE_ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.FILEBASE_ACCESS_KEY,
    secretAccessKey: process.env.FILEBASE_SECRET_KEY,
  },
});

/**
 * Choose an adaptive part size so we never exceed 10,000 parts,
 * but also avoid overly large chunks. Buckets: 8–512 MiB.
 */
function choosePartSize(totalBytes) {
  const bucketsMiB = [8, 16, 32, 64, 128, 256, 512]; // you can tune these
  // Minimum per S3 is 5 MiB — we use 8 MiB as a safer floor.
  const minNeeded = Math.ceil(totalBytes / 10000); // bytes per part to stay <= 10k parts
  for (const m of bucketsMiB) {
    if (m * 1024 * 1024 >= minNeeded) return m * 1024 * 1024;
  }
  return 512 * 1024 * 1024; // cap at 512 MiB
}

/**
 * Helper to build a dated key prefix like 2025/09/04/
 */
function datedPrefix(d = new Date()) {
  const iso = d.toISOString().slice(0, 10); // YYYY-MM-DD
  return iso.replace(/-/g, '/'); // YYYY/MM/DD
}

/**
 * POST /api/multipart/create
 * Body: { filename, contentType, fileSize }
 * Resp: { uploadId, key, partSize }
 */
router.post('/create', async (req, res) => {
  try {
    const { filename, contentType, fileSize } = req.body || {};
    if (!filename) {
      return res.status(400).json({ error: 'filename required' });
    }
    if (!Number.isFinite(fileSize) || fileSize <= 0) {
      return res.status(400).json({ error: 'fileSize (bytes) required' });
    }

    const partSize = choosePartSize(Number(fileSize));

    // 1) take what the user sent
    let clean = filename.trim();

    // 2) EXTRA hardening: no slashes, no empty
    if (!clean || clean === '.' || clean.includes('\\')) {
      return res.status(400).json({ error: 'bad filename' });
    }
    // disallow `/` so we don’t get 2025/09/.. leaks from the client
    if (clean.includes('/')) {
      return res.status(400).json({ error: 'filename must not contain /' });
    }

    // 3) final key: JUST the name
    // if later you want a fixed folder, do: const key = `uploads/${clean}`;
    const key = clean;

    const createCmd = new CreateMultipartUploadCommand({
      Bucket: process.env.FILEBASE_BUCKET,
      Key: key,
      ContentType: contentType || 'application/octet-stream',
      // Metadata: {...}   // still available
    });

    const resp = await s3.send(createCmd);
    return res.json({
      uploadId: resp.UploadId,
      key,
      partSize,
    });
  } catch (err) {
    console.error('[multipart/create] error:', err);
    return res.status(500).json({ error: 'failed to create multipart upload' });
  }
});

/**
 * GET /api/multipart/sign?key=...&uploadId=...&partNumber=...
 * Resp: { url }
 */
router.get('/sign', async (req, res) => {
  try {
    const { key, uploadId, partNumber } = req.query;
    if (!key || !uploadId || !partNumber) {
      return res.status(400).json({ error: 'key, uploadId, partNumber required' });
    }
    const pn = Number(partNumber);
    if (!Number.isInteger(pn) || pn < 1 || pn > 10000) {
      return res.status(400).json({ error: 'partNumber must be an integer 1..10000' });
    }

    const cmd = new UploadPartCommand({
      Bucket: process.env.FILEBASE_BUCKET,
      Key: String(key),
      UploadId: String(uploadId),
      PartNumber: pn,
    });

    const url = await getSignedUrl(s3, cmd, { expiresIn: 60 * 60 }); // 1 hour
    return res.json({ url });
  } catch (err) {
    console.error('[multipart/sign] error:', err);
    return res.status(500).json({ error: 'failed to sign upload part' });
  }
});

/**
 * POST /api/multipart/complete
 * Body: { key, uploadId, parts: [{ ETag, PartNumber }] }
 * Resp: { key, cid, url }
 */
router.post('/complete', async (req, res) => {
  try {
    const { key, uploadId, parts, uploader } = req.body || {};
    if (!key || !uploadId || !Array.isArray(parts) || parts.length === 0) {
      return res.status(400).json({ error: 'key, uploadId and parts are required' });
    }

    // use provided uploader, or env default, or fallback
    const finalUploader =
      uploader ||
      process.env.DEFAULT_UPLOADER ||
      'system';

    const out = await s3.send(new CompleteMultipartUploadCommand({
      Bucket: process.env.FILEBASE_BUCKET,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: {
        Parts: parts.map(p => ({
          ETag: p.ETag,
          PartNumber: p.PartNumber
        }))
      },
      // Filebase lets us keep metadata on complete
      Metadata: {
        uploader: finalUploader
      }
}));

//Complete error handler
const cid = out?.$metadata?.httpHeaders?.['x-amz-meta-cid'] || null;

return res.json({
      key,
      cid,
      uploader: finalUploader
    });
  } catch (err) {
    console.error('[multipart/complete] error:', err);
    return res.status(500).json({ error: 'complete failed' });
  }
});

/**
 * POST /api/multipart/abort
 * Body: { key, uploadId }
 * Resp: { aborted: true }
 */
router.post('/abort', async (req, res) => {
  try {
    const { key, uploadId } = req.body || {};
    if (!key || !uploadId) return res.status(400).json({ error: 'key and uploadId required' });

    const abortCmd = new AbortMultipartUploadCommand({
      Bucket: process.env.FILEBASE_BUCKET,
      Key: key,
      UploadId: uploadId,
    });
    await s3.send(abortCmd);
    return res.json({ aborted: true });
  } catch (err) {
    console.error('[multipart/abort] error:', err);
    return res.status(500).json({ error: 'failed to abort multipart upload' });
  }
});

export default router;
