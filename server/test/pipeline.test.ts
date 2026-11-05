import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { analyze, dHash } from '../src/pipeline.js';

const fixture = (f: string) => readFile(new URL(`./fixtures/${f}`, import.meta.url));

describe('validation pipeline', () => {
  it.each([
    ['ok-selfie.jpg', null],
    ['ok-headshot.png', null],
    ['src/selfie.heic', null],
    ['not-an-image.jpg', 'invalid_format'],
    ['tiny-bytes.jpg', 'file_too_small'],
    ['low-res.jpg', 'resolution_too_small'],
    ['no-face.jpg', 'no_face'],
    ['multiple-faces.jpg', 'multiple_faces'],
    ['face-too-small.jpg', 'face_too_small'],
    ['blurry.jpg', 'blurry'],
  ])('%s -> %s', async (file, expected) => {
    const result = await analyze(await fixture(file));
    expect(result.ok ? null : result.reason).toBe(expected);
  });

  it('near-duplicates hash within the similarity threshold, different photos do not', async () => {
    const [a, b, c] = await Promise.all(['ok-selfie.jpg', 'similar-selfie.jpg', 'ok-headshot.png'].map(async (f) => dHash(await fixture(f))));
    const dist = (x: bigint, y: bigint) => BigInt.asUintN(64, x ^ y).toString(2).replace(/0/g, '').length;
    expect(dist(a, b)).toBeLessThanOrEqual(10);
    expect(dist(a, c)).toBeGreaterThan(10);
  });
});
