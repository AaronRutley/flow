const fs = require('fs');
const pty = require('node-pty');
const { execFileSync } = require('child_process');
const proc = require('./proc');

// One PTY per session id. Sessions outlive renderer reloads; tmux makes them
// outlive the app itself.
const sessions = new Map();

// The scrollback tail is byte-bounded (0334): 2MB per session, however the
// output arrives. Chunk counting let one chatty build hold arbitrary memory
// — 400 chunks of anything is not a budget. Trimming drops whole chunks
// from the head and plants one honest marker so a reader knows the top is
// gone. xterm in the renderer keeps its own display scrollback; this buffer
// only serves background sessions (a server with no tab) explaining
// themselves after the fact.
const BUFFER_BUDGET_BYTES = 2 * 1024 * 1024;
const TRUNCATION_MARKER = '\n[flow: earlier output trimmed]\n';

function pushBounded(entry, data) {
  entry.buffer.push(data);
  entry.bufferBytes += Buffer.byteLength(data);
  // A single chunk bigger than the whole budget keeps only its tail.
  while (entry.bufferBytes > BUFFER_BUDGET_BYTES && entry.buffer.length > 1) {
    entry.bufferBytes -= Buffer.byteLength(entry.buffer.shift());
    entry.trimmed = true;
  }
  if (entry.bufferBytes > BUFFER_BUDGET_BYTES && entry.buffer.length === 1) {
    const only = entry.buffer[0];
    entry.buffer[0] = only.slice(-BUFFER_BUDGET_BYTES);
    entry.bufferBytes = Buffer.byteLength(entry.buffer[0]);
    entry.trimmed = true;
  }
}

let cachedTmux = null;
let send = () => {};

// PATH and command resolution live in the process policy (0322); these
// names stay because half the app asks sessions for them.
function loginPath() {
  return proc.loginPath();
}

// The absolute path to tmux, or null. It must be absolute: posix_spawnp
// resolves a bare command name against the *parent* process's PATH, not the
// environment handed to the child, and a GUI-launched Electron app has a
// minimal PATH with no /opt/homebrew in it. Passing "tmux" fails there with
// "posix_spawnp failed" even though the login shell can see it perfectly well.
function tmuxPath() {
  if (cachedTmux !== null) return cachedTmux;
  cachedTmux = proc.which('tmux');
  return cachedTmux;
}

function hasTmux() {
  return Boolean(tmuxPath());
}

// Same absolute-path rule as tmuxPath, for `claude` / `gh` / `codex`. A
// Finder-launched app will not find a Homebrew or ~/.local bin by name.
function which(name) {
  return proc.which(name);
}

function setSender(fn) {
  send = fn;
}

function baseEnv(extra = {}) {
  const env = {
    ...process.env,
    PATH: loginPath(),
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    ...extra,
  };
  // Cursor (and any other Electron host) sets this on the process. A child
  // `claude` — or a nested Electron binary — then starts as Node instead of
  // as itself, and headless Shape/Draft look hung.
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

// Same absolute-path requirement as tmux: a bare shell name would be resolved
// against the parent's PATH.
function shellPath() {
  const shell = process.env.SHELL;
  return shell && shell.startsWith('/') ? shell : '/bin/zsh';
}

function tmuxSessionExists(name) {
  const tmux = tmuxPath();
  if (!tmux) return false;
  try {
    proc.run(tmux, ['has-session', '-t', name], { env: baseEnv(), stdio: 'ignore' });
    return true;
  } catch (err) {
    return false;
  }
}

// Ends a tmux session outright, so the next start() counts as fresh and seeds
// its command again. Detaching is right for a Claude session you mean to come
// back to; a dev server you have asked to restart is not that.
// The pids running inside a tmux session's panes (0332): the proof that a
// port holder is flow's own server rather than a stranger.
// Whether a session's pane sits at a bare shell prompt (0453): tmux names
// the pane's foreground command, and a shell means nothing is running in
// it. Unknowable — no tmux, no session, tmux errors — reads as busy, so a
// caller never fires a prompt into a pane it cannot vouch for.
function paneIdle(id) {
  const tmux = tmuxPath();
  if (!tmux) return { idle: false };
  const entry = sessions.get(id);
  const name = entry && entry.tmuxName ? entry.tmuxName : `flow-${id}`;
  try {
    const out = proc.run(tmux, ['display-message', '-p', '-t', name, '#{pane_current_command}'], {
      env: baseEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const command = String(out).trim().replace(/^-/, '');
    return { idle: ['zsh', 'bash', 'sh', 'fish', 'dash', 'tcsh'].includes(command) };
  } catch (err) {
    return { idle: false };
  }
}

function panePids(name) {
  const tmux = tmuxPath();
  if (!tmux || !name) return [];
  try {
    const out = proc.run(tmux, ['list-panes', '-s', '-t', name, '-F', '#{pane_pid}'], {
      env: baseEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split('\n').map((line) => Number(line.trim())).filter(Boolean);
  } catch (err) {
    return [];
  }
}

function killTmuxSession(name) {
  const tmux = tmuxPath();
  if (!tmux) return;
  try {
    proc.run(tmux, ['kill-session', '-t', name], { env: baseEnv(), stdio: 'ignore' });
  } catch (err) {
    // No such session — which is the state we wanted anyway.
  }
}

/**
 * Starts (or reattaches) a session.
 *
 * @param {string} id           session key, usually `${projectName}-${cardId}`
 * @param {string} cwd          working directory — must exist, or posix_spawnp fails
 * @param {string} [command]    command to run on first attach, e.g. a claude invocation
 * @param {object} [env]        extra environment, e.g. { PORT: '4103' }
 * @param {string} [tmuxName]   tmux session name; defaults to `flow-${id}`
 */
function start(id, cwd, { command, prefill = false, env = {}, tmuxName } = {}) {
  const existing = sessions.get(id);
  if (existing) return { id, reattached: true };

  if (!cwd || !fs.existsSync(cwd)) {
    throw new Error(`Working directory does not exist: ${cwd}`);
  }

  const options = {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd,
    env: baseEnv(env),
  };

  let proc;
  let fresh = true;
  const tmux = tmuxPath();

  if (tmux) {
    const name = tmuxName || `flow-${id}`;
    fresh = !tmuxSessionExists(name);
    // Per-session variables travel as `-e` arguments: env handed to the pty
    // only reaches the tmux *client*, and whether the session's shell sees it
    // depends on which client happened to spawn the server. `-e` sets it on
    // the session itself, deterministically. Only a fresh session takes them;
    // a reattach keeps the world it already has.
    const envArgs = fresh
      ? Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`])
      : [];
    // `set-option status off` drops tmux's green status bar: inside a pane that
    // is the whole window, it is one wasted row telling you what the app's own
    // tab already says. `;` has to arrive as its own argument, not inside one.
    // `-D` kicks any other attached client: two clients of different widths
    // make tmux fill the wider one's spare columns with dot rows (the
    // "underscore things"), so the pane that attaches last owns the session.
    // `mouse on` (0437): tmux lives on the alternate screen, where xterm has
    // no scrollback of its own and turns the wheel into arrow keys — which
    // at a shell prompt walk command history instead of scrolling. With the
    // mouse on, the wheel reaches tmux and scrolls its real history via
    // copy-mode, the way iTerm behaves. Runs on every attach (`-A` falls
    // through to the set-options), so existing sessions pick it up too.
    proc = pty.spawn(
      tmux,
      ['new-session', '-A', '-D', ...envArgs, '-s', name,
       ';', 'set-option', '-t', name, 'status', 'off',
       ';', 'set-option', '-t', name, 'mouse', 'on'],
      options
    );
  } else {
    proc = pty.spawn(shellPath(), ['-l'], options);
  }

  const buffer = [];
  // The tmux name is kept so stop() can address the server directly instead of
  // typing a command into the pane.
  const entry = {
    proc,
    cwd,
    buffer,
    bufferBytes: 0,
    trimmed: false,
    tmuxName: tmux ? tmuxName || `flow-${id}` : '',
  };

  // Every handler checks that this entry is still the registered one. Restarting
  // reuses the id, so a shell that is on its way out would otherwise delete its
  // own replacement from the map and report the *new* session as exited.
  const current = () => sessions.get(id) === entry;

  proc.onData((data) => {
    // Keep a tail of output so a background session (a dev server with no tab)
    // can still show why it failed.
    pushBounded(entry, data);
    if (current()) send(id, 'data', data);
  });
  proc.onExit(({ exitCode, signal } = {}) => {
    if (!current()) return;
    sessions.delete(id);
    try {
      require('./proc-registry').markExit(id, { code: exitCode, signal });
    } catch (err) {
      // Never let bookkeeping mask the exit event.
    }
    send(id, 'exit');
  });

  sessions.set(id, entry);
  require('./events').logEvent('session-start', { session: id, cwd, fresh });

  // The lifecycle registry (0333): who this is, verified by pid start time.
  // The pane pid is the actual shell; the pty pid is only the tmux client.
  try {
    const registry = require('./proc-registry');
    const shellPid = tmux ? (panePids(entry.tmuxName)[0] || proc.pid) : proc.pid;
    registry.record({
      id,
      kind: id.endsWith('-server') ? 'server' : 'session',
      pid: shellPid,
      command: command || '',
      tmuxName: entry.tmuxName,
    });
  } catch (err) {
    // Registry is memory, never a gate.
  }

  // Opt-in transcripts (0334): with `"transcripts": true` in settings.json,
  // tmux streams the pane's full output to a per-session file under the
  // flow root's logs — complete history on disk, while the in-memory tail
  // above stays byte-bounded. Exit-time exports of these files go through
  // the 0323 redactor; the raw file stays local and intact.
  if (tmux && fresh) {
    try {
      const config = require('./config');
      if (config.read().transcripts) {
        const { FLOW_ROOT } = require('./flow-root');
        const dir = require('path').join(FLOW_ROOT, 'logs', 'transcripts');
        fs.mkdirSync(dir, { recursive: true });
        const file = require('path').join(dir, `${entry.tmuxName || id}-${Date.now()}.log`);
        require('./proc').run(tmux, ['pipe-pane', '-t', entry.tmuxName, '-o', `cat >> '${file}'`], {
          env: baseEnv(),
          stdio: 'ignore',
        });
      }
    } catch (err) {
      // A transcript is a nicety; the session must start regardless.
    }
  }

  // Only seed a command into a session that did not already exist, so
  // reattaching after a restart does not re-run it. A prefilled command is
  // typed without the trailing newline — it waits in the input line for the
  // user to read, edit, and run.
  if (fresh && command) {
    setTimeout(() => {
      if (current()) proc.write(prefill ? command : `${command}\n`);
    }, 500);
  }

  // Reattached panes can carry typed-but-unsent text from an earlier life —
  // the old stop() literally typed `tmux detach` at whatever was focused, and
  // those strays are still sitting in long-lived sessions' input lines. Ctrl-U
  // clears the input line in both a shell and Claude Code without running
  // anything, so a reattach always starts from a clean line.
  if (!fresh && tmux) {
    setTimeout(() => {
      if (current()) proc.write('\x15');
    }, 600);
  }

  return { id, reattached: !fresh };
}

function write(id, data) {
  const session = sessions.get(id);
  if (session) session.proc.write(data);
}

function resize(id, cols, rows) {
  const session = sessions.get(id);
  if (!session) return;
  try {
    session.proc.resize(cols, rows);
  } catch (err) {
    // Terminal went away mid-resize.
  }
}

function has(id) {
  return sessions.has(id);
}

// The tail of a session's output, with terminal escape sequences stripped so it
// reads as plain text in a panel rather than a terminal.
function log(id, lines = 40) {
  const session = sessions.get(id);
  if (!session) return '';

  const text = (session.trimmed ? TRUNCATION_MARKER : '') + session.buffer
    .join('')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?>]*[A-Za-z]/g, '')
    // Charset selection and keypad mode: short sequences a shell emits on every
    // prompt, and the reason a stripped log still looked like line noise.
    .replace(/\x1b[()][A-Za-z0-9]/g, '')
    .replace(/\x1b[=>]/g, '')
    .replace(/\r/g, '');

  return text.split('\n').filter((line) => line.trim()).slice(-lines).join('\n');
}

function list() {
  return [...sessions.keys()];
}

// Every flow tmux session the server knows about, whether or not a renderer is
// attached to it — the shells that outlive reloads and project switches. Names
// follow `flow-<id>`, so the prefix is the filter. `attached` is whether a
// client is currently on it; `created` is epoch seconds.
function listTmux() {
  const tmux = tmuxPath();
  if (!tmux) return [];
  let out;
  try {
    // A pipe separator, not a tab: tmux rewrites a tab in piped -F output to an
    // underscore, which would swallow the field boundaries. A `flow-` session
    // name never contains a pipe.
    out = execFileSync(
      tmux,
      ['list-sessions', '-F', '#{session_name}|#{session_created}|#{session_attached}'],
      { env: baseEnv(), encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
  } catch (err) {
    // No server running means no sessions.
    return [];
  }
  const rows = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [name, created, attached] = line.split('|');
    if (!name || !name.startsWith('flow-')) continue;
    rows.push({
      name,
      created: Number(created) || 0,
      attached: attached === '1',
    });
  }
  return rows;
}

// Ends a tmux session by name — the same kill the pane's close button does,
// reachable for a session with no pane open.
function killByName(name) {
  if (!name || !name.startsWith('flow-')) return false;
  const tmux = tmuxPath();
  if (!tmux) return false;
  try {
    proc.run(tmux, ['kill-session', '-t', name], { env: baseEnv(), stdio: 'ignore' });
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Detaches from tmux so the shell survives, or ends the session outright.
 *
 * Both are done by talking to the tmux server, never by typing into the pane.
 * Writing `tmux detach\n` at the shell used to leave that text sitting in the
 * pane's input line, so the next time you opened the tab there it was, typed
 * and waiting — and if the pane was busy it would have run later, at random.
 */
function stop(id, { killTmux = false, immediate = false } = {}) {
  const session = sessions.get(id);
  if (!session) return;
  require('./events').logEvent('session-stop', { session: id, killTmux });

  // Drop it from the map now, not when the kill lands. Callers that stop and
  // immediately restart — the dev server button does exactly that — would
  // otherwise find the dying session still registered, take the reattach path,
  // and end up with nothing running once the pending kill fired.
  sessions.delete(id);

  const tmux = tmuxPath();
  const name = session.tmuxName;

  if (tmux && name) {
    try {
      proc.run(tmux, killTmux ? ['kill-session', '-t', name] : ['detach-client', '-s', name], {
        env: baseEnv(),
        stdio: 'ignore',
      });
    } catch (err) {
      // No such session, or the client already went away.
    }
  }

  // The deferred kill lets tmux detach cleanly mid-session. On shutdown the
  // deferral is the bug (0214): a pty callback landing after the JS
  // environment starts tearing down aborts the whole process from inside
  // node-pty's NAPI layer, so quit paths kill synchronously instead.
  const finish = () => {
    try {
      session.proc.kill();
    } catch (err) {
      // Already gone.
    }
  };
  if (immediate) finish();
  else setTimeout(finish, 200);
}

function stopAll(options) {
  for (const id of [...sessions.keys()]) stop(id, options);
}

module.exports = {
  paneIdle,
  panePids,
  pushBounded,
  setSender,
  start,
  write,
  resize,
  stop,
  stopAll,
  has,
  list,
  listTmux,
  killByName,
  log,
  loginPath,
  baseEnv,
  which,
  tmuxPath,
  hasTmux,
  tmuxSessionExists,
  killTmuxSession,
};
