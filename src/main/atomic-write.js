// ── Crash-safe writes (0330) ──
// Every file that matters is written the same way: to a temp file in the
// same directory (same filesystem, so the rename is atomic), fsynced so the
// bytes are really down, then renamed over the target. An interruption at
// any point leaves either the old complete file or the new complete file,
// never a truncated one.
const fs = require('fs');
const path = require('path');

const TMP_PREFIX = '.flow-tmp-';

function atomicWrite(target, content, { mode } = {}) {
  const dir = path.dirname(target);
  const tmp = path.join(dir, `${TMP_PREFIX}${path.basename(target)}.${process.pid}.${Date.now()}`);
  const fd = fs.openSync(tmp, 'w', mode === undefined ? 0o644 : mode);
  try {
    fs.writeFileSync(fd, content, 'utf-8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, target);
  } catch (err) {
    // Rename failed (permissions, target dir vanished): clean the temp so
    // it cannot masquerade as content, then rethrow the real problem.
    try {
      fs.unlinkSync(tmp);
    } catch (cleanupErr) {
      // Nothing more to do.
    }
    throw err;
  }
}

// Create-only variant (0331): full content lands via hard link, which the
// filesystem refuses atomically when the target already exists. This is the
// claim step for card ids — an agent writing the same filename in the same
// instant loses cleanly with EEXIST instead of both winning.
function atomicCreate(target, content) {
  const dir = path.dirname(target);
  const tmp = path.join(dir, `${TMP_PREFIX}${path.basename(target)}.${process.pid}.${Date.now()}`);
  const fd = fs.openSync(tmp, 'w', 0o644);
  try {
    fs.writeFileSync(fd, content, 'utf-8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.linkSync(tmp, target);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch (cleanupErr) {
      // Nothing more to do.
    }
    throw err;
  }
  fs.unlinkSync(tmp);
}

// Stale temp files from a crashed run: swept opportunistically by callers
// that own a directory. Older than an hour means no live write owns it.
function sweepStaleTemp(dir) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    return;
  }
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const name of entries) {
    if (!name.startsWith(TMP_PREFIX)) continue;
    const file = path.join(dir, name);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
    } catch (err) {
      // Already gone, or unreadable — either way not ours to fight over.
    }
  }
}

// A short rolling history for documents (0330): the previous version of the
// file is copied into .history/ beside it before an overwrite, newest kept,
// pruned to `keep`. Restoring is a hand-copy, deliberately — no UI to hold.
function keepHistory(target, keep = 5) {
  if (!fs.existsSync(target)) return;
  const dir = path.join(path.dirname(target), '.history');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(target, path.join(dir, `${stamp}-${path.basename(target)}`));
    const mine = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(`-${path.basename(target)}`))
      .sort();
    for (const name of mine.slice(0, Math.max(0, mine.length - keep))) {
      fs.unlinkSync(path.join(dir, name));
    }
  } catch (err) {
    // History is a nicety; the atomic write above it is the guarantee.
  }
}

module.exports = { atomicWrite, atomicCreate, sweepStaleTemp, keepHistory, TMP_PREFIX };
