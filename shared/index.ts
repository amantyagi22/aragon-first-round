/** Contract shared by the API, the worker, and the web app. The server is authoritative; the client copies are for instant feedback. */

export const MAX_UPLOAD_BYTES = 120 * 1024 * 1024;
export const MAX_FILES_PER_BATCH = 20;

export const STATUSES = ['pending_upload', 'queued', 'processing', 'accepted', 'rejected', 'failed'] as const;
export type Status = (typeof STATUSES)[number];
export const SETTLED_STATUSES: readonly Status[] = ['accepted', 'rejected', 'failed'];

/** Ordered as the fail-fast pipeline runs. Mirrors the Postgres `rejection_reason` enum. */
export const REASONS = [
  'unsupported_format',
  'file_too_small',
  'corrupt',
  'low_resolution',
  'no_face',
  'multiple_faces',
  'face_too_small',
  'blurry',
  'too_similar',
] as const;
export type Reason = (typeof REASONS)[number];

export const ACCEPTED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/heic', 'image/heif'] as const;
export type ImageFormat = 'jpeg' | 'png' | 'heic';

const HEIF_BRANDS = ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'];

/** Real format from the first 12 bytes. Never trust extensions or declared MIME types. */
export function sniffFormat(head: Uint8Array): ImageFormat | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...head.subarray(from, to));
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => head[i] === b)) return 'png';
  if (head.length >= 12 && ascii(4, 8) === 'ftyp' && HEIF_BRANDS.includes(ascii(8, 12))) return 'heic';
  return null;
}

export type ImageDto = {
  id: string;
  filename: string;
  status: Status;
  reason: Reason | null;
  reasonDetail: string | null;
  width: number | null;
  height: number | null;
  createdAt: string;
  url: string | null;
};
