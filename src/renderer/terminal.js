// ── Dock position ──
// Retired shapes (0245): the bottom dock (0115) and the full-height pin
// (0172) left with their toggles — the pane keeps the one shape, docked on
// the right beside the board. termDock stays as a function because the
// resize code asks; the answer no longer varies.
function termDock() {
  return 'right';
}

// Opening the pane must not squeeze the columns: they keep the width they had
// with the whole window to themselves, and the row scrolls sideways instead.
// The lock is the measured pixel width, taken before the pane appears; closing
// the pane hands the columns back to the stylesheet's fluid track.
// Each home view remembers its own width. A first open has no memory yet:
// the board's takes most of the right of the window — everything up to the
// To do column's edge, covering where Doing and Done sat, the columns you
// consult least while a terminal is working — and Docs falls back to the
// stylesheet's half.
function termWidthKey() {
  return isDocsKind(termKind()) ? 'docs-term-width' : 'board-term-width';
}

function termHeightKey() {
  return isDocsKind(termKind()) ? 'docs-term-height' : 'board-term-height';
}

function restoreTermWidth() {
  const pane = $('board-term-pane');
  if (termDock() === 'bottom') {
    // Bottom dock remembers a height the way the side dock remembers a width.
    pane.style.width = '';
    const savedHeight = parseInt(localStorage.getItem(termHeightKey()), 10);
    pane.style.height =
      Number.isFinite(savedHeight) && savedHeight >= 160 ? `${savedHeight}px` : '';
    return;
  }
  pane.style.height = '';
  // The docs rooms drag too since 0396 (superseding 0280's fixed split):
  // a remembered width wins, the stylesheet's 40% is only the first day.
  if (isDocsKind(termKind())) {
    const savedDocs = parseInt(localStorage.getItem(termWidthKey()), 10);
    pane.style.width = Number.isFinite(savedDocs) && savedDocs >= 320 ? `${savedDocs}px` : '';
    return;
  }
  const saved = parseInt(localStorage.getItem(termWidthKey()), 10);
  if (Number.isFinite(saved) && saved >= 300) {
    pane.style.width = `${saved}px`;
    return;
  }
  pane.style.width = '';
  if (termKind() !== 'board') return;
  const view = $('board-view');
  const todo = document.querySelector('.column[data-column="to-do"]');
  if (!view || !todo || view.classList.contains('hidden')) return;
  // The 32px keeps the resize handle and the columns' gutter clear of the
  // To do column's right edge.
  const width = Math.round(
    view.getBoundingClientRect().right - todo.getBoundingClientRect().right - 32
  );
  if (width >= 300) pane.style.width = `${width}px`;
}

// Brings the current view's pane up: the right wrapper visible, the width
// and dock applied, the label naming the project and the room. Column widths
// need no JS: a stylesheet rule pins them to a third of the window whenever
// the side pane is up (0160).
function presentTermPane() {
  const kind = termKind();
  for (const [k, t] of Object.entries(homeTerms)) {
    if (t) t.wrapper.classList.toggle('hidden', k !== kind);
  }
  restoreTermWidth();
  // The label names the project, the room and the CLI actually launched, so a
  // reattached shell can never be mistaken for some other board's — or the
  // other view's.
  $('board-term-label').textContent = `${activeProject.title} · ${
    isDocsKind(kind) ? `${kind} · ${sessionCli}` : sessionCli
  }`;
  // The docs and insights rooms keep a quieter toolbar (0263): the board
  // goals (Process to-dos, Draft PR) make no sense beside a doc, so only
  // info and Hide stay.
  $('board-term-pane').classList.toggle('docs-room', isDocsKind(kind));
  $('board-term-pane').classList.remove('hidden');
  document.querySelector('.resize-handle[data-resize="board"]').classList.remove('hidden');
  $('global-term-button').classList.add('open');
}

// The typed doc-path prefill (0183, 0250) retired in 0285: one session
// serves every doc, and toggling docs types nothing. The session still
// knows which doc is open through the .current-doc note the main process
// keeps beside the vault.

async function openGlobalTerminal() {
  if (!activeProject) return;
  // The terminal docks beside whichever home view is up; only a session view
  // needs swapping away from.
  if (!isBoardVisible() && !isDocsVisible()) showBoard();
  placeTermPane();

  const kind = termKind();

  const existing = homeTerms[kind];
  if (existing) {
    // A hidden pane comes straight back: the session never stopped.
    paneOpen[kind] = true;
    presentTermPane();
    fitSession(existing);
    existing.term.focus();
    return;
  }

  const result = await window.api.openGlobalTerminal(activeProject.name, kind);
  if (result.error) {
    showToast(result.error);
    return;
  }

  const wrapper = document.createElement('div');
  wrapper.className = 'term-instance';
  $('board-term-stack').appendChild(wrapper);

  const { term, fitAddon } = buildTerminal(result.sessionId, wrapper);
  homeTerms[kind] = { id: result.sessionId, term, fitAddon, wrapper, kind };
  paneOpen[kind] = true;

  paintTermClose();
  presentTermPane();

  requestAnimationFrame(() => {
    fitSession(homeTerms[kind]);
    term.focus();
  });
}

// Takes the pane down without ending anything: the pty detaches and the tmux
// session keeps running for the next attach. Returns whether a pane was open,
// so a project switch knows to bring the new project's terminal straight up.
function detachGlobalTerminal() {
  const hadAny = Boolean(homeTerms.board || homeTerms.docs || homeTerms.insights);
  if (!hadAny) return false;
  // Only a visible pane asks to come back after a project switch; one that was
  // hidden stays put, its tmux session waiting for the button.
  const wasVisible = !$('board-term-pane').classList.contains('hidden');
  for (const kind of ['board', 'docs', 'insights']) {
    const t = homeTerms[kind];
    if (!t) continue;
    window.api.stopTerminal(t.id);
    t.term.dispose();
    homeTerms[kind] = null;
    paneOpen[kind] = false;
  }
  $('board-term-stack').innerHTML = '';
  // The pane comes down too: the next project only brings it back if its own
  // session is actually running, so an empty pane must not linger meanwhile.
  $('board-term-pane').classList.add('hidden');
  document.querySelector('.resize-handle[data-resize="board"]').classList.add('hidden');
  $('global-term-button').classList.remove('open');
  return wasVisible;
}

// The info dropdown (0262): what this shell is actually standing in. The
// board terminal runs in the project checkout on the checkout's branch; the
// docs terminal runs in the knowledgebase folder. Filled fresh on every
// open, so a project or branch switch can't leave it lying.
function renderTermInfo() {
  const menu = $('term-info-menu');
  if (!menu || !activeProject) return;
  const kind = termKind();
  const docs = isDocsKind(kind);
  const path = docs
    ? `${activeProject.boardRoot}/${kind === 'insights' ? 'insights' : '00-knowledge'}`
    : activeProject.path;
  const rows = [
    ['Path', tildePath(path)],
    ['Branch', docs ? 'not a repo — the docs folder' : projectBranch || 'no branch'],
  ];
  menu.innerHTML = rows
    .map(
      ([label, value]) => `<div class="term-info-row">
        <span class="term-info-label">${escapeHtml(label)}</span>
        <span class="term-info-value">${escapeHtml(value)}</span>
      </div>`
    )
    .join('');
}

on('term-info', 'click', (e) => {
  e.stopPropagation();
  const menu = $('term-info-menu');
  const opening = menu.classList.contains('hidden');
  if (opening) renderTermInfo();
  menu.classList.toggle('hidden', !opening);
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.term-info-wrap')) {
    const menu = $('term-info-menu');
    if (menu) menu.classList.add('hidden');
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const menu = $('term-info-menu');
  if (menu && !menu.classList.contains('hidden')) {
    // Immediate, so the docs view's own Escape (registered after this,
    // also on document) doesn't read the same press as "close the doc".
    e.stopImmediatePropagation();
    menu.classList.add('hidden');
  }
});

function paintTermClose() {
  const btn = $('board-term-close');
  if (!btn) return;
  btn.dataset.tip = 'Hide this terminal, session keeps running. Shift-click ends it';
}

// Dismissal slides the pane away and keeps the session running; only the
// animation's end actually takes the pane out of the layout, so the exit
// reads as leaving rather than vanishing.
function hideGlobalTerminal() {
  const pane = $('board-term-pane');
  if (pane.classList.contains('hidden') || pane.classList.contains('leaving')) return;
  paneOpen[termKind()] = false;
  document.querySelector('.resize-handle[data-resize="board"]').classList.add('hidden');
  $('global-term-button').classList.remove('open');
  if (typeof paintKbTermButton === 'function') paintKbTermButton();
  pane.classList.add('leaving');
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    pane.classList.remove('leaving');
    pane.classList.add('hidden');
  };
  pane.addEventListener('animationend', finish, { once: true });
  // Animations can be cut short (reduced motion, a hidden ancestor); the
  // pane must never be stranded half-gone.
  setTimeout(finish, 300);
}

function closeGlobalTerminal() {
  const kind = termKind();
  const t = homeTerms[kind];
  if (!t) return;
  window.api.killTerminal(t.id);
  t.term.dispose();
  t.wrapper.remove();
  homeTerms[kind] = null;
  paneOpen[kind] = false;
  $('board-term-pane').classList.add('hidden');
  document.querySelector('.resize-handle[data-resize="board"]').classList.add('hidden');
  $('global-term-button').classList.remove('open');
  if (typeof paintKbTermButton === 'function') paintKbTermButton();
}

// The Terminal tab opens a small menu; the actions live on its items. The
// side pane stays a toggle: opening when closed, dismissing when open. The
// session itself only ends from the close button, deliberately.
// The toggle types nothing (0305, retiring 0256's auto-typed loop goal): a
// fresh session opens on a bare prompt, and the loop brief lives behind the
// header's Process to-dos goal, clicked when it is actually wanted.
$('global-term-button').addEventListener('click', async () => {
  if (currentHomeTerm() && !$('board-term-pane').classList.contains('hidden')) {
    hideGlobalTerminal();
    return;
  }
  await openGlobalTerminal();
});

// The Insights room's own toggle (0447): the same pane, the same tmux
// session per project and room, standing in the insights folder — the
// button is just Insights' way of asking (0398 kept it away by default).
async function toggleKbTerminal() {
  if (currentHomeTerm() && !$('board-term-pane').classList.contains('hidden')) {
    hideGlobalTerminal();
  } else {
    await openGlobalTerminal();
  }
  paintKbTermButton();
}

// The insights toggle wears its open state the way the board's does.
function paintKbTermButton() {
  const btn = $('kb-term-button');
  if (!btn) return;
  btn.classList.toggle(
    'open',
    Boolean(currentHomeTerm()) && !$('board-term-pane').classList.contains('hidden')
  );
}

on('kb-term-button', 'click', toggleKbTerminal);

$('board-term-close').addEventListener('click', async (e) => {
  if (!currentHomeTerm()) return;
  if (e.shiftKey) {
    // Ending is the one act here with no way back (0359): the tmux session
    // and whatever runs in it stop for real, so it asks by name first.
    const ok = await confirmAction(
      'End this terminal session for real? The tmux session and anything running in it stops. Hiding the pane instead keeps it alive.',
      'End session'
    );
    if (!ok) return;
    closeGlobalTerminal();
  } else hideGlobalTerminal();
  // Planning's halves go together (0265): hiding the docs terminal closes
  // the doc back to the index too. showKbIndex re-hides the pane, which
  // the hide guards make a no-op.
  if (isDocsKind(termKind()) && isDocsVisible() && !$('docs-view').classList.contains('index-mode')) {
    showKbIndex();
  }
});

// ── Terminal goals ──
// The header's icons each type a ready-made brief into the terminal — typed,
// never sent, so the goal is always yours to read, edit and fire.
// Single-line goals go in as plain keystrokes (0256): fully visible and
// editable in place, instead of collapsing to the CLI's "[pasted N lines]"
// chip. Only text with real newlines still needs the bracketed-paste wrap,
// which is what keeps a mid-text Enter from firing early.
function typeGoal(text) {
  const t = currentHomeTerm();
  if (!t) return;
  const input = text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text;
  window.api.sendTerminalInput(t.id, input);
  t.term.focus();
}

function boardTodoDir() {
  return activeProject && activeProject.boardRoot
    ? `${activeProject.boardRoot}/01-to-do`
    : 'the board to-do folder';
}

// The card-by-card working instructions, shared by the terminal-header goal
// (current branch) and the column's loop icon (fresh branch off main).
function clearTodosBrief() {
  const todoDir = boardTodoDir();
  const doingDir = activeProject.boardRoot
    ? `${activeProject.boardRoot}/02-doing`
    : 'the board doing folder';
  const doneDir = activeProject.boardRoot
    ? `${activeProject.boardRoot}/03-done`
    : 'the board done folder';
  return `Work through every card in ${todoDir} in position order (the position field in each file's frontmatter). For each card, in this order: move its file to ${doingDir} and set its status to doing in the frontmatter, so the board shows it in progress; do the work it describes; tick its checklists in the file and add a short recap of what you did; then move the file to ${doneDir} and set its status to done and completed to today's date in the frontmatter. Commit as you go, one commit per card. Report progress after each card: which card just finished, which is next, how many remain. Before you finish, list ${todoDir} again — if new cards arrived while you worked, do those too, and repeat until the to-do folder is empty and ${doingDir} holds no card of yours.`;
}

// The Quick start menu (0380): the goals live behind one button. Choosing a
// goal types it and puts the menu away; clicking elsewhere or Escape closes.
on('term-quick-start', 'click', (e) => {
  e.stopPropagation();
  $('quick-start-menu').classList.toggle('hidden');
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.quick-start-wrap')) {
    const menu = $('quick-start-menu');
    if (menu) menu.classList.add('hidden');
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const menu = $('quick-start-menu');
    if (menu) menu.classList.add('hidden');
  }
});

on('term-clear-todos', 'click', () => {
  $('quick-start-menu').classList.add('hidden');
  if (!activeProject) return;
  typeGoal(`Goal: clear out the to-do list, on the current branch. ${clearTodosBrief()}`);
});

// Draft PR (0261): the goal asks for a reviewable draft, and the command
// is typed like every other goal — reading and firing it stays yours.
on('term-draft-pr', 'click', () => {
  $('quick-start-menu').classList.add('hidden');
  if (!activeProject) return;
  typeGoal(
    'Goal: draft a pull request for the current branch. Review what has changed against main (git log and diff), commit or note anything uncommitted, push the branch, then open a draft PR with `gh pr create --draft` — a clear title and a body that says what changed and why. Report the PR URL.'
  );
});

// ── Standalone terminals ──
// Full-width sessions tied to no card — a dev server, research, riffing.
// They live as tabs like card sessions, but the session view gives them the
// whole window. tmux keeps them alive; the remembered list brings their tabs
// back on the next launch.
function standaloneKey() {
  return `standalone:${activeProject ? activeProject.name : ''}`;
}

function readStandalones() {
  try {
    return JSON.parse(localStorage.getItem(standaloneKey())) || [];
  } catch (err) {
    return [];
  }
}

function writeStandalones(list) {
  localStorage.setItem(standaloneKey(), JSON.stringify(list));
}

function attachStandalone(sessionId, title, { activate = true } = {}) {
  let session = openSessions.get(sessionId);
  if (!session) {
    const wrapper = document.createElement('div');
    wrapper.className = 'term-instance hidden';
    $('term-stack').appendChild(wrapper);
    const { term, fitAddon } = buildTerminal(sessionId, wrapper);
    session = {
      id: sessionId,
      project: activeProject ? activeProject.name : '',
      cardId: '',
      cardPath: '',
      title,
      term,
      fitAddon,
      wrapper,
      dirty: false,
      notes: [],
      standalone: true,
    };
    openSessions.set(sessionId, session);
  }
  if (activate) activateSession(sessionId);
  else renderTabs();
}

// The new-tab menu, its standalone-terminal opener and the webview browser
// tab left for the plugin archive (0376). attachStandalone and the restore
// list stay: the Claude-login Flow and saved tabs still ride them.

// Tabs for standalone sessions still alive in tmux come back quietly; dead
// entries fall off the list.
async function restoreStandalones() {
  if (!activeProject) return;
  const list = readStandalones();
  if (!list.length) return;
  const rows = (await window.api.listTerminalSessions().catch(() => [])) || [];
  const alive = new Set(rows.map((r) => r.name));
  const kept = [];
  for (const entry of list) {
    if (!alive.has(`flow-${entry.id}`)) continue;
    if (!openSessions.has(entry.id)) {
      const result = await window.api
        .openShell(activeProject.name, entry.suffix)
        .catch(() => null);
      if (!result || result.error) continue;
      attachStandalone(entry.id, entry.title, { activate: false });
    }
    kept.push(entry);
  }
  writeStandalones(kept);
}
