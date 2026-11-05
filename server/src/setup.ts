// One-shot setup: create the database if missing, a private bucket with CORS for the web origin, then migrations.
// Safe to re-run. `pnpm infra` runs it for dev; the test suite runs it against the test database and bucket.
import { CreateBucketCommand, HeadBucketCommand, PutBucketCorsCommand } from '@aws-sdk/client-s3';
import knex from 'knex';
import { BUCKET, s3 } from './s3.js';
import { db } from './db.js';

async function ensureDatabase() {
  const url = new URL(process.env.DATABASE_URL!);
  const name = url.pathname.slice(1);
  url.pathname = '/postgres';
  const admin = knex({ client: 'pg', connection: url.toString() });
  try {
    const { rows } = await admin.raw('SELECT 1 FROM pg_database WHERE datname = ?', [name]);
    if (!rows.length) await admin.raw('CREATE DATABASE ??', [name]);
  } finally {
    await admin.destroy();
  }
}

async function ensureBucket() {
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
}

export async function bootstrap() {
  await ensureDatabase();
  await ensureBucket();
  const [, applied] = await db.migrate.latest({
    directory: new URL('./migrations', import.meta.url).pathname,
    loadExtensions: ['.ts'],
  });
  await db.destroy();
  return applied as string[];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const applied = await bootstrap();
  console.log(`bucket "${BUCKET}" ready, CORS allows ${process.env.WEB_ORIGIN}`);
  console.log(applied.length ? `migrated: ${applied.join(', ')}` : 'database up to date');
}
