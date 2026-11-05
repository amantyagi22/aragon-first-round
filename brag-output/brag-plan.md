# Brag plan - Headshot studio photo upload

## Answers

- **What:** A photo uploader that checks every selfie in the background and sorts it into Accepted or Rejected, with a plain-English reason.
- **For:** People uploading photos for AI headshots, who need to know which photos are usable and why the rest are not.
- **Sets it apart:** 8 fail-fast checks (magic bytes, size, decode, resolution, face count, face size, blur, dHash duplicates) in an async worker; the API never touches the bytes.
- **Most impressive / funniest claim:** `pdf-renamed.jpg` is caught in the browser before it uploads, and `corrupt.jpg` has a real JPEG header but fails at decode.
- **Visual hook:** Real selfies fanned out, each getting stamped with its verdict.
- **Real UI shown:** The actual App markup and Tailwind classes, the real fixture photos, the real REASON_COPY labels and hints.
- **Tone:** default - punchy, playful, clean, in the app's zinc + orange identity.
- **Share caption:** Drop 10 selfies in, 4 make it, and every rejected one says how to fix it.

## Angle

A bouncer for your selfies: it lets the good ones in and tells the rest why not.

## Visual identity

- Geist Variable, zinc-50 background, zinc-900 text, accent #d9773f.
- Emerald for accepted, rose for rejected, exactly as in `web/src/App.tsx`.

## Storyboard (20.0s, 1920x1080, 30fps)

| # | Time | Scene |
|---|---|---|
| 1 | 0.0-3.0 | **Hook.** "Not every selfie makes the cut." Five real photos fan in and get stamped: Multiple faces, Accepted, No face detected, Blurry face, Accepted. |
| 2 | 3.0-7.0 | **Reveal.** The real Headshot studio UI. A cursor drags 10 files onto the drop zone ("Drop to upload"). The Uploads list fills: `pdf-renamed.jpg` is rejected in the browser, the rest upload 4 at a time. Cards appear blurred with Uploading, Queued, Checking. Caption: "Drop your photos in." |
| 3 | 7.0-12.6 | **Highlight: the sort.** Cards unblur one by one and glide into Accepted or Needs attention, each rejection with its label and fix hint. The "Good photos" meter climbs to 4 / 10. The real "All photos have been checked" toast appears, and the camera pushes into the hints. Caption: "Every rejection says how to fix it." |
| 4 | 12.6-16.8 | **Highlight: under the hood.** "8 checks. Cheapest first." Eight pipeline steps in a row. `corrupt.jpg` passes magic bytes and size, then fails at Decodes ("JPEG header. Garbage inside."); `ok-selfie.jpg` lights up all eight and is accepted. |
| 5 | 16.8-20.0 | **Punchline.** "Only the good ones get through." over the real Accepted panel with 4 photos, stack line underneath. |

## Sound

120 bpm in F major (F - Dm - Bb - C), soft pad, plucked arpeggio, light kick from the reveal.
Effects are pitched to the same chords: soft plucks for accepted tiles, muted low notes for rejected, filtered-noise whooshes for transitions, all through the same reverb.
