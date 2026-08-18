// ── Init ──
// Proactive stale-main check: if the main process (or its preload) predates
// this renderer, say so once, up front, instead of failing feature by feature.
function checkMainFreshness() {
  const notice = () => showToast('Restart Flow to update (Cmd+Q, reopen)');
  if (typeof window.api.handshake !== 'function') {
    notice();
    return;
  }
  window.api.handshake().catch(notice);
}

// ── Accessible names ride the tooltips (0352) ──
// Every icon control already explains itself through data-tip; the same
// words become the aria-label, kept in step by observation so buttons the
// app creates later (tabs, menus, tools) are named the moment they appear.
function labelFromTip(el) {
  if (!el.getAttribute) return;
  const tip = el.getAttribute('data-tip');
  if (tip && !el.getAttribute('aria-label')) el.setAttribute('aria-label', tip);
}

function watchTipsForLabels() {
  for (const el of document.querySelectorAll('[data-tip]')) labelFromTip(el);
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'attributes') labelFromTip(mutation.target);
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== 1) continue;
        labelFromTip(node);
        for (const el of node.querySelectorAll ? node.querySelectorAll('[data-tip]') : []) {
          labelFromTip(el);
        }
      }
    }
  });
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['data-tip'],
  });
}

async function init() {
  watchTipsForLabels();
  // Renaming the sections is off (0420): any custom names a previous build
  // stored are cleared here, so every launch wears the defaults.
  try {
    const stored = (await window.api.readSettings()).sectionNames;
    if (stored && Object.keys(stored).length) await window.api.writeSettings({ sectionNames: {} });
  } catch (err) {
    // Settings unreadable — the tabs still paint their defaults.
  }
  paintStaticIcons();
  checkMainFreshness();
  await refreshSessionCli();
  initTheme();
  initResize();
  initSortable();
  startupMark('chrome-ready');
  await loadProjects();
  startupMark('projects-loaded');
  await loadBoard();
  startupMark('board-data-ready');
  await window.api.watchBoards();
  await restoreStandalones();
  // Every launch opens on the dashboard — the front door, not wherever the
  // last session happened to stand. The remembered views (0377) still do
  // their work on project switches: pick a project and you land where you
  // last stood in it.
  showDashboard();
  startupMark('view-restored');
  // First paint after the restored view: the moment the app looks ready.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      startupMark('first-paint');
      console.log(`[startup] ${startupSummary()}`);
      if (window.api.recordStartupMarks) {
        window.api.recordStartupMarks(startupMarks.map(([n, at]) => `${n}:${at}ms`));
      }
    })
  );

  // A reload that interrupted card-writing reopens the room, text intact.
  const draft = readDraft();
  if (draft.title || draft.text) openCardAdd(true);

  window.api.onBoardChanged(() => {
    if (isBoardVisible() || isShelfVisible('backlog') || isShelfVisible('archive')) {
      loadBoard();
      return;
    }

    // Docs regenerate under the watcher too — research and generators write
    // files while you look at the tree. Never redraw over a live edit, and
    // never churn the view under an open new-card modal (0269): the card
    // being written is itself a board change, and the rebuild was how
    // mid-sentence keystrokes ended up in the doc editor.
    if (isDocsVisible()) {
      if (kbSaveTimer || Date.now() - lastSelfWrite < 2000) return;
      if (!$('card-add-modal').classList.contains('hidden')) return;
      loadKb();
      return;
    }

    const session = openSessions.get(activeSessionId);
    if (!session) return;

    // Never redraw the doc out from under a live edit — that would move the
    // caret and lose whatever is not yet saved. Our own writes echo back
    // through the watcher too, so ignore those as well.
    if (session.dirty || Date.now() - lastSelfWrite < 2000) return;
    loadDoc(session);
  });
}

init();
