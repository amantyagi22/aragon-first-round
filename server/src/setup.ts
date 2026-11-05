// One-shot local setup: private bucket + CORS for the web origin, then migrations. Safe to re-run.
import { CreateBucketCommand, HeadBucketCommand, PutBucketCorsCommand } from '@aws-sdk/client-s3';
import { BUCKET, s3 } from './s3.js';
import { db } from './db.js';

try {
  await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
} catch {
  await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
}
await s3.send(
  new PutBucketCorsCommand({
    Bucket: BUCKET,
    CORSConfiguration: {
      CORSRules: [
        {
          AllowedOrigins: [process.env.WEB_ORIGIN!],
          AllowedMethods: ['GET', 'POST'],
          AllowedHeaders: ['*'],
          MaxAgeSeconds: 3600,
        },
      ],
    },
  }),
);
console.log(`bucket "${BUCKET}" ready, CORS allows ${process.env.WEB_ORIGIN}`);

const [, applied] = await db.migrate.latest({
  directory: new URL('./migrations', import.meta.url).pathname,
  loadExtensions: ['.ts'],
});
console.log(applied.length ? `migrated: ${applied.join(', ')}` : 'database up to date');
await db.destroy();
