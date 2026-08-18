// ── Knowledgebase ──
// The product's own library: folders and markdown docs under 00-knowledge/,
// edited in place with the same autosave receipt as everything else. The
// terminal can dock beside it, and .current-doc always names what is open so
// an agent asked about "this doc" knows which file that is.
let kbTree = [];
let kbActive = null;
let kbSaveTimer = null;

// Which vault the view is showing (0385): Planning reads the knowledgebase,
// Insights reads insights/. One DOM and one module serve both — the tabs are
// never up together, so the root is a mode, not a second instance. Each
// root's open doc waits here while the other has the floor.
let kbRoot = 'knowledge';
const kbActiveByRoot = { knowledge: null, insights: null };

// Each project keeps its own open docs (0401): the roots' open-doc state
// was app-global, so switching projects carried one project's Pitch into
// another's sidebar and forgot it on the way back. selectProject stashes
// and restores this per project; the remembered-view store still decides
// which view greets you.
const kbStateByProject = {};

function stashKbState(projectName) {
  if (!projectName) return;
  kbStateByProject[projectName] = { ...kbActiveByRoot, [kbRoot]: kbActive };
}

function restoreKbState(projectName) {
  const saved = kbStateByProject[projectName] || { knowledge: null, insights: null };
  kbActiveByRoot.knowledge = saved.knowledge || null;
  kbActiveByRoot.insights = saved.insights || null;
  kbActive = kbActiveByRoot[kbRoot] || null;
  kbTree = [];
}

function setKbRoot(root) {
  if (kbRoot === root) return;
  // Focus is a moment in the room being left; drop it flat, without the
  // usual exit's terminal side effects — the pane re-docks per root anyway.
  kbFocus = false;
  $('docs-view').classList.remove('focus-mode');
  const focusButton = $('kb-focus');
  if (focusButton) focusButton.classList.remove('open');

  kbActiveByRoot[kbRoot] = kbActive;
  kbRoot = root;
  kbActive = kbActiveByRoot[root] || null;
  kbTree = [];
}

// ── The link pane (0408) ──
// A link doc opens as the site itself, inside a main-owned sandboxed view
// laid over the doc pane. The renderer's whole job is geometry and
// lifecycle: say where the pane is, and take it down the moment anything
// else wants the room.
let linkPaneUp = false;
let linkPaneObserver = null;

function linkPaneBounds() {
  const content = $('kb-doc-content');
  if (!content) return { x: 0, y: 0, width: 0, height: 0 };
  const rect = content.getBoundingClientRect();
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

function openLinkPane(url) {
  linkPaneUp = true;
  window.api.linkOpen(url, linkPaneBounds());
  if (!linkPaneObserver) {
    linkPaneObserver = new ResizeObserver(() => {
      if (linkPaneUp) window.api.linkBounds(linkPaneBounds());
    });
  }
  const content = $('kb-doc-content');
  if (content) linkPaneObserver.observe(content);
}

function closeLinkPane() {
  if (!linkPaneUp) return;
  linkPaneUp = false;
  if (linkPaneObserver) linkPaneObserver.disconnect();
  window.api.linkClose();
}

// rememberView and the tab strip speak the tab's name, not the module's.
function kbViewName() {
  return kbRoot === 'insights' ? 'insights' : 'docs';
}

function kbCollapsedKey() {
  return kbRoot === 'insights' ? 'kb-collapsed-insights' : 'kb-collapsed';
}

function kbCollapsed() {
  try {
    return JSON.parse(localStorage.getItem(kbCollapsedKey()) || '{}');
  } catch (err) {
    return {};
  }
}

// ── Docs quick switcher ──
// Cmd/Ctrl+O anywhere in the Docs view opens a fuzzy finder over every note —
// the fastest way around a vault, straight from Obsidian.
let kbSwitcherDocs = [];
let kbSwitcherIndex = 0;

async function openKbSwitcher() {
  if (!activeProject) return;
  kbSwitcherDocs = (await window.api.kbAllDocs(activeProject.name, kbRoot).catch(() => [])) || [];
  if (typeof closeLinkPane === 'function') closeLinkPane();
  $('kb-switcher').classList.remove('hidden');
  const input = $('kb-switcher-input');
  input.value = '';
  renderKbSwitcher('');
  input.focus();
}

function closeKbSwitcher() {
  $('kb-switcher').classList.add('hidden');
}

// A forgiving subsequence match: the query's letters in order, anywhere in the
// "folder / name" label. Ranked by how tight the match is.
function fuzzyScore(query, text) {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 1;
  let qi = 0;
  let first = -1;
  let last = -1;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      if (first === -1) first = ti;
      last = ti;
      qi++;
    }
  }
  if (qi < q.length) return 0;
  // Tighter spans and earlier starts score higher.
  return 1000 - (last - first) - first;
}

function renderKbSwitcher(query) {
  const results = $('kb-switcher-results');
  const scored = kbSwitcherDocs
    .map((doc) => ({
      doc,
      // The switcher speaks the sidebar's language (0301): titles, not slugs.
      label: doc.folder
        ? `${prettyDocName(doc.folder)} / ${prettyDocName(doc.name)}`
        : prettyDocName(doc.name),
    }))
    .map((row) => ({ ...row, score: fuzzyScore(query, row.label) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);
  kbSwitcherIndex = 0;
  results.innerHTML = '';
  for (let i = 0; i < scored.length; i++) {
    const row = document.createElement('button');
    row.className = 'kb-switcher-row' + (i === 0 ? ' selected' : '');
    row.textContent = scored[i].label;
    row.addEventListener('click', () => {
      closeKbSwitcher();
      openKbDoc({ name: scored[i].doc.name, path: scored[i].doc.path });
    });
    results.appendChild(row);
  }
  results.dataset.count = String(scored.length);

  // Content hits follow the name hits (0182): docs whose text holds the
  // words, each with a snippet, skipping anything the names already found.
  appendKbContentMatches(query, results, new Set(scored.map((r) => r.doc.path)));
}

async function appendKbContentMatches(query, results, seen) {
  const q = String(query || '').trim();
  if (q.length < 2) return;
  const hits = (await window.api.kbSearch(activeProject.name, q, kbRoot).catch(() => [])) || [];
  // The input may have moved on while the vault was read; stale hits stay out.
  if ($('kb-switcher-input').value.trim() !== q) return;
  for (const hit of hits.slice(0, 8)) {
    if (seen.has(hit.path)) continue;
    const row = document.createElement('button');
    row.className = 'kb-switcher-row content';
    if (!results.querySelector('.selected')) row.classList.add('selected');
    row.innerHTML = `<span>${escapeHtml(
      hit.folder ? `${prettyDocName(hit.folder)} / ${prettyDocName(hit.name)}` : prettyDocName(hit.name)
    )}</span>
      <span class="kb-switcher-snippet">${escapeHtml(hit.snippet)}</span>`;
    row.addEventListener('click', () => {
      closeKbSwitcher();
      openKbDoc({ name: hit.name, path: hit.path });
    });
    results.appendChild(row);
  }
}

on('kb-switcher-input', 'input', (e) => renderKbSwitcher(e.target.value.trim()));
on('kb-switcher', 'mousedown', (e) => {
  if (e.target.id === 'kb-switcher') closeKbSwitcher();
});
on('kb-switcher-input', 'keydown', (e) => {
  const rows = [...document.querySelectorAll('.kb-switcher-row')];
  if (e.key === 'Escape') {
    e.preventDefault();
    // The key means "close the switcher", not "and the doc under it" (0251).
    e.stopPropagation();
    closeKbSwitcher();
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    kbSwitcherIndex = Math.min(kbSwitcherIndex + 1, rows.length - 1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    kbSwitcherIndex = Math.max(kbSwitcherIndex - 1, 0);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (rows[kbSwitcherIndex]) rows[kbSwitcherIndex].click();
    return;
  } else {
    return;
  }
  rows.forEach((r, i) => r.classList.toggle('selected', i === kbSwitcherIndex));
  if (rows[kbSwitcherIndex]) rows[kbSwitcherIndex].scrollIntoView({ block: 'nearest' });
});

// Cmd/Ctrl+O opens the switcher whenever the Docs view is up.
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'o' && isDocsVisible()) {
    e.preventDefault();
    openKbSwitcher();
  }
});

async function loadKb() {
  if (!activeProject) return;
  // The analytics terminal toggle belongs to Insights alone (0447).
  const termButton = $('kb-term-button');
  if (termButton) termButton.classList.toggle('hidden', kbRoot !== 'insights');
  if (typeof paintKbTermButton === 'function') paintKbTermButton();
  kbTree = await window.api.kbList(activeProject.name, kbRoot);
  renderKbResearchFolders();

  // A doc that was open stays open (refreshed); otherwise Planning stands
  // on the quiet index (0293, superseding 0287's open-on-first-doc): the
  // background, the sidebar, and one New document button. The doc comes
  // when asked — by the button, the sidebar, or the switcher.
  const all = kbTree.flatMap((g) => g.files);
  const current = kbActive && all.find((f) => f.path === kbActive.path);
  if (current) await openKbDoc(current, { keepCaret: true });
  else showKbIndex();
}

// ── The index (0243) ──
// Planning opens on one page: the four key docs as cards, then every other
// doc in a modified-first list — Google Docs, not Obsidian. Clicking a key
// doc that doesn't exist yet creates it and drops you straight in.
// The sidebar (0279) no longer collapses on its own (0286): it is part of
// the room's anatomy, and only focus mode clears it — together with the
// terminal — so "collapsed" always means "the doc has the floor".

// ── Focus mode (0280) ──
// The doc alone: the sidebar folds and the terminal slides away on the
// same animations they use everywhere else. Session state, not persisted —
// focus is a moment, not a setting. Esc steps out of it first, before it
// would close the doc.
let kbFocus = false;

function setKbFocus(on) {
  if (kbFocus === on) return;
  kbFocus = on;
  // The room does the moving (0395): focus-mode collapses the terminal's
  // width in step with the sidebar's fold, one eased motion instead of the
  // old slide-out-then-layout-jump. The session never hides or reopens —
  // the pane is simply given no width until focus lifts, and the resize
  // observer refits the columns on the way back.
  $('docs-view').classList.toggle('focus-mode', on);
  const button = $('kb-focus');
  if (button) button.classList.toggle('open', on);
}

on('kb-focus', 'click', () => setKbFocus(!kbFocus));

function showKbIndex() {
  closeLinkPane();
  kbActive = null;
  // Leaving the doc leaves focus mode too — with kbActive already cleared,
  // this never reopens the terminal.
  setKbFocus(false);
  destroyKbEditor();
  $('docs-view').classList.add('index-mode');
  renderKbIndex();
  // The doc's tab leaves with the doc (0372).
  if (typeof renderTabs === 'function') renderTabs();
  // The doc and its terminal go together (0265): leaving the doc slides
  // the pane away too. The session survives in tmux; the next doc brings
  // it straight back.
  if (isDocsVisible() && isDocsKind(termKind())) hideGlobalTerminal();
  window.api.kbNoteCurrent(activeProject.name, '', kbRoot);
  rememberView(kbViewName());
}

function renderKbIndex() {
  const listBox = $('kb-home-list');
  if (!listBox) return;
  // The room is the background and one invitation (0293): the doc arrives
  // by morphing out of this button into the 50/50 doc-and-terminal pair.
  listBox.innerHTML = '';
  const fresh = document.createElement('button');
  fresh.className = 'kb-index-new';
  fresh.innerHTML = `${icon('plus', 16)}<span>New document</span>`;
  fresh.addEventListener('click', async () => {
    await createKbDoc('');
    morphPanelFrom($('kb-group'), null);
  });
  listBox.appendChild(fresh);
  renderKbTree();
}

// One floating context menu at a time: right-clicking a folder opens it at
// the cursor, any click elsewhere closes it (0164).
let kbFolderMenu = null;
function closeKbFolderMenu() {
  if (kbFolderMenu) {
    kbFolderMenu.remove();
    kbFolderMenu = null;
  }
}
document.addEventListener('click', closeKbFolderMenu);

// The folder menu (0202, tightened 0223): rename in place and archive
// through the shared confirmation. Reordering is the head's own drag now.
function openKbFolderMenu(e, folder, head) {
  closeKbFolderMenu();
  const menu = document.createElement('div');
  menu.className = 'menu kb-folder-menu';

  const add = (label, action) => {
    const item = document.createElement('button');
    item.className = 'menu-item';
    item.textContent = label;
    item.addEventListener('click', (ev) => {
      ev.stopPropagation();
      closeKbFolderMenu();
      action();
    });
    menu.appendChild(item);
  };

  add('Rename', () => {
    const label = head && head.querySelector('.kb-folder-name');
    if (!label) return;
    label.setAttribute('contenteditable', 'plaintext-only');
    label.focus();
    document.execCommand('selectAll');
    const commit = async () => {
      label.removeAttribute('contenteditable');
      const next = label.textContent.trim();
      // The label wears the pretty title (0299); the disk name stays a
      // lowercase slug, so an unchanged title is a no-op either way.
      if (!next || next === prettyDocName(folder)) {
        label.textContent = prettyDocName(folder);
        return;
      }
      try {
        await window.api.kbRenameFolder(activeProject.name, folder, next, kbRoot);
      } catch (err) {
        label.textContent = prettyDocName(folder);
        showToast('That folder name is already taken');
        return;
      }
      await loadKb();
    };
    label.addEventListener('blur', commit, { once: true });
    label.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        label.blur();
      }
      if (ev.key === 'Escape') {
        ev.preventDefault();
        label.textContent = prettyDocName(folder);
        label.blur();
      }
    });
  });

  // Move up/down retired (0223): folders reorder by dragging their heads.

  add('Archive', async () => {
    const ok = await confirmAction(
      `Archive the folder "${folder}" and everything in it? Nothing is destroyed.`,
      'Archive folder'
    );
    if (!ok) return;
    try {
      await window.api.kbRemoveFolder(activeProject.name, folder, kbRoot);
    } catch (err) {
      showToast('Could not archive the folder');
      return;
    }
    if (kbActive && kbActive.path.includes(`/${folder}/`)) kbActive = null;
    await loadKb();
    showToast('Folder archived');
  });

  document.body.appendChild(menu);
  menu.style.position = 'fixed';
  menu.style.left = `${Math.min(e.clientX, window.innerWidth - menu.offsetWidth - 8)}px`;
  menu.style.top = `${Math.min(e.clientY, window.innerHeight - menu.offsetHeight - 8)}px`;
  kbFolderMenu = menu;
}

// The doc menu (0397): the folder menu's verbs for a single file. Rename
// rides the row's own double-click flow; Archive is the header delete
// without needing the doc open first.
function openKbFileMenu(e, file, row) {
  closeKbFolderMenu();
  const menu = document.createElement('div');
  menu.className = 'menu kb-folder-menu';

  const add = (label, action) => {
    const item = document.createElement('button');
    item.className = 'menu-item';
    item.textContent = label;
    item.addEventListener('click', (ev) => {
      ev.stopPropagation();
      closeKbFolderMenu();
      action();
    });
    menu.appendChild(item);
  };

  add('Rename', () => {
    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  });

  add('Archive', async () => {
    const ok = await confirmAction(
      `Archive "${prettyDocName(file.name)}"? It moves to the archive — nothing is destroyed.`,
      'Archive'
    );
    if (!ok) return;
    try {
      await window.api.kbDelete(activeProject.name, file.path, kbRoot);
    } catch (err) {
      showToast('Could not archive the document');
      return;
    }
    if (kbActive && kbActive.path === file.path) kbActive = null;
    await loadKb();
    showToast('Document archived');
  });

  document.body.appendChild(menu);
  menu.style.position = 'fixed';
  menu.style.left = `${Math.min(e.clientX, window.innerWidth - menu.offsetWidth - 8)}px`;
  menu.style.top = `${Math.min(e.clientY, window.innerHeight - menu.offsetHeight - 8)}px`;
  kbFolderMenu = menu;
}

// Filenames stay slugs on disk; the sidebar shows them as titles — hyphens
// and underscores become spaces, every word capitalised (0161).
function prettyDocName(name) {
  return String(name)
    .replace(/[-_]+/g, ' ')
    .trim()
    .replace(/\S+/g, (word) => word.charAt(0).toUpperCase() + word.slice(1));
}

// The header's label since 0290: the filename as it is on disk — lowercase,
// extension and all. The sidebar went back to titles in 0301; only the doc
// header still speaks filesystem.
function docLabel(file) {
  return String(file.path).split('/').pop().toLowerCase();
}

// What the user typed in a rename, less any extension they kept: the format
// belongs to the file, the name is theirs to change.
function strippedName(text) {
  return String(text)
    .trim()
    .replace(/\.(md|html|png|jpe?g|gif|webp)$/i, '');
}

// The folder being dragged by its head (0223), or null. A flag rather than
// dataTransfer: drag data is sealed until drop, and the tree's dragover
// needs to know what kind of drag is passing right now.
let kbFolderDragSection = null;

function renderKbTree() {
  const tree = $('kb-tree');
  if (!tree) return;
  tree.innerHTML = '';
  const collapsed = kbCollapsed();

  // Folders reorder by drag (0223): the tree adopts the dragged section at
  // the pointer's height, the same container-level pattern as the file
  // lists (0174). Wired once — the element outlives its children.
  if (!tree.dataset.dndWired) {
    tree.dataset.dndWired = '1';
    tree.addEventListener('dragover', (e) => {
      if (!kbFolderDragSection) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const sections = [...tree.querySelectorAll('.kb-folder')].filter(
        (el) => el !== kbFolderDragSection && el.dataset.folder
      );
      const next = sections.find((el) => {
        const rect = el.getBoundingClientRect();
        return e.clientY < rect.top + rect.height / 2;
      });
      if (next) tree.insertBefore(kbFolderDragSection, next);
      else tree.appendChild(kbFolderDragSection);
    });
    tree.addEventListener('drop', (e) => {
      if (kbFolderDragSection) e.preventDefault();
    });
  }

  const count = $('kb-count');
  if (count) count.textContent = kbTree.reduce((n, g) => n + g.files.length, 0);

  for (const group of kbTree) {
    const section = document.createElement('div');
    section.className = 'kb-folder';
    section.dataset.folder = group.folder || '';
    if (group.folder && collapsed[group.folder]) section.classList.add('collapsed');

    if (group.folder) {
      const head = document.createElement('button');
      head.className = 'kb-folder-head';
      head.innerHTML = `
        <span class="kb-caret">${icon('chevronDown', 13)}</span>
        <span class="kb-folder-name">${escapeHtml(prettyDocName(group.folder))}</span>`;

      // Dragging the head reorders the folder among its siblings (0223).
      // A name mid-rename keeps its selection drag; commit and cancel are
      // read off dropEffect — Escape leaves the order untouched.
      let headDragged = false;
      head.draggable = true;
      // A fresh press clears the guard, so a swallowed-click flag from an
      // old drag can never eat a genuine later click.
      head.addEventListener('mousedown', () => {
        headDragged = false;
      });
      head.addEventListener('dragstart', (e) => {
        if (head.querySelector('.kb-folder-name[contenteditable]')) {
          e.preventDefault();
          return;
        }
        e.dataTransfer.setData('text/plain', group.folder);
        e.dataTransfer.effectAllowed = 'move';
        headDragged = true;
        kbFolderDragSection = section;
        requestAnimationFrame(() => section.classList.add('dragging-folder'));
      });
      head.addEventListener('dragend', async (e) => {
        section.classList.remove('dragging-folder');
        kbFolderDragSection = null;
        if (e.dataTransfer.dropEffect === 'none') {
          // A cancelled drag (Escape, or released outside) re-renders from
          // the unchanged tree rather than keeping the preview.
          renderKbTree();
          return;
        }
        const names = [...$('kb-tree').querySelectorAll('.kb-folder')]
          .map((el) => el.dataset.folder)
          .filter(Boolean);
        await window.api.kbFolderOrder(activeProject.name, names, kbRoot);
        await loadKb();
      });
      head.addEventListener('click', () => {
        // A name mid-rename owns the clicks; collapsing under the caret
        // would eat the edit (0202). A drag that just ended is not a click
        // asking to collapse.
        if (headDragged) {
          headDragged = false;
          return;
        }
        if (head.querySelector('.kb-folder-name[contenteditable]')) return;
        section.classList.toggle('collapsed');
        const state = kbCollapsed();
        state[group.folder] = section.classList.contains('collapsed');
        localStorage.setItem(kbCollapsedKey(), JSON.stringify(state));
      });
      head.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        openKbFolderMenu(e, group.folder, head);
      });
      // A folder holding images gets a door to the Space (0210): the same
      // glyph as the Space tab, floating its pictures as plaques.
      section.appendChild(head);
    }

    const list = document.createElement('div');
    list.className = 'kb-files';
    // The folder this list stands for, read back on drop to tell a reorder
    // from a move (0222).
    list.dataset.folder = group.folder || '';

    // Drag to reorder within the folder (0161, fixed 0174) or into another
    // one (0222). The listeners that accept the drag live on the container,
    // not the rows: Chromium refuses a drop wherever nothing called
    // preventDefault, and the gaps between rows were exactly such dead
    // zones — a drag released there snapped back and read as "doesn't
    // work". The dragged row is found document-wide, so any folder's list
    // adopts it as the pointer passes over — the row previewing its place
    // is the drop indicator.
    list.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const dragging = document.querySelector('.kb-file.dragging');
      if (!dragging) return;
      const rows = [...list.querySelectorAll('.kb-file:not(.dragging)')];
      const next = rows.find((row) => {
        const rect = row.getBoundingClientRect();
        return e.clientY < rect.top + rect.height / 2;
      });
      if (next) list.insertBefore(dragging, next);
      else list.appendChild(dragging);
    });
    list.addEventListener('drop', (e) => e.preventDefault());

    // A collapsed folder has no visible list to hover; its head accepts the
    // drag instead, adopting the row and lighting up while the pointer is
    // on it (0222).
    const head = section.querySelector('.kb-folder-head');
    if (head) {
      head.addEventListener('dragover', (e) => {
        const dragging = document.querySelector('.kb-file.dragging');
        if (!dragging) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (!list.contains(dragging)) list.appendChild(dragging);
        section.classList.add('drag-target');
      });
      head.addEventListener('dragleave', () => section.classList.remove('drag-target'));
      head.addEventListener('drop', (e) => {
        e.preventDefault();
        section.classList.remove('drag-target');
      });
    }

    for (const file of group.files) {
      const row = document.createElement('button');
      row.className = 'kb-file';
      row.classList.toggle('active', Boolean(kbActive && kbActive.path === file.path));
      // Titles, not filenames (0301, walking back 0290's lowercase slugs):
      // hyphens become spaces, words capitalise, extensions stay hidden.
      row.innerHTML = `<span class="kb-file-name">${escapeHtml(prettyDocName(file.name))}</span>`;
      // A truncated row still tells its whole name on hover (0313).
      row.title = prettyDocName(file.name);
      // A drag that just ended also fires a click on the same row; without
      // the guard every reorder opened the doc it had just moved.
      let dragged = false;
      row.addEventListener('click', () => {
        if (dragged) {
          dragged = false;
          return;
        }
        openKbDoc(file);
      });

      row.draggable = true;
      row.dataset.base = file.path.split('/').pop();
      row.addEventListener('dragstart', (e) => {
        // Chromium abandons a drag that carries no data; the basename is
        // the payload, and doubles as the drag's identity.
        e.dataTransfer.setData('text/plain', row.dataset.base);
        e.dataTransfer.effectAllowed = 'move';
        dragged = true;
        // The class waits a frame so the drag image is the full-strength
        // row, not the dimmed one.
        requestAnimationFrame(() => row.classList.add('dragging'));
      });
      row.addEventListener('dragend', async () => {
        row.classList.remove('dragging');
        for (const lit of document.querySelectorAll('.kb-folder.drag-target')) {
          lit.classList.remove('drag-target');
        }
        // Where the row landed decides what happened: its own list is a
        // reorder, another folder's list is a move (0222) — the file moves
        // on disk, then the target's on-screen order is written down.
        const landed = row.closest('.kb-files') || list;
        const targetFolder = landed.dataset.folder || '';
        if (targetFolder !== (group.folder || '')) {
          let moved;
          try {
            moved = await window.api.kbMove(activeProject.name, file.path, targetFolder, kbRoot);
          } catch (err) {
            showToast('Could not move the doc');
            await loadKb();
            return;
          }
          // A name clash gets a suffix on the way in, so the order list
          // records the basename the file actually wears now.
          const movedBase = moved.path.split('/').pop();
          const names = [...landed.querySelectorAll('.kb-file')].map((el) =>
            el === row ? movedBase : el.dataset.base
          );
          await window.api.kbReorder(activeProject.name, targetFolder, names, kbRoot);
          if (kbActive && kbActive.path === file.path) {
            kbActive = { ...kbActive, path: moved.path };
          }
          await loadKb();
          showToast(`Moved to ${targetFolder || 'the top level'}`);
          return;
        }
        const names = [...list.querySelectorAll('.kb-file')].map((el) => el.dataset.base);
        await window.api.kbReorder(activeProject.name, group.folder || '', names, kbRoot);
        await loadKb();
      });

      // Double-click renames in place; Enter commits, Escape gives up.
      // Dragging stands down while the name is editable, or selecting text
      // would start a drag instead.
      const label = row.querySelector('.kb-file-name');
      row.addEventListener('dblclick', () => {
        row.draggable = false;
        label.setAttribute('contenteditable', 'plaintext-only');
        label.focus();
        document.execCommand('selectAll');
      });
      // Right-click offers the same verbs a folder gets (0397).
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openKbFileMenu(e, file, row);
      });
      label.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          label.blur();
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          label.textContent = prettyDocName(file.name);
          label.blur();
        }
      });
      label.addEventListener('blur', async () => {
        row.draggable = true;
        label.removeAttribute('contenteditable');
        const next = strippedName(label.textContent);
        if (!next || next === prettyDocName(file.name)) {
          label.textContent = prettyDocName(file.name);
          return;
        }
        try {
          const renamed = await window.api.kbRename(activeProject.name, file.path, next, kbRoot);
          if (kbActive && kbActive.path === file.path) {
            kbActive = { ...kbActive, path: renamed.path };
          }
        } catch (err) {
          label.textContent = prettyDocName(file.name);
          showToast('That name is already taken here');
          return;
        }
        await loadKb();
      });

      list.appendChild(row);
    }
    section.appendChild(list);
    tree.appendChild(section);
  }

  // The 0286 "New doc" last row retired with 0303: the foot's plus makes
  // the doc now, one control instead of two stacked ones.
}

async function openKbDoc(file, { keepCaret = false } = {}) {
  // A doc opens over the index (0243); the header's back button returns.
  $('docs-view').classList.remove('index-mode');
  // Flush a pending edit of the previous doc before swapping.
  if (kbSaveTimer) {
    clearTimeout(kbSaveTimer);
    kbSaveTimer = null;
    await saveKbDoc();
  }

  // 0250, superseding 0185's slide-away: a doc in Planning lives beside the
  // terminal, temp-flow's 50/50. The pane stays through doc switches; only
  // the typed context follows the doc.

  // An image — the Inspo shelf's residents — renders as itself (0194):
  // no editor, no text read, just the picture on the pane.
  if (/\.(png|jpe?g|gif|webp)$/i.test(file.path)) {
    kbActive = { path: file.path, name: file.name };
    window.api.kbNoteCurrent(activeProject.name, file.path, kbRoot);
    rememberView(kbViewName(), file.path);
    $('kb-open-browser').classList.add('hidden');
    const imgFolder =
      (kbTree.find((g) => g.files.some((f) => f.path === file.path)) || {}).folder || '';
    $('kb-doc-title').innerHTML = imgFolder
      ? `<span class="kb-crumb">${escapeHtml(imgFolder)}</span><span class="kb-crumb-sep">/</span>${escapeHtml(
          docLabel(file)
        )}`
      : escapeHtml(docLabel(file));
    $('kb-tell-agent').classList.toggle('hidden', !currentHomeTerm());
    destroyKbEditor();
    const imgContent = $('kb-doc-content');
    imgContent.classList.remove('html-doc');
    // Encoded per segment, so spaces and stray # in a screenshot's name
    // survive the trip into a URL (0203).
    const src = `file://${file.path.split('/').map(encodeURIComponent).join('/')}`;
    imgContent.innerHTML = `<img class="kb-image" src="${escapeHtml(src)}" alt="">`;
    renderKbTree();
    // The open doc appears in the tab strip like a task (0372).
    if (typeof renderTabs === 'function') renderTabs();
    return;
  }

  const doc = await window.api.kbRead(activeProject.name, file.path, kbRoot);

  // A link opens as the site itself (0408, reworking 0398): a sandboxed
  // main-owned pane over the doc area — in the app, but nothing like the
  // old webview. Still no terminal for links, and the header's globe hands
  // the page to the real browser.
  if (doc.kind === 'bookmark') {
    if (!doc.url) return;
    kbActive = { path: doc.path, name: file.name, url: doc.url };
    window.api.kbNoteCurrent(activeProject.name, doc.path, kbRoot);
    rememberView(kbViewName(), doc.path);
    destroyKbEditor();
    const linkContent = $('kb-doc-content');
    linkContent.classList.remove('html-doc');
    linkContent.innerHTML = '';
    $('kb-doc-title').textContent = prettyDocName(file.name);
    $('kb-open-browser').classList.remove('hidden');
    renderKbTree();
    if (typeof renderTabs === 'function') renderTabs();
    openLinkPane(doc.url);
    return;
  }

  closeLinkPane();
  kbActive = { path: doc.path, name: file.name, url: doc.url };
  window.api.kbNoteCurrent(activeProject.name, doc.path, kbRoot);
  rememberView(kbViewName(), doc.path);
  $('kb-open-browser').classList.add('hidden');
  renderKbTree();
  // The open doc appears in the tab strip like a task (0372).
  if (typeof renderTabs === 'function') renderTabs();

  // The pairing (0250, quieted 0285): opening a doc brings the terminal up
  // beside it — except in Insights, whose room keeps the terminal away
  // unless you ask (0398). A watcher refresh (keepCaret) never re-opens
  // what the user may have put away.
  if (!keepCaret && isDocsVisible() && !kbFocus && kbRoot !== 'insights') {
    const kind = termKind();
    if (!homeTerms[kind] || !paneOpen[kind]) openGlobalTerminal();
  }

  // Breadcrumb, not a bare filename: the folder it lives in, then the doc.
  // The name itself renames in place (0190): click, type, Enter — the same
  // contract as the sidebar's double-click.
  const folder = (kbTree.find((g) => g.files.some((f) => f.path === file.path)) || {}).folder || '';
  const nameHtml = `<span id="kb-doc-name" title="Click to rename">${escapeHtml(
    docLabel(file)
  )}</span>`;
  $('kb-doc-title').innerHTML = folder
    ? `<span class="kb-crumb">${escapeHtml(folder)}</span><span class="kb-crumb-sep">/</span>${nameHtml}`
    : nameHtml;

  const nameEl = $('kb-doc-name');
  nameEl.addEventListener('click', () => {
    if (nameEl.isContentEditable) return;
    nameEl.setAttribute('contenteditable', 'plaintext-only');
    nameEl.focus();
    document.execCommand('selectAll');
  });
  nameEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      nameEl.blur();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      nameEl.textContent = docLabel(file);
      nameEl.blur();
    }
  });
  nameEl.addEventListener('blur', async () => {
    nameEl.removeAttribute('contenteditable');
    const next = strippedName(nameEl.textContent);
    if (!next || next === strippedName(docLabel(file))) {
      nameEl.textContent = docLabel(file);
      return;
    }
    try {
      const renamed = await window.api.kbRename(activeProject.name, file.path, next, kbRoot);
      kbActive = { path: renamed.path, name: next };
    } catch (err) {
      nameEl.textContent = docLabel(file);
      showToast('That name is already taken here');
      return;
    }
    await loadKb();
  });
  $('kb-tell-agent').classList.toggle('hidden', !currentHomeTerm());

  const content = $('kb-doc-content');


  // An HTML doc renders as itself, sandboxed in its own frame — richer
  // documents with inline charts, assets and scripts. Markdown keeps the
  // in-place editor. Both share the header, Delete and To agent.
  if (doc.kind === 'html' || doc.path.endsWith('.html')) {
    destroyKbEditor();
    const frame = document.createElement('iframe');
    frame.className = 'kb-html-frame';
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    frame.src = `file://${doc.path}`;
    // Links inside the frame route like links anywhere else (0180): the web
    // to the browser, a sibling doc to that doc — with the sidebar following
    // — instead of the frame quietly navigating itself.
    frame.addEventListener('load', () => {
      try {
        frame.contentDocument.addEventListener('click', routeDocLink);
      } catch (err) {
        // A frame Chromium walls off keeps its own link behavior.
      }
    });
    content.innerHTML = '';
    // The report owns its canvas: the pane's reading padding comes off so
    // the frame runs to the edges.
    content.classList.add('html-doc');
    content.appendChild(frame);
    // An HTML doc is a vault citizen like any other: its incoming edges
    // show beneath the frame (0181).
    renderBacklinks(content, file.name);
    renderKbTree();
    return;
  }
  content.classList.remove('html-doc');

  // The editor is Toast UI now (0212, v3 since 0221): a real markdown
  // engine — the contenteditable-plus-turndown pair it replaces lost bold
  // on the round trip, glued list items to the paragraph above, and had no
  // ordered lists or checklists at all. WYSIWYG only — the mode switch is
  // hidden (0221) — and getMarkdown() is the save path, so what lands on
  // disk is the document, not a re-derivation.
  destroyKbEditor();
  content.innerHTML = '';
  const editorHost = document.createElement('div');
  editorHost.id = 'kb-editor-host';
  content.appendChild(editorHost);

  const docDir = doc.path.slice(0, doc.path.lastIndexOf('/'));
  kbEditorInstance = new toastui.Editor({
    el: editorHost,
    initialValue: doc.body || '',
    initialEditType: 'wysiwyg',
    height: 'auto',
    usageStatistics: false,
    // WYSIWYG is the one mode (0267): the switch never renders, instead of
    // being CSS-hidden and finding ways back onto the screen.
    hideModeSwitch: true,
    // Never grab focus on construction (0269): the watcher rebuilds this
    // editor under whatever the user is doing — mid-sentence in the
    // new-card modal, say — and Toast's default autofocus was where the
    // typed text went. Deliberate opens still focus explicitly below.
    autofocus: false,
    // The minimal set (0221): what prose in a knowledgebase actually uses.
    // Strike, tables, images-by-button and code blocks earn their keep from
    // markdown itself when needed.
    toolbarItems: [
      ['heading', 'bold', 'italic'],
      ['ul', 'ol', 'task'],
      ['link', 'code'],
    ],
    // Relative images resolve against the doc's own folder, not the app
    // shell's (0181, carried over).
    customHTMLRenderer: {
      image(node, context) {
        const result = context.origin();
        const src = String(node.destination || '');
        if (src && !/^(https?:|file:|data:|\/)/i.test(src)) {
          result.attributes.src = `file://${docDir}/${src}`;
        }
        return result;
      },
    },
    events: {
      change: () => {
        showKbSaveStatus('saving');
        if (kbSaveTimer) clearTimeout(kbSaveTimer);
        kbSaveTimer = setTimeout(() => {
          kbSaveTimer = null;
          saveKbDoc();
        }, 800);
      },
    },
  });

  // Prose gets the native macOS spell checker (0211).
  for (const surface of editorHost.querySelectorAll('[contenteditable]')) {
    surface.setAttribute('spellcheck', 'true');
  }

  // List shortcuts (0402): the toolbar's three list buttons, from the
  // keyboard — Cmd+Shift+7 ordered, Cmd+Shift+8 bullets, Cmd+Shift+9
  // checklist — the same chords most editors teach.
  editorHost.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || !kbEditorInstance) return;
    const command = { 7: 'orderedList', 8: 'bulletList', 9: 'taskList' }[e.code.replace('Digit', '')];
    if (!command) return;
    e.preventDefault();
    kbEditorInstance.exec(command);
  });

  // Toast paints its toolbar from a PNG sprite; the app's own hugeicons
  // replace it (0221), so the buttons read like every other icon here. The
  // commands stay Toast's — only the glyph changes.
  const glyphs = {
    heading: 'heading',
    bold: 'bold',
    italic: 'italic',
    'bullet-list': 'listBullet',
    'ordered-list': 'listNumber',
    'task-list': 'checkList',
    link: 'link',
    code: 'sourceCode',
  };
  for (const [cls, name] of Object.entries(glyphs)) {
    for (const btn of editorHost.querySelectorAll(`.toastui-editor-toolbar-icons.${cls}`)) {
      btn.style.backgroundImage = 'none';
      btn.innerHTML = icon(name, 16);
    }
  }

  // Links route as everywhere else (0180): the web to the browser, a doc to
  // that doc. And a [[wiki link]] still jumps — or creates (0181).
  editorHost.addEventListener('click', routeDocLink);
  editorHost.addEventListener('click', async (e) => {
    const name = wikiLinkAt(e);
    if (!name) return;
    e.preventDefault();
    const target = kbTree
      .flatMap((g) => g.files)
      .find((f) => f.name.toLowerCase() === name.toLowerCase());
    if (target) {
      openKbDoc(target);
      return;
    }
    const folder = (kbTree.find((g) => g.files.some((f) => f.path === file.path)) || {}).folder || '';
    const created = await window.api.kbCreate(activeProject.name, folder, name, kbRoot);
    kbActive = { path: created.path, name };
    await loadKb();
    showToast('Doc created');
  });

  renderBacklinks(content, file.name);

  if (!keepCaret) kbEditorInstance.focus();
  renderKbTree();
}

// One live editor at a time; whatever replaces it tears it down first.
let kbEditorInstance = null;
function destroyKbEditor() {
  if (!kbEditorInstance) return;
  try {
    kbEditorInstance.destroy();
  } catch (err) {
    // A half-built editor still clears.
  }
  kbEditorInstance = null;
}

// Resolves a link target from an open doc to another doc in the vault: an
// absolute path, or a relative one walked from the linking doc's folder
// (0180). Anything that doesn't land on a known doc returns null.
function kbDocByHref(href, fromPath) {
  let target = decodeURIComponent(String(href).split('#')[0].split('?')[0]);
  if (!target) return null;
  if (target.startsWith('file://')) target = target.slice('file://'.length);
  const files = kbTree.flatMap((g) => g.files);
  if (target.startsWith('/')) return files.find((f) => f.path === target) || null;
  const stack = fromPath.split('/').slice(0, -1);
  for (const part of target.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  const resolved = stack.join('/');
  return files.find((f) => f.path === resolved) || null;
}

// One routing rule for every link in a doc: the web goes to the real
// browser, a doc goes to that doc, anything else stays put (0180).
function routeDocLink(e) {
  const link = e.target.closest && e.target.closest('a[href]');
  if (!link) return;
  const href = link.getAttribute('href') || '';
  if (!href || href.startsWith('#')) return;
  e.preventDefault();
  if (/^https?:\/\//i.test(href)) {
    window.api.openExternal(href);
    return;
  }
  const doc = kbActive && kbDocByHref(href, kbActive.path);
  if (doc) openKbDoc(doc);
}

// The [[Name]] under a click, or null. Reads the clicked text node and finds a
// bracketed span covering the click offset — no markup required, so it works on
// the raw editable text.
function wikiLinkAt(event) {
  const node = event.target;
  const text = node && node.nodeType === 1 ? node.textContent : '';
  if (!text || !text.includes('[[')) return null;
  const caret = document.caretPositionFromPoint
    ? document.caretPositionFromPoint(event.clientX, event.clientY)
    : null;
  const offset = caret ? caret.offset : text.indexOf('[[') + 2;
  const re = /\[\[([^\]]+)\]\]/g;
  let m;
  while ((m = re.exec(text))) {
    if (offset >= m.index && offset <= m.index + m[0].length) return m[1].trim();
  }
  return null;
}

// The docs that link here, listed below the editor as a read-only strip — the
// vault's incoming edges, so a note is never a dead end.
async function renderBacklinks(content, docName) {
  const links =
    (await window.api.kbBacklinks(activeProject.name, docName, kbRoot).catch(() => [])) || [];
  const existing = content.querySelector('.kb-backlinks');
  if (existing) existing.remove();
  if (!links.length) return;
  const strip = document.createElement('div');
  strip.className = 'kb-backlinks';
  strip.innerHTML = `<div class="kb-backlinks-head">Linked from</div>`;
  for (const link of links) {
    const a = document.createElement('button');
    a.className = 'kb-backlink';
    a.textContent = link.folder
      ? `${prettyDocName(link.folder)} / ${prettyDocName(link.name)}`
      : prettyDocName(link.name);
    a.addEventListener('click', () => openKbDoc({ name: link.name, path: link.path }));
    strip.appendChild(a);
  }
  content.appendChild(strip);
}

async function saveKbDoc() {
  if (!kbActive || !kbEditorInstance) return;
  // The editor's own markdown, verbatim — no DOM-to-markdown re-derivation
  // to lose formatting in (0212).
  const markdown = kbEditorInstance.getMarkdown().trim();
  lastSelfWrite = Date.now();
  await window.api.kbWrite(activeProject.name, kbActive.path, `${markdown}\n`, kbRoot);
  lastSelfWrite = Date.now();
  showKbSaveStatus('saved');
}

let kbStatusTimer = null;
function showKbSaveStatus(state) {
  const el = $('kb-save-status');
  if (!el) return;
  if (kbStatusTimer) clearTimeout(kbStatusTimer);
  el.textContent = state === 'saving' ? 'Saving…' : 'Saved';
  el.classList.add('visible');
  if (state === 'saved') {
    kbStatusTimer = setTimeout(() => el.classList.remove('visible'), 1500);
  }
}

async function createKbDoc(folder) {
  const created = await window.api.kbCreate(activeProject.name, folder, 'untitled', kbRoot);
  kbTree = await window.api.kbList(activeProject.name, kbRoot);
  renderKbResearchFolders();
  // A user-made doc opens as a user open, not a background refresh — so the
  // 50/50 pairing (0250) brings the terminal up beside it, ready to riff.
  await openKbDoc({ path: created.path, name: 'untitled' });
}

// The plus opens one small left-click menu (0394, retiring 0303's
// insta-doc and the right-click layer): Document or Folder, plus Link in
// Insights (0398). Research and bookmarks left the menu with them.
on('kb-add-button', 'click', (e) => {
  e.stopPropagation();
  // Link joined Planning too (0400): both vaults make the same three
  // things, and a link always opens in the real browser, terminal-free.
  $('kb-add-menu').classList.toggle('hidden');
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.kb-add-switcher')) $('kb-add-menu').classList.add('hidden');
});

on('kb-add-folder', 'click', () => {
  $('kb-add-menu').classList.add('hidden');
  startNewKbFolder();
});

on('kb-add-doc', 'click', () => {
  $('kb-add-menu').classList.add('hidden');
  // Into the open doc's folder when there is one, otherwise the first shelf.
  const folder = kbActive
    ? (kbTree.find((g) => g.files.some((f) => f.path === kbActive.path)) || {}).folder || ''
    : (kbTree[0] || {}).folder || '';
  createKbDoc(folder);
});

// A new folder is named before it exists (0224): the row appears at the
// bottom of the tree with an empty name and the caret already in it — the
// way Finder does it, minus the placeholder text. Nothing touches the disk
// until a name is committed; Escape, or clicking away with nothing typed,
// leaves no trace.
function startNewKbFolder() {
  const tree = $('kb-tree');
  if (!tree) return;
  const existing = tree.querySelector('.kb-folder-new .kb-folder-name');
  if (existing) {
    existing.focus();
    return;
  }

  const section = document.createElement('div');
  section.className = 'kb-folder kb-folder-new';
  const head = document.createElement('div');
  head.className = 'kb-folder-head';
  head.innerHTML = `
    <span class="kb-caret">${icon('chevronDown', 13)}</span>
    <span class="kb-folder-name" contenteditable="plaintext-only"></span>`;
  section.appendChild(head);
  tree.appendChild(section);

  const label = head.querySelector('.kb-folder-name');
  section.scrollIntoView({ block: 'nearest' });
  label.focus();

  label.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      label.blur();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      label.textContent = '';
      label.blur();
    }
  });
  label.addEventListener(
    'blur',
    async () => {
      const name = label.textContent.trim();
      section.remove();
      if (!name) return;
      try {
        await window.api.kbCreateFolder(activeProject.name, name, kbRoot);
      } catch (err) {
        showToast('Could not create the folder');
        return;
      }
      await loadKb();
    },
    { once: true }
  );
}

// Archiving a doc asks once through the shared confirmation (0187); the doc
// goes to the knowledgebase's own .archive, never destroyed (0161).
on('kb-delete-doc', 'click', async () => {
  if (!kbActive) return;
  const ok = await confirmAction(
    `Archive "${prettyDocName(kbActive.name)}"? It moves to the archive — nothing is destroyed.`,
    'Archive'
  );
  if (!ok) return;
  await window.api.kbDelete(activeProject.name, kbActive.path, kbRoot);
  kbActive = null;
  await loadKb();
  showToast('Archived');
});

// The doc is a real file on disk; this shows it in the Finder for editing
// elsewhere, backing up, or dropping into another tool (0161). A main
// process that predates the handler says so instead of failing silently
// (0187).
on('kb-reveal-doc', 'click', async () => {
  if (!kbActive) return;
  if (!window.api.kbReveal) {
    showToast('Restart Flow to update (Cmd+Q, reopen)');
    return;
  }
  try {
    await window.api.kbReveal(activeProject.name, kbActive.path, kbRoot);
  } catch (err) {
    if (!staleMain(err)) showToast('Could not show the file');
  }
});

// Types the open doc's path into the terminal, so "reword that subheading"
// lands on the right file. Typed, never sent: Enter stays yours.
on('kb-tell-agent', 'click', () => {
  const t = currentHomeTerm();
  if (!t || !kbActive) return;
  window.api.sendTerminalInput(t.id, `The doc I have open is ${kbActive.path} - `);
  t.term.focus();
});

// A bookmark's site in the pane is a preview; the globe hands the page to
// the real browser when it needs tabs, logins or devtools (0385).
on('kb-open-browser', 'click', () => {
  if (kbActive && kbActive.url) window.api.openExternal(kbActive.url);
});

// ── Research, bookmarks and generators ──
// One filler for every shelf picker: the vault's folders, with a preferred
// default when it exists.
function fillKbFolders(selectId, preferred) {
  const select = $(selectId);
  if (!select) return;
  select.innerHTML = '';
  for (const group of kbTree) {
    if (!group.folder) continue;
    const opt = document.createElement('option');
    opt.value = group.folder;
    opt.textContent = group.folder;
    select.appendChild(opt);
  }
  if (preferred && [...select.options].some((o) => o.value === preferred)) {
    select.value = preferred;
  }
}

function renderKbResearchFolders() {
  fillKbFolders('kb-research-folder', 'Competitors');
}

// Research lives behind the plus (0191), asking in a small room of its own:
// topic, destination shelf, Go. Esc and the backdrop both close it.
function openResearchModal() {
  renderKbResearchFolders();
  if (typeof closeLinkPane === 'function') closeLinkPane();
  $('kb-research-modal').classList.remove('hidden');
  morphPanelFrom($('kb-research-panel'), null);
  const topic = $('kb-research-topic');
  topic.focus();
  topic.select();
}

function closeResearchModal() {
  $('kb-research-modal').classList.add('hidden');
}

on('kb-add-research', 'click', () => {
  $('kb-add-menu').classList.add('hidden');
  openResearchModal();
});

// Bookmarks (0194): a link filed into the vault — plain, or read first by
// an agent that writes the summary doc.
function openBookmarkModal() {
  // Links live on a Links shelf in both vaults (0398, 0400); folders named
  // Bookmarks from the old flow stay as ordinary folders.
  const shelf = 'Links';
  fillKbFolders('kb-bookmark-folder', shelf);
  // The shelf may not exist yet; it is always offered and created on save.
  const select = $('kb-bookmark-folder');
  if (![...select.options].some((o) => o.value === shelf)) {
    const opt = document.createElement('option');
    opt.value = shelf;
    opt.textContent = shelf;
    select.prepend(opt);
  }
  select.value = shelf;
  // The agent pipeline writes into the knowledgebase only; in Insights a
  // bookmark always lands plain, so the option leaves the room.
  $('kb-bookmark-process-label').classList.toggle('hidden', kbRoot === 'insights');
  if (kbRoot === 'insights') $('kb-bookmark-process').checked = false;
  if (typeof closeLinkPane === 'function') closeLinkPane();
  $('kb-bookmark-modal').classList.remove('hidden');
  morphPanelFrom($('kb-bookmark-panel'), null);
  const url = $('kb-bookmark-url');
  url.focus();
  url.select();
}

function closeBookmarkModal() {
  $('kb-bookmark-modal').classList.add('hidden');
}

on('kb-add-bookmark', 'click', () => {
  $('kb-add-menu').classList.add('hidden');
  openBookmarkModal();
});

on('kb-bookmark-modal', 'mousedown', (e) => {
  if (e.target.id === 'kb-bookmark-modal') closeBookmarkModal();
});

for (const inputId of ['kb-bookmark-url', 'kb-bookmark-tags']) {
  on(inputId, 'keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      $('kb-bookmark-save').click();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeBookmarkModal();
    }
  });
}

on('kb-bookmark-save', 'click', async () => {
  const url = $('kb-bookmark-url').value.trim();
  if (!url) return;
  const tags = $('kb-bookmark-tags').value.trim();
  const folder = $('kb-bookmark-folder').value;
  const processIt = $('kb-bookmark-process').checked;
  const save = $('kb-bookmark-save');
  save.disabled = true;
  save.textContent = processIt ? 'Reading…' : 'Saving…';

  const result = await window.api.kbBookmark(
    activeProject.name,
    folder,
    url,
    tags,
    processIt,
    kbRoot
  );
  save.disabled = false;
  save.textContent = 'Save';

  if (!result.ok) {
    showToast(`Bookmark failed: ${result.error || 'unknown'}`);
    return;
  }
  $('kb-bookmark-url').value = '';
  $('kb-bookmark-tags').value = '';
  closeBookmarkModal();
  await loadKb();
  showToast('Bookmark saved');
});

on('kb-research-modal', 'mousedown', (e) => {
  if (e.target.id === 'kb-research-modal') closeResearchModal();
});

on('kb-research-topic', 'keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    $('kb-research-go').click();
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    closeResearchModal();
  }
});

on('kb-research-go', 'click', async () => {
  const topic = $('kb-research-topic').value.trim();
  if (!topic) return;
  const folder = $('kb-research-folder').value;
  const go = $('kb-research-go');
  go.disabled = true;
  const started = Date.now();
  const tick = setInterval(() => {
    go.textContent = `Researching… ${Math.round((Date.now() - started) / 1000)}s`;
  }, 1000);
  go.textContent = 'Researching…';

  const result = await window.api.kbResearch(activeProject.name, folder, topic);
  clearInterval(tick);
  go.disabled = false;
  go.textContent = 'Go';

  if (!result.ok) {
    showToast(`Research failed: ${result.error || 'unknown'}`);
    return;
  }
  $('kb-research-topic').value = '';
  closeResearchModal();
  await loadKb();
  showToast('Research saved');
});

// With the index back (0293), the X on a doc returns to it — background
// and the New document button — rather than leaving Planning altogether.
on('kb-doc-close', 'click', () => showKbIndex());

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!isDocsVisible()) return;
  if ($('docs-view').classList.contains('index-mode')) return;
  if (!$('kb-switcher').classList.contains('hidden')) return;
  if (!$('card-view').classList.contains('hidden')) return;
  if (!$('card-add-modal').classList.contains('hidden')) return;
  if (!$('settings-modal').classList.contains('hidden')) return;
  if (kbFolderMenu) return;
  // Esc steps out of focus mode first; a second Esc closes the doc back
  // to the index (0293).
  if (kbFocus) setKbFocus(false);
  else showKbIndex();
});

// Arrow keys walk the vault (0287): up and down move through the docs in
// sidebar order, stopping at the ends. Only when the keys are free — a
// caret in the editor, a field, or the terminal owns its own arrows.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  if (!isDocsVisible() || !kbActive) return;
  const target = e.target;
  if (
    target &&
    target.closest &&
    target.closest('input, textarea, select, [contenteditable], #board-term-pane')
  ) {
    return;
  }
  const all = kbTree.flatMap((g) => g.files);
  const at = all.findIndex((f) => f.path === kbActive.path);
  if (at === -1) return;
  const next = all[at + (e.key === 'ArrowDown' ? 1 : -1)];
  if (!next) return;
  e.preventDefault();
  openKbDoc(next);
});

// ── The doc pane ──
let lastSelfWrite = 0;

function metaRow(label, value) {
  return `<div class="info-row">
    <span class="info-label">${escapeHtml(label)}</span>
    <span class="info-value">${escapeHtml(value)}</span>
  </div>`;
}

/**
 * The card's identity, as three things you can act on in the header rather than
 * a block of metadata above the document: the pull request, the dev server, and
 * an (i) that holds the facts you only need when something looks wrong.
 */
// A chip and the actions that belong to it: the actions live in a small panel
// that appears under the chip on hover, so the header row stays quiet.
function chipWithPop(chipHtml, popHtml) {
  return `<div class="doc-chip-group">
    ${chipHtml}
    <div class="chip-pop"><div class="chip-pop-inner">${popHtml}</div></div>
  </div>`;
}

function renderDocLinks(card) {
  const parts = [];

  // The PR chip left the header for now (0391): the pull request still
  // exists and its facts stay behind the (i); the header stops advertising.

  // The dev-server chip and its controls left the section (0375): the
  // localhost story returns later as a plugin, and until then the card
  // carries no server furniture.
  parts.push(`
    <div class="doc-info">
      <button class="icon-button ghost small" id="doc-info-button" title="Card details">
        ${icon('info', 15)}
      </button>
      <div class="info-pop">
        ${metaRow('Card', card.id || '')}
        ${metaRow('Branch', card.branch || 'none yet')}
        ${metaRow('Worktree', card.worktree ? tildePath(card.worktree) : 'working on the checkout')}
        ${card.needs_input === 'true' ? metaRow('Status', 'needs input') : ''}
      </div>
    </div>
  `);

  return parts.join('');
}

// The dev-server chip, the server log strip and their states left with 0375;
// the localhost story returns later as a plugin.

// Before a card has any shape, offer to draft one rather than showing an empty
// document and expecting you to start from nothing.
function renderPlanPrompt(card) {
  return `
    <div class="plan-prompt" id="plan-prompt">
      <div class="plan-copy">
        <strong>This card has no plan yet.</strong>
        <span>The local <code>claude</code> CLI drafts the steps, the checks and what “done” means. Same login as a terminal — nothing to connect.</span>
      </div>
      <button class="text-button primary" id="plan-draft" title="Ask the local claude CLI to write the four sections">${icon('magic', 15)} Draft a plan</button>
    </div>
  `;
}

async function loadDoc(session) {
  if (!session.cardPath) {
    $('doc-links').innerHTML = '';
    $('doc-content').innerHTML =
      '<div class="empty-state"><p>No card attached to this session.</p></div>';
    return;
  }

  let card = await window.api.readCard(session.cardPath);

  // A card started before pr_url existed only knows its number. Fetch the url
  // once so the link panel is not a dead end.
  if (card.pr && !card.pr_url) {
    const url = await window.api.backfillPrUrl(activeProject.name, session.cardPath);
    if (url) card = { ...card, pr_url: url };
  }

  session.title = card.title;
  session.card = card;

  $('doc-links').innerHTML = renderDocLinks(card);

  wireTitleField(
    'doc-title',
    () => session.title,
    async (next) => {
      lastSelfWrite = Date.now();
      await window.api.patchCard(session.cardPath, { title: next });
      lastSelfWrite = Date.now();
      session.title = next;
      renderTabs();
    }
  );

  const body = unescapeMarkdown(card.body);
  const structured = /##\s+(Plan|Build|QA|Done when)/i.test(body);
  const html = renderMarkdown(body);

  $('doc-content').innerHTML = `
    ${structured ? '' : renderPlanPrompt(card)}
    <div class="markdown-body">${html}</div>
  `;

  buildSections($('doc-content').querySelector('.markdown-body'), session, card);

  wireQaGenerate(session, card);
  wirePlanDraft(session);
  wirePrPrepare(session, card);
  wireReview(session, card);

  // Links go to the real browser through the app-wide delegated handler; no
  // per-render wiring, so nothing here can double-open a url.

  const markdown = $('doc-content').querySelector('.markdown-body');
  markdown.addEventListener('input', () => {
    session.dirty = true;
    showSaveStatus('saving');
    refreshUpdateAgent(session);
    debouncedSave(session);
  });

  wireChecklist(session.cardPath, markdown);
  wireQaEdits(session.cardPath, markdown);
  refreshUpdateAgent(session);
}

/**
 * The QA checklist is grounded in the diff, so writing it is the agent's job:
 * this types the brief into the session, and Enter is yours.
 */
function wireQaGenerate(session, card) {
  const button = $('qa-generate');
  if (!button) return;
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    window.api.sendTerminalInput(
      session.id,
      `In ${card.path}, write or update the "## QA" section: a checklist of the ` +
        'checks that prove the current work is right, grounded in the actual ' +
        'diff (git diff main...HEAD). Keep any items that are already checked.'
    );
    session.term.focus();
  });
}

/**
 * Items in the QA queue are editable in place: click the text, change it, and
 * the line in the file changes with it. Matching is by the item's text at the
 * moment editing started, so the agent writing elsewhere in the file while you
 * type cannot land your edit on the wrong line.
 */
function wireQaEdits(cardPath, markdown) {
  const queue = markdown.querySelector('.qa-queue');
  if (!queue) return;

  for (const item of queue.querySelectorAll('li')) {
    const box = item.querySelector('input[type="checkbox"]');
    if (!box) continue;

    // wireChecklist has already wrapped the label; make that span the field.
    const label = item.querySelector('.check-label');
    if (!label) continue;
    label.classList.add('qa-text');
    label.setAttribute('contenteditable', 'plaintext-only');
    label.setAttribute('spellcheck', 'false');

    let original = '';
    label.addEventListener('focus', () => {
      original = label.textContent.trim();
    });

    label.addEventListener('keydown', (e) => {
      // Shift+Return wraps the text while editing; the item is still saved as
      // one checklist line, so the break collapses to a space on blur.
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        label.blur();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        label.textContent = original;
        label.blur();
      }
    });

    label.addEventListener('blur', async () => {
      const next = label.textContent.trim().replace(/\s+/g, ' ');
      if (!original || next === original) return;

      const card = await window.api.readCard(cardPath);
      const lines = unescapeMarkdown(card.body).split('\n');
      const index = lines.findIndex((line) => {
        const match = line.match(/^\s*[-*]\s+\[[ xX]\]\s+(.*)$/);
        return match && match[1].trim() === original;
      });
      if (index === -1) return;

      lines[index] = next
        ? lines[index].replace(original, next)
        : ''; // emptied out means removed
      lastSelfWrite = Date.now();
      await window.api.writeCardBody(
        cardPath,
        lines.filter((line, i) => !(i === index && !next)).join('\n')
      );
      lastSelfWrite = Date.now();
      showSaveStatus('saved');
    });
  }
}

/**
 * The document as sections you walk through, in a fixed reading order:
 * context, plan, codebase, QA, review, follow ups. Each is a light accordion;
 * collapse state is remembered across cards. Only the context is free text —
 * the rest belongs to checkboxes and the agent, same rules as before.
 */
const SECTION_KINDS = [
  { key: 'plan', title: 'Dev Plan', match: /^(plan|build|done when)$/i, keepHeading: true },
  { key: 'codebase', title: 'Codebase context', match: /^(codebase( context)?|files)$/i },
  { key: 'qa', title: 'QA checklist', match: /^qa( checklist)?$/i },
  { key: 'review', title: 'Code review', match: /^(code )?review$/i },
  { key: 'summary', title: 'Summary', match: /^(summary|recap)$/i },
  { key: 'followups', title: 'Follow ups', match: /^(follow ups?|qa queue|to do)$/i },
];

const SECTION_ORDER = ['context', 'plan', 'codebase', 'qa', 'review', 'summary', 'followups'];

function accCollapsed() {
  try {
    return JSON.parse(localStorage.getItem('acc-collapsed') || '{}');
  } catch (err) {
    return {};
  }
}

// The context editor is the same element whether it sits in an accordion or
// a tab: free text, always editable, Enter and Shift+Enter both just write.
function buildContextEditor(contextEls) {
  const context = document.createElement('div');
  context.className = 'doc-context';
  context.setAttribute('contenteditable', 'plaintext-only');
  context.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      document.execCommand('insertLineBreak');
    }
  });
  for (const el of contextEls) context.appendChild(el);
  return context;
}

function buildSections(markdown, session, card, { tabs = false } = {}) {
  if (!markdown) return;

  const children = [...markdown.children];
  const sections = [];
  let current = null;

  const contextEls = [];
  for (const el of children) {
    if (el.tagName === 'H2') {
      const kind = SECTION_KINDS.find((k) => k.match.test(el.textContent.trim()));
      const key = kind ? kind.key : `other-${el.textContent.trim().toLowerCase()}`;
      const existing = sections.find((s) => s.key === key);
      current = existing || { key, title: kind ? kind.title : el.textContent.trim(), els: [] };
      if (!existing) sections.push(current);
      // The accordion header names the section; the h2 only survives inside
      // grouped sections (Plan/Build/Done when) as a sub-heading, and even
      // there the one that just repeats the section name goes.
      const repeatsTitle = el.textContent.trim().toLowerCase() === current.title.toLowerCase();
      if (kind && kind.keepHeading && !repeatsTitle) current.els.push(el);
      else el.remove();
      continue;
    }
    (current ? current.els : contextEls).push(el);
  }

  // A review section that does not exist yet still needs its kick-off buttons,
  // sitting in its proper place above the follow ups.
  if (session && !sections.some((s) => s.key === 'review')) {
    const empty = document.createElement('p');
    empty.className = 'acc-empty';
    empty.textContent = 'No review yet.';
    sections.push({ key: 'review', title: 'Code review', els: [empty] });
  }

  // Follow ups always exist for a live session: the input that feeds them
  // lives in the section itself, so there has to be a section to hold it.
  if (session && !sections.some((s) => s.key === 'followups')) {
    sections.push({ key: 'followups', title: 'Follow ups', els: [] });
  }

  // Context first, follow-ups last, everything else in reading order.
  sections.sort(
    (a, b) =>
      (SECTION_ORDER.includes(a.key) ? SECTION_ORDER.indexOf(a.key) : 3.5) -
      (SECTION_ORDER.includes(b.key) ? SECTION_ORDER.indexOf(b.key) : 3.5)
  );

  // The modal walks the document as tabs, not accordions (0178): Context
  // first with the follow ups folded in, then one pane per section. The
  // context editor is the same element either way, so autosave and the
  // checklist wiring never notice the furniture changed.
  if (tabs) {
    markdown.innerHTML = '';

    const strip = document.createElement('div');
    strip.className = 'card-tabs';
    const panes = document.createElement('div');
    panes.className = 'card-tab-panes';
    markdown.appendChild(strip);
    markdown.appendChild(panes);

    // The card sub-nav wears the main nav's manners (0425, after 0310): one
    // highlight slides between the tabs on hover and rests on the active
    // one, instead of each tab painting its own.
    const bubble = document.createElement('div');
    bubble.className = 'card-tab-bubble';
    strip.appendChild(bubble);
    let bubbleVisible = false;
    const showBubble = (tab) => {
      bubble.classList.toggle('teleport', !bubbleVisible);
      bubble.style.width = `${tab.offsetWidth}px`;
      bubble.style.height = `${tab.offsetHeight}px`;
      bubble.style.transform = `translate(${tab.offsetLeft}px, ${tab.offsetTop}px)`;
      bubble.style.opacity = '1';
      bubbleVisible = true;
    };
    const settleBubble = () => {
      const active = strip.querySelector('.card-tab.active');
      if (active) showBubble(active);
      else {
        bubble.style.opacity = '0';
        bubbleVisible = false;
      }
    };
    strip.addEventListener('mouseleave', settleBubble);

    const followups = sections.find((s) => s.key === 'followups');
    const tabbed = sections.filter((s) => s.key !== 'followups');

    const contextPane = document.createElement('div');
    contextPane.appendChild(buildContextEditor(contextEls));
    // The checklist stands as its own section (0451): a heading names it,
    // and the margin gives it air from the editor above.
    const checklistHeading = document.createElement('h4');
    checklistHeading.className = 'doc-checklist-heading';
    checklistHeading.textContent = 'Checklist';
    contextPane.appendChild(checklistHeading);
    if (followups) for (const el of followups.els) contextPane.appendChild(el);

    // Rapid-fire checklist for the agent (0197): type, Enter, type, Enter —
    // each line lands as a checkbox under the card's To do heading, where
    // the agent already knows to tick things off. No dialogs.
    if (card) {
      const todoInput = document.createElement('textarea');
      todoInput.rows = 1;
      todoInput.id = 'modal-todo-add';
      todoInput.placeholder = 'Add a checklist item for the agent, press Enter';
      todoInput.spellcheck = true;
      todoInput.addEventListener('input', () => autoGrow(todoInput));
      todoInput.addEventListener('keydown', async (e) => {
        if (e.key === 'Escape') {
          todoInput.value = '';
          todoInput.style.height = '';
          todoInput.blur();
          return;
        }
        if (e.key !== 'Enter' || e.shiftKey) return;
        e.preventDefault();
        const text = todoInput.value.replace(/\s+/g, ' ').trim();
        if (!text) return;
        todoInput.value = '';
        await appendTodoAt(card.path, text);
        // Re-render from the fresh file and put the caret straight back, so
        // the next item can follow without a click. The re-render restores
        // the remembered tab, and the caret lives on this one.
        localStorage.setItem('card-tab', 'context');
        modalCard = await window.api.readCard(card.path);
        renderCardModalBody();
        // A new item is context the agent has not seen (0451).
        if (typeof noteModalEdit === 'function') noteModalEdit();
        const fresh = $('modal-todo-add');
        if (fresh) fresh.focus();
      });
      contextPane.appendChild(todoInput);
    }

    const entries = [{ key: 'context', title: 'Task', pane: contextPane }].concat(
      tabbed.map((s) => {
        const pane = document.createElement('div');
        for (const el of s.els) pane.appendChild(el);
        return { key: s.key, title: s.title, pane };
      })
    );

    // The last tab you were on carries from card to card; a card without
    // that section just opens on Context.
    const saved = localStorage.getItem('card-tab');
    const activeKey = entries.some((e) => e.key === saved) ? saved : 'context';

    for (const entry of entries) {
      const button = document.createElement('button');
      button.className = 'card-tab';
      button.dataset.key = entry.key;
      button.innerHTML = `<span>${escapeHtml(entry.title)}</span><span class="card-tab-meta" data-meta></span>`;
      entry.pane.classList.add('card-tab-pane');
      entry.pane.dataset.key = entry.key;
      const active = entry.key === activeKey;
      button.classList.toggle('active', active);
      entry.pane.classList.toggle('hidden', !active);
      button.addEventListener('mouseenter', () => showBubble(button));
      button.addEventListener('click', () => {
        localStorage.setItem('card-tab', entry.key);
        for (const b of strip.querySelectorAll('.card-tab')) {
          b.classList.toggle('active', b === button);
        }
        for (const p of panes.querySelectorAll('.card-tab-pane')) {
          p.classList.toggle('hidden', p !== entry.pane);
        }
        showBubble(button);
      });
      strip.appendChild(button);
      panes.appendChild(entry.pane);
    }

    // The bubble starts at rest on the remembered tab, appearing in place.
    requestAnimationFrame(settleBubble);

    updateSectionMeta(markdown);
    return;
  }

  const collapsed = accCollapsed();
  markdown.innerHTML = '';

  const makeAccordion = (key, title, bodyEls, options = {}) => {
    const acc = document.createElement('section');
    acc.className = 'acc';
    acc.dataset.key = key;
    if (collapsed[key]) acc.classList.add('collapsed');

    const head = document.createElement('button');
    head.className = 'acc-head';
    head.innerHTML = `
      <span class="acc-caret">${icon('chevronDown', 14)}</span>
      <span class="acc-title">${escapeHtml(title)}</span>
      <span class="acc-meta" data-meta></span>
      <span class="acc-actions">${options.actions || ''}</span>
    `;
    head.addEventListener('click', (e) => {
      if (e.target.closest('.acc-actions')) return;
      acc.classList.toggle('collapsed');
      const state = accCollapsed();
      state[key] = acc.classList.contains('collapsed');
      localStorage.setItem('acc-collapsed', JSON.stringify(state));
    });

    const body = document.createElement('div');
    body.className = `acc-body ${options.bodyClass || ''}`;
    for (const el of bodyEls) body.appendChild(el);

    acc.appendChild(head);
    acc.appendChild(body);
    markdown.appendChild(acc);
    return acc;
  };

  // 0. Task: the original ask, always editable. An empty context stays
  // genuinely empty: the CSS :empty placeholder names the field, and
  // min-height keeps it clickable without a stand-in <br>.
  makeAccordion('context', 'Task', [buildContextEditor(contextEls)]);

  for (const section of sections) {
    const options = {};

    if (section.key === 'qa' && session) {
      options.actions = `<button class="acc-button" id="qa-generate">
        ${icon('magic', 13)} ${section.els.length ? 'Update' : 'Generate'}</button>`;
    }

    if (section.key === 'review') {
      options.actions =
        card && reviewing.has(card.path)
          ? `<span class="acc-running">Reviewing<span class="dots"><i></i><i></i><i></i></span></span>`
          : session
            ? activeProject && activeProject.reviewer === 'codex'
              ? `<button class="acc-button" id="review-codex">Codex</button>
                 <button class="acc-button" id="review-claude">Claude</button>`
              : `<button class="acc-button" id="review-claude">Claude</button>
                 <button class="acc-button" id="review-codex">Codex</button>`
            : '';
    }

    if (section.key === 'followups') options.bodyClass = 'qa-queue';

    makeAccordion(section.key, section.title, section.els, options);
  }

  // The follow-up input types straight into the section it feeds.
  if (session) {
    const followBody = markdown.querySelector('.acc[data-key="followups"] .acc-body');
    if (followBody) {
      const input = document.createElement('textarea');
      input.rows = 1;
      input.id = 'todo-add';
      input.placeholder = 'Add a follow up, press Enter';
      input.spellcheck = false;
      input.addEventListener('input', () => autoGrow(input));
      input.addEventListener('keydown', async (e) => {
        if (e.key === 'Escape') {
          input.value = '';
          input.style.height = '';
          input.blur();
          return;
        }
        // Shift+Return keeps writing on a new line; plain Enter hands it over.
        if (e.key !== 'Enter' || e.shiftKey) return;
        e.preventDefault();
        const text = input.value.replace(/\s+/g, ' ').trim();
        if (!text) return;
        input.value = '';
        input.style.height = '';
        await appendTodo(session, text);
        // The doc just re-rendered; put the caret back where the user was.
        const fresh = $('todo-add');
        if (fresh) fresh.focus();
      });
      followBody.appendChild(input);
    }
  }

  updateSectionMeta(markdown);
}

// The header of a checklist section says where it stands without opening it
// — accordion heads and tab buttons alike.
function updateSectionMeta(markdown) {
  for (const acc of markdown.querySelectorAll('.acc')) {
    const boxes = acc.querySelectorAll('input[type="checkbox"]');
    if (!boxes.length) continue;
    const done = [...boxes].filter((b) => b.checked).length;
    const meta = acc.querySelector('[data-meta]');
    if (meta) {
      meta.textContent =
        done === boxes.length ? `${done} done` : `${done} done · ${boxes.length - done} left`;
    }
  }
  for (const pane of markdown.querySelectorAll('.card-tab-pane')) {
    const boxes = pane.querySelectorAll('input[type="checkbox"]');
    const meta = markdown.querySelector(`.card-tab[data-key="${pane.dataset.key}"] [data-meta]`);
    if (!meta) continue;
    if (!boxes.length) {
      meta.textContent = '';
      continue;
    }
    const done = [...boxes].filter((b) => b.checked).length;
    meta.textContent = `${done}/${boxes.length}`;
  }
}
