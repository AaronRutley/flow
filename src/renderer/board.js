// ── Board ──
function withinLastWeek(dateString) {
  if (!dateString) return false;
  const then = new Date(dateString);
  if (Number.isNaN(then.getTime())) return false;
  return Date.now() - then.getTime() <= 7 * 24 * 60 * 60 * 1000;
}

// The live-port checks left with 0375: the board no longer polls dev
// servers; localhost returns later as a plugin.

async function loadBoard() {
  if (!activeProject) return;
  cards = await window.api.listCards(activeProject.name);
  projectBranch = window.api.currentBranch
    ? await window.api.currentBranch(activeProject.name).catch(() => '')
    : '';
  const tmuxRows = (await window.api.listTerminalSessions().catch(() => [])) || [];
  aliveTmux = new Set(tmuxRows.map((r) => r.name));
  trackAgentWorking();
  warnOnDuplicateIds();
  renderBoard();
  refreshEnvButton();
  refreshGitButton();
}

// Notices cards the board terminal's agent moved into Doing (0219). Runs on
// every board load, which the file watcher triggers for outside edits too, so
// the agent's moves land here without any channel of their own. Ids, not
// paths: moving between columns changes the path.
function trackAgentWorking() {
  const nowColumns = new Map(cards.filter((c) => c.id).map((c) => [c.id, c.column]));
  for (const [id, column] of nowColumns) {
    if (column !== 'doing') {
      agentWorking.delete(id);
      continue;
    }
    const before = prevColumns.get(id);
    const arrived = before && before !== 'doing';
    if (arrived && !dragMovedIds.has(id) && homeTerms.board) agentWorking.add(id);
  }
  // A card that vanished from the board (archived, deleted) stops working too.
  for (const id of agentWorking) {
    if (!nowColumns.has(id)) agentWorking.delete(id);
  }
  prevColumns = nowColumns;
  dragMovedIds.clear();
}

// Hand-written card files can reuse an id. Everything routes by path so
// nothing breaks, but say so once per board load rather than hiding it.
function dupIdsIn(list) {
  const seen = new Map();
  for (const card of list) {
    if (!card.id) continue;
    seen.set(card.id, (seen.get(card.id) || 0) + 1);
  }
  return [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id);
}

// The usual "duplicate" is no duplicate at all (0186): an agent moving a
// card between columns writes the destination file first and removes the
// original a beat later, and the watcher reloads the board inside that
// window. So a duplicate only earns its toast by surviving a re-read.
let lastDupWarning = '';
let dupRecheckTimer = null;
function warnOnDuplicateIds() {
  if (!dupIdsIn(cards).length) {
    lastDupWarning = '';
    return;
  }
  if (dupRecheckTimer) return;
  dupRecheckTimer = setTimeout(async () => {
    dupRecheckTimer = null;
    if (!activeProject) return;
    const fresh = await window.api.listCards(activeProject.name);
    const dups = dupIdsIn(fresh);
    const key = dups.join(',');
    if (dups.length && key !== lastDupWarning) {
      showToast(`Duplicate card id${dups.length > 1 ? 's' : ''}: ${dups.join(', ')}`);
      // The toast can only fit the ids; the paths that collide go to the
      // console so the offending files can be found without a manual grep.
      for (const id of dups) {
        const paths = fresh.filter((c) => c.id === id).map((c) => c.path);
        console.warn(`[board] duplicate card id ${id}:`, paths);
      }
    }
    lastDupWarning = key;
  }, 1500);
}

function visibleCards(column) {
  let list = cards.filter((c) => c.column === column);

  if (column === 'done' && !showAllDone) {
    list = list.filter((c) => withinLastWeek(c.completed));
  }
  if (searchTerm) {
    const needle = searchTerm.toLowerCase();
    list = list.filter(
      (c) =>
        c.title.toLowerCase().includes(needle) ||
        (c.body || '').toLowerCase().includes(needle)
    );
  }
  return list;
}

// The same four headings the main process checks for before an agent gets a
// card. Mirrored here so the board can tell a shaped card from a raw one.
function hasStructure(body) {
  return /##\s+(Plan|Build|QA|Done when)/i.test(body || '');
}

// ── Shaping ──
// A small model turns a dashed-off title into a proper card: tidied title,
// plan, checklists. Each run is its own process, so several go at once.
const shaping = new Set();
const shapeErrors = new Map();
const shapeStarted = new Map();
let shapeTick = null;

// The text each running shape has produced so far. A shaping card clicked
// open renders this live; the buffer goes when the shape lands or fails.
const shapeStreams = new Map();

window.api.onShapeStream(({ cardPath, text }) => {
  shapeStreams.set(cardPath, text);
  if (modalCard && modalCard.path === cardPath && shaping.has(cardPath)) {
    renderShapeStream(text);
  }
});

// The live view of a shape in progress: the streamed markdown so far, read
// only — the model owns the document until it finishes, so edits would only
// be overwritten by the next delta.
function shapeElapsed(cardPath) {
  const started = shapeStarted.get(cardPath);
  if (!started) return 0;
  return Math.max(0, Math.round((Date.now() - started) / 1000));
}

function ensureShapeTick() {
  if (shapeTick) return;
  shapeTick = setInterval(() => {
    if (!shaping.size) {
      clearInterval(shapeTick);
      shapeTick = null;
      return;
    }
    renderBoard();
    if (modalCard && shaping.has(modalCard.path) && !shapeStreams.get(modalCard.path)) {
      renderShapeStream('');
    }
  }, 1000);
}

function renderShapeStream(text) {
  const doc = (text || '').replace(/^TITLE:.*\n?/, '').trim();
  const seconds = modalCard ? shapeElapsed(modalCard.path) : 0;
  const { waiting, hint } = shapeWaitingCopy(seconds);
  $('card-modal-body').innerHTML = `<div class="markdown-body shape-streaming">${
    doc
      ? renderMarkdown(doc)
      : `<p class="shape-stream-waiting">${waiting}</p><p class="shape-stream-hint">${hint}</p>${
          seconds >= 8
            ? '<button type="button" class="text-button" id="shape-claude-login">Log in with claude</button>'
            : ''
        }`
  }</div>`;
  wireShapeLoginButton();
}

function shapeWaitingCopy(seconds) {
  if (seconds >= 15) {
    return {
      waiting: `Still no reply from the claude CLI · ${seconds}s`,
      hint: 'A healthy shape is a few seconds. This is stuck — log in with claude in Flow\'s terminal, then try Shape again. Flow gives up at 30s.',
    };
  }
  if (seconds >= 8) {
    return {
      waiting: `Still asking the claude CLI · ${seconds}s`,
      hint: 'Writing should have started by now. Log in with claude in Flow\'s terminal if you have not signed in recently.',
    };
  }
  return {
    waiting: `Asking the claude CLI to draft the plan${seconds ? ` · ${seconds}s` : ''}…`,
    hint: 'Same login as <code>claude</code> in a terminal. Nothing to connect.',
  };
}

function wireShapeLoginButton() {
  const button = $('shape-claude-login');
  if (!button) return;
  button.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openClaudeLogin();
  });
}

// Shape cannot log you in: that needs a real TTY and a browser. Flow already
// has both — a tmux shell, and claude opens the system browser. Prefill the
// command, never fire it, same as a card start.
async function openClaudeLogin() {
  if (!activeProject) return;
  if (modalCard) await closeCardModal();
  const result = await window.api
    .openShell(activeProject.name, 'claude-login', {
      command: 'claude auth login',
      prefill: true,
    })
    .catch((err) => ({ error: err.message }));
  if (!result || result.error) {
    showToast(result && result.error ? result.error : 'Could not open a terminal');
    return;
  }
  const list = readStandalones();
  if (!list.some((row) => row.id === result.sessionId)) {
    list.push({ id: result.sessionId, suffix: 'claude-login', title: 'Log in to Claude' });
    writeStandalones(list);
  }
  attachStandalone(result.sessionId, 'Log in to Claude');
  if (result.reattached) {
    // An existing Claude REPL is already at the prompt — "Welcome back" with
    // "Not logged in · Run /login" is this case. Type the slash command; do
    // not send it.
    window.api.sendTerminalInput(result.sessionId, '/login');
    showToast('Press Enter to run /login, then finish the browser sign-in.');
  } else {
    showToast('Press Enter to run claude auth login. Add --console if you use API billing. Folder access is not a login.');
  }
}

async function shapeCardAt(card) {
  if (shaping.has(card.path)) return;
  // Each shape is its own claude process; four at once is plenty for the
  // machine to stay usable.
  if (shaping.size >= 4) {
    showToast('Four shapes already running');
    return;
  }
  shaping.add(card.path);
  shapeStarted.set(card.path, Date.now());
  shapeErrors.delete(card.path);
  shapeStreams.delete(card.path);
  ensureShapeTick();
  renderBoard();
  if (modalCard && modalCard.path === card.path) openCardModal(card);

  const result = await window.api.shapeCard(activeProject.name, card.path);
  shaping.delete(card.path);
  shapeStarted.delete(card.path);
  shapeStreams.delete(card.path);
  if (!result.ok && !result.cancelled) {
    const reason = result.error || 'wrote no sections, try again';
    shapeErrors.set(card.path, reason);
    // The toast says why, not just that: a reason you have to hover for is a
    // reason most people never read. The card itself wears the failed flag,
    // so the toast can skip naming it.
    const short = reason.length > 90 ? `${reason.slice(0, 90)}…` : reason;
    showToast(`Shape failed: ${short}`);
  }
  await loadBoard();

  // If the card is open in the modal, show the newly shaped document.
  if (modalCard && modalCard.path === card.path) {
    const fresh = cards.find((c) => c.path === card.path);
    if (fresh) openCardModal(fresh);
  }
}

// A card titled `--- Later ---` is a divider, not work: it keeps its place in
// the column, splits the cards either side of it, and never counts as a task.
function dividerLabel(card) {
  const match = String(card.title || '').match(/^-{3,}\s*(.*?)\s*-{3,}$/);
  if (!match) return null;
  return match[1];
}

function renderDivider(card) {
  const label = dividerLabel(card);
  const el = document.createElement('div');
  el.className = 'card-divider';
  el.dataset.path = card.path;
  el.innerHTML = label ? `<span>${escapeHtml(label)}</span>` : '';
  return el;
}

function renderBoard() {
  // FLIP (0431): note where every card sits before the redraw, and each
  // column's scroll, so a status change reads as the one card gliding to
  // its new spot — not the whole board blinking and jumping to the top.
  // Keyed by id where there is one: a column move renames the file, and
  // the id is what survives the trip.
  const before = new Map();
  for (const el of document.querySelectorAll('.cards .card, .cards .card-divider')) {
    const key = el.dataset.id || el.dataset.path;
    if (key && !before.has(key)) before.set(key, el.getBoundingClientRect());
  }
  const scrolls = [...document.querySelectorAll('.column-body')].map((body) => [
    body,
    body.scrollTop,
  ]);

  for (const column of ['to-do', 'doing', 'done']) {
    const container = document.querySelector(`.cards[data-column="${column}"]`);
    container.innerHTML = '';

    const list = visibleCards(column);
    const tasks = list.filter((card) => dividerLabel(card) === null);

    // PR groups left for the plugin archive (0376, see local/plugins/):
    // every column reads flat.
    for (const card of list) {
      container.appendChild(
        dividerLabel(card) === null ? renderCard(card) : renderDivider(card)
      );
    }

    // An empty column stays clean whitespace (0478); only a search that
    // filtered everything out says so, or the blank reads as a lost result.
    if (!tasks.length && searchTerm) {
      const empty = document.createElement('div');
      empty.className = 'column-empty';
      empty.textContent = 'Nothing matches.';
      container.appendChild(empty);
    }

    document.querySelector(`.column[data-column="${column}"] .count-chip`).textContent =
      tasks.length;
  }

  // The sweep-to-archive button earns its place only when Done holds cards.
  const sweep = $('archive-done-button');
  if (sweep) {
    const doneCount = cards.filter(
      (c) => c.column === 'done' && dividerLabel(c) === null
    ).length;
    sweep.classList.toggle('hidden', !doneCount);
  }

  // A shelf in front stays in step with the same card list. The doors are
  // header icons now (0383), so the count lives in each door's tooltip.
  for (const shelf of ['backlog', 'archive']) {
    if (isShelfVisible(shelf)) renderShelf(shelf);
    const door = document.querySelector(`[data-foot-count="${shelf}"]`);
    if (door) {
      const count = cards.filter((c) => c.column === shelf && dividerLabel(c) === null).length;
      door.dataset.tip =
        shelf === 'backlog'
          ? `View backlog — ${count} queued for later`
          : `View archive — ${count} finished and retired`;
    }
  }

  // Re-renders replace every card element, so the keyboard highlight has to be
  // painted back on. A card that left the board simply loses it.
  paintSelection();

  // Scroll back first, then measure: the glide needs the settled geometry.
  for (const [body, top] of scrolls) body.scrollTop = top;
  animateBoardChanges(before);
}

// The second half of the FLIP (0431): every card that survived the redraw
// starts at its old spot and glides to the new one. Fresh cards just appear;
// reduced motion means no travel at all.
function animateBoardChanges(before) {
  if (!before.size) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  for (const el of document.querySelectorAll('.cards .card, .cards .card-divider')) {
    const key = el.dataset.id || el.dataset.path;
    const prev = key && before.get(key);
    if (!prev) continue;
    const now = el.getBoundingClientRect();
    const dx = prev.left - now.left;
    const dy = prev.top - now.top;
    if (!dx && !dy) continue;
    el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], {
      duration: 220,
      easing: 'cubic-bezier(0.3, 0.9, 0.35, 1)',
    });
  }
}

// ── The shelves ──
// Backlog and archive render as one flat list each: the same card look as the
// board, plus the moves that take a card off the shelf again.
function renderShelf(column) {
  const container = document.querySelector(`.shelf-cards[data-column="${column}"]`);
  if (!container) return;
  container.innerHTML = '';

  const list = cards.filter((c) => c.column === column && dividerLabel(c) === null);
  for (const card of list) container.appendChild(renderShelfCard(card, column));

  // A shelf is opened on purpose, so a bare blank would read as broken;
  // each says what would live here, in its own door's words (0478).
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'column-empty';
    empty.textContent =
      column === 'backlog' ? 'Nothing queued for later.' : 'Nothing retired yet.';
    container.appendChild(empty);
  }

  const chip = document.querySelector(`[data-shelf-count="${column}"]`);
  if (chip) chip.textContent = list.length;
}

function renderShelfCard(card, column) {
  const el = document.createElement('article');
  el.className = 'card shelf-card';
  el.dataset.path = card.path;

  const meta = [];
  if (card.pr) meta.push(`<span class="flag">${icon('pullRequest', 14)}#${escapeHtml(card.pr)}</span>`);
  if (column === 'archive' && card.completed) {
    meta.push(`<span class="flag">${icon('tick', 14)}${escapeHtml(card.completed)}</span>`);
  }

  const actions =
    column === 'backlog'
      ? `<button class="card-shape" data-move="to-do">${icon('kanban', 13)}To board</button>
         <button class="card-shape" data-move="archive">${icon('archive', 13)}Archive</button>`
      : `<button class="card-shape" data-move="to-do">${icon('refresh', 13)}Restore</button>`;

  // An untitled card admits it quietly (0465) until shaping names it.
  const untitled = card.title === 'Untitled task' && !hasStructure(card.body);
  el.innerHTML = `
    <div class="card-title${untitled ? ' untitled' : ''}">${renderTitle(card.title, card.body)}</div>
    ${meta.length ? `<div class="card-flags">${meta.join('')}</div>` : ''}
    <div class="card-foot shelf-actions">${actions}</div>
  `;

  for (const button of el.querySelectorAll('[data-move]')) {
    button.addEventListener('click', async (e) => {
      e.stopPropagation();
      await moveCardTo(card, button.dataset.move);
    });
  }

  el.addEventListener('click', () => openCardModal(card, el));
  return el;
}

// One move for the buttons everywhere: file to the new column, board and
// shelf redrawn, and a plain word about what happened.
async function moveCardTo(card, toColumn) {
  await window.api.moveCard(activeProject.name, card.path, toColumn);
  await loadBoard();
  showToast(columnToast(toColumn));
}

function columnToast(column) {
  return {
    'to-do': 'Moved to to do',
    doing: 'Moved to doing',
    done: 'Moved to done',
    backlog: 'Moved to backlog',
    archive: 'Archived',
  }[column] || 'Moved';
}

// "Concepts: colour change" reads better with the lead-in set apart, the way the
// cards are actually written. Where there is no lead-in, the first word carries
// it instead, which gives every card the same shape without an id line.
// Only shaped cards get the treatment: an unshaped card is a one-line wish,
// and a bold lead would dress it up as more finished than it is.
function renderTitle(title, body) {
  if (!hasStructure(body)) return escapeHtml(title);

  const colon = title.indexOf(':');
  if (colon > 0 && colon <= 24) {
    return `<span class="card-lead">${escapeHtml(title.slice(0, colon + 1))}</span>${escapeHtml(
      title.slice(colon + 1)
    )}`;
  }

  const space = title.indexOf(' ');
  if (space > 0) {
    return `<span class="card-lead">${escapeHtml(title.slice(0, space))}</span>${escapeHtml(
      title.slice(space)
    )}`;
  }
  return escapeHtml(title);
}

function renderCard(card) {
  const el = document.createElement('article');
  el.className = 'card';
  el.dataset.path = card.path;
  // The id keys the FLIP glide (0431): a column move renames the file, so
  // the path can't say "same card" across the redraw, and the id can.
  if (card.id) el.dataset.id = card.id;

  const flags = [];
  if (card.needs_input === 'true' || card.needs_input === true) {
    flags.push(`<span class="flag amber">${icon('magic', 14)}Needs input</span>`);
  }
  // The PR flag left the card face for now (0391); the PR itself still
  // happens, quietly.
  // The live-port chip left with 0375; localhost returns later as a plugin.

  // The foot is a constant-height row: shaping progress, the shaped tick, or
  // (on hover) the Shape button — the card never changes size between states.
  let foot = '';
  if (card.column === 'to-do') {
    if (shaping.has(card.path)) {
      const seconds = shapeElapsed(card.path);
      const stuck = seconds >= 15;
      foot = `<span class="flag shaping${stuck ? ' amber' : ''}" title="${
        stuck
          ? 'No reply yet. A healthy shape is a few seconds — Log in with claude, then try Shape again.'
          : 'The local claude CLI is drafting Plan, Build, QA and Done when'
      }">${icon('magic', 14)}${stuck ? 'No reply yet' : 'Asking Claude'}<span class="dots"><i></i><i></i><i></i></span></span>${
        seconds ? `<span class="shape-elapsed">${seconds}s</span>` : ''
      }`;
    } else if (hasStructure(card.body)) {
      foot = `<span class="card-shaped" title="Shaped: plan and checklists are drafted">${icon('book', 14)}Shaped</span>`;
      // The id rides beside the shaped tick, quiet and monospaced, so a card
      // can be named aloud straight off the board.
      if (card.id) foot += `<span class="card-id" title="Card id">#${escapeHtml(card.id)}</span>`;
    } else {
      foot = `<button class="card-shape" title="Ask the local claude CLI to tidy the title and draft the plan">${icon('magic', 13)}Shape</button>`;
      if (shapeErrors.has(card.path)) {
        const reason = shapeErrors.get(card.path);
        foot += `<span class="flag amber" title="${escapeHtml(reason)}">Shape failed</span>`;
      }
    }
  }

  // A Doing card with its session alive in tmux wears the working dots —
  // in-progress is visible from the board, no terminal needed (0195; dots
  // to the title's left since 0471, retiring the corner orb). A card the
  // board terminal's agent moved into Doing wears them too (0219).
  const sessionLive =
    card.column === 'doing' && aliveTmux.has(`flow-${activeProject.name}-${card.id}`);
  const agentLive = card.column === 'doing' && agentWorking.has(card.id);
  const working = sessionLive || agentLive;
  const workingTitle = sessionLive ? 'Session running' : 'Agent working on this card';

  // An untitled card admits it quietly (0465) until shaping names it.
  const untitled = card.title === 'Untitled task' && !hasStructure(card.body);
  el.innerHTML = `
    <div class="card-title${untitled ? ' untitled' : ''}">${
      working
        ? `<span class="card-working" title="${workingTitle}"><i></i><i></i><i></i></span>`
        : ''
    }${renderTitle(card.title, card.body)}</div>
    ${flags.length ? `<div class="card-flags">${flags.join('')}</div>` : ''}
    ${foot ? `<div class="card-foot">${foot}</div>` : ''}
  `;

  const shape = el.querySelector('.card-shape');
  if (shape) {
    shape.addEventListener('click', (e) => {
      e.stopPropagation();
      shapeCardAt(card);
    });
  }

  el.addEventListener('click', () => {
    // A live session takes you straight to its terminal; otherwise every card —
    // doing included — opens its document for reading and editing without
    // spinning up a terminal. The session is one button away inside. The card
    // is the modal's trigger, so the modal grows out of the card you clicked.
    const live = [...openSessions.values()].find((s) => s.cardPath === card.path);
    if (card.column === 'doing' && live) activateSession(live.id);
    else openCardModal(card, el);
  });

  return el;
}

// ── Drag and drop ──
// Sortable handles the pointer work — animation, autoscroll, the placeholder
// gap. Everything below is about turning a finished drop into file moves and
// written positions.
function initSortable() {
  for (const container of document.querySelectorAll('.cards')) {
    Sortable.create(container, {
      group: 'board',
      // Reorders snap into place rather than gliding: the board should feel
      // like it clicks, not floats.
      animation: 0,
      ghostClass: 'card-ghost',
      chosenClass: 'card-chosen',
      dragClass: 'card-dragging',
      fallbackOnBody: true,
      swapThreshold: 0.7,
      scroll: true,
      scrollSensitivity: 90,
      scrollSpeed: 14,
      // Done cards sit inside per-PR groups; dropping into a group would put a
      // card under the wrong PR, so only the column itself accepts them.
      filter: '.column-empty',
      onEnd: handleDrop,
    });
  }
}

async function handleDrop(evt) {
  const cardPath = evt.item.dataset.path;
  const fromColumn = evt.from.dataset.column;
  const toColumn = evt.to.dataset.column;
  if (!cardPath || !toColumn) return;

  const orderedPaths = (container) =>
    [...container.querySelectorAll('.card')].map((el) => el.dataset.path);

  // Same column: a reorder, nothing else.
  if (fromColumn === toColumn) {
    if (evt.oldIndex === evt.newIndex) return;
    await window.api.reorderColumn(activeProject.name, toColumn, orderedPaths(evt.to));
    await loadBoard();
    return;
  }

  // Across columns: the file moves first, then the new column is renumbered
  // using the order the drop left on screen.
  const card = cards.find((c) => c.path === cardPath);
  if (!card) return;

  // Dragging into Doing is just a move (0217, superseding 0177's auto-open):
  // no branch, no terminal, no seeded prompt. Starting work is a deliberate
  // act — opening the card and talking to the session beside it (0422).
  // Our own move must not read as the agent starting work (0219).
  if (toColumn === 'doing' && card.id) dragMovedIds.add(card.id);

  // Leaving doing pauses the card first: server, port and session shell stop,
  // the worktree stays. Open tabs for it come down with the session.
  if (fromColumn === 'doing') {
    for (const session of [...openSessions.values()]) {
      if (session.cardPath === cardPath) closeSessionTab(session.id);
    }
    // The move toast below is the one receipt; the pause itself is implied.
    await window.api.pauseCard(activeProject.name, cardPath);
  }

  const moved = await window.api.moveCard(activeProject.name, cardPath, toColumn);
  const paths = orderedPaths(evt.to).map((p) => (p === cardPath ? moved.path : p));
  await window.api.reorderColumn(activeProject.name, toColumn, paths);
  await window.api.reorderColumn(activeProject.name, fromColumn, orderedPaths(evt.from));
  await loadBoard();
  showToast(columnToast(toColumn));
}

// ── Sweep Done to the archive ──
// A whole column moving is worth a deliberate beat: it asks through the
// shared confirmation (0187).

on('archive-done-button', 'click', async () => {
  const doneCards = cards.filter((c) => c.column === 'done' && dividerLabel(c) === null);
  if (!doneCards.length) return;

  const plural = doneCards.length === 1 ? '' : 's';
  const ok = await confirmAction(
    `Archive ${doneCards.length} card${plural} from Done? Every card keeps its markdown.`,
    'Archive'
  );
  if (!ok) return;

  for (const card of doneCards) {
    await window.api.archiveCard(activeProject.name, card.path);
  }
  await loadBoard();
  showToast(`Archived ${doneCards.length} card${plural}`);
});
