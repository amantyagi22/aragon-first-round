import { analyze, RULES } from './pipeline.js';
import { db } from './db.js';
import { getBytes, putJpeg } from './s3.js';

const MAX_ATTEMPTS = 3;
const STALE_LOCK = '2 minutes';

/** Postgres as the queue: SKIP LOCKED lets any number of workers claim distinct rows. Stale locks are reclaimed. */
export async function claimNext(): Promise<Record<string, any> | null> {
  const { rows } = await db.raw(`
    UPDATE images SET status = 'processing', attempts = attempts + 1, locked_at = now(), updated_at = now()
    WHERE id = (
      SELECT id FROM images
      WHERE (status = 'queued' OR (status = 'processing' AND locked_at < now() - interval '${STALE_LOCK}'))
        AND attempts < ${MAX_ATTEMPTS}
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING *`);
  return rows[0] ?? null;
}

export async function processImage(row: Record<string, any>) {
  try {
    const result = await analyze(await getBytes(row.original_key));
    const processedKey = result.jpeg ? `sessions/${row.session_id}/${row.id}/processed.jpg` : null;
    if (processedKey) await putJpeg(processedKey, result.jpeg!);

    if (!result.ok) {
      await db('images').where({ id: row.id }).update({ status: 'rejected', reason: result.reason, processed_key: processedKey, locked_at: null, updated_at: db.fn.now() });
      return;
    }
    // Serialize the similarity check per session so two near-duplicates processed concurrently can't both be accepted.
    await db.transaction(async (trx) => {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [row.session_id]);
      const { rows: [dupe] } = await trx.raw(
        `SELECT id FROM images WHERE session_id = ? AND status = 'accepted' AND id <> ?
           AND bit_count((dhash # ?::bigint)::bit(64)) <= ? LIMIT 1`,
        [row.session_id, row.id, result.dhash.toString(), RULES.maxHammingDistance]);
      await trx('images').where({ id: row.id }).update({
        status: dupe ? 'rejected' : 'accepted', reason: dupe ? 'too_similar' : null,
        width: result.width, height: result.height, dhash: result.dhash.toString(),
        processed_key: processedKey, locked_at: null, updated_at: trx.fn.now(),
      });
    });
  } catch (err) {
    console.error(`image ${row.id} attempt ${row.attempts} failed`, err);
    await db('images').where({ id: row.id }).update({
      status: row.attempts >= MAX_ATTEMPTS ? 'failed' : 'queued', last_error: String(err).slice(0, 1000), locked_at: null, updated_at: db.fn.now(),
    });
  }
}

/** Process everything currently queued, with bounded concurrency. Returns when the queue is empty. */
export async function drain(concurrency = 2) {
  await Promise.all(Array.from({ length: concurrency }, async () => {
    for (let row = await claimNext(); row; row = await claimNext()) await processImage(row);
  }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log('worker started');
  // ponytail: 500ms poll; LISTEN/NOTIFY if idle latency or DB load ever matters.
  for (;;) {
    await drain(Number(process.env.WORKER_CONCURRENCY ?? 2));
    await new Promise((r) => setTimeout(r, 500));
  }
}
