import { createRequire } from 'node:module';
import path from 'node:path';
import sharp from 'sharp';
import heicConvert from 'heic-convert';

const require = createRequire(import.meta.url);

/** Rejection reasons, ordered by the fail-fast pipeline. Mirrors the Postgres enum. */
export const REASONS = [
  'invalid_format',
  'file_too_small',
  'resolution_too_small',
  'no_face',
  'multiple_faces',
  'face_too_small',
  'blurry',
  'too_similar',
] as const;
export type Reason = (typeof REASONS)[number];

export const RULES = {
  minBytes: 50 * 1024,
  minSide: 512,
  minFaceAreaRatio: 0.05,
  minSharpness: 40, // Laplacian variance on a 256px-wide grayscale face crop
  maxHammingDistance: 10, // of 64 dHash bits
};

export type Analysis =
  | { ok: true; jpeg: Buffer; width: number; height: number; dhash: bigint }
  | { ok: false; reason: Reason; jpeg?: Buffer };

type Format = 'jpeg' | 'png' | 'heic';

/** Trust bytes, not extensions or client-sent MIME types. */
export function sniffFormat(buf: Buffer): Format | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buf.toString('ascii', 8, 12);
    if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'].includes(brand)) return 'heic';
  }
  return null;
}

/** Full validation pipeline, cheapest checks first. Similarity is checked later, against the DB. */
export async function analyze(original: Buffer): Promise<Analysis> {
  const format = sniffFormat(original);
  if (!format) return { ok: false, reason: 'invalid_format' };
  if (original.length < RULES.minBytes) return { ok: false, reason: 'file_too_small' };

  const decodable = format === 'heic' ? Buffer.from(await heicConvert({ buffer: original, format: 'JPEG', quality: 0.92 })) : original;
  // rotate() applies EXIF orientation; sharp strips all metadata (GPS etc.) on output by default.
  const { data: jpeg, info } = await sharp(decodable).rotate().jpeg({ quality: 90 }).toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  if (Math.min(width, height) < RULES.minSide) return { ok: false, reason: 'resolution_too_small', jpeg };

  const faces = await detectFaces(jpeg, width, height);
  if (faces.length === 0) return { ok: false, reason: 'no_face', jpeg };
  if (faces.length > 1) return { ok: false, reason: 'multiple_faces', jpeg };
  const [face] = faces;
  if ((face.width * face.height) / (width * height) < RULES.minFaceAreaRatio) return { ok: false, reason: 'face_too_small', jpeg };
  if ((await sharpness(jpeg, face, width, height)) < RULES.minSharpness) return { ok: false, reason: 'blurry', jpeg };

  return { ok: true, jpeg, width, height, dhash: await dHash(jpeg) };
}

type Box = { x: number; y: number; width: number; height: number };

// ---- faces: face-api on the TF.js WASM backend (no native tfjs-node build) ----
const DETECT_SIZE = 640;
let faceapiReady: Promise<typeof import('@vladmandic/face-api')> | null = null;
function faceapi() {
  faceapiReady ??= (async () => {
    const api = require('@vladmandic/face-api/dist/face-api.node-wasm.js');
    const wasm = require('@tensorflow/tfjs-backend-wasm');
    wasm.setWasmPaths(path.dirname(require.resolve('@tensorflow/tfjs-backend-wasm/package.json')) + '/dist/');
    await api.tf.setBackend('wasm');
    await api.tf.ready();
    await api.nets.ssdMobilenetv1.loadFromDisk(path.join(path.dirname(require.resolve('@vladmandic/face-api/package.json')), 'model'));
    return api;
  })();
  return faceapiReady;
}

export async function detectFaces(jpeg: Buffer, width: number, height: number): Promise<Box[]> {
  const api = await faceapi();
  const { data, info } = await sharp(jpeg).resize(DETECT_SIZE, DETECT_SIZE, { fit: 'inside' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const tensor = api.tf.tensor3d(new Uint8Array(data), [info.height, info.width, 3]);
  try {
    const dets = await api.detectAllFaces(tensor as never, new api.SsdMobilenetv1Options({ minConfidence: 0.5 }));
    const scale = width / info.width;
    return dets.map((d) => ({ x: d.box.x * scale, y: d.box.y * scale, width: d.box.width * scale, height: d.box.height * scale }))
      .map((b) => clampBox(b, width, height));
  } finally {
    tensor.dispose();
  }
}

function clampBox(b: Box, w: number, h: number): Box {
  const x = Math.max(0, Math.floor(b.x));
  const y = Math.max(0, Math.floor(b.y));
  return { x, y, width: Math.max(1, Math.min(w - x, Math.floor(b.width))), height: Math.max(1, Math.min(h - y, Math.floor(b.height))) };
}

// ---- blur: variance of the Laplacian on the face crop, normalised to a fixed width ----
export async function sharpness(jpeg: Buffer, face: Box, width: number, height: number): Promise<number> {
  const box = clampBox(face, width, height);
  const { data, info } = await sharp(jpeg)
    .extract({ left: box.x, top: box.y, width: box.width, height: box.height })
    .resize(256)
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height;
  let sum = 0, sumSq = 0, n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = data[i - w] + data[i + w] + data[i - 1] + data[i + 1] - 4 * data[i];
      sum += lap; sumSq += lap * lap; n++;
    }
  }
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

// ---- similarity: 64-bit difference hash, stored as signed bigint ----
export async function dHash(jpeg: Buffer): Promise<bigint> {
  const data = await sharp(jpeg).greyscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer();
  let hash = 0n;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) hash = (hash << 1n) | (data[y * 9 + x] > data[y * 9 + x + 1] ? 1n : 0n);
  return BigInt.asIntN(64, hash);
}
