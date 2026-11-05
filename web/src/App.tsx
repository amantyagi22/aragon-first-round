import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, LayoutGroup, motion } from 'motion/react';
import { CheckCircle, CircleNotch, Trash, UploadSimple, WarningCircle } from '@phosphor-icons/react';
import { MAX_UPLOAD_BYTES, SETTLED_STATUSES, type ImageDto as Image } from 'shared';
import { REASON_COPY, completeUpload, deleteImage, isSupportedImage, listImages, reserveUploads, uploadToStorage } from './api';

const TARGET = 10;
const MAX_MB = MAX_UPLOAD_BYTES / 1024 / 1024;
const isSettled = (i: Image) => SETTLED_STATUSES.includes(i.status);

/** Client-side state for in-flight uploads: local preview + progress, keyed by server id. */
type UploadProgress = { preview: string; progress: number };
/** Files rejected in the browser (wrong type / too big): they never reach the server. */
type ClientReject = { key: string; filename: string; label: string; hint: string };

export function App() {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [local, setLocal] = useState<Record<string, UploadProgress>>({});
  const [clientRejects, setClientRejects] = useState<ClientReject[]>([]);
  const [dragging, setDragging] = useState(false);

  const { data: images = [] } = useQuery({
    queryKey: ['images'],
    queryFn: listImages,
    // Poll only while something is still being processed.
    refetchInterval: (q) => (q.state.data?.some((i) => !isSettled(i)) ? 1000 : false),
  });

  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      const reservations = await reserveUploads(files);
      setLocal((s) => ({ ...s, ...Object.fromEntries(reservations.map((r, i) => [r.id, { preview: URL.createObjectURL(files[i]), progress: 0 }])) }));
      await qc.invalidateQueries({ queryKey: ['images'] });
      await Promise.all(reservations.map(async (r, i) => {
        await uploadToStorage(r, files[i], (p) => setLocal((s) => ({ ...s, [r.id]: { ...s[r.id], progress: p } })));
        await completeUpload(r.id);
        await qc.invalidateQueries({ queryKey: ['images'] });
      }));
    },
  });

  const remove = useMutation({
    mutationFn: deleteImage,
    onMutate: (id) => qc.setQueryData<Image[]>(['images'], (xs) => xs?.filter((x) => x.id !== id)),
    onSettled: () => qc.invalidateQueries({ queryKey: ['images'] }),
  });

  async function onFiles(list: FileList | null) {
    const files = [...(list ?? [])];
    const verdicts = await Promise.all(files.map(async (f) =>
      !(await isSupportedImage(f)) ? REASON_COPY.unsupported_format
        : f.size > MAX_UPLOAD_BYTES ? { label: 'File too large', hint: `Photos must be under ${MAX_MB} MB.` }
          : null));
    setClientRejects((r) => [...r, ...files.flatMap((f, i) => verdicts[i] ? [{ key: crypto.randomUUID(), filename: f.name, ...verdicts[i] }] : [])]);
    const ok = files.filter((_, i) => !verdicts[i]);
    if (ok.length) upload.mutate(ok);
  }

  const accepted = images.filter((i) => i.status === 'accepted');
  const rejected = images.filter((i) => i.status === 'rejected' || i.status === 'failed');
  const pending = images.filter((i) => !isSettled(i));
  const busy = pending.length > 0 || upload.isPending;

  return (
    <div className="min-h-dvh font-sans text-zinc-900 antialiased">
      <header className="sticky top-0 z-10 border-b border-zinc-200 bg-white/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center px-6 text-[15px] font-semibold tracking-tight">Headshot studio</div>
      </header>

      <main className="mx-auto grid max-w-6xl gap-10 px-6 py-10 md:grid-cols-[300px_1fr]">
        <aside className="md:sticky md:top-24 md:self-start">
          <h1 className="text-2xl font-semibold tracking-tight">Upload photos</h1>
          <p className="mt-2 text-sm leading-relaxed text-zinc-600">
            Select at least <b className="text-zinc-900">{TARGET}</b> of your best photos. A mix of close-ups, selfies and mid-range shots works best.
          </p>
          <button
            type="button"
            onClick={() => input.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => { e.preventDefault(); setDragging(false); onFiles(e.dataTransfer.files); }}
            className={`mt-6 flex w-full flex-col items-center gap-3 rounded-2xl border-2 border-dashed px-6 py-10 text-center transition-colors focus-visible:outline-2 focus-visible:outline-accent ${dragging ? 'border-accent bg-orange-50' : 'border-zinc-300 bg-white hover:border-zinc-400'}`}
          >
            <span className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white shadow-sm">
              {busy ? <CircleNotch className="animate-spin" size={16} /> : <UploadSimple size={16} weight="bold" />}
              {busy ? 'Uploading…' : 'Choose photos'}
            </span>
            <span className="text-sm font-medium">Click to upload or drag and drop</span>
            <span className="text-xs text-zinc-500">PNG, JPG, HEIC up to {MAX_MB} MB</span>
          </button>
          <input ref={input} type="file" multiple hidden accept=".jpg,.jpeg,.png,.heic,.heif,image/jpeg,image/png,image/heic,image/heif"
            onChange={(e) => { onFiles(e.target.files); e.target.value = ''; }} />
          {upload.isError && <p role="alert" className="mt-3 text-sm text-rose-600">Upload failed. Please try again.</p>}
        </aside>

        <section>
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold">Uploaded images</h2>
            <span className="text-sm tabular-nums text-zinc-500">{accepted.length} of {TARGET}</span>
          </div>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-zinc-200">
            <motion.div className="h-full rounded-full bg-emerald-500" animate={{ width: `${Math.min(100, (accepted.length / TARGET) * 100)}%` }} />
          </div>

          <LayoutGroup>
            {pending.length > 0 && (
              <Panel tone="neutral" title="Checking your photos" subtitle="We're verifying the quality of your uploads to make sure you get the best results.">
                {pending.map((i) => <Tile key={i.id} image={i} local={local[i.id]} onDelete={() => remove.mutate(i.id)} />)}
              </Panel>
            )}
            {accepted.length > 0 && (
              <Panel tone="good" title={`${accepted.length} photo${accepted.length === 1 ? '' : 's'} accepted`} icon={<CheckCircle size={18} weight="fill" className="text-emerald-600" />}>
                {accepted.map((i) => <Tile key={i.id} image={i} local={local[i.id]} onDelete={() => remove.mutate(i.id)} />)}
              </Panel>
            )}
            {(rejected.length > 0 || clientRejects.length > 0) && (
              <Panel tone="bad" title="Some photos didn't meet our guidelines" subtitle="Replacing these is optional once you have enough good photos." icon={<WarningCircle size={18} weight="fill" className="text-rose-500" />}>
                {rejected.map((i) => {
                  const copy = REASON_COPY[i.status === 'failed' ? 'failed' : i.reason!];
                  return <Tile key={i.id} image={i} local={local[i.id]} copy={copy} onDelete={() => remove.mutate(i.id)} />;
                })}
                {clientRejects.map((r) => (
                  <Tile key={r.key} image={{ id: r.key, filename: r.filename, status: 'rejected', reason: null, reasonDetail: null, width: null, height: null, createdAt: '', url: null }}
                    copy={r} onDelete={() => setClientRejects((xs) => xs.filter((x) => x.key !== r.key))} />
                ))}
              </Panel>
            )}
            {images.length === 0 && clientRejects.length === 0 && (
              <p className="mt-16 text-center text-sm text-zinc-500">Your photos will appear here.</p>
            )}
          </LayoutGroup>
        </section>
      </main>
    </div>
  );
}

const TONES = { neutral: 'bg-white border-zinc-200', good: 'bg-emerald-50/60 border-emerald-100', bad: 'bg-rose-50/50 border-rose-100' };

function Panel({ tone, title, subtitle, icon, children }: { tone: keyof typeof TONES; title: string; subtitle?: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <motion.div layout className={`mt-6 rounded-2xl border p-5 ${TONES[tone]}`}>
      <h3 className="flex items-center gap-2 text-[15px] font-semibold">{icon}{title}</h3>
      {subtitle && <p className="mt-1 text-sm text-zinc-600">{subtitle}</p>}
      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        <AnimatePresence mode="popLayout">{children}</AnimatePresence>
      </div>
    </motion.div>
  );
}

function Tile({ image, local, copy, onDelete }: { image: Image; local?: UploadProgress; copy?: { label: string; hint: string }; onDelete: () => void }) {
  const settled = isSettled(image);
  // Prefer the server's processed JPEG (HEIC can't render in most browsers); fall back to the local preview.
  const src = image.url ?? local?.preview;
  const uploading = image.status === 'pending_upload' && local && local.progress < 1;
  return (
    <motion.figure layout layoutId={image.id} initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }} className="group">
      <div className="relative aspect-[3/4] overflow-hidden rounded-xl bg-zinc-200">
        {src ? <img src={src} alt={image.filename} className={`size-full object-cover transition-[filter] duration-500 ${settled ? '' : 'blur-md scale-105'}`} /> : <div className="grid size-full place-items-center px-3 text-center font-mono text-xs break-all text-zinc-500">{image.filename}</div>}
        {!settled && (
          <div className="absolute inset-0 grid place-items-center">
            <span className="flex items-center gap-1.5 rounded-full bg-white/90 px-2.5 py-1 text-xs font-medium text-zinc-700 shadow-sm">
              <CircleNotch size={12} className="animate-spin" />
              {uploading ? `Uploading ${Math.round((local?.progress ?? 0) * 100)}%` : image.status === 'processing' ? 'Checking' : 'Queued'}
            </span>
          </div>
        )}
        <button type="button" onClick={onDelete} aria-label={`Delete ${image.filename}`}
          className="absolute right-2 top-2 grid size-8 place-items-center rounded-full bg-white/90 text-zinc-700 shadow-sm transition hover:bg-white hover:text-rose-600 focus-visible:outline-2 focus-visible:outline-accent">
          <Trash size={16} />
        </button>
      </div>
      {copy && (
        <figcaption className="mt-2 px-1">
          <p className="text-sm font-medium text-zinc-800">{copy.label}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-zinc-500">{copy.hint}</p>
        </figcaption>
      )}
    </motion.figure>
  );
}
