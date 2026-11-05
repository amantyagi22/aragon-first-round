import type { Knex } from 'knex';

export async function up(knex: Knex) {
  await knex.raw(`
    CREATE TYPE image_status AS ENUM ('pending_upload', 'queued', 'processing', 'accepted', 'rejected', 'failed');
    CREATE TYPE rejection_reason AS ENUM ('unsupported_format', 'file_too_small', 'corrupt', 'low_resolution',
      'no_face', 'multiple_faces', 'face_too_small', 'blurry', 'too_similar');

    CREATE TABLE sessions (
      id         uuid PRIMARY KEY,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE images (
      id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id       uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
      filename         text NOT NULL CHECK (length(filename) BETWEEN 1 AND 255),
      declared_mime    text NOT NULL,
      detected_mime    text,
      size_bytes       bigint NOT NULL CHECK (size_bytes > 0),
      width            integer,
      height           integer,
      original_key     text NOT NULL,
      processed_key    text,
      status           image_status NOT NULL DEFAULT 'pending_upload',
      reason           rejection_reason,
      reason_detail    text,
      dhash            bigint,
      face_count       smallint,
      attempts         smallint NOT NULL DEFAULT 0,
      locked_at        timestamptz,
      last_error       text,
      created_at       timestamptz NOT NULL DEFAULT now(),
      updated_at       timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT rejected_iff_reason CHECK ((status = 'rejected') = (reason IS NOT NULL))
    );

    -- Gallery listing, newest first.
    CREATE INDEX images_session_created ON images (session_id, created_at DESC);
    -- Queue claim: only rows that still need work, so the index stays tiny however many images exist.
    CREATE INDEX images_queue ON images (created_at) WHERE status IN ('queued', 'processing');
    -- Similarity lookup: only a session's accepted images are compared against.
    CREATE INDEX images_accepted_by_session ON images (session_id) INCLUDE (dhash) WHERE status = 'accepted';
  `);
}

export async function down(knex: Knex) {
  await knex.raw(`DROP TABLE images; DROP TABLE sessions; DROP TYPE image_status; DROP TYPE rejection_reason;`);
}
