import type { Knex } from 'knex';

export async function up(knex: Knex) {
  await knex.raw(`
    CREATE TYPE image_status AS ENUM ('pending_upload', 'queued', 'processing', 'accepted', 'rejected', 'failed');
    CREATE TYPE rejection_reason AS ENUM ('invalid_format', 'file_too_small', 'resolution_too_small', 'no_face',
      'multiple_faces', 'face_too_small', 'blurry', 'too_similar');

    CREATE TABLE images (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id    uuid NOT NULL,
      filename      text NOT NULL CHECK (length(filename) <= 255),
      content_type  text NOT NULL,
      size_bytes    integer NOT NULL CHECK (size_bytes > 0),
      original_key  text NOT NULL,
      processed_key text,
      status        image_status NOT NULL DEFAULT 'pending_upload',
      reason        rejection_reason,
      width         integer,
      height        integer,
      dhash         bigint,
      attempts      smallint NOT NULL DEFAULT 0,
      locked_at     timestamptz,
      last_error    text,
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT reason_iff_rejected CHECK ((status = 'rejected') = (reason IS NOT NULL))
    );

    -- Session gallery listing.
    CREATE INDEX images_session_created ON images (session_id, created_at DESC);
    -- Worker queue: only rows that still need work.
    CREATE INDEX images_queue ON images (created_at) WHERE status IN ('queued', 'processing');
    -- Similarity scan: only accepted images per session are compared against.
    CREATE INDEX images_accepted_hash ON images (session_id) INCLUDE (dhash) WHERE status = 'accepted';
  `);
}

export async function down(knex: Knex) {
  await knex.raw(`DROP TABLE images; DROP TYPE image_status; DROP TYPE rejection_reason;`);
}
