# QA checklist

Script for the recorded walkthrough.
Start from a fresh session: open the app in a private window, or run `localStorage.clear()` and reload.
Fixtures are in `server/test/fixtures/`.

## Empty and upload states

- [ ] Empty state shows "Great photos" and "Avoid" lists, the progress meter at 0 / 10 with the Min 6 marker, and collapsed Photo requirements.
- [ ] Tab to the dropzone: a visible focus ring appears, and Enter or Space opens the file picker.
- [ ] Drag a file over the dropzone: the border turns orange and the button reads "Drop to upload".

## Browser-side rejection (no network request)

- [ ] `animation.gif`: appears in the Uploads list as "Unsupported format" immediately.
- [ ] Any file renamed to `.jpg` that is not an image (for example `pdf-renamed.jpg`): rejected in the Uploads list by its magic bytes.
- [ ] A file over 120 MB: "File too large" in the Uploads list.
- [ ] DevTools Network tab shows no request for any of the above.

## Server-side validation

Drop these together and watch each card move from the blurred, shimmering "Checking" state into a grid:

| Fixture                 | Expected                                                              |
| ----------------------- | --------------------------------------------------------------------- |
| `ok-selfie.jpg`         | Accepted                                                              |
| `ok-second-selfie.jpg`  | Accepted (same person, different photo)                               |
| `ok-headshot.png`       | Accepted                                                              |
| `src/selfie.heic`       | Accepted, preview renders even though the browser can't show HEIC     |
| `portrait-mode.jpg`     | Accepted (blurred background, sharp face)                             |
| `sideways-exif.jpg`     | Accepted and shown upright                                            |
| `tiny-thumbnail.jpg`    | File too small                                                        |
| `corrupt.jpg`           | Unreadable file (filename shown instead of a preview)                 |
| `low-resolution.jpg`    | Resolution too low                                                    |
| `no-face-landscape.jpg` | No face detected                                                      |
| `group.jpg`             | Multiple faces                                                        |
| `face-too-small.jpg`    | Face is too far away                                                  |
| `blurry.jpg`            | Blurry face                                                           |
| `near-duplicate.jpg`    | Too similar to another upload (if `ok-selfie.jpg` was accepted first) |

- [ ] Every rejected card shows its reason and a fix hint without hovering.
- [ ] At most 4 files show upload progress at the same time.
- [ ] "All photos have been checked" toast appears once everything settles.
- [ ] The progress meter turns green at 6 accepted photos.
- [ ] With VoiceOver on, verdicts are announced ("group.jpg needs attention: Multiple faces").

## Managing the set

- [ ] Delete an accepted photo: it disappears instantly and the counter drops.
- [ ] Click **Delete all** on Needs attention: a confirmation appears; after confirming, every rejected and failed photo is gone and accepted photos remain.
- [ ] Click the ✕ next to Uploads: the upload list hides, nothing is deleted, and every card (including `tiny-thumbnail.jpg`) keeps its preview.
- [ ] Upload `near-duplicate.jpg` again after deleting `ok-selfie.jpg`: now accepted.
- [ ] Reload the page: all images come back from the server.
- [ ] Stop the worker (Ctrl-C), upload a photo, and see it wait in "Queued"; restart with `pnpm dev` and it gets processed.

## Failure and recovery

- [ ] Covered by tests (`server/test/recovery.test.ts`): a worker killed mid-job is reclaimed, and after 3 crashed attempts the image ends "Something went wrong on our side" with a Retry button.

## Layout

- [ ] At 390px wide the layout is a single column with no horizontal scroll.
