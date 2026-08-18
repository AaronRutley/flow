// ── Path containment (0315) ──
// Every IPC handler that accepts a renderer-supplied path answers one
// question before touching disk: does this path really live inside a root
// we granted? "Really" is the point — candidates are resolved through
// realpath so `..` hops, absolute escapes and symlinks planted inside a
// root all land on the true target before the prefix check, and a target
// that does not exist yet resolves through its nearest existing ancestor
// so a symlinked parent cannot smuggle a write elsewhere.
const fs = require('fs');
const path = require('path');

function realResolve(candidate) {
  let current = path.resolve(String(candidate || ''));
  const suffix = [];
  for (;;) {
    try {
      const real = fs.realpathSync(current);
      return suffix.length ? path.join(real, ...suffix.reverse()) : real;
    } catch (err) {
      const parent = path.dirname(current);
      // Filesystem root and still nothing real to stand on: give back the
      // plain resolution; the prefix check will judge it as-is.
      if (parent === current) return path.resolve(String(candidate || ''));
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

function isInside(rootDir, candidate) {
  if (!rootDir) return false;
  let root;
  try {
    root = fs.realpathSync(rootDir);
  } catch (err) {
    return false;
  }
  const real = realResolve(candidate);
  return real === root || real.startsWith(root + path.sep);
}

// True when the candidate lives inside at least one of the roots. Roots may
// contain falsy entries (projects without a board yet); they are skipped.
function inRoots(candidate, roots) {
  if (!candidate) return false;
  return (roots || []).filter(Boolean).some((root) => isInside(root, candidate));
}

// The one refusal shape guarded handlers return, so the renderer can tell a
// policy refusal from a real filesystem error.
const PATH_REFUSAL = { error: 'path-outside-root' };

module.exports = { realResolve, isInside, inRoots, PATH_REFUSAL };
