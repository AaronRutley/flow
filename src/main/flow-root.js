const fs = require('fs');
const path = require('path');
const { atomicWrite } = require('./atomic-write');

// FLOW_ROOT is the folder that holds flow's files directly: one folder per
// project board, plus `config/`. In dev that is the repo's own `projects/`
// folder. The packaged app runs from inside flow.app, where nothing useful
// can live — boards written into the bundle would be invisible to git and
// wiped by the next build — so it asks on first launch and remembers the
// answer in a pointer file under Electron's per-app data folder: the one path
// that cannot live inside the chosen folder, because it says where that is.

const DEV_ROOT = path.resolve(__dirname, '..', '..', 'projects');

let packaged = false;
let pointerFile = null;
try {
  const { app } = require('electron');
  packaged = app.isPackaged;
  pointerFile = path.join(app.getPath('userData'), 'flow-root.json');
} catch (err) {
  // Not running under Electron (tests, scripts) — treat as dev.
}

function savedRoot() {
  try {
    const { root } = JSON.parse(fs.readFileSync(pointerFile, 'utf-8'));
    if (root && fs.existsSync(root)) return root;
  } catch (err) {
    // No pointer yet, or it names a folder that no longer exists.
  }
  return null;
}

function save(root) {
  fs.mkdirSync(path.dirname(pointerFile), { recursive: true });
  atomicWrite(pointerFile, JSON.stringify({ root }, null, 2));
}

const chosen = packaged ? savedRoot() : null;

// True on a packaged first launch: main.js shows the folder chooser and
// relaunches once a root is saved, so nothing reads the placeholder below.
const NEEDS_SETUP = packaged && !chosen;

const FLOW_ROOT = packaged
  ? chosen || path.join(path.dirname(pointerFile), 'data')
  : DEV_ROOT;

module.exports = { FLOW_ROOT, NEEDS_SETUP, save };
