/**
 * Line-faithful port of Nest StorageService.upload for migration scripts.
 * Canonical source:
 *   tasdeeq/apps/api/src/common/storage/storage.service.ts
 *
 * Same env vars, key formula (`${folder}/${uuid}.${ext}`), and PutObject shape.
 * Returns the object key only — never a signed URL.
 */
const { randomUUID } = require('crypto');
const {
  S3Client,
  PutObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
} = require('@aws-sdk/client-s3');

let client = null;
let bucket = null;
let bucketReady = null;

function getClient() {
  if (client) return client;

  bucket = process.env.S3_BUCKET ?? 'tasdeeq';
  const endpoint = process.env.S3_ENDPOINT ?? 'http://127.0.0.1:9000';
  const isAws = endpoint.includes('amazonaws.com');
  client = new S3Client({
    ...(isAws ? {} : { endpoint }),
    region: process.env.S3_REGION ?? 'us-east-1',
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY ?? 'minioadmin',
      secretAccessKey: process.env.S3_SECRET_KEY ?? 'minioadmin',
    },
    forcePathStyle: !isAws,
  });
  return client;
}

async function ensureBucket() {
  if (bucketReady) return bucketReady;
  bucketReady = (async () => {
    const s3 = getClient();
    try {
      await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch (err) {
      const code = err?.name ?? err?.Code;
      if (code === 'NotFound' || code === 'NoSuchBucket' || code === '404') {
        await s3.send(new CreateBucketCommand({ Bucket: bucket }));
      } else {
        throw err;
      }
    }
  })();
  return bucketReady;
}

/**
 * Mirrors StorageService.upload(buffer, originalName, mimeType, folder).
 * @returns {Promise<string>} object key e.g. worker-documents/<uuid>.png
 */
async function uploadToMinio(buffer, originalName, mimeType, folder = 'uploads') {
  await ensureBucket();
  const s3 = getClient();
  const ext = String(originalName || 'file').split('.').pop() || 'bin';
  const key = `${folder}/${randomUUID()}.${ext}`;

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: mimeType || 'application/octet-stream',
    })
  );

  return key;
}

module.exports = { uploadToMinio, ensureBucket, getClient };
