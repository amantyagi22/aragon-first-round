import { createRequire } from 'node:module';
import path from 'node:path';
import sharp from 'sharp';
import heicConvert from 'heic-convert';
import { sniffFormat, type ImageFormat, type Reason } from 'shared';
import { RULES } from './config.js';

const require = createRequire(import.meta.url);

type Rejection = { ok: false; reason: Reason; detail: string };
type Normalized = { jpeg: Buffer; width: number; height: number; format: ImageFormat };

export type Analysis =
  | ({ ok: true; dhash: bigint; faceCount: 1 } & Normalized)
  | (Rejection & { normalized?: Normalized; faceCount?: number });

const reject = (reason: Reason, detail: string) => ({ ok: false as const, reason, detail });

/**
 * The fail-fast validation pipeline, cheapest checks first. Similarity is the last step,
 * but it needs the session's other images, so the worker runs it in SQL after this returns.
 */
export async function analyze(original: Buffer): Promise<Analysis> {
  const format = sniffFormat(original.subarray(0, 12));
  if (!format) return reject('unsupported_format', 'file bytes are not JPEG, PNG, or HEIC');
  if (original.length < RULES.minBytes) return reject('file_too_small', `${original.length} bytes < ${RULES.minBytes}`);

  let normalized: Normalized;
  try {
    normalized = await normalize(original, format);
  } catch (err) {
    return reject('corrupt', `could not decode ${format}: ${(err as Error).message}`.slice(0, 500));
  }
  const { jpeg, width, height } = normalized;
  const fail = (r: Rejection, faceCount?: number) => ({ ...r, normalized, faceCount });

  const shortest = Math.min(width, height);
  if (shortest < RULES.minSidePx)
    return fail(reject('low_resolution', `shortest side ${shortest}px < ${RULES.minSidePx}px`));

  const faces = await detectFaces(jpeg, width, height);
  if (faces.length === 0) return fail(reject('no_face', 'no face detected'), 0);
  if (faces.length > 1) return fail(reject('multiple_faces', `${faces.length} faces detected`), faces.length);

  const [face] = faces;
  const areaRatio = (face.width * face.height) / (width * height);
  if (areaRatio < RULES.minFaceAreaRatio) {
    return fail(reject('face_too_small', `face covers ${pct(areaRatio)} < ${pct(RULES.minFaceAreaRatio)}`), 1);
  }
  const score = await sharpness(jpeg, face);
  if (score < RULES.minSharpness)
    return fail(reject('blurry', `face sharpness ${score.toFixed(1)} < ${RULES.minSharpness}`), 1);

  return { ok: true, ...normalized, faceCount: 1, dhash: await dHash(jpeg) };
}

const pct = (r: number) => `${(r * 100).toFixed(1)}%`;

/** HEIC via a dedicated decoder (prebuilt sharp has no HEVC). rotate() applies EXIF orientation; sharp drops all metadata on output. */
async function normalize(original: Buffer, format: ImageFormat): Promise<Normalized> {
  const decodable =
    format === 'heic' ? Buffer.from(await heicConvert({ buffer: original, format: 'JPEG', quality: 0.92 })) : original;
  const { data, info } = await sharp(decodable, { failOn: 'error' })
    .rotate()
    .jpeg({ quality: 90 })
    .toBuffer({ resolveWithObject: true });
  return { jpeg: data, width: info.width, height: info.height, format };
}

type Box = { x: number; y: number; width: number; height: number };

// ---- faces: face-api on the TF.js WASM backend (no native tfjs-node build to break) ----

const DETECT_MAX_SIDE = 640;
type FaceApi = typeof import('@vladmandic/face-api');
let faceApi: Promise<FaceApi> | null = null;

/** Loads the detector once per process. The worker calls this at startup so the first job isn't slow. */
export function loadFaceModel(): Promise<FaceApi> {
  faceApi ??= (async () => {
    const api: FaceApi = require('@vladmandic/face-api/dist/face-api.node-wasm.js');
    const wasm = require('@tensorflow/tfjs-backend-wasm');
    wasm.setWasmPaths(path.join(path.dirname(require.resolve('@tensorflow/tfjs-backend-wasm/package.json')), 'dist/'));
    // The node-wasm build's `tf` is full tfjs at runtime; its typings only expose tfjs-core.
    const tf = api.tf as unknown as { setBackend(name: string): Promise<boolean>; ready(): Promise<void> };
    await tf.setBackend('wasm');
    await tf.ready();
    await api.nets.ssdMobilenetv1.loadFromDisk(
      path.join(path.dirname(require.resolve('@vladmandic/face-api/package.json')), 'model'),
    );
    return api;
  })();
  return faceApi;
}

async function detectFaces(jpeg: Buffer, width: number, height: number): Promise<Box[]> {
  const api = await loadFaceModel();
  const { data, info } = await sharp(jpeg)
    .resize(DETECT_MAX_SIDE, DETECT_MAX_SIDE, { fit: 'inside' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const tensor = api.tf.tensor3d(new Uint8Array(data), [info.height, info.width, 3]);
  try {
    const detections = await api.detectAllFaces(
      tensor as never,
      new api.SsdMobilenetv1Options({ minConfidence: RULES.minFaceConfidence }),
    );
    const scale = width / info.width;
    return detections.map(({ box }) =>
      clampBox(
        { x: box.x * scale, y: box.y * scale, width: box.width * scale, height: box.height * scale },
        width,
        height,
      ),
    );
  } finally {
    tensor.dispose();
  }
}

function clampBox(b: Box, w: number, h: number): Box {
  const x = Math.min(w - 1, Math.max(0, Math.floor(b.x)));
  const y = Math.min(h - 1, Math.max(0, Math.floor(b.y)));
  return {
    x,
    y,
    width: Math.max(1, Math.min(w - x, Math.floor(b.width))),
    height: Math.max(1, Math.min(h - y, Math.floor(b.height))),
  };
}

// ---- blur: variance of the Laplacian on the face crop, so portrait-mode backgrounds don't count ----

async function sharpness(jpeg: Buffer, face: Box): Promise<number> {
  const { data, info } = await sharp(jpeg)
    .extract({ left: face.x, top: face.y, width: face.width, height: face.height })
    .resize(256)
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const w = info.width;
  let sum = 0,
    sumSq = 0,
    n = 0;
  for (let y = 1; y < info.height - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const laplacian = data[i - w] + data[i + w] + data[i - 1] + data[i + 1] - 4 * data[i];
      sum += laplacian;
      sumSq += laplacian * laplacian;
      n++;
    }
  }
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

// ---- similarity: 64-bit difference hash, stored as a signed bigint and compared in SQL ----

async function dHash(jpeg: Buffer): Promise<bigint> {
  const px = await sharp(jpeg).greyscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer();
  let hash = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) hash = (hash << 1n) | (px[y * 9 + x] > px[y * 9 + x + 1] ? 1n : 0n);
  }
  return BigInt.asIntN(64, hash);
}
