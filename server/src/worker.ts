import { RULES, WORKER } from './config.js';
import type { Knex } from 'knex';
import { db, keys, type ImageRow } from './db.js';
import { analyze, loadFaceModel } from './pipeline.js';
import { deleteObjects, getBytes, putJpeg } from './s3.js';

const MIME = { jpeg: 'image/jpeg', png: 'image/png', heic: 'image/heic' } as const;

/**
 * Postgres is the queue: the image row is also the job. SKIP LOCKED lets any number of workers claim distinct rows.
 * A `processing` row whose worker died is reclaimed after the stale window, or failed if it has used all its attempts.
 */
async function claimNext(): Promise<ImageRow | null> {
  const stale = `now() - make_interval(secs => ${WORKER.staleAfterSeconds})`;
  await db.raw(`
    UPDATE images SET status = 'failed', locked_at = NULL, updated_at = now(),
      last_error = coalesce(last_error, 'worker stopped responding on the final attempt')
    WHERE status = 'processing' AND locked_at < ${stale} AND attempts >= ${WORKER.maxAttempts}`);
  const { rows } = await db.raw(`
    UPDATE images SET status = 'processing', attempts = attempts + 1, locked_at = now(), updated_at = now()
    WHERE id = (
      SELECT id FROM images
      WHERE status = 'queued' OR (status = 'processing' AND locked_at < ${stale})
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING *`);
  return rows[0] ?? null;
}

async function processImage(job: ImageRow) {
  // Fencing: a write only lands if this worker still owns the attempt (not reclaimed, not deleted by the user).
  const owned = (q: Knex = db) => q('images').where({ id: job.id, status: 'processing', attempts: job.attempts });
  const update = async (q: Knex, patch: object) => Number(await owned(q).update(patch));
  try {
    const result = await analyze(await getBytes(job.original_key));
    const normalized = result.ok ? result : result.normalized;
    const processedKey = normalized ? keys.processed(job.id) : null;
    if (normalized) await putJpeg(processedKey!, normalized.jpeg);

    const common = {
      processed_key: processedKey,
      detected_mime: normalized ? MIME[normalized.format] : null,
      width: normalized?.width ?? null,
      height: normalized?.height ?? null,
      face_count: result.faceCount ?? null,
      locked_at: null,
      updated_at: db.fn.now(),
    };

    let written: number;
    if (!result.ok) {
      written = await update(db, {
        ...common,
        status: 'rejected',
        reason: result.reason,
        reason_detail: result.detail,
      });
    } else {
      // Serialize the similarity check per session, so two near-duplicates processed at once can't both be accepted.
      written = await db.transaction<number>(async (trx) => {
        await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [job.session_id]);
        const { rows } = await trx.raw(
          `SELECT id, bit_count((dhash # ?::bigint)::bit(64)) AS distance FROM images
           WHERE session_id = ? AND status = 'accepted' AND id <> ?
           ORDER BY distance LIMIT 1`,
          [result.dhash.toString(), job.session_id, job.id],
        );
        const nearest = rows[0] as { id: string; distance: string } | undefined;
        const duplicate = nearest && Number(nearest.distance) <= RULES.maxSimilarDistance;
        return update(trx, {
          ...common,
          dhash: result.dhash.toString(),
          status: duplicate ? 'rejected' : 'accepted',
          reason: duplicate ? 'too_similar' : null,
          reason_detail: duplicate
            ? `distance ${nearest.distance} <= ${RULES.maxSimilarDistance} to image ${nearest.id}`
            : null,
        });
      });
    }
    // Deleted while we were processing: don't leave the processed copy behind.
    if (!written && processedKey && !(await db('images').where({ id: job.id }).first()))
      await deleteObjects([processedKey]);
  } catch (err) {
    console.error(`image ${job.id} attempt ${job.attempts} failed:`, err);
    await update(db, {
      status: job.attempts >= WORKER.maxAttempts ? 'failed' : 'queued',
      last_error: String(err).slice(0, 1000),
      locked_at: null,
      updated_at: db.fn.now(),
    });
  }
}

async function runLoop(signal: AbortSignal) {
  while (!signal.aborted) {
    const job = await claimNext();
    if (job) {
      console.log(`claimed ${job.id} attempt ${job.attempts}`);
      await processImage(job);
    }
    // ponytail: fixed idle poll; Postgres LISTEN/NOTIFY when idle latency or DB load matters.
    else await new Promise((r) => setTimeout(r, WORKER.idlePollMs));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await loadFaceModel();
  const stop = new AbortController();
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => stop.abort());
  console.log(`worker ready (concurrency ${WORKER.concurrency})`);
  await Promise.all(Array.from({ length: WORKER.concurrency }, () => runLoop(stop.signal)));
  await db.destroy();
}
