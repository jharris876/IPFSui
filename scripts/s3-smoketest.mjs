import 'dotenv/config';
import { S3Client, HeadBucketCommand } from '@aws-sdk/client-s3';

const s3 = new S3Client({
	region: process.env.FILEBASE_REGION,
	endpoint: process.env.FILEBASE_ENDPOINT,
	forcePathStyle: true,
	credentials: {
		accessKeyId: process.env.FILEBASE_ACCESS_KEY,
		secretAccessKey: process.env.FILEBASE_SECRET_KEY,
	},
});

async function main() {
	try {
		await s3.send(new HeadBucketCommand({ Bucket: process.env.FILEBASE_BUCKET }));
		console.log('Filebnase bucket is reachable.');
	} catch (err) {
		console.error('Cannot reach Filebase bucket: ', err?.name, err?.message);
		process.exit(1);
	}
}
main()

