// ── Projects ──
async function loadProjects() {
  projects = await window.api.listProjects();

  const remembered = localStorage.getItem('project');
  activeProject = projects.find((p) => p.name === remembered) || projects[0] || null;

  renderProjectSwitcher();
}

function renderProjectSwitcher() {
  if (!activeProject) return;

  const title = $('project-title');
  if (title && title.textContent !== activeProject.title) {
    title.textContent = activeProject.title;
  }
  const projectIcon = $('project-icon');
  if (projectIcon) {
    // An uploaded image wins; the emoji is the fallback; a project with
    // neither shows a faint dashed circle, which is also the upload target.
    if (activeProject.imageIcon) {
      projectIcon.innerHTML = `<img class="project-icon-img" src="${escapeHtml(
        activeProject.imageIcon
      )}" alt="">`;
    } else if (activeProject.icon) {
      projectIcon.textContent = activeProject.icon;
    } else {
      projectIcon.innerHTML = '<span class="project-icon-empty"></span>';
    }
    // The slot explains itself in the app's own tooltip (0470), and says
    // the right thing for its state: an empty circle invites the icon, a
    // filled one offers the swap and the way back.
    const slot = $('project-icon-slot');
    if (slot) {
      slot.dataset.tip = activeProject.imageIcon
        ? 'Click to replace the icon · right-click to remove it'
        : 'Add an app icon — a square (1:1) image';
    }
  }

  const menu = $('project-menu');
  menu.innerHTML = '';

  for (const project of projects) {
    const item = document.createElement('button');
    item.className = 'menu-item';
    item.classList.toggle('current', project.name === activeProject.name);
    const menuIcon = project.imageIcon
      ? `<img class="menu-icon-img" src="${escapeHtml(project.imageIcon)}" alt="">`
      : project.icon
        ? `${escapeHtml(project.icon)} `
        : '';
    item.innerHTML = `
      <span class="menu-text">
        <span class="menu-title">${menuIcon}${escapeHtml(project.title || project.name)}</span>
        <span class="menu-path">${escapeHtml(tildePath(project.path))}</span>
      </span>
    `;
    item.addEventListener('click', () => selectProject(project));
    menu.appendChild(item);
  }

  // The dashboard (0406): the front door, above the app-level actions.
  const dashItem = document.createElement('button');
  dashItem.className = 'menu-item add';
  // Its own glyph: the window-frame reads as the app's front screen — the
  // kanban icon belongs to the board tab, the card stack read too board-ish.
  dashItem.innerHTML = `<span class="menu-text"><span class="menu-title">${icon(
    'sidebar',
    15
  )} Dashboard…</span></span>`;
  dashItem.addEventListener('click', () => {
    closeProjectMenu();
    showDashboard();
  });
  menu.appendChild(dashItem);

  const globalItem = document.createElement('button');
  globalItem.className = 'menu-item add';
  globalItem.innerHTML = `<span class="menu-text"><span class="menu-title">${icon(
    'settings',
    15
  )} Global settings…</span></span>`;
  globalItem.addEventListener('click', () => {
    closeProjectMenu();
    openGlobalSettings();
  });
  menu.appendChild(globalItem);

  const add = document.createElement('button');
  add.className = 'menu-item add';
  add.innerHTML = `<span class="menu-text"><span class="menu-title">${icon(
    'folderAdd',
    15
  )} Add a project…</span></span>`;
  add.addEventListener('click', async () => {
    closeProjectMenu();
    // A folder you just added is the one you want to be looking at: switch to
    // it straight away rather than leaving the old board up.
    const before = new Set(projects.map((p) => p.path));
    projects = await window.api.addProject();
    await loadProjects();
    const added = projects.find((p) => !before.has(p.path));
    if (added && added.name !== activeProject.name) await selectProject(added);
    else await loadBoard();
  });
  menu.appendChild(add);
}

// Each project remembers where you stood (0213): the view, and the doc if
// the view was the knowledgebase. Written on every navigation, read on
// every switch back.
function rememberView(view, docPath) {
  if (!activeProject) return;
  localStorage.setItem(
    `view-${activeProject.name}`,
    JSON.stringify({ view, docPath: docPath || '' })
  );
}

// ── The dashboard (0406) ──
// The front door: a short welcome the first time, the projects as cards
// with their icons after. Clicking a card switches to that project's board.
function showDashboard() {
  stopPolling();
  showView('dashboard');
  renderDashboard();
  // Not remembered as a view: every launch opens here anyway, and a
  // project's remembered place should stay the last spot in the work —
  // remembering the front door would overwrite it on every boot.
}

function projectCardIcon(project) {
  if (project.imageIcon) {
    return `<img class="dash-card-icon-img" src="${escapeHtml(project.imageIcon)}" alt="">`;
  }
  if (project.icon) return `<span class="dash-card-icon-emoji">${escapeHtml(project.icon)}</span>`;
  return '<span class="dash-card-icon-empty"></span>';
}

function renderDashboard() {
  const host = $('dashboard-projects');
  const welcome = $('dashboard-welcome');
  if (!host) return;
  // The welcome shows until the dashboard has been seen once with at least
  // one project in the house; after that the cards speak for themselves.
  const seen = localStorage.getItem('dashboard-seen') === 'true';
  const firstTime = !seen || !projects.length;
  if (welcome) welcome.classList.toggle('hidden', !firstTime);
  if (projects.length) localStorage.setItem('dashboard-seen', 'true');

  host.innerHTML = '';
  for (const project of projects) {
    const card = document.createElement('button');
    card.className = 'dash-card';
    card.innerHTML = `
      <span class="dash-card-icon">${projectCardIcon(project)}</span>
      <span class="dash-card-text">
        <span class="dash-card-title">${escapeHtml(project.title || project.name)}</span>
        <span class="dash-card-path">${escapeHtml(tildePath(project.path))}</span>
      </span>
    `;
    card.addEventListener('click', async () => {
      if (activeProject && project.name === activeProject.name) {
        showBoard();
        return;
      }
      await selectProject(project);
    });
    host.appendChild(card);
  }

  const add = document.createElement('button');
  add.className = 'dash-card dash-card-add';
  add.innerHTML = `<span class="dash-card-icon">${icon('folderAdd', 22)}</span>
    <span class="dash-card-text"><span class="dash-card-title">Add a project…</span>
    <span class="dash-card-path">any local repo</span></span>`;
  add.addEventListener('click', async () => {
    const before = new Set(projects.map((p) => p.path));
    projects = await window.api.addProject();
    await loadProjects();
    const added = projects.find((p) => !before.has(p.path));
    if (added) await selectProject(added);
    else renderDashboard();
  });
  host.appendChild(add);
}

async function restoreProjectView() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(`view-${activeProject.name}`) || 'null');
  } catch (err) {
    saved = null;
  }

  // A remembered session tab (0377): reactivate it if that session is still
  // attached — standalones restore before this runs. A session that died or
  // belongs to a card that moved on falls through to the board, no surprise
  // substitute.
  if (saved && saved.view === 'session' && saved.docPath) {
    const target = [...openSessions.values()].find(
      (s) => s.id === saved.docPath && (!s.project || s.project === activeProject.name)
    );
    if (target) {
      activateSession(target.id);
      return;
    }
  }

  // Planning and Insights restore the same way (0385): land on the
  // remembered doc only if it still exists in that tab's own vault; a doc
  // that moved on means the board, not a surprise substitute.
  if (saved && (saved.view === 'docs' || saved.view === 'insights')) {
    const root = saved.view === 'insights' ? 'insights' : 'knowledge';
    const show = saved.view === 'insights' ? showInsights : showDocs;
    if (!saved.docPath) {
      show();
      return;
    }
    const tree = await window.api.kbList(activeProject.name, root).catch(() => []);
    const exists = tree.flatMap((g) => g.files).some((f) => f.path === saved.docPath);
    if (exists) {
      setKbRoot(root);
      kbActive = {
        path: saved.docPath,
        name: saved.docPath
          .split('/')
          .pop()
          .replace(/\.(md|html|png|jpe?g|gif|webp)$/i, ''),
      };
      show();
      return;
    }
  }
  // A stale remembered 'dashboard' (written before launches always opened
  // there) reads as the board: picking a project should land in the work.
  showBoard();
}

async function selectProject(project) {
  closeProjectMenu();
  if (project.name === activeProject.name) return;

  // The terminal follows the project: detach this one — its shell keeps
  // running in tmux — and reattach or spawn the new project's own after the
  // board has switched over.
  const termWasOpen = detachGlobalTerminal();

  // The open docs are project belongings (0401): stash the old project's,
  // bring out the new one's before the view restore reads them.
  if (typeof stashKbState === 'function') stashKbState(activeProject.name);

  activeProject = project;
  localStorage.setItem('project', project.name);
  if (typeof restoreKbState === 'function') restoreKbState(project.name);
  renderProjectSwitcher();
  // Standalone tabs come back before the view is restored (0377), so a
  // remembered terminal tab has something to land on.
  await restoreStandalones();
  await restoreProjectView();
  // Auto-open only when the new project's session is actually alive in tmux.
  // Open means running; a dead or never-started session stays a closed pane.
  // A stale main process (no handler yet) falls back to the old always-reopen.
  const running = await window.api.globalTerminalRunning(project.name).catch(() => true);
  if (termWasOpen && running) await openGlobalTerminal();
}

function closeProjectMenu() {
  $('project-menu').classList.add('hidden');
  $('project-button').classList.remove('open');
}

$('project-button').addEventListener('click', (e) => {
  e.stopPropagation();
  const menu = $('project-menu');
  const opening = menu.classList.contains('hidden');
  menu.classList.toggle('hidden', !opening);
  $('project-button').classList.toggle('open', opening);
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.project-switcher')) closeProjectMenu();
});

// ── Renaming a project ──
// The heading is the field, and it edits the display title only: the folder
// name underneath is the stable key for the board and the tmux sessions, so
// "Flow" can become "Flow" (or "My Flow") without anything on disk moving.
// Enter commits, Escape puts the old title back.
async function commitProjectRename() {
  const title = $('project-title');
  if (!title || !activeProject) return;

  const next = title.textContent.trim();
  if (!next || next === activeProject.title) {
    title.textContent = activeProject.title;
    return;
  }

  projects = await window.api.updateProject(activeProject.name, { title: next });
  activeProject = projects.find((p) => p.name === activeProject.name) || activeProject;
  title.textContent = activeProject.title;
  renderProjectSwitcher();
}

on('project-title', 'keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    e.target.blur();
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    e.target.textContent = activeProject ? activeProject.title : '';
    e.target.blur();
  }
});

on('project-title', 'blur', commitProjectRename);

// Pasting into a heading brings markup with it unless it is intercepted.
on('project-title', 'paste', (e) => {
  e.preventDefault();
  const text = (e.clipboardData || window.clipboardData).getData('text');
  document.execCommand('insertText', false, text.replace(/\s+/g, ' ').trim());
});
