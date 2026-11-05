# Walkthrough outline (about 18 minutes)

## 1. Demo (4 min)

- Empty state, requirements, the Min 6 marker.
- Drop the GIF: rejected in the browser, no request.
- Drop the fixture set: upload progress (4 at a time), blurred processing cards, cards landing in Accepted and Needs attention, the toast.
- Read out each rejection reason and hint; HEIC preview; sideways photo upright.

## 2. Architecture (4 min)

- Mermaid diagram in the README: browser, API, storage, Postgres, worker.
- Presigned POST: the API never touches bytes; storage enforces size and content type.
- Postgres as the queue: one row is both the image and the job, so they cannot drift.
- Polling at 1s only while something is unsettled; SSE over LISTEN/NOTIFY as the upgrade.
- Anonymous session id, every query scoped by it.

## 3. Key code (5 min)

- `server/src/worker.ts`: the `FOR UPDATE SKIP LOCKED` claim, stale reclaim, 3 attempts then failed, fenced writes.
- Advisory-locked similarity: `pg_advisory_xact_lock(hashtext(session_id))` plus `bit_count` Hamming distance in SQL.
- `server/src/pipeline.ts`: fail-fast order, HEIC decode, EXIF rotate and strip, face rules, Laplacian on the face crop (why not the whole image), dHash (why not face embeddings).
- `server/src/config.ts`: every threshold in one place.
- Migration: enums, the rejected-iff-reason CHECK, partial indexes.

## 4. QA (3 min)

- Run `pnpm test`: 32 tests through the HTTP API with a real worker, including SIGKILL crash recovery and the concurrent near-duplicate race.
- Walk a few rows of `docs/QA.md` live: delete then re-upload a near-duplicate, reload persistence, worker stopped then restarted.

## 5. Tradeoffs and next steps (2 min)

- The tradeoffs table in the README.
- Next: real auth, SSE, crop for far-away faces, SQS if Postgres becomes the bottleneck, keyset pagination, abandoned-upload sweeper, IAM roles and lifecycle rules on real S3.
