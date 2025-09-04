// scripts/set-bucket-cors.mjs
import 'dotenv/config';
import { S3Client, PutBucketCorsCommand, GetBucketCorsCommand } from '@aws-sdk/client-s3';

// Use a single allowed origin for now. You can change this later to your domain.
// Examples:
//   http://<YOUR_DROPLET_IP>
//   https://ipfs.yourdomain.com
const ORIGIN = process.env.CORS_ALLOWED_ORIGIN || 'http://134.209.115.217';

if (!process.env.FILEBASE_BUCKET) {
  console.error('Missing FILEBASE_BUCKET in .env');
  process.exit(1);
}

const s3 = new S3Client({
  region: process.env.FILEBASE_REGION,
  endpoint: process.env.FILEBASE_ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.FILEBASE_ACCESS_KEY,
    secretAccessKey: process.env.FILEBASE_SECRET_KEY,
  },
});

const corsConfig = {
  CORSConfiguration: {
    CORSRules: [
      {
        // Allow browser to send multipart uploads and read response headers
        AllowedOrigins: [ORIGIN],
        AllowedMethods: ['GET', 'PUT', 'POST', 'HEAD'],
        AllowedHeaders: ['*'],
        ExposeHeaders: ['ETag', 'x-amz-meta-cid', 'x-amz-request-id'],
        MaxAgeSeconds: 3000
      }
    ]
  },
  Bucket: process.env.FILEBASE_BUCKET
};

async function main() {
  console.log('Setting CORS for bucket:', process.env.FILEBASE_BUCKET);
  console.log('Allowed Origin:', ORIGIN);
  await s3.send(new PutBucketCorsCommand(corsConfig));
  const confirm = await s3.send(new GetBucketCorsCommand({ Bucket: process.env.FILEBASE_BUCKET }));
  console.log('✅ CORS set. Current rules:', JSON.stringify(confirm.CORSRules, null, 2));
}
main().catch(err => {
  console.error('❌ Failed to set CORS:', err);
  process.exit(1);
});
