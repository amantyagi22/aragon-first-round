/**
 * Validation thresholds, in one place. Code constants, not env vars: changing a rule is a reviewed code change.
 * Values were calibrated against the fixtures in test/fixtures (see README "Validation pipeline").
 */
export const RULES = {
  /** Smaller files are almost always thumbnails or heavily recompressed. */
  minBytes: 50 * 1024,
  /** Shortest side, after EXIF orientation is applied. */
  minSidePx: 512,
  /** Face detector confidence; detections below this are ignored when counting faces. */
  minFaceConfidence: 0.5,
  /** Face box area / image area. Below this the face is too far away. */
  minFaceAreaRatio: 0.05,
  /** Variance of the Laplacian on the face crop, resized to 256px wide. Sharp faces score in the hundreds; a soft blur is under 20. */
  minSharpness: 40,
  /** Max Hamming distance (of 64 dHash bits) to an accepted image for two photos to count as near-duplicates. */
  maxSimilarDistance: 10,
} as const;

export const WORKER = {
  maxAttempts: 3,
  /** A `processing` row older than this is assumed to belong to a dead worker and is reclaimed. */
  staleAfterSeconds: Number(process.env.WORKER_STALE_SECONDS ?? 120),
  concurrency: Number(process.env.WORKER_CONCURRENCY ?? 2),
  idlePollMs: 500,
} as const;

/** Signed preview URLs are valid for 5-10 minutes and stable within a 5 minute window, so polling doesn't re-download images. */
export const PREVIEW_URL_WINDOW_SECONDS = 300;
