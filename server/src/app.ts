import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { db } from './db.js';
import { MAX_UPLOAD_BYTES, deleteKeys, exists, presignGet, presignUpload } from './s3.js';

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/heic', 'image/heif'] as const;

const createBody = z.object({
  files: z.array(z.object({
    filename: z.string().min(1).max(255),
    contentType: z.enum(ALLOWED_TYPES),
    size: z.number().int().positive().max(MAX_UPLOAD_BYTES),
  })).min(1).max(50),
});
const idParam = z.object({ id: z.string().uuid() });

type Row = Record<string, any>;
async function toDto(r: Row) {
  return {
    id: r.id, filename: r.filename, status: r.status, reason: r.reason,
    width: r.width, height: r.height, createdAt: r.created_at,
    url: r.processed_key ? await presignGet(r.processed_key) : null,
  };
}

// Anonymous identity: every query is scoped to the caller's session UUID.
const session: RequestHandler = (req, res, next) => {
  const parsed = z.string().uuid().safeParse(req.header('x-session-id'));
  if (!parsed.success) return void res.status(401).json({ error: 'Missing or invalid X-Session-Id' });
  res.locals.sessionId = parsed.data;
  next();
};

export function createApp() {
  const app = express();
  app.use(helmet());
  app.use(cors({ origin: process.env.WEB_ORIGIN ?? 'http://localhost:5180', allowedHeaders: ['content-type', 'x-session-id'] }));
  app.use(express.json({ limit: '32kb' }));
  app.use('/api', rateLimit({ windowMs: 60_000, limit: 600 }), session);

  const images = express.Router();

  // Reserve rows + issue presigned POSTs for a batch. Bytes never pass through the API.
  images.post('/', async (req, res) => {
    const { files } = createBody.parse(req.body);
    const sessionId = res.locals.sessionId;
    const rows = await db('images').insert(files.map((f) => ({
      session_id: sessionId, filename: f.filename, content_type: f.contentType, size_bytes: f.size, original_key: 'pending',
    }))).returning(['id']);
    const out = await Promise.all(rows.map(async ({ id }, i) => {
      const key = `sessions/${sessionId}/${id}/original`;
      await db('images').where({ id }).update({ original_key: key });
      return { id, filename: files[i].filename, upload: await presignUpload(key) };
    }));
    res.status(201).json({ images: out });
  });

  // Client signals the upload finished. Idempotent: only pending_upload -> queued.
  images.post('/:id/complete', async (req, res) => {
    const { id } = idParam.parse(req.params);
    const row = await db('images').where({ id, session_id: res.locals.sessionId }).first();
    if (!row) return void res.status(404).json({ error: 'Not found' });
    if (row.status === 'pending_upload') {
      if (!(await exists(row.original_key))) return void res.status(409).json({ error: 'Upload not found in storage' });
      await db('images').where({ id, status: 'pending_upload' }).update({ status: 'queued', updated_at: db.fn.now() });
    }
    res.status(202).json(await toDto(await db('images').where({ id }).first()));
  });

  images.get('/', async (_req, res) => {
    const rows = await db('images').where({ session_id: res.locals.sessionId }).orderBy('created_at', 'asc').limit(200);
    res.json({ images: await Promise.all(rows.map(toDto)) });
  });

  images.get('/:id', async (req, res) => {
    const { id } = idParam.parse(req.params);
    const row = await db('images').where({ id, session_id: res.locals.sessionId }).first();
    if (!row) return void res.status(404).json({ error: 'Not found' });
    res.json(await toDto(row));
  });

  images.delete('/:id', async (req, res) => {
    const { id } = idParam.parse(req.params);
    const [row] = await db('images').where({ id, session_id: res.locals.sessionId }).delete().returning(['original_key', 'processed_key']);
    if (!row) return void res.status(404).json({ error: 'Not found' });
    await deleteKeys([row.original_key, row.processed_key].filter(Boolean));
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
