// ── Adding a card ──
// A textarea that sizes itself as text wraps; the CSS max-height is the
// ceiling. Called with the value already changed.
function autoGrow(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = `${textarea.scrollHeight + 2}px`;
}

// A half-written card survives a reload: every keystroke lands in
// localStorage under the project's name, and only saving the card or
// deliberately closing the modal lets go of it. A reload mid-thought brings
// the modal back with the text where it was.
function draftKey() {
  return `card-draft:${activeProject ? activeProject.name : ''}`;
}

function readDraft() {
  try {
    const draft = JSON.parse(localStorage.getItem(draftKey()));
    // A day-old draft is an abandoned thought, not a reload survivor.
    if (draft && (draft.title || draft.text) && Date.now() - draft.at < 24 * 60 * 60 * 1000) {
      return { title: draft.title || '', text: draft.text || '' };
    }
  } catch (err) {
    // An unreadable draft is no draft.
  }
  localStorage.removeItem(draftKey());
  return { title: '', text: '' };
}

function saveDraft() {
  const title = $('card-add-title').value;
  const text = $('card-add-input').value;
  if (title.trim() || text.trim()) {
    localStorage.setItem(draftKey(), JSON.stringify({ title, text, at: Date.now() }));
  } else {
    localStorage.removeItem(draftKey());
  }
}

// The dashed button opens a room built for writing: one big input where the
// first line becomes the title and the rest is context. Save and shape closes
// the modal, creates the card and shapes it in the background.
//
// Clicking "New card" is a deliberate fresh start, so it opens empty and drops
// any stale draft. Only the reload path (`restore`) brings a half-written card
// back — that is the interruption the draft exists to survive.
// A modal that grows out of the thing you clicked, rather than popping in over
// it. The panel keeps its final place; only its scale pivots — around the
// trigger's centre, expressed in the panel's own coordinates — so it appears
// to emerge from the button or card and settle into size. Transform and
// opacity only, so it stays on the compositor. A trigger off-screen (or none)
// falls back to a plain centre-scale.
function morphPanelFrom(panel, trigger) {
  if (!panel) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  requestAnimationFrame(() => {
    const p = panel.getBoundingClientRect();
    if (!p.width) return;
    const t = trigger && trigger.getBoundingClientRect();
    if (t && t.width) {
      panel.style.transformOrigin = `${t.left + t.width / 2 - p.left}px ${
        t.top + t.height / 2 - p.top
      }px`;
    } else {
      panel.style.transformOrigin = '50% 50%';
    }
    panel.classList.add('morph-in');
    panel.addEventListener(
      'animationend',
      () => {
        panel.classList.remove('morph-in');
        panel.style.transformOrigin = '';
      },
      { once: true }
    );
  });
}

function openCardAdd(restore = false, trigger = null) {
  // Overlays live in the DOM; the link pane floats above it (0408).
  if (typeof closeLinkPane === 'function') closeLinkPane();

  $('card-add-modal').classList.remove('hidden');
  morphPanelFrom($('card-add-panel'), trigger);
  const title = $('card-add-title');
  const input = $('card-add-input');
  if (restore) {
    const draft = readDraft();
    title.value = draft.title;
    input.value = draft.text;
  } else {
    title.value = '';
    input.value = '';
    localStorage.removeItem(draftKey());
  }
  // Writing starts at the title; a restored draft that already has one
  // resumes in the context field instead.
  const field = restore && title.value.trim() ? input : title;
  field.focus();
  field.setSelectionRange(field.value.length, field.value.length);
}

function closeCardAdd() {
  $('card-add-modal').classList.add('hidden');
  // The fields empty with the room: closing lets go of the thought, and a
  // hidden form holding old text could otherwise be saved again later.
  $('card-add-title').value = '';
  $('card-add-input').value = '';
  localStorage.removeItem(draftKey());
}

// Save lands the card either way; `shape` decides whether the model then
// drafts its plan. The primary button and Enter shape and close the modal;
// the quiet Save clears the form and keeps it open, so a run of tasks can
// be captured one after another without reopening the room each time.
async function saveCardAdd(shape = true) {
  const context = $('card-add-input').value.trim();
  let title = $('card-add-title').value.replace(/\s+/g, ' ').trim();
  if (!title && !context) {
    $('card-add-title').focus();
    return;
  }
  // A title is optional (0465): a description alone lands as an untitled
  // card, whole, and shaping writes the real title from it — the first
  // line is not stolen to stand in.
  let raw = context ? (title ? `${title}\n\n${context}` : context) : title;
  if (!title) {
    title = 'Untitled task';
    raw = context;
  }

  if (shape) {
    closeCardAdd();
  } else {
    $('card-add-title').value = '';
    $('card-add-input').value = '';
    localStorage.removeItem(draftKey());
    $('card-add-title').focus();
  }
  const card = await window.api.createCard(activeProject.name, title);
  // The title leads the body with the context under it: shaping may rewrite
  // the card's title, so the original ask has to live in the body or it is
  // lost the moment the model renames the card. Shaping keeps this leading
  // text and appends its sections below it.
  await window.api.writeCardBody(card.path, `\n${raw}\n`);
  // Pasted images take the new card's number (0289). An older main process
  // without the handler just leaves the neutral names.
  if (window.api.adoptAttachments) {
    await window.api.adoptAttachments(activeProject.name, card.path).catch(() => {});
  }
  await loadBoard();
  if (shape) shapeCardAt(await window.api.readCard(card.path));
  else showToast('Saved');
}

on('card-add-title', 'input', saveDraft);
on('card-add-input', 'input', saveDraft);

// A bare arrow, or the click event lands in `restore` and every fresh open
// resurrects the last draft — the exact bug this reconciles.
on('quick-add-button', 'click', (e) => openCardAdd(false, e.currentTarget));
on('card-add-save', 'click', () => saveCardAdd(true));
on('card-add-save-only', 'click', () => saveCardAdd(false));
on('card-add-modal', 'mousedown', (e) => {
  if (e.target.id === 'card-add-modal') closeCardAdd();
});
// The title is one line, so Enter there saves and shapes outright; Tab is
// the way down into the context field.
on('card-add-title', 'keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    saveCardAdd(true);
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    closeCardAdd();
  }
});
on('card-add-input', 'keydown', (e) => {
  // Enter saves and shapes; Shift+Enter writes the next line. Esc closes —
  // the modal has no other chrome, so the keys are the whole interface.
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    saveCardAdd(true);
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    closeCardAdd();
  }
});

// Done shows the last seven days by default. The count chip is the toggle —
// clicking it swaps between that and everything ever finished.
const doneChip = document.querySelector('.column[data-column="done"] .count-chip');
if (doneChip) {
  doneChip.classList.add('toggle');
  doneChip.title = 'Showing the last 7 days. Click for everything';
  doneChip.addEventListener('click', () => {
    showAllDone = !showAllDone;
    doneChip.classList.toggle('on', showAllDone);
    doneChip.title = showAllDone
      ? 'Showing everything. Click for the last 7 days'
      : 'Showing the last 7 days. Click for everything';
    renderBoard();
  });
}

// ── Search ──
// Summoned with Cmd+K rather than sitting on the board taking up room.
function openSearch() {
  const overlay = $('search-overlay');
  if (!overlay) return;
  if (typeof closeLinkPane === 'function') closeLinkPane();
  overlay.classList.remove('hidden');
  $('search').focus();
  $('search').select();
}

function closeSearch() {
  const overlay = $('search-overlay');
  if (!overlay) return;
  overlay.classList.add('hidden');
  if (searchTerm) {
    searchTerm = '';
    $('search').value = '';
    renderBoard();
  }
}

on('search', 'input', (e) => {
  searchTerm = e.target.value.trim();
  renderBoard();
});

on('search', 'keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    closeSearch();
  }
});

// ── Keyboard navigation ──
// Arrow Up and Down walk the cards of one column; Enter opens the highlighted
// card exactly as a click would. The highlight belongs to the board alone — it
// clears when a session takes the window or the user clicks anywhere else.
let selectedCardPath = null;

// Only cards that are actually on screen count: a collapsed done group hides
// its cards, and stepping onto an invisible card would strand the highlight.
function selectableCards(column) {
  const container = document.querySelector(`.cards[data-column="${column}"]`);
  if (!container) return [];
  return [...container.querySelectorAll('.card')].filter((el) => el.offsetParent !== null);
}

function selectedColumn() {
  for (const column of ['to-do', 'doing', 'done']) {
    if (selectableCards(column).some((el) => el.dataset.path === selectedCardPath)) {
      return column;
    }
  }
  return null;
}

function paintSelection() {
  for (const el of document.querySelectorAll('#board-view .card')) {
    el.classList.toggle(
      'kb-selected',
      Boolean(selectedCardPath) && el.dataset.path === selectedCardPath
    );
  }
}

function clearSelection() {
  if (!selectedCardPath) return;
  selectedCardPath = null;
  paintSelection();
}

// Selection stays in its column and wraps at the ends. With nothing selected
// yet, the first press lands on the first card of the first column that has one.
function moveSelection(delta) {
  const column = selectedColumn();

  if (!column) {
    for (const candidate of ['to-do', 'doing', 'done']) {
      const els = selectableCards(candidate);
      if (els.length) {
        selectedCardPath = els[delta > 0 ? 0 : els.length - 1].dataset.path;
        break;
      }
    }
  } else {
    const els = selectableCards(column);
    const index = els.findIndex((el) => el.dataset.path === selectedCardPath);
    selectedCardPath = els[(index + delta + els.length) % els.length].dataset.path;
  }

  paintSelection();
  const el = document.querySelector('#board-view .card.kb-selected');
  if (el) el.scrollIntoView({ block: 'nearest' });
}

// Left/Right walk the highlight across columns (0351), landing on roughly
// the same height in the neighbour rather than snapping to its top.
function moveSelectionAcross(delta) {
  const columns = ['to-do', 'doing', 'done'];
  const column = selectedColumn();
  if (!column) {
    moveSelection(1);
    return;
  }
  const fromEls = selectableCards(column);
  const fromIndex = Math.max(
    0,
    fromEls.findIndex((el) => el.dataset.path === selectedCardPath)
  );
  let at = columns.indexOf(column);
  for (let step = 0; step < columns.length - 1; step += 1) {
    at = (at + delta + columns.length) % columns.length;
    const els = selectableCards(columns[at]);
    if (els.length) {
      selectedCardPath = els[Math.min(fromIndex, els.length - 1)].dataset.path;
      break;
    }
  }
  paintSelection();
  const el = document.querySelector('#board-view .card.kb-selected');
  if (el) el.scrollIntoView({ block: 'nearest' });
}

// Alt+Arrow moves the card itself (0351): dragging must not be the only
// route. Left/Right change column through the same move-card door the drag
// uses; the board reloads and the highlight follows the card.
async function moveSelectedCard(delta) {
  const card = cards.find((c) => c.path === selectedCardPath);
  if (!card) return;
  const columns = ['to-do', 'doing', 'done'];
  const at = columns.indexOf(card.column);
  const target = columns[at + delta];
  if (at === -1 || !target) return;
  const moved = await window.api
    .moveCard(activeProject.name, card.path, target)
    .catch(() => null);
  if (moved && moved.path) selectedCardPath = moved.path;
  await loadBoard();
  paintSelection();
}

function openSelectedCard() {
  const card = cards.find((c) => c.path === selectedCardPath);
  if (!card) return;
  const live = [...openSessions.values()].find((s) => s.cardPath === card.path);
  if (card.column === 'doing' && live) activateSession(live.id);
  else openCardModal(card);
}

document.addEventListener('keydown', (e) => {
  // Only the bare board: no session in front, no modal or overlay open, and
  // the keystroke not meant for a field or the board terminal.
  if (!isBoardVisible() || modalCard) return;
  if (!$('search-overlay').classList.contains('hidden')) return;
  if (!$('settings-modal').classList.contains('hidden')) return;
  if (!$('card-add-modal').classList.contains('hidden')) return;
  if (
    e.target.closest &&
    e.target.closest('input, textarea, [contenteditable], #board-term-pane')
  ) {
    return;
  }

  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    moveSelection(e.key === 'ArrowDown' ? 1 : -1);
    return;
  }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    if (e.altKey && selectedCardPath) moveSelectedCard(e.key === 'ArrowRight' ? 1 : -1);
    else moveSelectionAcross(e.key === 'ArrowRight' ? 1 : -1);
    return;
  }
  if (e.key === 'Enter' && selectedCardPath) {
    e.preventDefault();
    openSelectedCard();
  }
});

// With a card open, Up/Down step to the neighbouring card in the same column —
// but only when the keystroke is not meant for text: a caret inside the
// context or title owns the arrows while it has focus.
document.addEventListener('keydown', (e) => {
  if (!modalCard) return;
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  if (e.target.closest && e.target.closest('input, textarea, [contenteditable]')) return;

  const siblings = cards
    .filter((c) => c.column === modalCard.column)
    .sort((a, b) => (a.position || 0) - (b.position || 0));
  const at = siblings.findIndex((c) => c.path === modalCard.path);
  if (at === -1) return;
  const next = siblings[at + (e.key === 'ArrowDown' ? 1 : -1)];
  if (!next) return; // Held at the ends rather than wrapping.
  e.preventDefault();
  // Navigating replaces the card in place; the trigger becomes the neighbour's
  // board element so a later close still morphs to the right card.
  const el = document.querySelector(`#board-view .card[data-path="${CSS.escape(next.path)}"]`);
  openCardModal(next, el);
});

// Clicking anywhere that is not a card hands control back to the mouse.
document.addEventListener('click', (e) => {
  if (selectedCardPath && !e.target.closest('.card')) clearSelection();
});

// One handler for every link in the app, whichever pane rendered it: chips
// carry data-href, markdown from marked carries a real href, and both end in
// the system browser rather than navigating the window or spawning a child.
document.addEventListener('click', (e) => {
  const linked = e.target.closest && e.target.closest('[data-href], a[href]');
  if (!linked) return;
  const url = linked.dataset.href || linked.getAttribute('href') || '';
  if (!/^https?:\/\//i.test(url)) return;
  e.preventDefault();
  e.stopPropagation();
  window.api.openExternal(url);
});

// ── Toast ──
// The one place failures surface. Quiet, bottom of the window, goes away on its
// own; anything that needs more than a sentence belongs in the document.
let toastTimer = null;

function showToast(message) {
  const el = $('toast');
  if (!el) return;
  el.textContent = message;
  el.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 6000);
}
