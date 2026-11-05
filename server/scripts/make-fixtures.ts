// Derives every test case from the source photos in test/fixtures/src:
//   selfie.jpg (sharp close-up), glasses.jpg (a second, distinct selfie), headshot.png, selfie.heic (iPhone), desk.jpg (no person).
// The group photo and the far-away shot are composited from these, since no real ones were supplied.
import sharp from 'sharp';
import { writeFile } from 'node:fs/promises';

const src = (f: string) => sharp(new URL(`../test/fixtures/src/${f}`, import.meta.url).pathname).rotate();
const save = (f: string, b: Buffer) => writeFile(new URL(`../test/fixtures/${f}`, import.meta.url), b);

const selfie = await src('selfie.jpg').resize(1200).jpeg({ quality: 92 }).toBuffer();
const { width = 0, height = 0 } = await sharp(selfie).metadata();

await save('ok-selfie.jpg', selfie);
await save('ok-second-selfie.jpg', await src('glasses.jpg').resize(1200).jpeg({ quality: 92 }).toBuffer());
await save('ok-headshot.png', await src('headshot.png').png().toBuffer());

// Near-duplicate: re-encoded, slightly cropped, slightly brighter.
await save('near-duplicate.jpg', await sharp(selfie)
  .extract({ left: 30, top: 40, width: width - 60, height: height - 80 })
  .modulate({ brightness: 1.04 })
  .jpeg({ quality: 78 })
  .toBuffer());

await save('blurry.jpg', await sharp(selfie).blur(12).jpeg({ quality: 95 }).toBuffer());

// Portrait mode: background heavily blurred, face region left sharp.
const faceRegion = { left: Math.round(width * 0.2), top: Math.round(height * 0.12), width: Math.round(width * 0.6), height: Math.round(height * 0.5) };
await save('portrait-mode.jpg', await sharp(await sharp(selfie).blur(20).toBuffer())
  .composite([{ input: await sharp(selfie).extract(faceRegion).toBuffer(), left: faceRegion.left, top: faceRegion.top }])
  .jpeg({ quality: 92 })
  .toBuffer());

// Sideways: pixels stored rotated, with EXIF orientation 6 saying "rotate 90° clockwise to display".
await save('sideways-exif.jpg', await sharp(selfie).rotate(-90).withMetadata({ orientation: 6 }).jpeg({ quality: 92 }).toBuffer());

await save('low-resolution.jpg', await src('glasses.jpg').resize(400).jpeg({ quality: 100, chromaSubsampling: '4:4:4' }).toBuffer());
await save('tiny-thumbnail.jpg', await src('glasses.jpg').resize(160).jpeg({ quality: 80 }).toBuffer());
await save('no-face-landscape.jpg', await src('desk.jpg').jpeg({ quality: 90 }).toBuffer());

// Far-away shot: a small person on a large canvas.
await save('face-too-small.jpg', await sharp({ create: { width: 2400, height: 1800, channels: 3, background: '#d8d4cc' } })
  .composite([{ input: await sharp(selfie).resize(220).toBuffer(), left: 1100, top: 700 }])
  .jpeg({ quality: 92 })
  .toBuffer());

// Group photo: two people side by side.
await save('group.jpg', await sharp({ create: { width: 1600, height: 1200, channels: 3, background: '#fff' } })
  .composite([
    { input: await sharp(selfie).resize(800, 1200, { fit: 'cover' }).toBuffer(), left: 0, top: 0 },
    { input: await src('headshot.png').resize(800, 1200, { fit: 'cover' }).toBuffer(), left: 800, top: 0 },
  ])
  .jpeg({ quality: 90 })
  .toBuffer());

// Valid JPEG header, then garbage: passes the format and size gates, fails decoding.
const header = selfie.subarray(0, 600);
await save('corrupt.jpg', Buffer.concat([header, Buffer.alloc(100 * 1024, 0x5a)]));

// A real PDF renamed to .jpg, and a real GIF.
const pdf = `%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n`;
await save('pdf-renamed.jpg', Buffer.concat([Buffer.from(pdf), Buffer.alloc(60 * 1024, 0x20)]));
await save('animation.gif', await sharp(selfie).resize(600).gif().toBuffer());

console.log('fixtures written');
