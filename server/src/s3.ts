import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { MAX_UPLOAD_BYTES } from 'shared';
import { PREVIEW_URL_WINDOW_SECONDS } from './config.js';

export const BUCKET = process.env.S3_BUCKET ?? 'images';

// S3_ENDPOINT points at local S3-compatible storage; leave it unset to use AWS S3.
export const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT || undefined,
  region: process.env.S3_REGION ?? 'us-east-1',
  forcePathStyle: !!process.env.S3_ENDPOINT,
  credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID!, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY! },
});

/** The policy pins key, content type, and size range, so storage refuses anything else before it is stored. */
export const presignUpload = (Key: string, contentType: string) =>
  createPresignedPost(s3, {
    Bucket: BUCKET,
    Key,
    Fields: { 'Content-Type': contentType },
    Conditions: [
      ['content-length-range', 1, MAX_UPLOAD_BYTES],
      ['eq', '$Content-Type', contentType],
    ],
    Expires: 600,
  });

/** Signed against the start of the current window, so the URL (and the browser cache) is stable across polls. */
export function presignPreview(Key: string) {
  const windowMs = PREVIEW_URL_WINDOW_SECONDS * 1000;
  const signingDate = new Date(Math.floor(Date.now() / windowMs) * windowMs);
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key }), {
    expiresIn: PREVIEW_URL_WINDOW_SECONDS * 2,
    signingDate,
  });
}

/** Stored size in bytes, or null if the object doesn't exist. */
export async function storedSize(Key: string): Promise<number | null> {
  try {
    return (await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key }))).ContentLength ?? null;
  } catch {
    return null;
  }
}

export async function getBytes(Key: string) {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key }));
  return Buffer.from(await res.Body!.transformToByteArray());
}

export const putJpeg = (Key: string, Body: Buffer) =>
  s3.send(new PutObjectCommand({ Bucket: BUCKET, Key, Body, ContentType: 'image/jpeg' }));

export const deleteObjects = (keys: string[]) =>
  s3.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: keys.map((Key) => ({ Key })) } }));
