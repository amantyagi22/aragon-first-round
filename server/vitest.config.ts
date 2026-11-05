import { defineConfig } from 'vitest/config';

// Tests use their own database and bucket, so `pnpm test` can run while `pnpm dev` is up
// without the dev worker stealing test jobs (or tests filling the dev gallery).
process.loadEnvFile(new URL('../.env', import.meta.url).pathname);
const databaseUrl = new URL(process.env.DATABASE_URL!);
databaseUrl.pathname = `${databaseUrl.pathname}_test`;
process.env.DATABASE_URL = databaseUrl.toString();
process.env.S3_BUCKET = `${process.env.S3_BUCKET ?? 'images'}-test`;

export default defineConfig({
  test: {
    globalSetup: './test/global-setup.ts',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
