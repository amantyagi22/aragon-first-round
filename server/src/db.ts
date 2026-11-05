import knex from 'knex';
import type { Reason, Status } from 'shared';

export const db = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 10 } });

export type ImageRow = {
  id: string;
  session_id: string;
  filename: string;
  declared_mime: string;
  detected_mime: string | null;
  size_bytes: string;
  width: number | null;
  height: number | null;
  original_key: string;
  processed_key: string | null;
  status: Status;
  reason: Reason | null;
  reason_detail: string | null;
  dhash: string | null;
  face_count: number | null;
  attempts: number;
  locked_at: Date | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
};

/** Object keys come from the image id only; the client-supplied filename is never part of a key. */
export const keys = {
  original: (id: string) => `uploads/${id}`,
  processed: (id: string) => `processed/${id}.jpg`,
};
