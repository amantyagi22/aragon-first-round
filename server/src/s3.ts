import { CreateBucketCommand, DeleteObjectsCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const Bucket = process.env.S3_BUCKET ?? 'images';
// S3_ENDPOINT points at the local S3-compatible store; unset it to talk to real AWS S3.
export const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT || undefined,
  region: process.env.S3_REGION ?? 'us-east-1',
  forcePathStyle: !!process.env.S3_ENDPOINT,
  credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID!, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY! },
});

export async function ensureBucket() {
  try { await s3.send(new HeadBucketCommand({ Bucket })); } catch { await s3.send(new CreateBucketCommand({ Bucket })); }
}

/** Browser uploads straight to storage; the policy caps size so the API never handles bytes. */
export const presignUpload = (Key: string) =>
  createPresignedPost(s3, { Bucket, Key, Conditions: [['content-length-range', 1, MAX_UPLOAD_BYTES]], Expires: 600 });

export const presignGet = (Key: string) => getSignedUrl(s3, new GetObjectCommand({ Bucket, Key }), { expiresIn: 3600 });

export async function exists(Key: string) {
  try { await s3.send(new HeadObjectCommand({ Bucket, Key })); return true; } catch { return false; }
}

export async function getBytes(Key: string) {
  const res = await s3.send(new GetObjectCommand({ Bucket, Key }));
  return Buffer.from(await res.Body!.transformToByteArray());
}

export const putJpeg = (Key: string, Body: Buffer) => s3.send(new PutObjectCommand({ Bucket, Key, Body, ContentType: 'image/jpeg' }));

export const deleteKeys = (keys: string[]) =>
  s3.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: keys.map((Key) => ({ Key })) } }));
