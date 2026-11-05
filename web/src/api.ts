const API = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';

export type Status = 'pending_upload' | 'queued' | 'processing' | 'accepted' | 'rejected' | 'failed';
export type Reason = 'invalid_format' | 'file_too_small' | 'resolution_too_small' | 'no_face' | 'multiple_faces' | 'face_too_small' | 'blurry' | 'too_similar';
export type Image = { id: string; filename: string; status: Status; reason: Reason | null; url: string | null };
type Reservation = { id: string; upload: { url: string; fields: Record<string, string> } };

// Anonymous identity, persisted per browser.
const sessionId = localStorage.getItem('sessionId') ?? crypto.randomUUID();
localStorage.setItem('sessionId', sessionId);

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}/api/images${path}`, { ...init, headers: { 'content-type': 'application/json', 'x-session-id': sessionId } });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.status === 204 ? (undefined as T) : res.json();
}

export const listImages = () => call<{ images: Image[] }>('').then((r) => r.images);
export const deleteImage = (id: string) => call<void>(`/${id}`, { method: 'DELETE' });
export const completeUpload = (id: string) => call<Image>(`/${id}/complete`, { method: 'POST' });
export const reserveUploads = (files: File[]) =>
  call<{ images: Reservation[] }>('', {
    method: 'POST',
    body: JSON.stringify({ files: files.map((f) => ({ filename: f.name, contentType: contentTypeOf(f), size: f.size })) }),
  }).then((r) => r.images);

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

// Browsers often report HEIC with an empty MIME type, so fall back to the extension.
const BY_EXT: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', heic: 'image/heic', heif: 'image/heif' };
export function contentTypeOf(f: File): string | null {
  if (Object.values(BY_EXT).includes(f.type)) return f.type;
  return BY_EXT[f.name.split('.').pop()?.toLowerCase() ?? ''] ?? null;
}

export const REASON_COPY: Record<Reason | 'failed', [string, string]> = {
  invalid_format: ['Unsupported format', 'Only JPG, PNG and HEIC photos are supported.'],
  file_too_small: ['File too small', 'This file is under 50 KB, which usually means heavy compression. Upload the original photo.'],
  resolution_too_small: ['Resolution too low', 'Photos need to be at least 512px on the shortest side.'],
  no_face: ['No face detected', 'We could not find a face in this photo. Make sure your face is clearly visible.'],
  multiple_faces: ['Multiple faces', 'Only you should be in the photo. Crop out or avoid other people.'],
  face_too_small: ['Face is too far away', 'Your face takes up too little of the photo. Try a closer shot.'],
  blurry: ['Blurry face detected', 'Your face looks out of focus. Use a sharper photo with good lighting.'],
  too_similar: ['Too similar to another upload', 'You already uploaded a similar photo. Try different backgrounds, lighting and clothing.'],
  failed: ['Processing failed', 'Something went wrong on our side. Delete and try again.'],
};
