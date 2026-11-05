import { defineConfig } from 'vitest/config';
process.loadEnvFile(new URL('../.env', import.meta.url).pathname);
export default defineConfig({ test: { testTimeout: 60_000, hookTimeout: 60_000, fileParallelism: false } });
