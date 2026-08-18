const board = require('./board');
const proc = require('./proc');

// All lsof/kill traffic goes through the process policy (0322): argument
// arrays with the port and pids validated as integers first, so nothing a
// card or config says can reach a command line as text.
function inUse(port) {
  try {
    const out = proc.run('lsof', [`-ti:${proc.assertPort(port)}`], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return Boolean(out.trim());
  } catch (err) {
    // lsof exits non-zero when nothing holds the port.
    return false;
  }
}

// Lowest port from the project's base that no card has claimed and nothing is
// listening on. Checking both matters: a card can hold a port while its server
// is stopped, and something outside flow can hold one no card knows about.
function allocate(project, { exclude = [] } = {}) {
  const base = Number(project.portBase) || 4100;
  const claimed = new Set(
    board
      .listCards(project.boardRoot)
      .map((card) => Number(card.port))
      .filter(Boolean)
  );
  for (const port of exclude) claimed.add(Number(port));

  for (let port = base; port < base + 100; port += 1) {
    if (claimed.has(port)) continue;
    if (inUse(port)) continue;
    return port;
  }
  return null;
}

function holders(port) {
  try {
    const out = proc.run('lsof', [`-ti:${proc.assertPort(port)}`], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim().split('\n').filter(Boolean).map((pid) => String(proc.assertPid(pid)));
  } catch (err) {
    return [];
  }
}

// Who a pid actually is, for saying so instead of shooting blind (0332).
function identify(pids) {
  if (!pids.length) return [];
  try {
    const out = proc.run('ps', ['-o', 'pid=,command=', '-p', pids.join(',')], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const m = line.trim().match(/^(\d+)\s+(.*)$/);
        return m ? { pid: m[1], command: m[2].slice(0, 120) } : null;
      })
      .filter(Boolean);
  } catch (err) {
    return pids.map((pid) => ({ pid, command: 'unknown' }));
  }
}

// The full descendant closure of a set of pids, from one ps snapshot: a
// server's children (watchers, workers) count as flow's own.
function descendants(rootPids) {
  const roots = new Set(rootPids.map(Number).filter(Boolean));
  if (!roots.size) return roots;
  let table = [];
  try {
    table = proc
      .run('ps', ['-axo', 'pid=,ppid='], { stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n')
      .map((line) => line.trim().split(/\s+/).map(Number))
      .filter((row) => row.length === 2);
  } catch (err) {
    return roots;
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const [pid, ppid] of table) {
      if (roots.has(ppid) && !roots.has(pid)) {
        roots.add(pid);
        grew = true;
      }
    }
  }
  return roots;
}

/**
 * Frees a port before starting a server on it, the way umami-wizzard's
 * start.sh does: ask politely first, escalate only if ignored. A straight
 * kill -9 can leave a half-written .next behind.
 *
 * Ownership first (0332): with ownerPids given, only holders inside that
 * process family are killed; anything else is named and left standing, and
 * the caller decides what to tell the human. Without ownerPids (a caller
 * that predates the record) the old free-everything behaviour remains.
 *
 * @returns {{freed: boolean, killed: string[], strangers: {pid: string, command: string}[]}}
 */
function free(port, { ownerPids = null } = {}) {
  let pids = holders(port);
  if (!pids.length) return { freed: true, killed: [], strangers: [] };

  let strangers = [];
  if (ownerPids !== null) {
    const family = descendants(ownerPids);
    strangers = identify(pids.filter((pid) => !family.has(Number(pid))));
    pids = pids.filter((pid) => family.has(Number(pid)));
    if (!pids.length) return { freed: false, killed: [], strangers };
  }

  const killed = [...pids];
  try {
    proc.run('/bin/kill', pids, { stdio: 'ignore' });
  } catch (err) {
    // Some already gone.
  }
  proc.run('/bin/sleep', ['2'], { stdio: 'ignore' });

  pids = holders(port);
  if (pids.length) {
    try {
      proc.run('/bin/kill', ['-9', ...pids], { stdio: 'ignore' });
    } catch (err) {
      // Same.
    }
    proc.run('/bin/sleep', ['1'], { stdio: 'ignore' });
  }

  return { freed: holders(port).length === 0, killed, strangers };
}

module.exports = { allocate, inUse, free, holders };
