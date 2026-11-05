import type { ChildProcess } from 'node:child_process';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_UPLOAD_BYTES } from 'shared';
import { postToStorage, session, startApi, startWorker, stopWorker } from './harness.js';

let api: Awaited<ReturnType<typeof startApi>>;
let worker: ChildProcess;
beforeAll(async () => {
  [api, worker] = await Promise.all([startApi(), startWorker({ WORKER_CONCURRENCY: '4' })]);
});
afterAll(async () => {
  api?.close();
  if (worker) await stopWorker(worker);
});
const newSession = () => session(api.base);

describe('validation rules', () => {
  // Each fixture in its own session, so similarity between fixtures can't interfere.
  it.each([
    ['ok-selfie.jpg', null],
    ['ok-second-selfie.jpg', null],
    ['ok-headshot.png', null],
    ['src/selfie.heic', null],
    ['portrait-mode.jpg', null],
    ['sideways-exif.jpg', null],
    ['pdf-renamed.jpg', 'unsupported_format'],
    ['tiny-thumbnail.jpg', 'file_too_small'],
    ['corrupt.jpg', 'corrupt'],
    ['low-resolution.jpg', 'low_resolution'],
    ['no-face-landscape.jpg', 'no_face'],
    ['group.jpg', 'multiple_faces'],
    ['face-too-small.jpg', 'face_too_small'],
    ['blurry.jpg', 'blurry'],
  ] as const)('%s -> %s', async (file, reason) => {
    const [image] = await newSession().uploadAndSettle([file]);
    expect({ status: image.status, reason: image.reason }).toEqual({
      status: reason ? 'rejected' : 'accepted',
      reason,
    });
    if (reason) expect(image.reasonDetail).toBeTruthy();
  });

  it('serves the HEIC as a viewable JPEG preview', async () => {
    const [image] = await newSession().uploadAndSettle(['src/selfie.heic']);
    const preview = await fetch(image.url!);
    expect(preview.headers.get('content-type')).toBe('image/jpeg');
    expect((await sharp(Buffer.from(await preview.arrayBuffer())).metadata()).format).toBe('jpeg');
  });

  it('previews a sideways-tagged photo upright, with all metadata stripped', async () => {
    const [image] = await newSession().uploadAndSettle(['sideways-exif.jpg']);
    const meta = await sharp(Buffer.from(await (await fetch(image.url!)).arrayBuffer())).metadata();
    expect(meta.height).toBeGreaterThan(meta.width!);
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
  });
});

describe('similarity', () => {
  it('accepts two different photos of the same person', async () => {
    const images = await newSession().uploadAndSettle(['ok-selfie.jpg', 'ok-second-selfie.jpg']);
    expect(images.map((i) => i.status)).toEqual(['accepted', 'accepted']);
  });

  it('rejects a near-duplicate of an accepted photo, but only within the same session', async () => {
    const s = newSession();
    await s.uploadAndSettle(['ok-selfie.jpg']);
    const [dupe] = await s.uploadAndSettle(['near-duplicate.jpg']);
    expect(dupe).toMatchObject({ status: 'rejected', reason: 'too_similar' });

    const [elsewhere] = await newSession().uploadAndSettle(['near-duplicate.jpg']);
    expect(elsewhere.status).toBe('accepted');
  });

  it('accepts exactly one of two near-duplicates completed at the same moment', async () => {
    const s = newSession();
    const ids = await s.upload(['ok-selfie.jpg', 'near-duplicate.jpg'], { complete: false });
    await Promise.all(ids.map(s.completeUpload));
    const outcomes = (await s.settled(ids)).map((i) => i.reason ?? i.status).sort();
    expect(outcomes).toEqual(['accepted', 'too_similar']);
  });
});

describe('managing the set', () => {
  it('deletes an image from the list and storage, freeing its slot for a similar photo', async () => {
    const s = newSession();
    const [selfie] = await s.uploadAndSettle(['ok-selfie.jpg']);
    expect((await s.call(`/${selfie.id}`, { method: 'DELETE' })).status).toBe(204);
    expect(await s.list()).toEqual([]);
    expect((await fetch(selfie.url!)).status).toBe(404);

    const [dupe] = await s.uploadAndSettle(['near-duplicate.jpg']);
    expect(dupe.status).toBe('accepted');
  });

  it('completing an upload twice processes it once and returns the current state', async () => {
    const s = newSession();
    const [id] = await s.upload(['ok-selfie.jpg'], { complete: false });
    const [a, b] = await Promise.all([s.completeUpload(id), s.completeUpload(id)]);
    expect([a.status, b.status]).toEqual([202, 202]);
    await s.settled([id]);
    const again = await s.completeUpload(id);
    expect((await again.json()).status).toBe('accepted');
  });

  it('hides images from other sessions', async () => {
    const owner = newSession();
    const [id] = await owner.upload(['ok-headshot.png'], { complete: false });
    const stranger = newSession();
    expect((await stranger.call(`/${id}`)).status).toBe(404);
    expect((await stranger.call(`/${id}`, { method: 'DELETE' })).status).toBe(404);
    expect((await stranger.call(`/${id}/complete`, { method: 'POST' })).status).toBe(404);
    expect(await stranger.list()).toEqual([]);
    expect((await owner.list()).map((i) => i.id)).toEqual([id]);
  });

  it('lists newest first', async () => {
    const s = newSession();
    const [first] = await s.upload(['ok-selfie.jpg'], { complete: false });
    const [second] = await s.upload(['ok-headshot.png'], { complete: false });
    expect((await s.list()).map((i) => i.id)).toEqual([second, first]);
  });
});

describe('edge security', () => {
  it('refuses an upload larger than the limit at the storage layer', async () => {
    const s = newSession();
    const [reservation] = await s.reserve([{ filename: 'huge.jpg', contentType: 'image/jpeg', size: 1000 }]);
    const res = await postToStorage(reservation, Buffer.alloc(MAX_UPLOAD_BYTES + 1));
    expect(res.ok).toBe(false);
    expect((await s.completeUpload(reservation.id)).status).toBe(409);
  });

  it('refuses an upload whose content type differs from the one reserved', async () => {
    const s = newSession();
    const [reservation] = await s.reserve([{ filename: 'a.png', contentType: 'image/png', size: 1000 }]);
    reservation.upload.fields['Content-Type'] = 'text/html';
    expect((await postToStorage(reservation, Buffer.alloc(1000))).ok).toBe(false);
  });

  it('rejects requests without a valid session header', async () => {
    expect((await fetch(api.base)).status).toBe(401);
    expect((await fetch(api.base, { headers: { 'x-session-id': 'not-a-uuid' } })).status).toBe(401);
  });

  it.each([
    ['a GIF', [{ filename: 'a.gif', contentType: 'image/gif', size: 10 }]],
    ['a file over the size limit', [{ filename: 'a.jpg', contentType: 'image/jpeg', size: MAX_UPLOAD_BYTES + 1 }]],
    ['an overlong filename', [{ filename: `${'a'.repeat(256)}.jpg`, contentType: 'image/jpeg', size: 10 }]],
    [
      'more than 20 files',
      Array.from({ length: 21 }, () => ({ filename: 'a.jpg', contentType: 'image/jpeg', size: 10 })),
    ],
  ])('rejects reserving %s', async (_, files) => {
    const res = await newSession().call('', { method: 'POST', body: JSON.stringify({ files }) });
    expect(res.status).toBe(400);
  });
});
