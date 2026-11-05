// Test seam: the public HTTP API, with the real worker process, storage, and Postgres from docker-compose.
// Each test uses a fresh session id, which isolates tests without resetting the database.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { SETTLED_STATUSES, type ImageDto } from 'shared';
import { createApp } from '../src/app.js';

export async function startApi() {
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  return { base: `http://localhost:${(server.address() as AddressInfo).port}/api/images`, close: () => server.close() };
}

const workerOutput = new WeakMap<ChildProcess, string>();

/** Starts a real worker process and resolves once its face model is loaded. */
export function startWorker(env: Record<string, string> = {}): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/worker.ts'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  workerOutput.set(child, '');
  child.stdout!.on('data', (d: Buffer) => workerOutput.set(child, workerOutput.get(child) + d.toString()));
  return waitForOutput(child, 'worker ready').then(() => child);
}

/** Resolves once the worker has printed `text`, including output printed before this was called. */
export function waitForOutput(child: ChildProcess, text: string) {
  return new Promise<void>((resolve, reject) => {
    const check = () => workerOutput.get(child)!.includes(text) && (child.stdout!.off('data', check), resolve());
    child.stdout!.on('data', check);
    child.once('exit', (code) => reject(new Error(`worker exited (${code}) before printing "${text}"`)));
    queueMicrotask(check);
  });
}

export const stopWorker = (w: ChildProcess) =>
  new Promise<void>((r) =>
    w.exitCode !== null || w.signalCode !== null ? r() : (w.once('exit', () => r()), w.kill('SIGKILL')),
  );

const fixture = (name: string) => readFile(new URL(`./fixtures/${name}`, import.meta.url));
const MIME: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', heic: 'image/heic', gif: 'image/gif' };
export const mimeOf = (name: string) => MIME[name.split('.').pop()!];

type Reservation = { id: string; upload: { url: string; fields: Record<string, string> } };

export function postToStorage(r: Reservation, body: Buffer) {
  const form = new FormData();
  for (const [k, v] of Object.entries(r.upload.fields)) form.append(k, v);
  form.append('file', new Blob([new Uint8Array(body)]));
  return fetch(r.upload.url, { method: 'POST', body: form });
}

/** A browser session: talks to the API exactly the way the web app does. */
export function session(base: string, id = randomUUID()) {
  const call = (path: string, init: RequestInit = {}) =>
    fetch(base + path, {
      ...init,
      headers: { 'content-type': 'application/json', 'x-session-id': id, ...init.headers },
    });
  const json = async <T>(res: Response | Promise<Response>) => (await res).json() as Promise<T>;

  async function reserve(files: Array<{ filename: string; contentType: string; size: number }>) {
    const res = await call('', { method: 'POST', body: JSON.stringify({ files }) });
    if (res.status !== 201) throw new Error(`reserve failed: ${res.status} ${await res.text()}`);
    return (await json<{ images: Reservation[] }>(res)).images;
  }

  /** Reserve, upload straight to storage, then (unless told not to) mark complete. */
  async function upload(names: string[], { complete = true } = {}) {
    const bodies = await Promise.all(names.map(fixture));
    const reservations = await reserve(
      names.map((n, i) => ({ filename: n, contentType: mimeOf(n), size: bodies[i].length })),
    );
    await Promise.all(
      reservations.map(async (r, i) => {
        const res = await postToStorage(r, bodies[i]);
        if (!res.ok) throw new Error(`storage refused ${names[i]}: ${res.status}`);
      }),
    );
    const ids = reservations.map((r) => r.id);
    if (complete) await Promise.all(ids.map((i) => completeUpload(i)));
    return ids;
  }

  const completeUpload = (imageId: string) => call(`/${imageId}/complete`, { method: 'POST' });
  const get = (imageId: string) => json<ImageDto>(call(`/${imageId}`));
  const list = async () => (await json<{ images: ImageDto[] }>(call(''))).images;

  /** Poll like the web app does until every given image has settled. */
  async function settled(ids: string[], timeoutMs = 60_000): Promise<ImageDto[]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const all = await Promise.all(ids.map(get));
      if (all.every((i) => SETTLED_STATUSES.includes(i.status))) return all;
      if (Date.now() > deadline)
        throw new Error(`not settled: ${all.map((i) => `${i.filename}=${i.status}`).join(', ')}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  async function uploadAndSettle(names: string[]) {
    return settled(await upload(names));
  }

  return { id, call, reserve, upload, completeUpload, get, list, settled, uploadAndSettle };
}
