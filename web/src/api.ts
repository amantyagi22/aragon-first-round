import { ACCEPTED_MIME_TYPES, MAX_FILES_PER_BATCH, sniffFormat, type ImageDto, type Reason } from 'shared';

const API = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';
type Reservation = { id: string; upload: { url: string; fields: Record<string, string> } };

// Anonymous identity, persisted per browser.
const sessionId = localStorage.getItem('sessionId') ?? crypto.randomUUID();
localStorage.setItem('sessionId', sessionId);

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}/api/images${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-session-id': sessionId },
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.status === 204 ? (undefined as T) : res.json();
}

export const listImages = () => call<{ images: ImageDto[] }>('').then((r) => r.images);
export const deleteImage = (id: string) => call<void>(`/${id}`, { method: 'DELETE' });
export const completeUpload = (id: string) => call<ImageDto>(`/${id}/complete`, { method: 'POST' });

/** Reserves rows + presigned POSTs, in batches the API accepts. */
export async function reserveUploads(files: File[]): Promise<Reservation[]> {
  const out: Reservation[] = [];
  for (let i = 0; i < files.length; i += MAX_FILES_PER_BATCH) {
    const batch = files.slice(i, i + MAX_FILES_PER_BATCH);
    const { images } = await call<{ images: Reservation[] }>('', {
      method: 'POST',
      body: JSON.stringify({
        files: batch.map((f) => ({ filename: f.name, contentType: contentTypeOf(f), size: f.size })),
      }),
    });
    out.push(...images);
  }
  return out;
}

/** XHR (not fetch) so we get upload progress. Bytes go straight to storage. */
export function uploadToStorage(r: Reservation, file: File, onProgress: (pct: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(r.upload.fields)) form.append(k, v);
    form.append('file', file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', r.upload.url);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error(`upload failed: ${xhr.status}`)));
    xhr.onerror = () => reject(new Error('upload failed'));
    xhr.send(form);
  });
}

const MIME_BY_FORMAT = { jpeg: 'image/jpeg', png: 'image/png', heic: 'image/heic' } as const;
const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  heic: 'image/heic',
  heif: 'image/heif',
};

/** Browsers often report HEIC with an empty MIME type, so fall back to the extension. */
function contentTypeOf(f: File): string {
  if ((ACCEPTED_MIME_TYPES as readonly string[]).includes(f.type)) return f.type;
  return MIME_BY_EXT[f.name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';
}

/** Instant client check: extension and the file's real magic bytes must both say JPEG, PNG, or HEIC. */
export async function isSupportedImage(f: File): Promise<boolean> {
  if (!MIME_BY_EXT[f.name.split('.').pop()?.toLowerCase() ?? '']) return false;
  const format = sniffFormat(new Uint8Array(await f.slice(0, 12).arrayBuffer()));
  return !!format && !!MIME_BY_FORMAT[format];
}

/** Every rejection reason's user-facing copy, in one place. */
export const REASON_COPY: Record<Reason | 'failed', { label: string; hint: string }> = {
  unsupported_format: { label: 'Unsupported format', hint: 'Only JPG, PNG and HEIC photos are supported.' },
  file_too_small: { label: 'File too small', hint: 'Upload the original photo, not a thumbnail or screenshot.' },
  corrupt: { label: 'Unreadable file', hint: 'This file looks damaged. Export the photo again and re-upload.' },
  low_resolution: { label: 'Resolution too low', hint: 'Use a photo at least 512px on its shortest side.' },
  no_face: { label: 'No face detected', hint: 'Make sure your face is clearly visible.' },
  multiple_faces: { label: 'Multiple faces', hint: 'Only you should be in the photo.' },
  face_too_small: { label: 'Face is too far away', hint: 'Try a closer shot where your face fills more of the frame.' },
  blurry: { label: 'Blurry face', hint: 'Use a sharper photo with good lighting.' },
  too_similar: { label: 'Too similar to another upload', hint: 'Try a different background, lighting, or outfit.' },
  failed: { label: 'Something went wrong on our side', hint: 'This is not your photo. Delete it and upload it again.' },
};
