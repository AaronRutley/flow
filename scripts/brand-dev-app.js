#!/usr/bin/env node
/**
 * Make a development run present itself as flow instead of Electron.
 *
 *   node scripts/brand-dev-app.js
 *
 * `npm start` runs the app inside node_modules/electron's stock bundle, and
 * macOS reads the Dock label, the app menu title and the Dock icon from that
 * bundle's Info.plist — not from package.json, and not from app.setName(). So
 * this rewrites the bundle's name keys and swaps in build/icon.icns.
 *
 * Editing the bundle invalidates its signature, so it is re-signed ad hoc
 * afterwards. Runs from postinstall, because npm replaces the bundle whenever
 * electron is reinstalled.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'node_modules', 'electron', 'dist');
const STOCK = path.join(DIST, 'Electron.app');
// The bundle is renamed on disk: the Dock's hover label comes from Launch
// Services, which keys off the bundle path, and a bundle called Electron.app
// says "Electron" on hover no matter what its Info.plist claims.
const APP = path.join(DIST, 'Flow.app');
const PATH_TXT = path.join(ROOT, 'node_modules', 'electron', 'path.txt');
const PLIST = path.join(APP, 'Contents', 'Info.plist');
// The dev build wears its own amber icon when one has been made (0204), so
// the Dock says at a glance which flow is which; production packaging reads
// build/icon.icns through electron-builder and never sees the dev variant.
const DEV_ICNS = path.join(ROOT, 'build', 'icon_dev.icns');
const ICNS = fs.existsSync(DEV_ICNS) ? DEV_ICNS : path.join(ROOT, 'build', 'icon.icns');

const NAME = 'Flow';
// The same identity and bundle id as the packaged app: macOS keys permission
// grants (Documents access, etc.) off both, so dev and release runs share one
// set of grants that survive rebuilds. The certificate is self-signed, made
// once in the login keychain under this name.
const IDENTITY = 'flow code signing';
const BUNDLE_ID = 'com.flow.app';

function plist(...commands) {
  const args = commands.flatMap((c) => ['-c', c]);
  return execFileSync('/usr/libexec/PlistBuddy', [...args, PLIST], { encoding: 'utf8' }).trim();
}

function main() {
  if (process.platform !== 'darwin') return;

  // A fresh npm install brings the stock bundle back; move it over the brand.
  if (fs.existsSync(STOCK)) {
    fs.rmSync(APP, { recursive: true, force: true });
    fs.renameSync(STOCK, APP);
  }
  if (!fs.existsSync(PLIST)) {
    console.log('[brand] no Electron bundle yet — skipping');
    return;
  }

  // Prestart runs this before every launch as a safety net (0479), so an
  // already-branded bundle exits before the plist edits and the re-sign.
  try {
    if (
      plist('Print :CFBundleName') === NAME &&
      fs.readFileSync(PATH_TXT, 'utf8').startsWith('Flow.app/')
    ) {
      return;
    }
  } catch (err) {
    // Unreadable plist or path.txt just means brand from scratch.
  }

  // The electron launcher reads path.txt to find the binary. The case has to
  // match the renamed bundle: a case-sensitive volume never finds flow.app.
  fs.writeFileSync(PATH_TXT, 'Flow.app/Contents/MacOS/Electron', 'utf8');

  const icon = plist('Print :CFBundleIconFile');
  plist(
    `Set :CFBundleName ${NAME}`,
    `Set :CFBundleDisplayName ${NAME}`,
    `Set :CFBundleIdentifier ${BUNDLE_ID}`
  );

  if (fs.existsSync(ICNS)) {
    // Overwrite the icon the bundle already points at, so CFBundleIconFile and
    // the helper bundles keep working.
    fs.copyFileSync(ICNS, path.join(APP, 'Contents', 'Resources', icon));
  } else {
    console.log('[brand] no build/icon.icns — keeping the stock icon');
  }

  // Prefer the stable identity — an ad-hoc signature changes on every rebuild,
  // and macOS forgets permission grants whenever the signature changes.
  try {
    execFileSync('codesign', ['--force', '--deep', '--sign', IDENTITY, APP], { stdio: 'ignore' });
  } catch (err) {
    try {
      execFileSync('codesign', ['--force', '--deep', '--sign', '-', APP], { stdio: 'ignore' });
      console.log(`[brand] no "${IDENTITY}" certificate — signed ad hoc, permission prompts will recur`);
    } catch (err2) {
      console.log('[brand] re-signing failed — the app should still launch');
    }
  }

  // The Dock and Finder cache bundle names; touching the bundle invalidates it.
  try {
    execFileSync('touch', [APP]);
  } catch (err) {
    // Not worth failing install over.
  }

  console.log(`[brand] dev Electron.app now presents as "${NAME}"`);
}

main();
