// ── Sessions and tabs ──
function openPlaceholderSession(card) {
  showView('session');
  $('doc-title').textContent = card.title;
  $('doc-links').innerHTML = '';
  $('doc-content').innerHTML = '<div class="empty-state"><p>Setting up…</p></div>';
  $('term-status').textContent = 'starting';
  $('update-agent').classList.add('hidden');
}

async function openSession(card) {
  // Match by file path, never id: two hand-written cards can share an id, and
  // the path is the only thing guaranteed unique on the board.
  const existing = [...openSessions.values()].find((s) => s.cardPath === card.path);
  if (existing) {
    activateSession(existing.id);
    return;
  }
  await startCard(card);
}

// One xterm setup for every pane in the app, so the global terminal and the
// card sessions are the same terminal.
function buildTerminal(sessionId, wrapper) {
  // Sized and styled to match the terminal Aaron actually works in: JetBrains
  // Mono at 16, a block cursor that does not blink.
  const term = new window.Terminal({
    fontFamily:
      "'JetBrainsMono Nerd Font Mono', 'JetBrains Mono', 'Geist Mono', 'SF Mono', monospace",
    fontSize: 15,
    lineHeight: 1.35,
    cursorBlink: false,
    cursorStyle: 'block',
    scrollback: 10000,
    theme: getTerminalTheme(),
  });

  const fitAddon = new window.FitAddon.FitAddon();
  term.loadAddon(fitAddon);

  // Urls printed by an agent are the whole point of some of its output, so
  // make them clickable — into the real browser, not this window.
  if (window.WebLinksAddon) {
    term.loadAddon(
      new window.WebLinksAddon.WebLinksAddon((event, uri) => {
        event.preventDefault();
        window.api.openExternal(uri);
      })
    );
  }

  // Cmd+Enter and Shift+Enter insert a literal newline instead of submitting.
  // The routing lives in lib/term-keys.js so the smoke test can pin it down:
  // it must refuse every event of an overridden combo (keydown, keypress,
  // keyup), or xterm's keypress path sends an extra \r that submits.
  term.attachCustomKeyEventHandler((event) => {
    const override = window.termKeys.enterKeyOverride(event);
    if (override) {
      if (override.data) window.api.sendTerminalInput(sessionId, override.data);
      return false;
    }

    // A terminal selection is not a DOM selection, so the Edit menu's Copy
    // finds nothing to copy — Cmd+C has to be answered here. Cmd+Shift+C/V
    // are the same muscle memory with Shift held; xterm would otherwise drop
    // every Cmd combination on the floor.
    if (event.type === 'keydown' && event.metaKey && !event.altKey && !event.ctrlKey) {
      const key = event.key.toLowerCase();
      if (key === 'c' && term.hasSelection()) {
        navigator.clipboard.writeText(term.getSelection());
        return false;
      }
      if (key === 'v' && event.shiftKey) {
        navigator.clipboard.readText().then((text) => {
          if (text) term.paste(text);
        });
        return false;
      }
    }
    return true;
  });

  // Codex turns on mouse reporting while staying in the normal buffer, so the
  // wheel gets sent to it as mouse events and it scrolls its own history
  // instead of the terminal's scrollback. When that combination is active,
  // scroll the viewport ourselves and keep the event away from the app.
  // Full-screen apps (alternate buffer, e.g. vim or less) keep mouse reporting.
  term.attachCustomWheelEventHandler((event) => {
    if (term.modes.mouseTrackingMode !== 'none' && term.buffer.active.type === 'normal') {
      const lines = Math.max(1, Math.round(Math.abs(event.deltaY) / 12));
      term.scrollLines(event.deltaY < 0 ? -lines : lines);
      return false;
    }
    return true;
  });

  term.open(wrapper);
  term.onData((data) => window.api.sendTerminalInput(sessionId, data));

  return { term, fitAddon };
}

async function attachSession(card, sessionId, notes = []) {
  let session = openSessions.get(sessionId);

  if (!session) {
    const wrapper = document.createElement('div');
    wrapper.className = 'term-instance hidden';
    $('term-stack').appendChild(wrapper);

    const { term, fitAddon } = buildTerminal(sessionId, wrapper);

    session = {
      id: sessionId,
      project: activeProject ? activeProject.name : '',
      cardId: card.id,
      cardPath: card.path,
      title: card.title,
      term,
      fitAddon,
      wrapper,
      dirty: false,
      notes,
    };
    openSessions.set(sessionId, session);
  }

  session.cardPath = card.path;
  activateSession(sessionId);
}

function activateSession(sessionId) {
  const session = openSessions.get(sessionId);
  if (!session) return;

  // Whatever we were watching, we are not watching it now.
  stopPolling();
  activeSessionId = sessionId;
  showView('session');

  for (const other of openSessions.values()) {
    other.wrapper.classList.toggle('hidden', other.id !== sessionId);
  }

  // A standalone terminal owns the whole session view: no document beside it.
  $('session-view').classList.toggle('full-term', Boolean(session.standalone));

  $('doc-title').textContent = session.title;
  $('term-label').textContent = session.browser
    ? 'Browser'
    : session.standalone || sessionId.endsWith('-shell')
      ? 'Terminal'
      : sessionId.includes('codex')
        ? 'Codex CLI'
        : 'Claude Code CLI';
  $('term-status').textContent = (session.notes || []).join(' · ');
  refreshUpdateAgent(session);
  renderTabs();
  loadDoc(session);
  // A session tab is a place you stood too (0377): remembered by id, so a
  // project switch or a restart can land back on this tab.
  rememberView('session', sessionId);

  requestAnimationFrame(() => {
    // A browser tab has no terminal to fit; the address bar takes the caret.
    if (session.browser) {
      const bar = session.wrapper.querySelector('.browser-url');
      if (bar) bar.focus();
      return;
    }
    fitSession(session);
    session.term.focus();
  });
}

function fitSession(session) {
  try {
    session.fitAddon.fit();
    window.api.sendTerminalResize(session.id, session.term.cols, session.term.rows);
  } catch (err) {
    // Pane is hidden or zero-sized.
  }
}

// The session tabs' saved order, one list of session ids per project (0207).
// Ids are stable across restarts (project-cardId for cards, the stored id
// for standalones), so the order survives with them.
function tabOrderKey() {
  return `tab-order-${activeProject ? activeProject.name : ''}`;
}

function savedTabOrder() {
  try {
    return JSON.parse(localStorage.getItem(tabOrderKey()) || '[]');
  } catch (err) {
    return [];
  }
}

// Dragging reorders within the strip: the container accepts the drag across
// its whole surface, the same pattern as the docs sidebar (0174, 0207).
{
  const strip = $('session-tabs');
  strip.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const dragging = strip.querySelector('.tab.dragging');
    if (!dragging) return;
    const rest = [...strip.querySelectorAll('.tab:not(.dragging)')];
    const next = rest.find((tab) => {
      const rect = tab.getBoundingClientRect();
      return e.clientX < rect.left + rect.width / 2;
    });
    if (next) strip.insertBefore(dragging, next);
    else strip.appendChild(dragging);
  });
  strip.addEventListener('drop', (e) => e.preventDefault());
}

function renderTabs() {
  const container = $('session-tabs');
  container.innerHTML = '';

  // A tab belongs to the project it was opened from. Sessions for the others
  // stay alive in the background — switching back brings their tabs with it.
  // The saved drag order beats arrival order; newcomers join at the end.
  const rank = new Map(savedTabOrder().map((id, i) => [id, i]));
  const sessions = [...openSessions.values()]
    .filter((s) => !(s.project && activeProject && s.project !== activeProject.name))
    .sort((a, b) => {
      const ra = rank.has(a.id) ? rank.get(a.id) : Infinity;
      const rb = rank.has(b.id) ? rank.get(b.id) : Infinity;
      return ra - rb;
    });

  // Only a visible session view lights its tab (0371): "not the board" also
  // covered Insights and Planning, so landing there left the last session's
  // tab lit as if it were in front.
  const sessionInFront = !$('session-view').classList.contains('hidden');

  // Open docs are tabs like tasks are (0372): visible from any view, lit
  // while their doc is in front, the X closing that doc back to its index.
  // Each vault can hold one open doc (0385), so there is at most one tab
  // per root, and a tab knows which room it belongs to (0392) — clicking
  // Pitch lights Pitch, whichever tab you came from.
  if (typeof kbActive !== 'undefined' && activeProject) {
    const openDocs = [];
    const current = { ...kbActiveByRoot, [kbRoot]: kbActive };
    for (const root of ['knowledge', 'insights']) {
      if (current[root]) openDocs.push({ root, doc: current[root] });
    }
    for (const { root, doc } of openDocs) {
      const tab = document.createElement('button');
      tab.className = 'tab doc-tab';
      const docInFront =
        isDocsVisible() && kbRoot === root && !$('docs-view').classList.contains('index-mode');
      tab.classList.toggle('active', docInFront);
      const label = document.createElement('span');
      const name = prettyDocName(doc.name || '');
      label.textContent = name.length > 26 ? `${name.slice(0, 26)}…` : name;
      tab.appendChild(label);
      const close = document.createElement('span');
      close.className = 'tab-close';
      close.innerHTML = icon('cancel', 13);
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        if (kbRoot === root) {
          showKbIndex();
        } else {
          // Closing the other room's doc just forgets it; no view change.
          kbActiveByRoot[root] = null;
        }
        renderTabs();
      });
      tab.appendChild(close);
      tab.addEventListener('click', () => {
        if (docInFront) return;
        if (root === 'insights') showInsights();
        else showDocs();
      });
      container.appendChild(tab);
    }
  }

  for (const session of sessions) {
    const tab = document.createElement('button');
    tab.className = 'tab';
    tab.classList.toggle('active', session.id === activeSessionId && sessionInFront);

    // Drag to reorder; the click a finished drag leaves behind is swallowed
    // so dropping a tab never also activates it.
    let dragged = false;
    tab.draggable = true;
    tab.dataset.sessionId = session.id;
    tab.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', session.id);
      e.dataTransfer.effectAllowed = 'move';
      dragged = true;
      requestAnimationFrame(() => tab.classList.add('dragging'));
    });
    tab.addEventListener('dragend', () => {
      tab.classList.remove('dragging');
      const ids = [...container.querySelectorAll('.tab')]
        .map((el) => el.dataset.sessionId)
        .filter(Boolean);
      localStorage.setItem(tabOrderKey(), JSON.stringify(ids));
    });
    tab.addEventListener(
      'click',
      (e) => {
        if (!dragged) return;
        dragged = false;
        e.stopImmediatePropagation();
      },
      true
    );

    // A card waiting on you announces itself on the tab, not only in the doc.
    if (session.card && String(session.card.needs_input) === 'true') {
      const dot = document.createElement('span');
      dot.className = 'tab-needs';
      dot.dataset.tip = 'Needs input';
      tab.appendChild(dot);
    }

    const label = document.createElement('span');
    label.textContent =
      session.title.length > 26 ? `${session.title.slice(0, 26)}…` : session.title;
    // No native title (0370): the browser bubble is off-language, and worse,
    // it advertised a rename the rebuild-on-click made unreachable.
    tab.appendChild(label);

    // Double-click renames in place. A card-backed tab renames the card too,
    // so the tab, the doc title and the file never disagree; a standalone
    // terminal only carries its label.
    tab.addEventListener('dblclick', () => {
      // Dragging stands down while the name is being edited; the re-render
      // on commit or escape restores it (0207).
      tab.draggable = false;
      const input = document.createElement('input');
      input.className = 'tab-rename';
      input.value = session.title;
      label.replaceWith(input);
      input.focus();
      input.select();

      let done = false;
      const commit = async () => {
        if (done) return;
        done = true;
        const next = input.value.trim();
        if (next && next !== session.title) {
          session.title = next;
          if (session.cardPath) {
            lastSelfWrite = Date.now();
            await window.api.patchCard(session.cardPath, { title: next });
            lastSelfWrite = Date.now();
          }
        }
        renderTabs();
        if (session.id === activeSessionId) $('doc-title').textContent = session.title;
      };
      input.addEventListener('blur', commit);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') {
          done = true;
          renderTabs();
        }
        e.stopPropagation();
      });
    });

    const close = document.createElement('span');
    close.className = 'tab-close';
    close.innerHTML = icon('cancel', 13);
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      closeSession(session.id);
    });
    tab.appendChild(close);

    // An already-active tab swallows the click instead of re-activating
    // (0370): activateSession re-renders the strip, which replaced the tab
    // between the two clicks of a double-click and killed the rename.
    tab.addEventListener('click', () => {
      if (session.id === activeSessionId && sessionInFront) return;
      activateSession(session.id);
    });
    container.appendChild(tab);
  }

  // The shelves are the board's own furniture, so the Board tab stays lit
  // while one of them is in front.
  $('tab-board').classList.toggle(
    'active',
    isBoardVisible() || isShelfVisible('backlog') || isShelfVisible('archive')
  );
  // The docs view serves two tabs (0385); the root decides which one is lit.
  const docsTab = $('tab-docs');
  if (docsTab) docsTab.classList.toggle('active', isDocsVisible() && kbRoot === 'knowledge');
  const insightsTab = $('tab-insights');
  if (insightsTab)
    insightsTab.classList.toggle('active', isDocsVisible() && kbRoot === 'insights');
  // The nav bubble rests behind whichever home tab is now current.
  if (window.settleNavBubble) window.settleNavBubble();
}

// Removes a tab from the window. Nothing on disk or in tmux is touched.
function closeSessionTab(sessionId) {
  const session = openSessions.get(sessionId);
  if (!session) return;

  if (session.term) session.term.dispose();
  session.wrapper.remove();
  openSessions.delete(sessionId);

  if (activeSessionId === sessionId) {
    const next = openSessions.values().next().value;
    if (next) activateSession(next.id);
    else showBoard();
  }
  renderTabs();
}

/**
 * Closing a card's tab gives back what costs something to hold — the dev
 * server and its port — and keeps what took work to make. The branch, the
 * worktree and the pull request all survive; the Claude session detaches into
 * tmux rather than dying, so reopening the card resumes the conversation.
 */
async function closeSession(sessionId) {
  const session = openSessions.get(sessionId);
  if (!session) return;

  // A server tab is only ever the server: stop it, nothing else to keep.
  if (sessionId.endsWith('-server')) {
    await window.api.stopServer(activeProject.name, session.cardPath);
    closeSessionTab(sessionId);
    return;
  }

  // A browser tab is only its page: nothing in tmux to end.
  if (session.browser) {
    closeSessionTab(sessionId);
    return;
  }

  // A standalone terminal has nothing behind it worth keeping: closing the
  // tab ends the tmux session too, and takes it off the restore list.
  if (session.standalone) {
    window.api.killTerminal(sessionId);
    writeStandalones(readStandalones().filter((entry) => entry.id !== sessionId));
    closeSessionTab(sessionId);
    return;
  }

  closeSessionTab(sessionId);
  closeSessionTab(`${sessionId}-server`);

  if (session.cardPath) {
    await window.api.closeCard(activeProject.name, session.cardPath);
  }
}

window.api.onTerminalEvent(({ id, kind, data }) => {
  const home = boardTermFor(id);
  if (home) {
    if (kind === 'data') home.term.write(data);
    if (kind === 'exit') home.term.writeln('\r\n[session ended]');
    return;
  }
  if (modalTerm && modalTerm.id === id) {
    if (kind === 'data') modalTerm.term.write(data);
    if (kind === 'exit') modalTerm.term.writeln('\r\n[session ended]');
    return;
  }
  const session = openSessions.get(id);
  if (!session) return;
  if (kind === 'data') session.term.write(data);
  if (kind === 'exit') session.term.writeln('\r\n[session ended]');
});

// The CLI a session launches — the default terminal command from settings.
// The main process owns that decision; the renderer only caches
// the name it resolved to, for labels and for the commands it types. Refreshed
// at boot and whenever the settings that decide it are saved.
let sessionCli = 'claude';

async function refreshSessionCli() {
  sessionCli = (await window.api.sessionCli().catch(() => null)) || 'claude';
  return sessionCli;
}

// ── Global terminals ──
// A scratch session beside each home view — its own tmux session, the session
// CLI already running. The board and Docs each keep their own:
// different sessions, different saved widths, so board work and doc work
// stop sharing one shell. Switching projects detaches both (tmux keeps them
// running); only the pane's close button ends a session outright.
const homeTerms = { board: null, docs: null, insights: null };
const paneOpen = { board: false, docs: false, insights: false };

// Which home view's terminal is in front. In a session view this answers for
// the board, which is where the pane will dock next. Planning and Insights
// share the docs view but not a shell (0385): each vault keeps its own.
function termKind() {
  return isDocsVisible() ? (kbRoot === 'insights' ? 'insights' : 'docs') : 'board';
}

// Planning and Insights share the docs room's layout and manners; only the
// board differs. "Is this a docs-shaped terminal" in one word.
function isDocsKind(kind) {
  return kind === 'docs' || kind === 'insights';
}

function currentHomeTerm() {
  return homeTerms[termKind()];
}

// Legacy alias for the few places that only care whether "the" terminal is
// up in front of the current view.
function boardTermFor(id) {
  return Object.values(homeTerms).find((t) => t && t.id === id) || null;
}
