// Needs `docker compose up -d` + migrations. Exercises the real HTTP API, storage, and worker end to end.
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { ensureBucket } from '../src/s3.js';
import { db } from '../src/db.js';
import { drain } from '../src/worker.js';

let base: string;
let server: ReturnType<ReturnType<typeof createApp>['listen']>;
beforeAll(async () => {
  await ensureBucket();
  server = createApp().listen(0);
  base = `http://localhost:${(server.address() as AddressInfo).port}/api/images`;
});
afterAll(async () => { server?.close(); await db.destroy(); });

function client(sessionId = randomUUID()) {
  const call = (path: string, init: RequestInit = {}) =>
    fetch(base + path, { ...init, headers: { 'content-type': 'application/json', 'x-session-id': sessionId, ...init.headers } });
  return {
    call,
    /** What the browser does: reserve, POST bytes straight to storage, mark complete. */
    async upload(files: string[]) {
      const bodies = await Promise.all(files.map((f) => readFile(new URL(`./fixtures/${f}`, import.meta.url))));
      const res = await call('', { method: 'POST', body: JSON.stringify({ files: files.map((f, i) => ({ filename: f, contentType: f.endsWith('.png') ? 'image/png' : 'image/jpeg', size: bodies[i].length })) }) });
      expect(res.status).toBe(201);
      const { images } = await res.json();
      for (const [i, img] of images.entries()) {
        const form = new FormData();
        for (const [k, v] of Object.entries(img.upload.fields)) form.append(k, v as string);
        form.append('file', new Blob([bodies[i]]));
        const put = await fetch(img.upload.url, { method: 'POST', body: form });
        expect(put.ok).toBe(true);
        expect((await call(`/${img.id}/complete`, { method: 'POST' })).status).toBe(202);
      }
      return images.map((i: { id: string }) => i.id) as string[];
    },
    async list() { return (await (await call('')).json()).images as Array<{ id: string; status: string; reason: string | null; url: string | null }>; },
  };
}

describe('image upload API', () => {
  it('uploads, processes asynchronously, and categorises images', async () => {
    const c = client();
    const [good, blurry] = await c.upload(['ok-selfie.jpg', 'blurry.jpg']);
    expect((await c.list()).every((i) => i.status === 'queued')).toBe(true);

    await drain();
    const byId = Object.fromEntries((await c.list()).map((i) => [i.id, i]));
    expect(byId[good]).toMatchObject({ status: 'accepted', reason: null });
    expect(byId[blurry]).toMatchObject({ status: 'rejected', reason: 'blurry' });
    expect((await fetch(byId[good].url!)).headers.get('content-type')).toBe('image/jpeg');
  });

  it('isolates sessions and deletes images', async () => {
    const owner = client();
    const [id] = await owner.upload(['ok-headshot.png']);
    expect((await client().call(`/${id}`)).status).toBe(404);
    expect((await owner.call(`/${id}`, { method: 'DELETE' })).status).toBe(204);
    expect(await owner.list()).toEqual([]);
  });

  it('rejects requests without a session and disallowed content types', async () => {
    expect((await fetch(base)).status).toBe(401);
    const res = await client().call('', { method: 'POST', body: JSON.stringify({ files: [{ filename: 'x.gif', contentType: 'image/gif', size: 10 }] }) });
    expect(res.status).toBe(400);
  });

  it('accepts only one of two near-duplicates even when processed concurrently', async () => {
    const c = client();
    await c.upload(['ok-selfie.jpg', 'similar-selfie.jpg']);
    await drain(2); // two workers, each claims one of the pair at the same time
    const statuses = (await c.list()).map((i) => i.reason ?? i.status).sort();
    expect(statuses).toEqual(['accepted', 'too_similar']);
  });
});
