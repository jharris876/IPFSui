// lib/s3.js
import 'dotenv/config';
import fs from 'fs';
import { S3Client, HeadObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';

export const s3 = new S3Client({
  region: process.env.FILEBASE_REGION,
  endpoint: process.env.FILEBASE_ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.FILEBASE_ACCESS_KEY,
    secretAccessKey: process.env.FILEBASE_SECRET_KEY,
  },
});

export async function uploadFileToFilebase(localPath, key, contentType) {
  const fileStream = fs.createReadStream(localPath);

  // Multipart upload (handles big files)
  const uploader = new Upload({
    client: s3,
    params: {
      Bucket: process.env.FILEBASE_BUCKET,
      Key: key,
      Body: fileStream,
      ContentType: contentType || 'application/octet-stream',
    },
    leavePartsOnError: false,
  });

  await uploader.done();

  // After upload, Filebase exposes the IPFS CID via HEAD metadata/header
  const head = await s3.send(
    new HeadObjectCommand({ Bucket: process.env.FILEBASE_BUCKET, Key: key })
  );

  // Try both places: Metadata.cid or raw header
  const cidFromMetadata = head.Metadata?.cid;
  const cidFromHeader = head?.$metadata?.httpHeaders?.['x-amz-meta-cid'];
  const cid = cidFromMetadata || cidFromHeader;

  const gw = (process.env.FILEBASE_GATEWAY_URL || 'https://ipfs.filebase.io').replace(/\/+$/, '');
  const url = cid ? `${gw}/ipfs/${cid}` : null;

  return { cid, url, key };
}
