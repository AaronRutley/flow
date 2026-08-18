// Grafts the production icon's alpha channel onto the dev artwork (0204):
// nano-banana returns opaque JPEG, and a Dock icon needs the rounded
// transparency back. Runs under Electron for nativeImage:
//   npx electron scripts/apply-icon-alpha.js
const { app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BASE = path.join(ROOT, 'build', 'icon_1024.png');
const ART = path.join(ROOT, 'build', 'icon_dev_1024.png');

app.whenReady().then(() => {
  const base = nativeImage.createFromPath(BASE).resize({ width: 1024, height: 1024 });
  const art = nativeImage.createFromPath(ART).resize({ width: 1024, height: 1024 });
  const baseBits = base.toBitmap();
  const artBits = art.toBitmap();

  // BGRA rows: keep the art's color, take the base's alpha, premultiplied
  // the way toBitmap hands it over.
  for (let i = 0; i < artBits.length; i += 4) {
    const a = baseBits[i + 3];
    artBits[i] = Math.round((artBits[i] * a) / 255);
    artBits[i + 1] = Math.round((artBits[i + 1] * a) / 255);
    artBits[i + 2] = Math.round((artBits[i + 2] * a) / 255);
    artBits[i + 3] = a;
  }

  const out = nativeImage.createFromBitmap(artBits, { width: 1024, height: 1024 });
  fs.writeFileSync(ART, out.toPNG());
  console.log(`[dev-icon] alpha grafted onto ${ART}`);
  app.quit();
});
