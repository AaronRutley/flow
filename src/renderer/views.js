// ── Views ──
function isBoardVisible() {
  return !$('board-view').classList.contains('hidden');
}

function isDocsVisible() {
  return !$('docs-view').classList.contains('hidden');
}

function isShelfVisible(column) {
  const view = $(`${column}-view`);
  return Boolean(view) && !view.classList.contains('hidden');
}

// The card room sits fixed over the content area; navigating anywhere puts
// it away first, flushing any pending edit (0188). No morph — the click
// asked for a different view, not a close animation.
function dismissCardView() {
  if ($('card-view').classList.contains('hidden')) return;
  if (modalSaveTimer) {
    clearTimeout(modalSaveTimer);
    modalSaveTimer = null;
    if (modalCard) saveBody(modalCard.path, $('card-modal-body').querySelector('.markdown-body'));
  }
  closeModalShell();
  modalCard = null;
  $('card-view').classList.add('hidden');
}

function showView(which) {
  // The link pane floats above the DOM (0408); any navigation puts it away
  // before the room changes underneath it.
  if (typeof closeLinkPane === 'function') closeLinkPane();
  dismissCardView();
  // The settings screen has no close button (0225): choosing any view above
  // is how you leave it.
  $('settings-modal').classList.add('hidden');
  if (which !== 'board') clearSelection();
  $('board-view').classList.toggle('hidden', which !== 'board');
  // Insights has no view of its own (0385): the docs view serves both tabs,
  // pointed at whichever vault kbRoot names.
  $('docs-view').classList.toggle('hidden', which !== 'docs');
  const backlogView = $('backlog-view');
  if (backlogView) backlogView.classList.toggle('hidden', which !== 'backlog');
  const archiveView = $('archive-view');
  if (archiveView) archiveView.classList.toggle('hidden', which !== 'archive');
  const dashboardView = $('dashboard-view');
  if (dashboardView) dashboardView.classList.toggle('hidden', which !== 'dashboard');
  // The dashboard is its own place (0469): no project bar, no tab strip —
  // the projects on it are the navigation. The titlebar stays, for the
  // window's own controls.
  document.body.classList.toggle('dashboard-up', which === 'dashboard');
  $('session-view').classList.toggle('hidden', which !== 'session');
  renderTabs();
  refreshEnvButton();
}

// The global terminal pane is one DOM node that docks into whichever home
// view is showing: board or docs. Moving the node keeps the xterm alive.
function placeTermPane() {
  const pane = $('board-term-pane');
  const handle = document.querySelector('.resize-handle[data-resize="board"]');
  // In Planning the pane docks inside the grouped unit (0286), under the
  // shared header beside the doc; on the board it stays the floating pane.
  const host = isDocsVisible() ? $('kb-doc-row') : $('board-view');
  if (pane && handle && pane.parentElement !== host) {
    host.appendChild(handle);
    host.appendChild(pane);
  }
  // The pane belongs to the view: each home view shows only its own session.
  // Landing on a view whose terminal was open brings it back; a view whose
  // terminal is closed gets no pane, whatever the other view had up.
  const kind = termKind();
  if (paneOpen[kind] && homeTerms[kind]) {
    presentTermPane();
    requestAnimationFrame(() => fitSession(homeTerms[kind]));
  } else if (pane) {
    pane.classList.add('hidden');
    if (handle) handle.classList.add('hidden');
    $('global-term-button').classList.remove('open');
  }
}

function showBoard() {
  stopPolling();
  showView('board');
  loadBoard();
  placeTermPane();
  rememberView('board');
}

function showDocs() {
  stopPolling();
  setKbRoot('knowledge');
  showView('docs');
  loadKb();
  placeTermPane();
  rememberView('docs', kbActive && kbActive.path);
}

$('tab-board').addEventListener('click', showBoard);
on('tab-docs', 'click', showDocs);

// Insights (0385): Planning's twin pointed at the insights/ vault — the
// same view and machinery, a different root on disk.
function showInsights() {
  stopPolling();
  setKbRoot('insights');
  showView('docs');
  loadKb();
  placeTermPane();
  rememberView('insights', kbActive && kbActive.path);
}

on('tab-insights', 'click', showInsights);


// The shelves load through the same board fetch, so their lists are always
// the same truth the columns read from.
function showShelf(column) {
  stopPolling();
  showView(column);
  loadBoard();
}

on('foot-backlog', 'click', () => showShelf('backlog'));
on('foot-archive', 'click', () => showShelf('archive'));

// Leaving a shelf is one click on its header's X — or Escape (0173).
for (const button of document.querySelectorAll('[data-shelf-close]')) {
  button.addEventListener('click', showBoard);
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!isShelfVisible('backlog') && !isShelfVisible('archive')) return;
  if (modalCard) return;
  if (!$('card-add-modal').classList.contains('hidden')) return;
  showBoard();
});

// ── The nav bubble (0310, resting state 0371) ──
// iOS manners for the main nav: one glassy highlight lives behind the home
// tabs and slides between them on hover, instead of each tab painting its
// own. Its resting place is the active tab — hover borrows the bubble, and
// the pointer moving on or leaving the bar hands it back, so the current
// view always wears the same flowing highlight.
(() => {
  const toolbar = $('toolbar');
  if (!toolbar) return;
  const bubble = document.createElement('div');
  bubble.id = 'nav-bubble';
  toolbar.appendChild(bubble);
  let visible = false;

  const show = (tab) => {
    // A fresh arrival appears where it is; only travel animates.
    bubble.classList.toggle('teleport', !visible);
    bubble.style.width = `${tab.offsetWidth}px`;
    bubble.style.height = `${tab.offsetHeight}px`;
    bubble.style.transform = `translate(${tab.offsetLeft}px, ${tab.offsetTop}px)`;
    bubble.style.opacity = '1';
    visible = true;
  };

  const settle = () => {
    const active = toolbar.querySelector('.home-tab.active:not(.hidden)');
    if (active) show(active);
    else {
      bubble.style.opacity = '0';
      visible = false;
    }
  };
  // renderTabs calls this whenever the active view changes.
  window.settleNavBubble = settle;

  toolbar.addEventListener('mouseover', (e) => {
    const tab = e.target.closest && e.target.closest('.home-tab');
    if (tab && !tab.classList.contains('hidden')) {
      show(tab);
      return;
    }
    // The gaps between tabs keep the bubble alive mid-slide; any other
    // control sends it home to the active tab.
    if (e.target.closest && e.target.closest('button')) settle();
  });
  toolbar.addEventListener('mouseleave', settle);
  settle();
})();
