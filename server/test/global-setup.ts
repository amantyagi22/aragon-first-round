// Creates and migrates the test database and bucket before any test file runs.
// Runs the setup script under tsx (Vitest's main process can't load the .ts migrations itself);
// it inherits the test DATABASE_URL and S3_BUCKET set in vitest.config.ts.
import { execFileSync } from 'node:child_process';

export function setup() {
  execFileSync(process.execPath, ['--import', 'tsx', 'src/setup.ts'], {
    cwd: new URL('..', import.meta.url).pathname,
    stdio: 'inherit',
  });
}
