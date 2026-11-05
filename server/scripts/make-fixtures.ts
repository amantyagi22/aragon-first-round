// Derives every rejection case from the user-supplied source photos in test/fixtures/src.
import sharp from 'sharp';
import { writeFile } from 'node:fs/promises';
const src = new URL('../test/fixtures/src/', import.meta.url);
const out = new URL('../test/fixtures/', import.meta.url);
const s = (f: string) => sharp(new URL(f, src).pathname).rotate();
const save = (f: string, b: Buffer) => writeFile(new URL(f, out), b);

const selfie = await s('selfie.jpg').resize(1200).jpeg({ quality: 92 }).toBuffer();
await save('ok-selfie.jpg', selfie);
await save('ok-headshot.png', await s('headshot.png').png().toBuffer());
// Same photo, re-encoded smaller + slightly brighter: should be "too similar".
await save('similar-selfie.jpg', await sharp(selfie).resize(1000).modulate({ brightness: 1.05 }).jpeg({ quality: 80 }).toBuffer());
await save('blurry.jpg', await sharp(selfie).blur(12).jpeg({ quality: 95 }).toBuffer());
await save('low-res.jpg', await s('glasses.jpg').resize(400).jpeg({ quality: 100, chromaSubsampling: '4:4:4' }).toBuffer());
await save('tiny-bytes.jpg', await s('glasses.jpg').resize(900).jpeg({ quality: 5 }).toBuffer());
await save('no-face.jpg', await s('desk.jpg').jpeg({ quality: 90 }).toBuffer());
// Face pasted small onto a large canvas.
const smallFace = await sharp(selfie).resize(220).toBuffer();
await save('face-too-small.jpg', await sharp({ create: { width: 2400, height: 1800, channels: 3, background: '#d8d4cc' } })
  .composite([{ input: smallFace, left: 1100, top: 700 }]).jpeg({ quality: 92 }).toBuffer());
// Two different people... well, two faces side by side.
const left = await sharp(selfie).resize(800, 1200, { fit: 'cover' }).toBuffer();
const right = await s('headshot.png').resize(800, 1200, { fit: 'cover' }).toBuffer();
await save('multiple-faces.jpg', await sharp({ create: { width: 1600, height: 1200, channels: 3, background: '#fff' } })
  .composite([{ input: left, left: 0, top: 0 }, { input: right, left: 800, top: 0 }]).jpeg({ quality: 90 }).toBuffer());
// Valid-looking extension, wrong bytes.
await save('not-an-image.jpg', Buffer.alloc(80 * 1024, 'GIF89a'));
console.log('fixtures written');
