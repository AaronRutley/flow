// ── Project settings ──
// The choices that shape how a card starts: worktrees or the checkout, the dev
// command, and what "prepare" means here. Stored in ~/.flow/projects.json.
// Sidebar areas (0225): one active at a time, General on every open so the
// screen always greets you the same way.
function showSettingsArea(area) {
  for (const item of document.querySelectorAll('.settings-nav-item')) {
    // Project rows share the 'project' area (0416); only the row for the
    // project on screen lights up, not every project at once.
    const mine =
      item.dataset.area === area &&
      (!item.dataset.project || (settingsProject && item.dataset.project === settingsProject.name));
    item.classList.toggle('active', mine);
  }
  for (const pane of document.querySelectorAll('.settings-area')) {
    pane.classList.toggle('hidden', pane.dataset.area !== area);
  }
  if (area === 'project') renderProjectArea();
  // The sessions list goes stale the moment a terminal opens or ends;
  // re-read it on every visit rather than trusting the fill from open time.
  if (area === 'sessions') renderSessionList();
}

// ── The Projects group (0416) ──
// Every project Flow knows gets a row; clicking one opens that project's
// settings screen. Which project the screen is about is this, not the app's
// active project — reading another project's settings switches nothing.
let settingsProject = null;

function renderSettingsProjectsNav() {
  const host = $('settings-projects-nav');
  if (!host) return;
  host.innerHTML = '';
  for (const project of projects) {
    const button = document.createElement('button');
    button.className = 'settings-nav-item';
    button.dataset.area = 'project';
    button.dataset.project = project.name;
    button.textContent = project.title;
    button.addEventListener('click', async () => {
      // Re-clicking the open page is a no-op — it must not wipe a draft.
      if (project === settingsProject && button.classList.contains('active')) return;
      if (!(await confirmLeaveProjectSettings())) return;
      resetProjectNameField();
      settingsProject = project;
      showSettingsArea('project');
    });
    host.appendChild(button);
  }
}

// The one project screen: whose it is, its name and icon (0444), where its
// files live, and the way off Flow's list.
function renderProjectArea() {
  if (!settingsProject) return;
  $('settings-project-name').textContent = settingsProject.title;
  $('settings-project-path').textContent = settingsProject.boardRoot || '';
  $('settings-project-title').value = settingsProject.title;
  $('settings-project-title-dirty').classList.add('hidden');
  $('settings-project-icon-remove').classList.toggle('hidden', !settingsProject.imageIcon);
}

// ── Name and icon (0444) ──
// The name saves with the footer's Save; until then it is a draft, worn as
// a quiet "unsaved" by the label, and leaving the page asks first.
function projectNameDirty() {
  const input = $('settings-project-title');
  if (!input || !settingsProject) return false;
  const typed = input.value.trim();
  return Boolean(typed) && typed !== settingsProject.title;
}

async function confirmLeaveProjectSettings() {
  if (!projectNameDirty()) return true;
  return confirmAction(
    'The project name has unsaved changes — Save keeps them. Leave without saving?',
    'Leave without saving'
  );
}

function resetProjectNameField() {
  const input = $('settings-project-title');
  if (input && settingsProject) input.value = settingsProject.title;
  $('settings-project-title-dirty').classList.add('hidden');
}

on('settings-project-title', 'input', () => {
  $('settings-project-title-dirty').classList.toggle('hidden', !projectNameDirty());
});

// The refreshed project list lands everywhere at once: the nav, the page,
// the switcher, and the app's own idea of the active project.
function adoptProjects(fresh) {
  projects = fresh;
  settingsProject = projects.find((p) => p.name === settingsProject.name) || settingsProject;
  if (activeProject && settingsProject && activeProject.name === settingsProject.name) {
    activeProject = settingsProject;
  }
  renderSettingsProjectsNav();
  renderProjectArea();
  renderProjectSwitcher();
}

on('settings-project-icon', 'click', async () => {
  if (!settingsProject) return;
  const result = await window.api.pickProjectIcon(settingsProject.name).catch(() => null);
  if (!result || result.canceled) return;
  if (result.error) {
    showToast(result.error);
    return;
  }
  adoptProjects(result.projects);
  showToast('Icon updated');
});

on('settings-project-icon-remove', 'click', async () => {
  if (!settingsProject || !settingsProject.imageIcon) return;
  adoptProjects(await window.api.updateProject(settingsProject.name, { imageIcon: '' }));
  showToast('Icon removed');
});

document.querySelectorAll('.settings-nav-item').forEach((item) => {
  item.addEventListener('click', async () => {
    // An unsaved project name asks before the page changes (0444).
    if (!(await confirmLeaveProjectSettings())) return;
    resetProjectNameField();
    showSettingsArea(item.dataset.area);
  });
});

// Settings arrives the way the knowledge panels do (0237): the panel morphs
// up out of the gear that opened it, and shrinks back into it on close.
let settingsTrigger = null;

// The built-in shaping command and brief (0429), fetched at open so the
// save can tell "left at the default" apart from "customised".
let shapeDefaults = { command: 'claude -p', instructions: '' };

async function openSettings(trigger = null, area = 'project') {
  if (!activeProject) return;
  // Overlays live in the DOM; the link pane floats above it (0408).
  if (typeof closeLinkPane === 'function') closeLinkPane();

  settingsTrigger = trigger || $('open-settings');

  // The screen opens on the active project's page; the Projects group lists
  // the rest (0416).
  settingsProject = activeProject;
  renderSettingsProjectsNav();
  showSettingsArea(area);

  // Working style left the panel with 0412, joining Dev command and Port
  // base (0375): the stored mode keeps steering worktrees, just not from here.
  // Briefs rests with 0413 — uncomment with the index.html block to restore:
  // $('setting-prepare').value = activeProject.preparePrompt || '';
  // $('setting-prepare').placeholder = DEFAULT_PREPARE_PROMPT;

  $('settings-modal').classList.remove('hidden');
  morphPanelFrom($('settings-panel'), settingsTrigger);

  // The app-wide areas (0240) fill from the settings file after the screen
  // is already up — none of it blocks the open.
  const settings = await window.api.readSettings();
  // $('global-shape').value = settings.shapePrompt || ''; // briefs (0413)
  $('global-terminal-command').value = settings.terminalCommand || '';
  // Shaping (0429): the fields pre-fill with the built-ins, so what you
  // read is exactly what runs; an untouched default is stored as absence.
  shapeDefaults = (await window.api.shapeDefaults().catch(() => null)) || {
    command: 'claude -p',
    model: 'haiku',
    instructions: '',
    start: '',
  };
  // Pre-filled as real text (0466), like the model and the brief: what
  // runs is what you read, not a ghost in a placeholder.
  $('shape-command').value = settings.shapeCommand || shapeDefaults.command;
  $('shape-command').placeholder = shapeDefaults.command;
  // The model pre-fills like the prompt (0450): the default sits in the
  // field as real text, ready to be read or replaced.
  $('shape-model').value = settings.shapeModel || shapeDefaults.model;
  $('shape-model').placeholder = shapeDefaults.model;
  $('shape-instructions').value = settings.shapeInstructions || shapeDefaults.instructions;
  $('start-prompt').value = settings.startPrompt || shapeDefaults.start;
  renderCliStatus();
  renderSessionList();
  renderVersionLine();
}

async function closeSettings() {
  // Leaving with an unsaved project name asks first (0444).
  if (!(await confirmLeaveProjectSettings())) return;
  resetProjectNameField();
  const trigger = settingsTrigger;
  settingsTrigger = null;
  morphPanelClosed($('settings-modal'), $('settings-panel'), trigger, () => {
    $('settings-modal').classList.add('hidden');
  });
}

// The icon is edited where it lives: hover the slot by the project name and
// the upload control appears. Picking applies straight away — the dialog is
// its own commitment. Right-clicking the slot takes an uploaded image off
// again, back to the emoji or the empty circle.
// A renderer that reloaded ahead of its main process calls handlers that do
// not exist yet — live-reload restarts the app on main changes, but when that
// relaunch fails the mismatch surfaces here. Say what is wrong instead of
// failing silently.
// ── The one confirmation (0187) ──
// Every destructive act asks through this: one sentence, Cancel, and the
// act by name. Resolves true only on the named button; Escape, the
// backdrop and Cancel all mean no.
let confirmResolve = null;

function confirmAction(message, label = 'Confirm') {
  $('confirm-message').textContent = message;
  $('confirm-go').textContent = label;
  $('confirm-modal').classList.remove('hidden');
  morphPanelFrom($('confirm-panel'), null);
  $('confirm-go').focus();
  return new Promise((resolve) => {
    confirmResolve = resolve;
  });
}

function settleConfirm(result) {
  if (!confirmResolve) return;
  $('confirm-modal').classList.add('hidden');
  const resolve = confirmResolve;
  confirmResolve = null;
  resolve(result);
}

on('confirm-go', 'click', () => settleConfirm(true));
on('confirm-cancel', 'click', () => settleConfirm(false));
on('confirm-modal', 'mousedown', (e) => {
  if (e.target.id === 'confirm-modal') settleConfirm(false);
});
// Capture phase, so the Escape that cancels a confirmation never also
// closes whatever sits beneath it.
document.addEventListener(
  'keydown',
  (e) => {
    if (!confirmResolve || e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    settleConfirm(false);
  },
  true
);

function staleMain(err) {
  if (!/No handler registered/i.test(String(err && err.message))) return false;
  showToast('Restart Flow to update (Cmd+Q, reopen)');
  return true;
}

on('icon-upload', 'click', async (e) => {
  e.stopPropagation();
  if (!activeProject) return;
  let result;
  try {
    result = await window.api.pickProjectIcon(activeProject.name);
  } catch (err) {
    if (!staleMain(err)) showToast('Could not open the image picker');
    return;
  }
  if (result.canceled) return;
  if (result.error) {
    showToast(result.error);
    return;
  }
  projects = result.projects;
  activeProject = projects.find((p) => p.name === activeProject.name) || activeProject;
  renderProjectSwitcher();
});

on('project-icon-slot', 'contextmenu', async (e) => {
  e.preventDefault();
  if (!activeProject || !activeProject.imageIcon) return;
  projects = await window.api.updateProject(activeProject.name, { imageIcon: '' });
  activeProject = projects.find((p) => p.name === activeProject.name) || activeProject;
  renderProjectSwitcher();
  showToast('Icon removed');
});

// No close button and no backdrop (0225): Escape or any navigation above
// leaves the screen. Removing a project only takes it off Flow's list —
// nothing on disk is touched, ever.
on('settings-remove-project', 'click', async () => {
  const leaving = settingsProject || activeProject;
  if (!leaving) return;
  const ok = await confirmAction(
    `Remove "${leaving.title}" from Flow? The repo and its board folder stay on disk untouched.`,
    'Remove project'
  );
  if (!ok) return;
  resetProjectNameField();
  projects = await window.api.removeProject(leaving.name);
  // Removing the project you're standing in changes the ground; removing
  // another from its settings page just shortens the list (0416).
  if (activeProject && leaving.name === activeProject.name) {
    closeSettings();
    activeProject = projects[0] || null;
    if (activeProject) {
      localStorage.setItem('project', activeProject.name);
      renderProjectSwitcher();
      showBoard();
    }
  } else {
    settingsProject = activeProject;
    renderSettingsProjectsNav();
    showSettingsArea('project');
    renderProjectSwitcher();
  }
  showToast(`${leaving.title} removed — files kept on disk`);
});

on('settings-close', 'click', () => closeSettings());

// One Save for the whole screen (0240): the project fields go through
// updateProject in the settings-save handler, and the app-wide fields
// through here, called from the same click. (Restored after the 0376
// theme-workshop extraction took it along by accident.)
async function saveGlobalSettings() {
  // The default terminal command is validated as it is saved (0417): a typo
  // still saves — the binary might be installed later — but says so now,
  // not the first time a session opens on a blank stare.
  const typedCommand = $('global-terminal-command').value.trim();
  if (typedCommand && window.api.resolveCommand) {
    const found = await window.api.resolveCommand(typedCommand).catch(() => null);
    if (found && !found.ok) showToast(`"${found.name}" isn't on your PATH yet — saved anyway`);
  }
  // The shaping fields (0429): a brief left reading exactly as the built-in
  // stores as absence, so default improvements keep reaching this install.
  const shapeCommand = $('shape-command').value.trim();
  if (shapeCommand && window.api.resolveCommand) {
    const found = await window.api.resolveCommand(shapeCommand).catch(() => null);
    if (found && !found.ok) showToast(`"${found.name}" isn't on your PATH yet — saved anyway`);
  }
  const shapeModel = $('shape-model').value.trim();
  const shapeInstructions = $('shape-instructions').value.trim();
  await window.api.writeSettings({
    // shapePrompt stays as stored while Briefs rests (0413) — write merges,
    // so leaving it out leaves it alone.
    terminalCommand: typedCommand,
    shapeCommand: shapeCommand === shapeDefaults.command ? '' : shapeCommand,
    // Left reading as the default, the model stores as absence (0450) —
    // same contract as the command and the brief.
    shapeModel: shapeModel === shapeDefaults.model ? '' : shapeModel,
    shapeInstructions:
      shapeInstructions === shapeDefaults.instructions.trim() ? '' : shapeInstructions,
    startPrompt: (() => {
      const typed = $('start-prompt').value.trim();
      return typed === String(shapeDefaults.start || '').trim() ? '' : typed;
    })(),
  });
  // A changed command renames what every terminal pane launches; the label
  // saying so must not keep naming the old one.
  await refreshSessionCli();
}

on('settings-save', 'click', async () => {
  // The project name lands with the one Save (0444). The title is what the
  // user reads and renames freely; the name keys the files and stays put.
  if (settingsProject && projectNameDirty()) {
    adoptProjects(
      await window.api.updateProject(settingsProject.name, {
        title: $('settings-project-title').value.trim(),
      })
    );
  }
  await saveGlobalSettings();
  renderProjectSwitcher();
  refreshGitButton();
  refreshEnvButton();
  closeSettings();
  // goes with it.
});

on('open-settings', 'click', () => openSettings($('open-settings')));

// The menu bar's Flow › Preferences (Cmd+,) opens the app-level settings — the
// same panel the project menu's Global settings does.
window.api.onOpenPreferences(() => openGlobalSettings());

// Cmd+N, via the File menu: a fresh card for the active project, from
// wherever in the app the key lands. The menu accelerator means the key
// works even while a terminal or input holds focus.
window.api.onNewCard(() => {
  if (!activeProject) return;
  if (!$('card-add-modal').classList.contains('hidden')) return;
  openCardAdd(false);
});

// ── Global settings ──
// App-level settings live in the same screen since 0240; Preferences and
// the project menu's Global settings both land on the first app-wide area.
function openGlobalSettings() {
  openSettings(null, 'agent');
}


async function renderCliStatus() {
  const root = $('cli-status');
  if (!root) return;
  wireDiagnosticsButton();
  root.innerHTML = '<p class="theme-empty">Checking…</p>';
  const status = (await window.api.cliStatus().catch(() => null)) || {};
  const rows = [
    { key: 'claude', label: 'claude', why: 'Shape, Draft, Research, Review' },
    { key: 'tmux', label: 'tmux', why: 'sessions survive closing the app' },
    { key: 'git', label: 'git', why: 'branches, worktrees and PR plumbing' },
    { key: 'gh', label: 'gh', why: 'draft pull requests' },
    { key: 'codex', label: 'codex', why: 'optional second-opinion reviews' },
    { key: 'boardRoot', label: 'board folder', why: 'where every card and doc is written' },
    { key: 'disk', label: 'disk space', why: 'room for boards and worktrees' },
  ];
  root.innerHTML = '';
  for (const row of rows) {
    const tool = status[row.key] || { ok: false, optional: row.key !== 'claude' && row.key !== 'tmux' };
    const el = document.createElement('div');
    el.className = 'session-row';
    const state = tool.ok ? 'found' : tool.optional ? 'optional' : 'missing';
    const meta = tool.ok
      ? tool.path
      : tool.hint || (tool.optional ? 'Not installed (optional)' : 'Not on PATH');
    el.innerHTML = `
      <span class="session-dot${tool.ok ? ' live' : ''}" title="${escapeHtml(state)}"></span>
      <span class="session-label">
        <span class="session-name">${escapeHtml(row.label)}${
          tool.ok ? '' : tool.optional ? ' · optional' : ' · required'
        }</span>
        <span class="session-meta">${escapeHtml(meta)} · ${escapeHtml(row.why)}</span>
      </span>
    `;
    root.appendChild(el);
  }
}

// Which code is live. A dev app launched in the morning happily keeps running
// the morning's code; when the checkout has moved on since, say so plainly.
async function renderVersionLine() {
  const el = $('global-version');
  if (!el) return;
  const info = await window.api.appVersion().catch(() => null);
  if (!info) {
    el.textContent = '';
    return;
  }
  const parts = [`flow ${info.version}`];
  if (info.commit) parts.push(info.branch ? `${info.commit} on ${info.branch}` : info.commit);
  if (info.stale) parts.push(`the checkout has moved to ${info.onDisk}, relaunch to run it`);
  el.textContent = parts.join(' · ');
}

// Every tmux session Flow is running, labelled by the work it belongs to, each
// with an End. A quiet count when there is nothing to show.
async function renderSessionList() {
  const list = $('session-list');
  if (!list) return;
  list.innerHTML = '<p class="theme-empty">Loading…</p>';
  const rows = (await window.api.listTerminalSessions().catch(() => [])) || [];
  list.innerHTML = '';
  if (!rows.length) {
    const empty = document.createElement('p');
    empty.className = 'theme-empty';
    empty.textContent = 'No sessions running.';
    list.appendChild(empty);
    return;
  }
  for (const row of rows) {
    const el = document.createElement('div');
    el.className = 'session-row';
    const since = row.created ? `started ${relativeTime(row.created * 1000)}` : '';
    el.innerHTML = `
      <span class="session-dot${row.attached ? ' live' : ''}" title="${
        row.attached ? 'A window is attached' : 'Running, detached'
      }"></span>
      <span class="session-label">
        <span class="session-name">${escapeHtml(row.label)}</span>
        <span class="session-meta">${escapeHtml(since)}</span>
      </span>
      <button class="text-button small session-end">End</button>
    `;
    el.querySelector('.session-end').addEventListener('click', async () => {
      await window.api.endTerminalSession(row.name);
      renderSessionList();
    });
    list.appendChild(el);
  }
}

// ── Bulk cleanup (0419) ──
// End the whole lot, or only the ones that have sat around longer than the
// typed number of days. One confirmation either way, then the same
// end-one-session call the row buttons use, in a loop.
async function endSessionsWhere(keep, describe) {
  const rows = (await window.api.listTerminalSessions().catch(() => [])) || [];
  const targets = rows.filter((row) => !keep(row));
  if (!targets.length) {
    showToast('No sessions match');
    return;
  }
  const plural = targets.length === 1 ? 'session' : 'sessions';
  const ok = await confirmAction(
    `End ${targets.length} ${describe} ${plural}? Whatever is running inside stops; nothing on disk is touched.`,
    'End sessions'
  );
  if (!ok) return;
  for (const row of targets) {
    await window.api.endTerminalSession(row.name).catch(() => {});
  }
  renderSessionList();
  showToast(`${targets.length} ${plural} ended`);
}

on('sessions-end-all', 'click', () => endSessionsWhere(() => false, 'running'));

on('sessions-end-old', 'click', () => {
  const field = $('sessions-age-days');
  // The field clamps to a sane whole number and shows what will be used.
  const days = Math.min(365, Math.max(1, Math.round(Number(field.value)) || 7));
  field.value = days;
  const cutoff = Date.now() / 1000 - days * 24 * 60 * 60;
  // A session with no readable age is left alone — too old to tell is not
  // the same as too old.
  endSessionsWhere((row) => !row.created || row.created >= cutoff, `older-than-${days}-day`);
});

// "3m ago", "2h ago" — coarse on purpose; a session's exact age is never the
// point, only roughly how long it has been sitting there.
function relativeTime(ms) {
  const secs = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}



// Copy diagnostics (0360): the bundle is written to a file and revealed,
// so it gets read before it gets shared. Redacted at assembly either way.
function wireDiagnosticsButton() {
  if ($('copy-diagnostics-button')) return;
  const host = $('cli-status');
  if (!host || !host.parentElement) return;
  const button = document.createElement('button');
  button.className = 'text-button';
  button.id = 'copy-diagnostics-button';
  button.textContent = 'Save diagnostics bundle';
  button.addEventListener('click', async () => {
    button.disabled = true;
    const result = await window.api.copyDiagnostics().catch(() => null);
    button.disabled = false;
    showToast(
      result && result.path
        ? 'Diagnostics saved and revealed — read it before you share it'
        : 'Could not assemble diagnostics'
    );
  });
  host.parentElement.appendChild(button);
}
