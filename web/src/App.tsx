import { useEffect, useReducer, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, LayoutGroup, motion } from 'motion/react';
import {
  ArrowClockwise,
  CaretDown,
  Check,
  CheckCircle,
  CircleNotch,
  Trash,
  UploadSimple,
  WarningCircle,
  X,
} from '@phosphor-icons/react';
import { MAX_UPLOAD_BYTES, SETTLED_STATUSES, type ImageDto as Image } from 'shared';
import {
  REASON_COPY,
  completeUpload,
  deleteImage,
  isSupportedImage,
  listImages,
  reserveUploads,
  uploadToStorage,
} from './api';

const TARGET = 10;
const MINIMUM = 6;
const MAX_CONCURRENT_UPLOADS = 4;
const MAX_MB = MAX_UPLOAD_BYTES / 1024 / 1024;
const NO_IMAGES: Image[] = []; // stable identity, so render-time comparisons don't loop
const isSettled = (i: Image) => SETTLED_STATUSES.includes(i.status);

type Copy = { label: string; hint: string };

// ---- local upload state: one entry per selected file, keyed by a client id ----

type Phase = 'validating' | 'uploading' | 'done' | 'error';
type Entry = {
  key: string;
  file: File;
  preview: string;
  phase: Phase;
  progress: number;
  serverId?: string;
  error?: Copy;
  /** Hidden from the uploads list by "Clear"; kept so its card still has a local preview. */
  cleared?: boolean;
};
type Action =
  { type: 'add'; entries: Entry[] } | { type: 'patch'; key: string; patch: Partial<Entry> } | { type: 'clearFinished' };

function uploadsReducer(state: Entry[], action: Action): Entry[] {
  switch (action.type) {
    case 'add':
      return [...action.entries, ...state];
    case 'patch':
      return state.map((e) => (e.key === action.key ? { ...e, ...action.patch } : e));
    case 'clearFinished':
      // Entries with a server image keep their preview: the card may have no server preview (e.g. file too small).
      state.filter((e) => e.phase === 'error' && !e.serverId).forEach((e) => URL.revokeObjectURL(e.preview));
      return state
        .filter((e) => !(e.phase === 'error' && !e.serverId))
        .map((e) => (e.phase === 'done' || e.phase === 'error' ? { ...e, cleared: true } : e));
  }
}

/** Runs `task` over `items` with at most `limit` in flight. */
async function pool<T>(items: T[], limit: number, task: (item: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) await task(item);
    }),
  );
}

export function App() {
  const qc = useQueryClient();
  const [uploads, dispatch] = useReducer(uploadsReducer, []);
  const [dragging, setDragging] = useState(false);
  const [awaitingBatch, setAwaitingBatch] = useState(false);
  const [announcement, setAnnouncement] = useState('');

  const { data: images = NO_IMAGES, isPending } = useQuery({
    queryKey: ['images'],
    queryFn: listImages,
    // Poll only while something is still in flight; stops by itself once everything has settled.
    refetchInterval: (q) => (q.state.data?.some((i) => !isSettled(i)) ? 1000 : false),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['images'] });

  const remove = useMutation({
    mutationFn: deleteImage,
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: ['images'] });
      qc.setQueryData<Image[]>(['images'], (xs) => xs?.filter((x) => x.id !== id));
    },
    onSettled: refresh,
  });

  async function onFiles(files: File[]) {
    if (!files.length) return;
    const entries: Entry[] = files.map((file) => ({
      key: crypto.randomUUID(),
      file,
      preview: URL.createObjectURL(file),
      phase: 'validating',
      progress: 0,
    }));
    dispatch({ type: 'add', entries });
    setAwaitingBatch(true);

    const verdicts = await Promise.all(
      entries.map(async ({ file }): Promise<Copy | null> =>
        !(await isSupportedImage(file))
          ? REASON_COPY.unsupported_format
          : file.size > MAX_UPLOAD_BYTES
            ? { label: 'File too large', hint: `Photos must be under ${MAX_MB} MB.` }
            : null,
      ),
    );
    entries.forEach(
      (e, i) => verdicts[i] && dispatch({ type: 'patch', key: e.key, patch: { phase: 'error', error: verdicts[i]! } }),
    );
    const valid = entries.filter((_, i) => !verdicts[i]);
    if (!valid.length) return;

    let reservations;
    try {
      reservations = await reserveUploads(valid.map((e) => e.file));
    } catch {
      valid.forEach((e) => dispatch({ type: 'patch', key: e.key, patch: { phase: 'error', error: UPLOAD_FAILED } }));
      return;
    }
    const jobs = valid.map((entry, i) => ({ entry, reservation: reservations[i] }));
    jobs.forEach(({ entry, reservation }) =>
      dispatch({ type: 'patch', key: entry.key, patch: { phase: 'uploading', serverId: reservation.id } }),
    );
    await refresh();

    await pool(jobs, MAX_CONCURRENT_UPLOADS, async ({ entry, reservation }) => {
      try {
        await uploadToStorage(reservation, entry.file, (progress) =>
          dispatch({ type: 'patch', key: entry.key, patch: { progress } }),
        );
        await completeUpload(reservation.id);
        dispatch({ type: 'patch', key: entry.key, patch: { phase: 'done', progress: 1 } });
      } catch {
        dispatch({ type: 'patch', key: entry.key, patch: { phase: 'error', error: UPLOAD_FAILED } });
        await deleteImage(reservation.id).catch(() => {}); // don't leave a row waiting for bytes that never came
      }
      await refresh();
    });
  }

  /** A failed image is the system's fault: delete it and upload the same file again. */
  function retry(image: Image) {
    const entry = uploads.find((e) => e.serverId === image.id);
    if (!entry) return;
    remove.mutate(image.id);
    void onFiles([entry.file]);
  }

  // Toast once the whole batch has settled: nothing uploading locally, nothing processing on the server.
  const localBusy = uploads.some((e) => e.phase === 'validating' || e.phase === 'uploading');
  const serverBusy = images.some((i) => !isSettled(i));
  const batchSettled = awaitingBatch && !localBusy && !serverBusy;
  useEffect(() => {
    if (!batchSettled) return;
    const t = setTimeout(() => setAwaitingBatch(false), 4000);
    return () => clearTimeout(t);
  }, [batchSettled]);

  // Announce each verdict to screen readers as it lands (adjusting state from the previous render, not in an effect).
  const [previousImages, setPreviousImages] = useState(images);
  if (images !== previousImages) {
    const before = new Map(previousImages.map((i) => [i.id, i.status]));
    const messages = images
      .filter((i) => isSettled(i) && before.has(i.id) && before.get(i.id) !== i.status)
      .map((i) =>
        i.status === 'accepted' ? `${i.filename} accepted` : `${i.filename} needs attention: ${copyFor(i).label}`,
      );
    setPreviousImages(images);
    if (messages.length) setAnnouncement(messages.join('. '));
  }
  // ponytail: preview object URLs are revoked on "Clear"; the browser frees the rest on page unload.

  const visibleUploads = uploads.filter((e) => !e.cleared);
  const previewFor = (id: string) => uploads.find((e) => e.serverId === id)?.preview;
  const accepted = images.filter((i) => i.status === 'accepted');
  const needsAttention = images.filter((i) => i.status === 'rejected' || i.status === 'failed');
  const processing = images.filter((i) => !isSettled(i));

  return (
    <div className="min-h-dvh font-sans text-zinc-900 antialiased">
      <div aria-live="polite" className="sr-only">
        {announcement}
      </div>

      <header className="sticky top-0 z-20 border-b border-zinc-200 bg-white/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center px-4 text-[15px] font-semibold tracking-tight sm:px-6">
          Headshot studio
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl gap-8 px-4 py-8 sm:px-6 md:grid-cols-[300px_minmax(0,1fr)] md:gap-10 md:py-10">
        <aside className="md:sticky md:top-24 md:self-start">
          <h1 className="text-2xl font-semibold tracking-tight">Upload photos</h1>
          <p className="mt-2 text-sm leading-relaxed text-zinc-600">
            Add at least <b className="text-zinc-900">{MINIMUM}</b>, ideally <b className="text-zinc-900">{TARGET}</b>,
            of your best photos. Mix close-ups, selfies, and mid-range shots.
          </p>

          <label
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              void onFiles([...e.dataTransfer.files]);
            }}
            className={`mt-6 flex cursor-pointer flex-col items-center gap-3 rounded-2xl border-2 border-dashed px-6 py-10 text-center transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent ${dragging ? 'border-accent bg-orange-50' : 'border-zinc-300 bg-white hover:border-zinc-400'}`}
          >
            <input
              type="file"
              multiple
              className="sr-only"
              accept=".jpg,.jpeg,.png,.heic,.heif,image/jpeg,image/png,image/heic,image/heif"
              onChange={(e) => {
                void onFiles([...(e.target.files ?? [])]);
                e.target.value = '';
              }}
            />
            <span className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white shadow-sm transition-transform active:scale-[0.97]">
              <UploadSimple size={16} weight="bold" />
              {dragging ? 'Drop to upload' : 'Choose photos'}
            </span>
            <span className="text-sm font-medium">Click to upload or drag and drop</span>
            <span className="text-xs text-zinc-500">PNG, JPG, HEIC up to {MAX_MB} MB</span>
          </label>

          {visibleUploads.length > 0 && (
            <section aria-label="Uploads" className="mt-6">
              <div className="flex items-center justify-between">
                <h2 className="text-xs font-semibold tracking-wide text-zinc-500 uppercase">Uploads</h2>
                {!localBusy && (
                  <button
                    type="button"
                    onClick={() => dispatch({ type: 'clearFinished' })}
                    className="text-xs text-zinc-500 hover:text-zinc-900 active:scale-[0.97]"
                  >
                    Clear
                  </button>
                )}
              </div>
              <ul className="mt-2 max-h-72 space-y-2 overflow-y-auto pr-1">
                {visibleUploads.map((e) => (
                  <UploadRow key={e.key} entry={e} />
                ))}
              </ul>
            </section>
          )}
        </aside>

        <section className="min-w-0">
          <ProgressMeter accepted={accepted.length} />

          <LayoutGroup>
            {processing.length > 0 && (
              <Panel
                tone="neutral"
                title="Checking your photos"
                subtitle="We're verifying each photo. Results appear as soon as each check finishes."
              >
                {processing.map((i) => (
                  <Card key={i.id} image={i} preview={previewFor(i.id)} onDelete={() => remove.mutate(i.id)} />
                ))}
              </Panel>
            )}
            {accepted.length > 0 && (
              <Panel
                tone="good"
                title="Accepted"
                count={accepted.length}
                icon={<CheckCircle size={18} weight="fill" className="text-emerald-600" />}
              >
                {accepted.map((i) => (
                  <Card key={i.id} image={i} preview={previewFor(i.id)} onDelete={() => remove.mutate(i.id)} />
                ))}
              </Panel>
            )}
            {needsAttention.length > 0 && (
              <Panel
                tone="bad"
                title="Needs attention"
                count={needsAttention.length}
                subtitle="Replacing these is optional once you have enough good photos."
                action={
                  <button
                    type="button"
                    onClick={() => needsAttention.forEach((i) => remove.mutate(i.id))}
                    className="text-xs font-normal text-zinc-500 hover:text-zinc-900 active:scale-[0.97]"
                  >
                    Remove all
                  </button>
                }
                icon={<WarningCircle size={18} weight="fill" className="text-rose-500" />}
              >
                {needsAttention.map((i) => (
                  <Card
                    key={i.id}
                    image={i}
                    preview={previewFor(i.id)}
                    copy={copyFor(i)}
                    onDelete={() => remove.mutate(i.id)}
                    onRetry={
                      i.status === 'failed' && uploads.some((e) => e.serverId === i.id) ? () => retry(i) : undefined
                    }
                  />
                ))}
              </Panel>
            )}
          </LayoutGroup>

          {!isPending && images.length === 0 && <EmptyState />}
          <Requirements />
        </section>
      </main>

      <AnimatePresence>
        {batchSettled && (
          <motion.div
            role="status"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            className="fixed inset-x-0 bottom-6 z-30 mx-auto flex w-fit items-center gap-2 rounded-full bg-zinc-900 px-4 py-2.5 text-sm text-white shadow-lg"
          >
            <CheckCircle size={18} weight="fill" className="text-emerald-400" /> All photos have been checked
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

const UPLOAD_FAILED: Copy = { label: 'Upload failed', hint: 'Check your connection and try again.' };
const copyFor = (i: Image) => REASON_COPY[i.status === 'failed' ? 'failed' : i.reason!];

function UploadRow({ entry }: { entry: Entry }) {
  const status = {
    validating: 'Checking file',
    uploading: `${Math.round(entry.progress * 100)}%`,
    done: 'Uploaded',
    error: entry.error?.label ?? 'Failed',
  }[entry.phase];
  return (
    <li className="rounded-lg border border-zinc-200 bg-white px-3 py-2">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="truncate font-mono text-zinc-700">{entry.file.name}</span>
        <span className={`shrink-0 tabular-nums ${entry.phase === 'error' ? 'text-rose-600' : 'text-zinc-500'}`}>
          {status}
        </span>
      </div>
      {entry.phase === 'error' ? (
        <p className="mt-1 text-xs text-zinc-500">{entry.error?.hint}</p>
      ) : (
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-zinc-100">
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-200"
            style={{ width: `${entry.phase === 'done' ? 100 : entry.progress * 100}%` }}
          />
        </div>
      )}
    </li>
  );
}

function ProgressMeter({ accepted }: { accepted: number }) {
  const pct = (n: number) => `${Math.min(100, (n / TARGET) * 100)}%`;
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold">Good photos</h2>
        <span className="font-mono text-sm tabular-nums text-zinc-500">
          {accepted} / {TARGET}
        </span>
      </div>
      <div
        className="relative mt-3 h-2 rounded-full bg-zinc-200"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={TARGET}
        aria-valuenow={accepted}
        aria-label="Accepted photos"
      >
        <motion.div
          className={`h-full rounded-full ${accepted >= MINIMUM ? 'bg-emerald-500' : 'bg-accent'}`}
          animate={{ width: pct(accepted) }}
        />
        <div className="absolute -top-1 -bottom-1 w-px bg-zinc-500" style={{ left: pct(MINIMUM) }} aria-hidden />
      </div>
      <div className="relative mt-1.5 h-4 text-[11px] text-zinc-500">
        <span className="absolute -translate-x-1/2" style={{ left: pct(MINIMUM) }}>
          Min {MINIMUM}
        </span>
      </div>
    </div>
  );
}

const TONES = {
  neutral: 'bg-white border-zinc-200',
  good: 'bg-emerald-50/60 border-emerald-100',
  bad: 'bg-rose-50/50 border-rose-100',
};

function Panel({
  tone,
  title,
  count,
  subtitle,
  icon,
  action,
  children,
}: {
  tone: keyof typeof TONES;
  title: string;
  count?: number;
  subtitle?: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <motion.section layout className={`mt-6 rounded-2xl border p-4 sm:p-5 ${TONES[tone]}`}>
      <h3 className="flex items-center gap-2 text-[15px] font-semibold">
        {icon}
        {title}
        {count !== undefined && <span className="font-mono text-sm font-normal text-zinc-500">{count}</span>}
        {action && <span className="ml-auto">{action}</span>}
      </h3>
      {subtitle && <p className="mt-1 text-sm text-zinc-600">{subtitle}</p>}
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4">
        <AnimatePresence mode="popLayout">{children}</AnimatePresence>
      </div>
    </motion.section>
  );
}

function Card({
  image,
  preview,
  copy,
  onDelete,
  onRetry,
}: {
  image: Image;
  preview?: string;
  copy?: Copy;
  onDelete: () => void;
  onRetry?: () => void;
}) {
  const settled = isSettled(image);
  // The server's normalized JPEG wins (HEIC can't render in most browsers); the local preview fills in until then.
  const src = image.url ?? preview;
  return (
    <motion.figure
      layout
      layoutId={image.id}
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96 }}
    >
      <div className="relative aspect-[3/4] overflow-hidden rounded-xl bg-zinc-200">
        {/* Filename sits behind the image, so an unrenderable preview (corrupt file) still shows something. */}
        <div className="absolute inset-0 grid place-items-center px-3 text-center font-mono text-xs break-all text-zinc-500">
          {image.filename}
        </div>
        {src && (
          <img
            src={src}
            alt={image.filename}
            onError={(e) => (e.currentTarget.hidden = true)}
            className={`relative size-full object-cover transition-[filter] duration-500 ${settled ? '' : 'scale-105 blur-md'}`}
          />
        )}
        {!settled && (
          <>
            <div className="shimmer absolute inset-0" aria-hidden />
            <div className="absolute inset-0 grid place-items-center">
              <span className="flex items-center gap-1.5 rounded-full bg-white/90 px-2.5 py-1 text-xs font-medium text-zinc-700 shadow-sm">
                <CircleNotch size={12} className="animate-spin" />
                {image.status === 'pending_upload'
                  ? 'Uploading'
                  : image.status === 'processing'
                    ? 'Checking'
                    : 'Queued'}
              </span>
            </div>
          </>
        )}
        <button
          type="button"
          onClick={onDelete}
          aria-label={`Remove ${image.filename}`}
          className="absolute top-2 right-2 grid size-8 place-items-center rounded-full bg-white/90 text-zinc-700 shadow-sm transition hover:bg-white hover:text-rose-600 focus-visible:outline-2 focus-visible:outline-accent active:scale-90"
        >
          <Trash size={16} />
        </button>
      </div>
      {copy && (
        <figcaption className="mt-2 px-1">
          <p className="text-sm font-medium text-zinc-800">{copy.label}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-zinc-500">{copy.hint}</p>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs font-medium hover:border-zinc-400 focus-visible:outline-2 focus-visible:outline-accent active:scale-[0.97]"
            >
              <ArrowClockwise size={12} weight="bold" /> Retry
            </button>
          )}
        </figcaption>
      )}
    </motion.figure>
  );
}

function EmptyState() {
  const good = ['Just you, face clearly visible', 'Sharp and well lit', 'Varied backgrounds, outfits, and angles'];
  const bad = ['Group photos', 'Blurry or far-away shots', 'Near-identical repeats', 'Screenshots and thumbnails'];
  return (
    <div className="mt-6 grid gap-4 rounded-2xl border border-dashed border-zinc-300 bg-white p-5 sm:grid-cols-2">
      <List title="Great photos" items={good} icon={<Check size={14} weight="bold" className="text-emerald-600" />} />
      <List title="Avoid" items={bad} icon={<X size={14} weight="bold" className="text-rose-500" />} />
    </div>
  );
}

function List({ title, items, icon }: { title: string; items: string[]; icon: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-sm font-semibold">{title}</h3>
      <ul className="mt-2 space-y-1.5">
        {items.map((t) => (
          <li key={t} className="flex items-center gap-2 text-sm text-zinc-600">
            {icon}
            {t}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Requirements() {
  const rules = [
    `JPG, PNG, or HEIC, between 50 KB and ${MAX_MB} MB`,
    'At least 512px on the shortest side',
    'Exactly one face, filling at least 5% of the photo',
    'Face in focus (a blurred background is fine)',
    'Not a near-duplicate of a photo you already have',
  ];
  return (
    <details className="group mt-6 rounded-2xl border border-zinc-200 bg-white">
      <summary className="flex cursor-pointer list-none items-center justify-between p-4 text-[15px] font-semibold sm:p-5 [&::-webkit-details-marker]:hidden">
        Photo requirements
        <CaretDown size={16} className="transition-transform group-open:rotate-180" />
      </summary>
      <ul className="space-y-1.5 px-4 pb-4 sm:px-5 sm:pb-5">
        {rules.map((r) => (
          <li key={r} className="flex items-center gap-2 text-sm text-zinc-600">
            <Check size={14} weight="bold" className="text-zinc-400" />
            {r}
          </li>
        ))}
      </ul>
    </details>
  );
}
