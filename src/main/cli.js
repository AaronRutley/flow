const { spawn, execFile } = require('child_process');
const { redact } = require('./redact');
const fs = require('fs');
const sessions = require('./sessions');

// Headless Claude/Codex runs look like in-app magic. They are not: they
// spawn a CLI already on this Mac. First-time users stare at "Shaping" and
// wonder which account to connect. This module is the shared contract for
// those processes — find the binary, close stdin, speak a failure in English.

/**
 * A first-time-user sentence for a CLI failure. Raw stderr ("no stdin data
 * received in 3s") is true and useless; the person in front of the board
 * needs to know whether to install something, log in, or just try again.
 */
function explainError(detail, bin = 'claude') {
  const raw = String(detail || '');
  // Recent claude prints this to stderr even when stdin is /dev/null, then
  // fails for a real reason (usually login). The warning must not be the
  // message the human sees.
  const stripped = raw.replace(/Warning: no stdin data received[\s\S]*?(?:\n|$)/gi, '').trim();
  const text = stripped || raw.trim();
  const lower = text.toLowerCase();

  if (!text || /enoent|not found|command not found/.test(lower)) {
    return (
      `The ${bin} CLI is not on your PATH. Install it, run \`${bin}\` once ` +
      `to log in, then try again. Flow does not connect to a desktop app.`
    );
  }
  if (/no stdin data received/.test(raw.toLowerCase()) && !stripped) {
    return (
      `The ${bin} CLI is not logged in. Folder access is not a login. Use Log in with claude, ` +
      `press Enter on \`claude auth login\`, finish the browser sign-in, then try Shape again.`
    );
  }
  if (
    /401|oauth|access token is invalid|authentication_error|not logged in|unauthorized|authentication required|please run \/login|not authenticated/.test(
      lower
    )
  ) {
    return (
      `The ${bin} CLI is not logged in. "Welcome back" is not a session. Use Log in with claude, ` +
      `press Enter on \`claude auth login\`, finish the browser sign-in, then try Shape again.`
    );
  }
  if (/timed out|etimedout|sigkill/.test(lower)) {
    return `The ${bin} CLI did not finish in time. A healthy shape is a few seconds. Use Log in with claude in Flow, press Enter, then try again.`;
  }

  // Whatever stderr said, no secret in it may reach a toast (0323).
  const compact = redact(text.replace(/\s+/g, ' '));
  return compact.length > 180 ? `${compact.slice(0, 180)}…` : compact;
}

function resolve(name) {
  const bin = sessions.which(name);
  if (!bin) return { ok: false, error: explainError(`spawn ${name} ENOENT`, name) };
  return { ok: true, bin };
}

function execOptions(extra = {}) {
  const { env, ...rest } = extra;
  return {
    encoding: 'utf-8',
    // An open stdin pipe makes recent `claude` wait three seconds, warn, and
    // often exit non-zero — which is exactly "Shaping" with nothing happening.
    stdio: ['ignore', 'pipe', 'pipe'],
    ...rest,
    env: env || sessions.baseEnv(),
  };
}

function spawnOptions(extra = {}) {
  const { env, encoding: _encoding, ...rest } = extra;
  return {
    stdio: ['ignore', 'pipe', 'pipe'],
    ...rest,
    env: env || sessions.baseEnv(),
  };
}

function attachDevNullStdin(options) {
  // Node's 'ignore' is not always what claude's stdin-wait looks for.
  // Opening /dev/null is the redirect the CLI's own warning asks for.
  let fd = 'ignore';
  try {
    fd = fs.openSync('/dev/null', 'r');
  } catch (err) {
    fd = 'ignore';
  }
  const stdio = Array.isArray(options.stdio) ? [...options.stdio] : ['ignore', 'pipe', 'pipe'];
  stdio[0] = fd;
  return { options: { ...options, stdio }, fd };
}

function closeFd(fd) {
  if (typeof fd !== 'number') return;
  try {
    fs.closeSync(fd);
  } catch (err) {
    // Already closed.
  }
}

function runFile(bin, args, extra, callback) {
  const { options, fd } = attachDevNullStdin(execOptions(extra));
  return execFile(bin, args, options, (err, stdout, stderr) => {
    closeFd(fd);
    callback(err, stdout, stderr);
  });
}

function runSpawn(bin, args, extra = {}) {
  const { options, fd } = attachDevNullStdin(spawnOptions(extra));
  const child = spawn(bin, args, options);
  const done = () => closeFd(fd);
  child.on('close', done);
  child.on('error', done);
  return child;
}

function tool(name, bin, { optional = false } = {}) {
  if (bin) return { name, ok: true, optional, path: bin };
  return {
    name,
    ok: false,
    optional,
    path: null,
    hint: optional
      ? `Optional. Install ${name} if you want this.`
      : `Not on PATH. Install ${name}, then restart Flow.`,
  };
}

/**
 * What a first launch can actually see: the CLIs Shape / Draft / Review /
 * sessions depend on, resolved through the login PATH, not Electron's.
 */
function diagnose() {
  return {
    claude: tool('claude', sessions.which('claude')),
    tmux: tool('tmux', sessions.tmuxPath()),
    gh: tool('gh', sessions.which('gh'), { optional: true }),
    codex: tool('codex', sessions.which('codex'), { optional: true }),
    // The environment rows (0358): the machine-side facts that break Flow
    // in ways a missing CLI does not — each with a copyable remedy.
    ...environmentChecks(),
  };
}

function environmentChecks() {
  const fs = require('fs');
  const path = require('path');
  const { FLOW_ROOT } = require('./flow-root');
  const checks = {};

  checks.git = tool('git', sessions.which('git'));
  checks.git.hint = checks.git.ok ? '' : 'Install the Xcode command line tools: xcode-select --install';

  // The Flow root has to be writable or nothing else matters.
  let writable = false;
  try {
    fs.accessSync(FLOW_ROOT, fs.constants.W_OK);
    writable = true;
  } catch (err) {
    writable = false;
  }
  checks.boardRoot = {
    ok: writable,
    optional: false,
    path: FLOW_ROOT,
    hint: writable ? '' : `flow cannot write its board folder — check permissions on ${FLOW_ROOT}`,
  };

  // Disk space where the boards live: below 1GB things start failing oddly.
  try {
    const stat = fs.statfsSync(FLOW_ROOT);
    const freeBytes = stat.bavail * stat.bsize;
    checks.disk = {
      ok: freeBytes > 1024 * 1024 * 1024,
      optional: false,
      path: `${Math.round(freeBytes / (1024 * 1024 * 1024))} GB free`,
      hint: freeBytes > 1024 * 1024 * 1024 ? '' : 'Under 1 GB free where boards live — saves and worktrees will start failing',
    };
  } catch (err) {
    checks.disk = { ok: true, optional: true, path: 'unreadable', hint: '' };
  }

  return checks;
}

module.exports = {
  explainError,
  resolve,
  execOptions,
  runFile,
  runSpawn,
  diagnose,
};
