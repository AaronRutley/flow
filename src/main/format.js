// ── On-disk format versioning (0362) ──
// The flow root carries an explicit format version in config/format.json
// instead of being forever inferred from folder names. Version 1 is the
// shape the app promises to keep readable. Migrations are ordered steps,
// each idempotent, each able to describe itself before touching anything,
// with the affected files backed up through the atomic-write history
// machinery. A root stamped newer than this build refuses politely.
const fs = require('fs');
const path = require('path');
const { atomicWrite, keepHistory } = require('./atomic-write');

const CURRENT = 1;

// Real migrations register here as { to, title, describe(root), apply(root) }.
// describe returns human-readable lines of what apply will do; apply must be
// safe to run twice. None exist yet — version 1 is the founding shape.
const MIGRATIONS = [];

function markerFile(flowRoot) {
  return path.join(flowRoot, 'config', 'format.json');
}

function readVersion(flowRoot) {
  try {
    const parsed = JSON.parse(fs.readFileSync(markerFile(flowRoot), 'utf-8'));
    return Number(parsed.version) || 1;
  } catch (err) {
    // No marker: a pre-versioning root, which is exactly version 1.
    return 1;
  }
}

function stamp(flowRoot, version) {
  fs.mkdirSync(path.dirname(markerFile(flowRoot)), { recursive: true });
  atomicWrite(markerFile(flowRoot), `${JSON.stringify({ version }, null, 2)}\n`);
}

function status(flowRoot, { current = CURRENT, migrations = MIGRATIONS } = {}) {
  const version = readVersion(flowRoot);
  return {
    version,
    current,
    newer: version > current,
    pending: migrations.filter((m) => m.to > version && m.to <= current),
  };
}

// Preview then apply. Dry runs return the description and change nothing;
// real runs back the named files up, apply each step once, and stamp only
// after every step landed. Running again is a no-op by construction.
function migrate(flowRoot, { dryRun = false, current = CURRENT, migrations = MIGRATIONS } = {}) {
  const state = status(flowRoot, { current, migrations });
  if (state.newer) {
    return {
      ok: false,
      refused: true,
      reason: `This board folder is format ${state.version}; this build of flow only knows ${current}. Update flow instead of letting an old build rewrite newer files.`,
    };
  }
  const plan = state.pending.map((m) => ({
    to: m.to,
    title: m.title,
    changes: m.describe(flowRoot),
  }));
  if (dryRun || !state.pending.length) {
    return { ok: true, applied: [], plan, version: state.version };
  }
  for (const m of state.pending) {
    for (const file of m.describe(flowRoot).map((c) => c.file).filter(Boolean)) {
      if (fs.existsSync(file)) keepHistory(file);
    }
    m.apply(flowRoot);
    stamp(flowRoot, m.to);
  }
  return { ok: true, applied: plan.map((p) => p.to), plan, version: readVersion(flowRoot) };
}

module.exports = { CURRENT, readVersion, stamp, status, migrate, markerFile };
