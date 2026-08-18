// ── Watcher coalescing (0329) ──
// A burst of filesystem events becomes one refresh: changes collect for a
// short quiet window (an agent saving five cards, an editor writing through
// a temp file), then flush as a single batch keyed by path — the last event
// per path wins. Editor droppings that survive the watcher's dotfile ignore
// (backup~ files, emacs #locks#) never enter the batch at all.
const NOISE = /(~|\.swp|\.swx|\.tmp)$|^#.*#$/;

function createCoalescer(emit, { quietMs = 150, timers } = {}) {
  const set = (timers && timers.set) || setTimeout;
  const clear = (timers && timers.clear) || clearTimeout;
  let pending = new Map();
  let timer = null;

  function flush() {
    timer = null;
    if (!pending.size) return;
    const batch = [...pending].map(([path, event]) => ({ event, path }));
    pending = new Map();
    emit({ changes: batch });
  }

  function add(event, filePath) {
    const base = String(filePath || '').split('/').pop();
    if (NOISE.test(base)) return;
    pending.set(filePath, event);
    if (timer) clear(timer);
    timer = set(flush, quietMs);
  }

  return { add, flush };
}

module.exports = { createCoalescer };
