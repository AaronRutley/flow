// ── Process lifecycle registry (0333) ──
// Every session and server flow launches gets a durable record: what ran,
// for which project and card, which pid (verified by start time, so pid
// reuse cannot misname a stranger), and how it ended. Restart and cleanup
// reconcile against this instead of guessing from terminal tails.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const proc = require('./proc');
const { atomicWrite } = require('./atomic-write');
const { FLOW_ROOT } = require('./flow-root');

const FILE = path.join(FLOW_ROOT, 'logs', 'process-registry.json');
const KEEP = 200; // finished records retained, newest last

function read() {
  try {
    const rows = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
    return Array.isArray(rows) ? rows : [];
  } catch (err) {
    return [];
  }
}

function write(rows) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    atomicWrite(FILE, JSON.stringify(rows.slice(-KEEP), null, 2));
  } catch (err) {
    // The registry is memory, not a gate: failing to write must not stop a
    // launch or a cleanup.
  }
}

// The pid's kernel start time, the disambiguator against pid reuse.
function startTimeOf(pid) {
  try {
    return proc
      .run('ps', ['-p', String(proc.assertPid(pid)), '-o', 'lstart='], {
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      .trim();
  } catch (err) {
    return '';
  }
}

function commandHash(command) {
  return crypto.createHash('sha256').update(String(command || '')).digest('hex').slice(0, 12);
}

// Records a launch. `id` is the session id (unique per running thing).
function record({ id, kind, pid, command, project, card, tmuxName }) {
  const rows = read().filter((row) => row.id !== id || row.exit);
  rows.push({
    id,
    kind: kind || 'session',
    pid: Number(pid) || null,
    pidStart: pid ? startTimeOf(pid) : '',
    commandHash: commandHash(command),
    command: String(command || '').slice(0, 120),
    project: project || '',
    card: card || '',
    tmuxName: tmuxName || '',
    startedAt: new Date().toISOString(),
    exit: null,
  });
  write(rows);
}

// Marks how a process ended; the reason cards can later show.
function markExit(id, { code = null, signal = null, reason = '' } = {}) {
  const rows = read();
  const row = [...rows].reverse().find((r) => r.id === id && !r.exit);
  if (!row) return;
  row.exit = {
    code,
    signal,
    reason: reason || (signal ? `signal ${signal}` : `exit code ${code}`),
    at: new Date().toISOString(),
  };
  write(rows);
}

// Is this record's pid still the same process it named at launch?
function stillOurs(row) {
  if (!row.pid) return false;
  const now = startTimeOf(row.pid);
  return Boolean(now) && now === row.pidStart;
}

// Startup reconciliation: records with no exit whose pid is gone (or reused
// by a stranger) get closed as orphaned — the app was not there to see them
// die. Returns what was closed, for a log line.
function sweep() {
  const rows = read();
  const orphaned = [];
  for (const row of rows) {
    if (row.exit) continue;
    if (stillOurs(row)) continue;
    row.exit = { code: null, signal: null, reason: 'orphaned (app was not running)', at: new Date().toISOString() };
    orphaned.push(row.id);
  }
  if (orphaned.length) write(rows);
  return orphaned;
}

// The most recent exit for a card's server or session, for "why stopped".
function lastExit(idPrefix) {
  const rows = read().filter((r) => r.id.startsWith(idPrefix) && r.exit);
  return rows.length ? rows[rows.length - 1] : null;
}

module.exports = { record, markExit, sweep, lastExit, stillOurs, startTimeOf, read, FILE };
