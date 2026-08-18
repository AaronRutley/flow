// ── Child-process policy (0322) ──
// One place decides how flow launches programs. The rules:
//   - argument arrays, never interpolated shell strings; the single shell
//     invocation left in the app (the login-shell PATH probe) runs a fixed
//     string with no outside input
//   - executables resolve to absolute paths through the login shell's PATH,
//     because a GUI-launched app's own PATH misses Homebrew and ~/.local
//   - a working directory, when a caller supplies allowed roots, must pass
//     the 0315 path guard before anything runs
//   - every launch is recorded (what, with which args, where) so process
//     provenance exists for the observability work (0333, 0360)
const fs = require('fs');
const path = require('path');
const { execSync, execFileSync } = require('child_process');
const pathGuard = require('./path-guard');
const { FLOW_ROOT } = require('./flow-root');

let cachedPath = null;
const whichCache = new Map();

// The one fixed shell string in the app: ask the user's login shell for the
// PATH it would give a terminal. No outside input reaches it.
function loginPath() {
  if (cachedPath) return cachedPath;
  const shell = process.env.SHELL || '/bin/zsh';
  cachedPath = process.env.PATH || '';
  try {
    cachedPath = execSync(`${shell} -l -c 'echo $PATH'`, { encoding: 'utf-8' }).trim();
  } catch (err) {
    // Keep the process PATH.
  }
  return cachedPath;
}

// Absolute path for a command name, or null. The name travels as a positional
// parameter — `command -v -- "$1"` — so no name can rewrite the shell line.
function which(name) {
  const key = String(name || '');
  if (!key) return null;
  if (key.includes('/')) return fs.existsSync(key) ? path.resolve(key) : null;
  if (whichCache.has(key)) return whichCache.get(key);
  let found = null;
  try {
    const out = execFileSync('/bin/sh', ['-c', 'command -v -- "$1"', 'which', key], {
      encoding: 'utf-8',
      env: { ...process.env, PATH: loginPath() },
    }).trim();
    found = out.startsWith('/') ? out : null;
  } catch (err) {
    found = null;
  }
  // Cache hits only: a miss should be retried after the user installs the
  // CLI without forcing a restart.
  if (found) whichCache.set(key, found);
  return found;
}

// Provenance: one JSON line per launch under the flow root's logs folder.
// Local file, never uploaded; args are capped so a long prompt cannot bloat
// the log (and the redactor of 0323 fronts any export).
function record(bin, args, cwd) {
  try {
    const dir = path.join(FLOW_ROOT, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const entry = {
      t: new Date().toISOString(),
      bin,
      args: (args || []).slice(0, 8).map((a) => String(a).slice(0, 200)),
      cwd: cwd || null,
    };
    fs.appendFileSync(path.join(dir, 'proc.log'), `${JSON.stringify(entry)}\n`);
  } catch (err) {
    // Provenance must never be the thing that breaks a launch.
  }
}

// Synchronous launch with the policy applied. opts.cwdRoots, when given,
// fences opts.cwd with the path guard before anything runs.
function run(bin, args = [], opts = {}) {
  const { cwdRoots, ...rest } = opts;
  if (rest.cwd && cwdRoots && !pathGuard.inRoots(rest.cwd, cwdRoots)) {
    throw new Error('cwd-outside-root');
  }
  record(bin, args, rest.cwd);
  return execFileSync(bin, args, { encoding: 'utf-8', ...rest });
}

// A TCP port that may reach a command line: an integer in range or nothing.
function assertPort(port) {
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('invalid-port');
  return n;
}

// A process id that may reach kill: digits or nothing.
function assertPid(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n < 1) throw new Error('invalid-pid');
  return n;
}

module.exports = { loginPath, which, run, record, assertPort, assertPid };
