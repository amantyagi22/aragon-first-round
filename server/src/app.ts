import { randomUUID } from 'node:crypto';
import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { ACCEPTED_MIME_TYPES, MAX_FILES_PER_BATCH, MAX_UPLOAD_BYTES, type ImageDto } from 'shared';
import { db, keys, type ImageRow } from './db.js';
import { deleteObjects, presignPreview, presignUpload, storedSize } from './s3.js';

const createBody = z.object({
  files: z
    .array(
      z.object({
        filename: z.string().min(1).max(255),
        contentType: z.enum(ACCEPTED_MIME_TYPES),
        size: z.number().int().positive().max(MAX_UPLOAD_BYTES),
      }),
    )
    .min(1)
    .max(MAX_FILES_PER_BATCH),
});
const idParam = z.object({ id: z.string().uuid() });

async function toDto(r: ImageRow): Promise<ImageDto> {
  return {
    id: r.id,
    filename: r.filename,
    status: r.status,
    reason: r.reason,
    reasonDetail: r.reason_detail,
    width: r.width,
    height: r.height,
    createdAt: r.created_at.toISOString(),
    url: r.processed_key ? await presignPreview(r.processed_key) : null,
  };
}

/** Anonymous identity (not auth): the session id is a bearer secret, and every query is scoped by it. */
const requireSession: RequestHandler = (req, res, next) => {
  const parsed = z.string().uuid().safeParse(req.header('x-session-id'));
  if (!parsed.success) return void res.status(401).json({ error: 'Missing or invalid X-Session-Id header' });
  res.locals.sessionId = parsed.data;
  next();
};

const findOwned = (id: string, sessionId: string) =>
  db<ImageRow>('images').where({ id, session_id: sessionId }).first();

export function createApp() {
  const app = express();
  app.use(helmet());
  app.use(cors({ origin: process.env.WEB_ORIGIN, allowedHeaders: ['content-type', 'x-session-id'] }));
  app.use(express.json({ limit: '32kb' }));
  app.use('/api', rateLimit({ windowMs: 60_000, limit: 600 }), requireSession);

  const images = express.Router();

  // Reserve a batch: rows in one insert, plus a presigned POST per file. File bytes never pass through the API.
  images.post('/', async (req, res) => {
    const { files } = createBody.parse(req.body);
    const sessionId: string = res.locals.sessionId;
    await db('sessions').insert({ id: sessionId }).onConflict('id').ignore();
    const rows = files.map((f) => {
      const id = randomUUID();
      return { id, session_id: sessionId, filename: f.filename, declared_mime: f.contentType, size_bytes: f.size, original_key: keys.original(id) };
    });
    await db('images').insert(rows);
    const out = await Promise.all(
      rows.map(async (r) => ({ id: r.id, filename: r.filename, upload: await presignUpload(r.original_key, r.declared_mime) })),
    );
    res.status(201).json({ images: out });
  });

  // The browser finished uploading. Idempotent: only pending_upload -> queued; repeats return the current state.
  images.post('/:id/complete', async (req, res) => {
    const { id } = idParam.parse(req.params);
    const row = await findOwned(id, res.locals.sessionId);
    if (!row) return void res.status(404).json({ error: 'Not found' });
    if (row.status === 'pending_upload') {
      const size = await storedSize(row.original_key);
      if (size === null) return void res.status(409).json({ error: 'Upload not found in storage' });
      // Storage enforces the size policy; this is defence in depth for stores that might not.
      if (size > MAX_UPLOAD_BYTES) {
        await deleteObjects([row.original_key]);
        return void res.status(413).json({ error: 'Upload exceeds the size limit' });
      }
      await db('images').where({ id, status: 'pending_upload' }).update({ status: 'queued', updated_at: db.fn.now() });
    }
    res.status(202).json(await toDto((await findOwned(id, res.locals.sessionId))!));
  });

  images.get('/', async (_req, res) => {
    // ponytail: no pagination, sessions hold tens of images; keyset pagination on (created_at, id) if that changes.
    const rows = await db<ImageRow>('images').where({ session_id: res.locals.sessionId }).orderBy('created_at', 'desc').limit(500);
    res.json({ images: await Promise.all(rows.map(toDto)) });
  });

  images.get('/:id', async (req, res) => {
    const { id } = idParam.parse(req.params);
    const row = await findOwned(id, res.locals.sessionId);
    if (!row) return void res.status(404).json({ error: 'Not found' });
    res.json(await toDto(row));
  });

  images.delete('/:id', async (req, res) => {
    const { id } = idParam.parse(req.params);
    const [row] = await db<ImageRow>('images')
      .where({ id, session_id: res.locals.sessionId })
      .delete()
      .returning(['original_key', 'processed_key']);
    if (!row) return void res.status(404).json({ error: 'Not found' });
    // Best effort: the row is already gone, so a storage hiccup must not turn into an error for the user.
    await deleteObjects([row.original_key, row.processed_key].filter((k): k is string => !!k)).catch((err) =>
      console.error(`failed to delete objects for image ${id}:`, err),
    );
    res.status(204).end();
  });

  app.use('/api/images', images);

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof z.ZodError) return void res.status(400).json({ error: 'Invalid request', issues: err.issues });
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  };
  app.use(onError);
  return app;
}
