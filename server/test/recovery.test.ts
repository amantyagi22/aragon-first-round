// Worker crashes are real: the worker process is SIGKILLed mid-job, then a fresh one is started.
import type { ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { session, startApi, startWorker, stopWorker, waitForOutput } from './harness.js';

// Short stale window so reclaim happens quickly; one loop per worker so a worker never reclaims its own live job.
const WORKER_ENV = { WORKER_STALE_SECONDS: '1', WORKER_CONCURRENCY: '1' };
// HEIC decoding is the slowest job, which gives a wide window to kill the worker mid-processing.
const SLOW_FIXTURE = 'src/selfie.heic';

let api: Awaited<ReturnType<typeof startApi>>;
const workers: ChildProcess[] = [];
beforeAll(async () => {
  api = await startApi();
});
afterAll(async () => {
  api?.close();
  await Promise.all(workers.map(stopWorker));
});

/** Start a worker, wait until it has claimed this job (its own log line), then kill it mid-processing. */
async function crashWorkerMidJob(id: string) {
  const worker = await startWorker(WORKER_ENV);
  workers.push(worker);
  await waitForOutput(worker, `claimed ${id}`);
  await stopWorker(worker);
}

it('reclaims a job whose worker died, and finishes it', async () => {
  const s = session(api.base);
  const [id] = await s.upload([SLOW_FIXTURE]);
  await crashWorkerMidJob(id);

  workers.push(await startWorker(WORKER_ENV));
  const [image] = await s.settled([id]);
  expect(image.status).toBe('accepted');
  await Promise.all(workers.splice(0).map(stopWorker));
});

it('fails an image for good once every attempt has crashed', async () => {
  const s = session(api.base);
  const [id] = await s.upload([SLOW_FIXTURE]);
  for (let attempt = 1; attempt <= 3; attempt++) await crashWorkerMidJob(id);

  workers.push(await startWorker(WORKER_ENV));
  const [image] = await s.settled([id]);
  expect(image.status).toBe('failed');
});
