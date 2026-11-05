# Brag plan - Headshot studio photo upload

## Answers

- **What:** A photo uploader that checks every selfie in the background and sorts it into Accepted or Rejected, with a plain-English reason.
- **For:** People uploading photos for AI headshots, who need to know which photos are usable and why the rest are not.
- **Sets it apart:** 8 fail-fast checks (magic bytes, size, HEIC, resolution, face count, face size, blur, dHash duplicates) in an async worker; the API never touches the bytes.
- **Most impressive / funniest claim:** `not-an-image.jpg` - its name says JPG, its bytes do not, and it is caught at step 1.
- **Visual hook:** Real selfies fanned out, each getting stamped with its verdict.
- **Real UI shown:** The actual App markup and Tailwind classes, the real fixture photos, the real REASON_COPY labels.
- **Tone:** default - punchy, playful, clean, in the app's zinc + orange identity.
- **Share caption:** Drop 10 selfies in, 3 make it, and the other 7 are told exactly why.

## Angle

A bouncer for your selfies: it lets the good ones in and tells the rest why not.

## Visual identity

- Geist Variable, zinc-50 background, zinc-900 text, accent #d9773f.
- Emerald for accepted, red for rejected, exactly as in `web/src/App.tsx`.

## Storyboard (20.0s, 1920x1080, 30fps)

| # | Time | Scene |
|---|---|---|
| 1 | 0.0-3.0 | **Hook.** "Not every selfie makes the cut." Five real photos fan in and get stamped: Multiple faces, Accepted, No face detected, Blurry face detected, Accepted. |
| 2 | 3.0-7.2 | **Reveal.** The real Headshot studio UI. A cursor drags 10 files onto the drop zone; it turns orange; tiles appear blurred with Uploading % then Checking. Caption: "Drop your photos in." |
| 3 | 7.2-12.6 | **Highlight: the sort.** Tiles unblur one by one and glide into Accepted or Rejected with their reason labels. Progress bar fills to 3 of 10. Camera pushes into the reasons; cursor hovers "Too similar to another upload" and the real tooltip opens. Caption: "Every rejection comes with a reason." |
| 4 | 12.6-16.8 | **Highlight: under the hood.** "8 checks. Cheapest first." Eight pipeline steps in a row. `not-an-image.jpg` fails step 1 ("Name says .jpg. Bytes don't."), `ok-selfie.jpg` lights up all eight and is accepted. |
| 5 | 16.8-20.0 | **Punchline.** "Only the good ones get through." over the real Accepted panel with 3 photos, stack line underneath. |

## Sound

120 bpm in F major (F - Dm - Bb - C), soft pad, plucked arpeggio, light kick from the reveal.
Effects are pitched to the same chords: soft plucks for accepted tiles, muted low notes for rejected, filtered-noise whooshes for transitions, all through the same reverb.
