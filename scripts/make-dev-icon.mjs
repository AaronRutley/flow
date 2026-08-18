#!/usr/bin/env node
/**
 * Makes the dev build's icon (0204): the production icon run through
 * Google's nano-banana on Replicate with a prompt that recolors it toward
 * amber and stamps a small DEV tag, so the Dock says at a glance which
 * flow is which.
 *
 *   REPLICATE_API_TOKEN=... node scripts/make-dev-icon.mjs
 *
 * Writes build/icon_dev_1024.png and build/icon_dev.icns. Run once (or
 * whenever the base icon changes); brand-dev-app.js prefers the dev icns
 * when it exists. Production builds never touch these files.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.join(import.meta.dirname, '..');
const BASE = path.join(ROOT, 'build', 'icon_1024.png');
const OUT_PNG = path.join(ROOT, 'build', 'icon_dev_1024.png');
const OUT_ICNS = path.join(ROOT, 'build', 'icon_dev.icns');

const token = process.env.REPLICATE_API_TOKEN;
if (!token) {
  console.error('REPLICATE_API_TOKEN is not set');
  process.exit(1);
}
if (!fs.existsSync(BASE)) {
  console.error(`missing ${BASE}`);
  process.exit(1);
}

const dataUri = `data:image/png;base64,${fs.readFileSync(BASE).toString('base64')}`;

const prompt = [
  'Edit this macOS app icon. Keep the exact same shape, composition,',
  'perspective and rounded-square silhouette. Shift the color scheme from',
  'its current tones to a warm amber/orange palette, and add a small,',
  'clean, capital-letters "DEV" tag in the bottom-right corner inside a',
  'subtle darker rounded rectangle. No other changes, no new elements,',
  'same background transparency and framing.',
].join(' ');

console.log('[dev-icon] asking nano-banana…');
const res = await fetch('https://api.replicate.com/v1/models/google/nano-banana/predictions', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Prefer: 'wait=60',
  },
  body: JSON.stringify({ input: { prompt, image_input: [dataUri] } }),
});
if (!res.ok) {
  console.error(`[dev-icon] replicate said ${res.status}: ${(await res.text()).slice(0, 300)}`);
  process.exit(1);
}
let prediction = await res.json();

// `Prefer: wait` usually returns finished; poll if it came back early.
while (prediction.status === 'starting' || prediction.status === 'processing') {
  await new Promise((r) => setTimeout(r, 2000));
  const poll = await fetch(`https://api.replicate.com/v1/predictions/${prediction.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  prediction = await poll.json();
}
if (prediction.status !== 'succeeded') {
  console.error(`[dev-icon] prediction ${prediction.status}: ${prediction.error || ''}`);
  process.exit(1);
}

const url = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output;
const img = await fetch(url);
fs.writeFileSync(OUT_PNG, Buffer.from(await img.arrayBuffer()));
console.log(`[dev-icon] wrote ${OUT_PNG}`);

// The model returns opaque JPEG; graft the production icon's rounded alpha
// back on through Electron's nativeImage.
execFileSync('npx', ['electron', path.join(ROOT, 'scripts', 'apply-icon-alpha.js')], {
  cwd: ROOT,
  stdio: 'ignore',
});
console.log('[dev-icon] alpha grafted');

// PNG → icns through the same sips/iconutil path the base icon uses.
const iconset = path.join(ROOT, 'build', 'icon_dev.iconset');
fs.rmSync(iconset, { recursive: true, force: true });
fs.mkdirSync(iconset, { recursive: true });
for (const size of [16, 32, 128, 256, 512]) {
  execFileSync('sips', ['-z', String(size), String(size), OUT_PNG, '--out',
    path.join(iconset, `icon_${size}x${size}.png`)], { stdio: 'ignore' });
  execFileSync('sips', ['-z', String(size * 2), String(size * 2), OUT_PNG, '--out',
    path.join(iconset, `icon_${size}x${size}@2x.png`)], { stdio: 'ignore' });
}
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', OUT_ICNS]);
console.log(`[dev-icon] wrote ${OUT_ICNS}`);
