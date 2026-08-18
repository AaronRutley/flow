const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  Menu,
  MenuItem,
  nativeImage,
  crashReporter,
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

// ── Crash capture (0216) ──
// A crash that leaves no trace costs a whole QA round. Native crashes land
// as minidumps via crashpad (never uploaded anywhere); everything the JS
// side can catch is appended to logs/crashes.log under userData, one
// timestamped block per event, with a launch line so every log reads from a
// known starting point. The Flow menu's "Show Logs" opens the folder.
// The app presents as Flow (0388), but its data stays where "Flow" put
// it: macOS derives userData from the app name, and the rename must not
// orphan existing installs' saved board-root pointer, crash logs or
// permission grants. The path is pinned before anything reads it.
app.setName('Flow');
app.setPath('userData', path.join(app.getPath('appData'), 'flow'));

crashReporter.start({ uploadToServer: false });

const LOGS_DIR = path.join(app.getPath('userData'), 'logs');
const CRASH_LOG = path.join(LOGS_DIR, 'crashes.log');

function logCrash(kind, detail) {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.appendFileSync(CRASH_LOG, `\n[${new Date().toISOString()}] ${kind}\n${detail}\n`);
  } catch (err) {
    // Logging must never be the thing that crashes.
  }
}

process.on('uncaughtException', (err) => {
  logCrash('uncaughtException', (err && err.stack) || String(err));
  console.error('[crash]', err);
});
process.on('unhandledRejection', (reason) => {
  logCrash('unhandledRejection', (reason && reason.stack) || String(reason));
  console.error('[crash]', reason);
});
app.on('render-process-gone', (event, webContents, details) => {
  logCrash('render-process-gone', JSON.stringify(details));
});
app.on('child-process-gone', (event, details) => {
  if (details.reason === 'clean-exit') return;
  logCrash('child-process-gone', JSON.stringify(details));
});
const chokidar = require('chokidar');

const projects = require('./src/main/projects');
const knowledge = require('./src/main/knowledge');
const board = require('./src/main/board');
const sessions = require('./src/main/sessions');
const pipeline = require('./src/main/pipeline');
const git = require('./src/main/git');
const config = require('./src/main/config');
const flowRoot = require('./src/main/flow-root');
const cli = require('./src/main/cli');
const { isSafeExternalUrl } = require('./src/main/urls');
const guard = require('./src/main/path-guard');
const watchCoalesce = require('./src/main/watch-coalesce');

// ── Path containment (0315) ──
// The roots a renderer-supplied path is ever allowed to name. Cards and
// docs live in a project's board folder; env files may also live in the
// repo checkout or a card worktree (.flow-worktrees beside the repo).
function boardRoots(projectName) {
  if (projectName) {
    const project = projects.find(projectName);
    return project ? [project.boardRoot] : [];
  }
  return projects.read().map((p) => p.boardRoot);
}


// One question at every door: is this path really inside an allowed root?
function cardPathOk(cardPath, projectName) {
  return guard.inRoots(cardPath, boardRoots(projectName));
}

// ── IPC argument validation (0321) ──
// Every channel declares its argument shapes here; registration refuses a
// channel with no declaration, so a new handler cannot ship unvalidated.
// The wrapper below checks the schema before any handler runs and answers
// bad input with one stable public error.
const v = require('./src/main/validate');
const NAME = v.str(200); // a project name
const P = v.str(1024); // a filesystem path (containment is 0315's job)
const COLUMNS = v.oneOf('to-do', 'doing', 'done', 'archive', 'backlog');
// The docs vault a kb-* call works in (0385): absent means the knowledgebase,
// so every caller from before Insights keeps its meaning.
const ROOT = (val) =>
  val === undefined || val === null || val === 'knowledge' || val === 'insights'
    ? null
    : 'one of knowledge, insights';

const IPC_SCHEMAS = {
  'choose-flow-root': [],
  'renderer-main-handshake': [],
  'close-window': [],
  'list-projects': [],
  'add-project': [],
  'remove-project': [NAME],
  'pick-project-icon': [NAME],
  'save-attachment': [NAME, v.optStr(64), v.bytes()],
  'adopt-attachments': [NAME, P],
  'list-cards': [NAME],
  'create-card': [NAME, v.str(4000)],
  'transfer-card': [NAME, P, NAME],
  'move-card': [NAME, P, COLUMNS],
  'card-session-log': [NAME, P, v.optBool()],
  'current-branch': [NAME],
  'reorder-column': [NAME, COLUMNS, v.arrOf(v.str(1024), 2000)],
  'read-card': [P],
  'archive-card': [NAME, P],
  'read-settings': [],
  'write-settings': [v.obj()],
  'session-cli': [],
  'resolve-command': [v.str(500)],
  'shape-defaults': [],
  'session-idle': [v.str(200)],
  'app-version': [],
  'open-external': [v.str(2048)],
  'write-card-body': [P, v.str(2 * 1024 * 1024)],
  'patch-card': [P, v.obj()],
  'kb-list': [NAME, ROOT],
  'kb-all-docs': [NAME, ROOT],
  'kb-search': [NAME, v.str(500), ROOT],
  'kb-bookmark': [NAME, v.optStr(200), v.str(2048), v.optStr(500), v.optBool(), ROOT],
  'kb-backlinks': [NAME, v.str(300), ROOT],
  'kb-read': [NAME, P, ROOT],
  'kb-write': [NAME, P, v.str(5 * 1024 * 1024), ROOT],
  'kb-create': [NAME, v.optStr(200), v.str(300), ROOT],
  'kb-create-folder': [NAME, v.str(200), ROOT],
  'kb-rename': [NAME, P, v.str(300), ROOT],
  'kb-delete': [NAME, P, ROOT],
  'kb-remove-folder': [NAME, v.str(200), ROOT],
  'kb-reorder': [NAME, v.optStr(200), v.arrOf(v.str(300), 1000), ROOT],
  'kb-rename-folder': [NAME, v.str(200), v.str(200), ROOT],
  'kb-move': [NAME, P, v.optStr(200), ROOT],
  'kb-folder-order': [NAME, v.arrOf(v.str(200), 500), ROOT],
  'kb-reveal': [NAME, P, ROOT],
  'kb-note-current': [NAME, v.optStr(1024), ROOT],
  'kb-research': [NAME, v.optStr(200), v.str(4000)],
  'start-card': [NAME, P],
  'open-shell': [NAME, v.str(100), v.optObj()],
  'attach-card-session': [NAME, v.str(100)],
  'open-global-terminal': [NAME, v.oneOf('board', 'docs', 'insights')],
  'global-terminal-running': [NAME],
  'stop-server': [NAME, P],
  'update-project': [NAME, v.obj()],
  'cli-status': [],
  'shape-card': [NAME, P],
  'review-card': [NAME, P, v.optStr(50)],
  'plan-card': [NAME, P],
  'close-card': [NAME, P],
  'pause-card': [NAME, P],
  'backfill-pr-url': [NAME, P],
  'list-terminal-sessions': [],
  'end-terminal-session': [v.str(200)],
  'terminal-input': [v.str(200), v.str(1024 * 1024)],
  'terminal-resize': [v.str(200), v.num(10000), v.num(10000)],
  'terminal-stop': [v.str(200)],
  'terminal-kill': [v.str(200)],
  'startup-marks': [v.arrOf(v.str(100), 30)],
  'link-open': [v.str(2048), v.obj(8)],
  'link-bounds': [v.obj(8)],
  'link-close': [],
  'copy-diagnostics': [],
  'watch-boards': [],
  'dev-update-apply': [],
};

{
  const rawHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, fn) => {
    const schema = IPC_SCHEMAS[channel];
    if (!schema) throw new Error(`IPC channel without a schema: ${channel}`);
    return rawHandle(channel, (event, ...args) => {
      const reason = v.check(args, schema);
      if (reason) throw new Error(`invalid-arguments (${channel}): ${reason}`);
      return fn(event, ...args);
    });
  };

  const rawOn = ipcMain.on.bind(ipcMain);
  ipcMain.on = (channel, fn) => {
    const schema = IPC_SCHEMAS[channel];
    if (!schema) throw new Error(`IPC channel without a schema: ${channel}`);
    return rawOn(channel, (event, ...args) => {
      // Fire-and-forget channels (terminal keystrokes) drop bad input
      // silently — there is no reply to carry a reason.
      if (v.check(args, schema)) return;
      fn(event, ...args);
    });
  };
}

let mainWindow;
let setupWindow;
let boardWatcher;

// In development the app runs inside the stock Electron binary, so macOS takes
// the Dock label and icon from that bundle and shows "Electron". Naming the app
// and setting the Dock icon here makes a dev run look like the real thing. A
// packaged build reads both from Info.plist and ignores this.
if (!app.isPackaged) {
  const devIcon = path.join(__dirname, 'build', 'icon_1024.png');
  if (fs.existsSync(devIcon)) {
    app.whenReady().then(() => app.dock?.setIcon(devIcon));
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1000,
    minHeight: 600,
    title: 'Flow',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 17 },
    backgroundColor: '#0c0c0c',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The webview returns for one job (0385, revisiting 0317/0376):
      // bookmark docs render their site in the doc pane. will-attach-webview
      // below strips every guest down to a sandboxed http(s) page.
      webviewTag: true,
      // A FLOW_SHOT proof run drives an occluded window; throttled rAF
      // would freeze the very animations it came to verify (0210).
      backgroundThrottling: !process.env.FLOW_SHOT,
    },
  });

  // The 0317 deny-all softens to a strip-search (0385): a guest page may
  // attach only as a sandboxed, isolated http(s) page — no preload, no node,
  // whatever the tag asked for. Anything else still trips the deny.
  mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload;
    delete webPreferences.preloadURL;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    if (!isSafeExternalUrl(params.src)) event.preventDefault();
  });

  // A bookmark's site behaves like a browser inside its pane, but its exits
  // stay policed: popups go to the system browser, and navigation never
  // leaves http(s).
  mainWindow.webContents.on('did-attach-webview', (event, guest) => {
    guest.setWindowOpenHandler(({ url }) => {
      if (isSafeExternalUrl(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    guest.on('will-navigate', (navEvent, url) => {
      if (!isSafeExternalUrl(url)) navEvent.preventDefault();
    });
  });

  mainWindow.loadFile('index.html');

  // Links belong in the real browser. A markdown <a href> would otherwise
  // navigate the app window away, and target=_blank would spawn a bare
  // chromeless child window; both routes end at the system browser instead.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('file://')) return;
    event.preventDefault();
    if (isSafeExternalUrl(url)) shell.openExternal(url);
  });

  // Right-click on a misspelling offers the system dictionary's suggestions
  // (0211) — macOS's own spell checker drives spellcheck=true surfaces, so
  // the suggestions and Learn Spelling behave like every native app.
  mainWindow.webContents.on('context-menu', (event, params) => {
    if (!params.misspelledWord) return;
    const menu = new Menu();
    for (const suggestion of params.dictionarySuggestions.slice(0, 6)) {
      menu.append(
        new MenuItem({
          label: suggestion,
          click: () => mainWindow.webContents.replaceMisspelling(suggestion),
        })
      );
    }
    if (params.dictionarySuggestions.length) menu.append(new MenuItem({ type: 'separator' }));
    menu.append(
      new MenuItem({
        label: `Learn Spelling "${params.misspelledWord}"`,
        click: () =>
          mainWindow.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
      })
    );
    menu.popup();
  });

}

// First launch of a packaged build: nothing says where boards and settings
// live yet, so the board window waits behind this one until a folder is
// chosen. Small and fixed — it holds a logo, one sentence and one button.
function createSetupWindow() {
  setupWindow = new BrowserWindow({
    width: 520,
    height: 620,
    resizable: false,
    fullscreenable: false,
    title: 'Flow',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 17 },
    backgroundColor: '#0c0c0c',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  setupWindow.loadFile('setup.html');
}

// The chosen root is written to the pointer file and the app relaunches into
// the board: config.js and projects.js resolve their paths when they load,
// so a fresh process is the honest way to pick the new root up everywhere.
ipcMain.handle('choose-flow-root', async () => {
  const result = await dialog.showOpenDialog(setupWindow, {
    title: 'Choose where Flow keeps your files',
    buttonLabel: 'Use this folder',
    defaultPath: path.join(process.env.HOME, 'Vibes'),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return { chosen: false };

  const root = result.filePaths[0];
  flowRoot.save(root);

  // A short beat so the splash can say where it is going before the restart.
  setTimeout(() => {
    app.relaunch();
    app.exit(0);
  }, 700);

  return { chosen: true, root };
});

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// The default Window menu binds Cmd+W to closing the window, and a menu
// accelerator wins before the renderer ever sees the key. Rebuilding the menu
// is the only way to give Cmd+W to the tabs; the renderer closes the window
// itself when there is no tab left to close.
function buildMenu() {
  const template = [
    {
      // The app menu, spelled out rather than the default role, so it carries a
      // Preferences item — the proper home for app-level settings (Cmd+,) — and
      // reads as "Flow" rather than the stock Electron menu.
      label: 'Flow',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Preferences…',
          accelerator: 'CmdOrCtrl+,',
          click: () => sendToRenderer('open-preferences'),
        },
        {
          // Crash log and crashpad dumps, one click away (0216).
          label: 'Show Logs',
          click: () => {
            fs.mkdirSync(LOGS_DIR, { recursive: true });
            if (!fs.existsSync(CRASH_LOG)) fs.writeFileSync(CRASH_LOG, '');
            shell.showItemInFolder(CRASH_LOG);
          },
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        {
          // Cmd+N belongs to making a card — the app's one act of creation.
          label: 'New Card',
          accelerator: 'CmdOrCtrl+N',
          click: () => sendToRenderer('new-card'),
        },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        {
          label: 'Close Tab',
          accelerator: 'CmdOrCtrl+W',
          click: () => sendToRenderer('close-tab'),
        },
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// The renderer calls this once on boot. Its only job is to exist: a main
// process older than the renderer (a failed live-reload relaunch) will not
// have it, the invoke rejects, and the renderer can say "restart me" up front
// instead of scattering "No handler registered" errors across every feature.
ipcMain.handle('renderer-main-handshake', () => true);

ipcMain.handle('close-window', async () => {
  if (!mainWindow || mainWindow.isDestroyed()) return true;
  // Cmd+W past the last tab is the whole app going down, and that deserves
  // a breath — especially since the same keystroke was closing tabs a
  // moment ago.
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'none',
    message: 'Close Flow?',
    detail: 'Terminal sessions keep running and will reattach next time.',
    buttons: ['Close', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) mainWindow.close();
  return response === 0;
});

// ── Projects and cards ──

ipcMain.handle('list-projects', () => projects.read());

ipcMain.handle('add-project', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Add a project folder',
  });
  if (result.canceled || !result.filePaths.length) return projects.read();
  return projects.add(result.filePaths[0]);
});


// Removing a project only forgets it (0225): the entry leaves projects.json,
// and the repo and board folder stay on disk exactly where they are.
ipcMain.handle('remove-project', (event, projectName) => {
  const project = projects.find(projectName);
  if (!project) return projects.read();
  return projects.remove(project.path);
});

// A project can wear a real image instead of an emoji. The file lives with the
// board's other images, in the project's attachments folder, under a stamped
// name — the stamp doubles as a cache-buster, so replacing the icon never
// shows the old pixels — and the path lands in the project record as
// `imageIcon`. Only square images are accepted: the icon renders in a
// squircle, and a rectangle would be silently cropped.
ipcMain.handle('pick-project-icon', async (event, projectName) => {
  const project = projects.find(projectName);
  if (!project) return { error: `Unknown project: ${projectName}` };

  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a square icon image',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };

  const source = result.filePaths[0];
  const image = nativeImage.createFromPath(source);
  if (image.isEmpty()) return { error: 'That file could not be read as an image' };

  const { width, height } = image.getSize();
  if (Math.abs(width - height) > Math.round(Math.max(width, height) * 0.01)) {
    return { error: `Needs a 1:1 image — this one is ${width}×${height}` };
  }

  const dir = board.columnDir(project.boardRoot, 'attachments');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = Date.now();
  const target = path.join(dir, `project-icon-${stamp}${path.extname(source).toLowerCase()}`);
  fs.copyFileSync(source, target);

  return { path: target, projects: projects.update(project.name, { imageIcon: target }) };
});

// Pasted screenshots live with the board, not the repo: one attachments
// folder per project. Numbered per card since 0289 — 0289-1.png reads as
// "card 0289, attachment 1" — with next-unused numbering so nothing ever
// collides, overwrites or renumbers.
ipcMain.handle('save-attachment', (event, projectName, cardId, bytes) => {
  const project = projects.find(projectName);
  if (!project) throw new Error(`Unknown project: ${projectName}`);

  const dir = board.columnDir(project.boardRoot, 'attachments');
  fs.mkdirSync(dir, { recursive: true });

  const key = cardId || 'note';
  const name = `${key}-${board.nextAttachmentNumber(dir, key)}.png`;
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.from(bytes));

  return { path: file, name };
});

// A just-created card claims the images pasted while it was being written:
// the neutral new-card files take the card's own number (0289).
ipcMain.handle('adopt-attachments', (event, projectName, cardPath) => {
  const project = projects.find(projectName);
  if (!project) throw new Error(`Unknown project: ${projectName}`);
  if (!cardPathOk(cardPath, projectName)) throw new Error('path-outside-root');
  return board.adoptAttachments(project.boardRoot, cardPath);
});

ipcMain.handle('list-cards', (event, projectName) => {
  const project = projects.find(projectName);
  if (!project) return [];
  // Duplicate ids heal before the board renders, so a collision from an
  // outside writer lasts one load instead of toasting until fixed by hand.
  board.healDuplicateIds(project.boardRoot);
  return board.listCards(project.boardRoot);
});

ipcMain.handle('create-card', (event, projectName, title) => {
  const project = projects.find(projectName);
  if (!project) throw new Error(`Unknown project: ${projectName}`);
  return board.createCard(project.boardRoot, title);
});

// A card changing projects (0312): both boards resolved here, the move
// itself in board.transferCard. Any running shape stops — the card is
// leaving this project's pipeline.
ipcMain.handle('transfer-card', (event, projectName, cardPath, targetProjectName) => {
  const project = projects.find(projectName);
  const target = projects.find(targetProjectName);
  if (!project) throw new Error(`Unknown project: ${projectName}`);
  if (!target) throw new Error(`Unknown project: ${targetProjectName}`);
  if (!cardPathOk(cardPath, projectName)) throw new Error('path-outside-root');
  pipeline.cancelShape(cardPath);
  return board.transferCard(project.boardRoot, cardPath, target.boardRoot);
});

ipcMain.handle('move-card', (event, projectName, cardPath, toColumn) => {
  const project = projects.find(projectName);
  if (!project) throw new Error(`Unknown project: ${projectName}`);
  if (!cardPathOk(cardPath, projectName)) throw new Error('path-outside-root');
  // A card leaving the live columns takes any running shape with it (0249).
  if (toColumn === 'archive' || toColumn === 'backlog') pipeline.cancelShape(cardPath);
  const moved = board.moveCard(project.boardRoot, cardPath, toColumn);
  // A card finishing without a branch on record finished on the checkout:
  // stamp the branch the checkout was on, so Done can group and name it
  // (0193) instead of shrugging "no branch".
  if (toColumn === 'done') {
    try {
      const card = board.readCardAt(moved.path || moved);
      if (!card.branch) {
        const branch = git.currentBranch(project.path);
        if (branch) board.patchCard(card.path, { branch });
      }
    } catch (err) {
      // A card that cannot be stamped still moved; the label just stays bare.
    }
  }
  return moved;
});

// A card's session transcript on disk (0196): Claude Code files each
// conversation as ~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl, and
// the card's frontmatter holds both halves of that address — the session id
// it stores at start, and the worktree (or checkout) the session ran in.
// Probe finds it; reveal shows it in the Finder.
ipcMain.handle('card-session-log', (event, projectName, cardPath, reveal) => {
  const project = projects.find(projectName);
  if (!project) return null;
  if (!cardPathOk(cardPath, projectName)) return null;
  let card;
  try {
    card = board.readCardAt(cardPath);
  } catch (err) {
    return null;
  }
  if (!card.claude_session) return null;
  const log = pipeline.claudeSessionLog(project, card);
  if (!log) return null;
  if (reveal) shell.showItemInFolder(log);
  return log;
});

// The branch the project's checkout is on right now, for labelling work
// done straight on it (0193).
ipcMain.handle('current-branch', (event, projectName) => {
  const project = projects.find(projectName);
  if (!project) return '';
  return git.currentBranch(project.path) || '';
});

ipcMain.handle('reorder-column', (event, projectName, column, orderedPaths) => {
  const project = projects.find(projectName);
  if (!project) throw new Error(`Unknown project: ${projectName}`);
  if (!(orderedPaths || []).every((p) => cardPathOk(p, projectName)))
    throw new Error('path-outside-root');
  return board.reorder(project.boardRoot, column, orderedPaths);
});

ipcMain.handle('read-card', (event, cardPath) => {
  if (!cardPathOk(cardPath)) throw new Error('path-outside-root');
  return board.readCardAt(cardPath);
});

// A to-do that stopped mattering: out of the board, markdown kept.
ipcMain.handle('archive-card', (event, projectName, cardPath) => {
  const project = projects.find(projectName);
  if (!project) throw new Error(`Unknown project: ${projectName}`);
  if (!cardPathOk(cardPath, projectName)) throw new Error('path-outside-root');
  // Archiving mid-shape stops the model call too (0249).
  pipeline.cancelShape(cardPath);
  return board.archiveCard(project.boardRoot, cardPath);
});

// App-level settings: the prompts Flow uses everywhere.
// Startup marks (0326): the renderer reports its milestone timeline once
// per launch; one line per run lands in the Flow root's logs, so a cold
// start is measured every time anyone simply uses the app.
ipcMain.handle('startup-marks', (event, marks) => {
  try {
    const dir = path.join(flowRoot.FLOW_ROOT, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, 'startup.log'),
      `${new Date().toISOString()} ${marks.join(' ')}\n`
    );
  } catch (err) {
    // Measurement must never break a launch.
  }
  return true;
});

// The diagnostics bundle (0360): everything a bug report needs, assembled
// on request, redacted before it leaves the main process, and returned to
// the renderer so the person can read exactly what they are about to share.
ipcMain.handle('copy-diagnostics', () => {
  const events = require('./src/main/events');
  const registry = require('./src/main/proc-registry');
  const readTail = (file, n) => {
    try {
      return fs.readFileSync(file, 'utf-8').trim().split('\n').slice(-n).join('\n');
    } catch (err) {
      return '';
    }
  };
  const logsDir = path.join(flowRoot.FLOW_ROOT, 'logs');
  const bundle = [
    `flow ${app.getVersion()} · ${process.platform} ${os.release()} · ${new Date().toISOString()}`,
    '',
    '## On this Mac',
    JSON.stringify(cli.diagnose(), null, 2),
    '',
    '## Recent events',
    events.tail(120) || '(none)',
    '',
    '## Process registry',
    JSON.stringify(registry.read().slice(-20), null, 2),
    '',
    '## Startup marks',
    readTail(path.join(logsDir, 'startup.log'), 10) || '(none)',
  ].join('\n');
  const { redact } = require('./src/main/redact');
  // Inspect-first, not clipboard-first: the bundle lands as a file and
  // Finder opens on it, so what leaves the machine is read before it does.
  const clean = redact(bundle);
  const out = path.join(logsDir, `diagnostics-${Date.now()}.txt`);
  fs.mkdirSync(logsDir, { recursive: true });
  fs.writeFileSync(out, clean);
  shell.showItemInFolder(out);
  return { path: out };
});

// The link pane (0408): a main-owned, sandboxed WebContentsView laid over
// the doc pane. The renderer says where; policy lives in link-view.js.
ipcMain.handle('link-open', (event, url, bounds) => {
  const linkView = require('./src/main/link-view');
  return mainWindow ? linkView.open(mainWindow, url, bounds) : false;
});
ipcMain.handle('link-bounds', (event, bounds) => {
  require('./src/main/link-view').setBounds(bounds);
  return true;
});
ipcMain.handle('link-close', () => {
  require('./src/main/link-view').close();
  return true;
});

ipcMain.handle('read-settings', () => config.read());
ipcMain.handle('write-settings', (event, changes) => config.write(changes));

// Which CLI a session would launch right now — the renderer types it into
// terminals and names it on the pane label, and must not re-derive the
// toggle's meaning for itself.
ipcMain.handle('session-cli', () => config.cli());

// Whether a session's pane sits at a bare shell prompt (0453), so a
// go-ahead prompt is fired as the agent's argument rather than typed into
// zsh as a command that isn't.
ipcMain.handle('session-idle', (event, id) => sessions.paneIdle(id));

// What shaping runs when nothing is customised (0429): the settings screen
// pre-fills its fields with these, so what the user reads is what runs.
ipcMain.handle('shape-defaults', () => ({
  command: pipeline.SHAPE_COMMAND,
  model: pipeline.SHAPE_MODEL,
  instructions: pipeline.SHAPE_INSTRUCTIONS,
  start: pipeline.START_PROMPT,
}));

// Whether a typed default terminal command exists on this Mac (0417): the
// first word is the binary; resolution goes through the login shell's PATH,
// same as launching would. Advisory — the save never blocks on it.
ipcMain.handle('resolve-command', (event, command) => {
  const name = String(command || '').trim().split(/\s+/)[0];
  if (!name) return { ok: true };
  const found = require('./src/main/proc').which(name);
  return { ok: Boolean(found), path: found || null, name };
});

// The code this process is actually running, captured once at launch. A dev
// app sits open for hours while merges land under it; the settings modal uses
// this to say which commit is live and whether the checkout has moved on.
const launchedFrom = {
  commit: git.run(__dirname, ['rev-parse', '--short', 'HEAD'], { tolerate: true }),
  branch: git.currentBranch(__dirname),
};
ipcMain.handle('app-version', () => {
  const onDisk = git.run(__dirname, ['rev-parse', '--short', 'HEAD'], { tolerate: true });
  return {
    version: app.getVersion(),
    commit: launchedFrom.commit,
    branch: launchedFrom.branch,
    onDisk,
    stale: Boolean(onDisk && launchedFrom.commit && onDisk !== launchedFrom.commit),
  };
});


// Links belong in the real browser, not in the app window. Same policy as
// the navigation guards — one helper, no drift (0316).
ipcMain.handle('open-external', (event, url) => {
  if (!isSafeExternalUrl(url)) return false;
  shell.openExternal(url);
  return true;
});

ipcMain.handle('write-card-body', (event, cardPath, body) => {
  if (!cardPathOk(cardPath)) throw new Error('path-outside-root');
  board.writeBody(cardPath, body);
  return board.readCardAt(cardPath);
});

ipcMain.handle('patch-card', (event, cardPath, changes) => {
  if (!cardPathOk(cardPath)) throw new Error('path-outside-root');
  board.patchCard(cardPath, changes);
  return board.readCardAt(cardPath);
});

// ── Knowledgebase ──
// Every handler resolves the project first and the knowledge module refuses
// any path outside that project's knowledge root.
function kb(projectName) {
  const project = projects.find(projectName);
  if (!project) throw new Error(`Unknown project: ${projectName}`);
  return project;
}

ipcMain.handle('kb-list', (event, projectName, root) => {
  const project = kb(projectName);
  // First visit generates the docs stylesheet and its sample; after that the
  // files are the user's and are left alone. The stylesheet belongs to the
  // knowledgebase only — insights has no seeded look.
  if (knowledge.normalizeRoot(root) === 'knowledge') {
    try {
      knowledge.ensureStyles(project);
    } catch (err) {
      console.error('[kb] could not generate the docs styles:', err.message);
    }
  }
  return knowledge.list(project.boardRoot, root);
});

ipcMain.handle('kb-all-docs', (event, projectName, root) =>
  knowledge.allDocs(kb(projectName).boardRoot, root)
);
ipcMain.handle('kb-search', (event, projectName, term, root) =>
  knowledge.search(kb(projectName).boardRoot, term, root)
);
// A bookmark lands plain, or through the agent when asked (0194). The agent
// path writes into the knowledgebase only, so it stays knowledge-bound.
ipcMain.handle('kb-bookmark', async (event, projectName, folder, url, tags, processIt, root) => {
  const project = kb(projectName);
  if (processIt && knowledge.normalizeRoot(root) === 'knowledge') {
    return pipeline.bookmarkDoc(project, folder, url, tags);
  }
  try {
    knowledge.saveBookmark(project.boardRoot, folder, url, tags, root);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle('kb-backlinks', (event, projectName, docName, root) =>
  knowledge.backlinks(kb(projectName).boardRoot, docName, root)
);
ipcMain.handle('kb-read', (event, projectName, docPath, root) =>
  knowledge.read(kb(projectName).boardRoot, docPath, root)
);
ipcMain.handle('kb-write', (event, projectName, docPath, body, root) =>
  knowledge.write(kb(projectName).boardRoot, docPath, body, root)
);
ipcMain.handle('kb-create', (event, projectName, folder, name, root) =>
  knowledge.createDoc(kb(projectName).boardRoot, folder, name, root)
);
ipcMain.handle('kb-create-folder', (event, projectName, name, root) =>
  knowledge.createFolder(kb(projectName).boardRoot, name, root)
);
ipcMain.handle('kb-rename', (event, projectName, docPath, newName, root) =>
  knowledge.renameDoc(kb(projectName).boardRoot, docPath, newName, root)
);
ipcMain.handle('kb-delete', (event, projectName, docPath, root) =>
  knowledge.removeDoc(kb(projectName).boardRoot, docPath, root)
);

ipcMain.handle('kb-remove-folder', (event, projectName, folderName, root) =>
  knowledge.removeFolder(kb(projectName).boardRoot, folderName, root)
);
ipcMain.handle('kb-reorder', (event, projectName, folder, names, root) =>
  knowledge.setOrder(kb(projectName).boardRoot, folder, names, root)
);
ipcMain.handle('kb-rename-folder', (event, projectName, folderName, newName, root) =>
  knowledge.renameFolder(kb(projectName).boardRoot, folderName, newName, root)
);
ipcMain.handle('kb-move', (event, projectName, docPath, folder, root) =>
  knowledge.moveDoc(kb(projectName).boardRoot, docPath, folder, root)
);
ipcMain.handle('kb-folder-order', (event, projectName, names, root) =>
  knowledge.setFolderOrder(kb(projectName).boardRoot, names, root)
);
// Reveal goes through read() so the path is proven to be a doc inside this
// project's knowledgebase before Finder ever sees it.
ipcMain.handle('kb-reveal', (event, projectName, docPath, root) => {
  const doc = knowledge.read(kb(projectName).boardRoot, docPath, root);
  shell.showItemInFolder(doc.path);
  return true;
});
ipcMain.handle('kb-note-current', (event, projectName, docPath, root) =>
  knowledge.noteCurrent(kb(projectName).boardRoot, docPath, root)
);

ipcMain.handle('kb-research', async (event, projectName, folder, topic) => {
  try {
    return await pipeline.researchDoc(kb(projectName), folder, topic);
  } catch (err) {
    return { ok: false, error: err.message };
  }
});


// ── Sessions ──

sessions.setSender((id, kind, data) => {
  sendToRenderer('terminal-event', { id, kind, data });
});

ipcMain.handle('start-card', async (event, projectName, cardPath) => {
  if (!cardPathOk(cardPath, projectName)) return { error: 'path-outside-root' };
  const project = projects.find(projectName);
  if (!project) throw new Error(`Unknown project: ${projectName}`);

  const onProgress = (step, detail) => {
    sendToRenderer('start-progress', { cardPath, step, detail });
  };

  try {
    return await pipeline.startCard(project, cardPath, onProgress);
  } catch (err) {
    return { error: err.message };
  }
});

// A plain shell in the project folder, for the sessionless case. A suffix
// makes it one of the standalone terminals — any number can run at once,
// each its own tmux session, none tied to a card.
ipcMain.handle('open-shell', (event, projectName, suffix, opts = {}) => {
  const project = projects.find(projectName);
  if (!project) throw new Error(`Unknown project: ${projectName}`);
  const id = suffix ? `${project.name}-shell-${suffix}` : `${project.name}-shell`;
  try {
    // An orphaned pty from a previous renderer life streams to nobody; drop
    // it (tmux keeps the shell) so the fresh attach repaints.
    if (sessions.has(id)) sessions.stop(id);
    const started = sessions.start(id, project.path, {
      command: opts.command,
      prefill: Boolean(opts.prefill),
      env: pipeline.flowEnv(project),
      tmuxName: `flow-${id}`,
    });
    // Whether this shell already existed in tmux matters to the caller
    // (0229): a fresh one that never gets used is worth cleaning up; a
    // reattached one carries history and is always kept.
    return { sessionId: id, cwd: project.path, reattached: started.reattached };
  } catch (err) {
    return { error: err.message };
  }
});

// A Doing card's modal pane shows the work itself (0230): when the card's
// own tmux session is alive, attach it — history, running agent and all —
// rather than opening a side shell next to it.
ipcMain.handle('attach-card-session', (event, projectName, cardId) => {
  const project = projects.find(projectName);
  if (!project) throw new Error(`Unknown project: ${projectName}`);
  const id = `${project.name}-${cardId}`;
  if (!sessions.tmuxSessionExists(`flow-${id}`)) return { missing: true };
  try {
    // An orphaned pty from a previous renderer life streams to nobody; drop
    // it (tmux keeps the shell) so the fresh attach repaints.
    if (sessions.has(id)) sessions.stop(id);
    sessions.start(id, project.path, { tmuxName: `flow-${id}` });
    return { sessionId: id, reattached: true };
  } catch (err) {
    return { error: err.message };
  }
});

// Each project keeps one persistent terminal beside its board, for work that
// belongs to no card: loops, one-off commands, extra Claude sessions. The
// session is the project's own — switching projects or restarting the app
// reattaches to the same tmux shell with its history intact. Only the pane's
// close button ends it outright. The renderer passes the project name because
// the active project is its state, not the main process's.
// `kind` picks the room: the board's own session, or the Docs view's — a
// different tmux session, so the two rooms stop sharing one terminal.
ipcMain.handle('open-global-terminal', (event, projectName, kind) => {
  const project = projects.find(projectName);
  if (!project) throw new Error(`Unknown project: ${projectName}`);
  const id = kind === 'board' ? project.name : `${project.name}-${kind}`;
  try {
    // A pty surviving from a previous renderer life is an orphan streaming to
    // nobody. Drop it (tmux keeps the shell) so the fresh attach repaints.
    if (sessions.has(id)) sessions.stop(id);

    // The docs and insights terminals are vault residents: each starts in
    // its own root with the docs brief in its system prompt and the repo
    // added read-side, so a report can cross-reference code without cd'ing.
    // The board terminal stays a plain shell in the repo.
    let cwd = project.path;
    const cli = config.cli();
    let command = cli;
    if (kind === 'docs' || kind === 'insights') {
      const rootName = kind === 'insights' ? 'insights' : 'knowledge';
      cwd = knowledge.ensure(project.boardRoot, rootName);
      command = `${cli} --add-dir ${JSON.stringify(project.path)} --append-system-prompt ${JSON.stringify(
        pipeline.docsContext(project, rootName)
      )}`;
    }

    sessions.start(id, cwd, {
      command,
      env: pipeline.flowEnv(project),
      tmuxName: `flow-${id}`,
    });
    return { sessionId: id, cwd };
  } catch (err) {
    return { error: err.message };
  }
});

// Whether a project's global terminal is actually alive in tmux. The renderer
// asks before auto-opening the pane on a project switch: open should mean the
// session is running, not that a pane happened to be up somewhere else.
ipcMain.handle('global-terminal-running', (event, projectName) => {
  const project = projects.find(projectName);
  if (!project) return false;
  return sessions.tmuxSessionExists(`flow-${project.name}`);
});


ipcMain.handle('stop-server', (event, projectName, cardPath) => {
  if (!cardPathOk(cardPath, projectName)) return { error: 'path-outside-root' };
  const project = projects.find(projectName);
  if (!project) throw new Error(`Unknown project: ${projectName}`);
  const card = cardPath ? board.readCardAt(cardPath) : { id: 'server', worktree: '', port: '' };
  return pipeline.stopServer(project, card);
});


ipcMain.handle('update-project', (event, projectName, changes) =>
  projects.update(projectName, changes)
);


// Whether the CLIs Shape / Draft / sessions need are actually on this Mac.
// First-time users open this from Global settings when a button sits still.
ipcMain.handle('cli-status', () => cli.diagnose());

// Shapes a raw card on a small model. Several can run at once — each is its own
// process, so parallelism costs nothing here.
ipcMain.handle('shape-card', async (event, projectName, cardPath) => {
  if (!cardPathOk(cardPath, projectName)) return { error: 'path-outside-root' };
  const project = projects.find(projectName);
  if (!project) throw new Error(`Unknown project: ${projectName}`);
  try {
    // Text streams back to the window as the model writes it, so a clicked
    // card can show the shape forming. The window can close mid-shape; the
    // shape itself carries on and lands in the file either way.
    return await pipeline.shapeCard(project, cardPath, (text) => {
      if (!event.sender.isDestroyed()) event.sender.send('shape-stream', { cardPath, text });
    });
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Runs a background review over a card's worktree and appends it to the card.
ipcMain.handle('review-card', async (event, projectName, cardPath, reviewer) => {
  if (!cardPathOk(cardPath, projectName)) return { error: 'path-outside-root' };
  const project = projects.find(projectName);
  if (!project) throw new Error(`Unknown project: ${projectName}`);
  try {
    return await pipeline.reviewCard(project, cardPath, reviewer);
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Drafts a card's plan in the background, before it is started.
ipcMain.handle('plan-card', async (event, projectName, cardPath) => {
  if (!cardPathOk(cardPath, projectName)) return { error: 'path-outside-root' };
  const project = projects.find(projectName);
  if (!project) throw new Error(`Unknown project: ${projectName}`);
  try {
    return await pipeline.planCard(project, cardPath);
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Closing a tab frees the server and its port but keeps the worktree, branch
// and pull request.
ipcMain.handle('close-card', (event, projectName, cardPath) => {
  if (!cardPathOk(cardPath, projectName)) return null;
  const project = projects.find(projectName);
  if (!project || !cardPath) return null;
  try {
    return pipeline.closeCard(project, cardPath);
  } catch (err) {
    return { error: err.message };
  }
});

// A card dragged out of doing stops what it was running — server, port,
// session shell — while the worktree, branch and PR stay for a later resume.
ipcMain.handle('pause-card', (event, projectName, cardPath) => {
  if (!cardPathOk(cardPath, projectName)) return null;
  const project = projects.find(projectName);
  if (!project || !cardPath) return null;

  const onProgress = (step, detail) => {
    sendToRenderer('start-progress', { cardPath, step, detail });
  };

  try {
    return pipeline.pauseCard(project, cardPath, onProgress);
  } catch (err) {
    return { error: err.message };
  }
});



// Cards started before pr_url existed only carry the number. Ask GitHub once
// and write the url back so the link panel has something to point at.
ipcMain.handle('backfill-pr-url', (event, projectName, cardPath) => {
  if (!cardPathOk(cardPath, projectName)) return null;
  const project = projects.find(projectName);
  if (!project) return null;

  const card = board.readCardAt(cardPath);
  if (!card.pr || card.pr_url) return card.pr_url || null;

  const state = git.prState(project.path, card.pr);
  if (!state || !state.url) return null;

  board.patchCard(cardPath, { pr_url: state.url });
  return state.url;
});





// Every Flow tmux session, labelled with the project and card it belongs to so
// the list reads as work, not tmux names. A `flow-<project>-<id>` is a card, a
// bare `flow-<project>` the project's own terminal.
ipcMain.handle('list-terminal-sessions', () => {
  const known = projects.read();
  return sessions.listTmux().map((row) => {
    const rest = row.name.replace(/^flow-/, '');
    const project = known.find((p) => rest === p.name || rest.startsWith(`${p.name}-`));
    let label;
    if (!project) {
      label = rest;
    } else if (rest === project.name) {
      label = `${project.title} · terminal`;
    } else {
      const tail = rest.slice(project.name.length + 1);
      label =
        tail === 'shell' || tail.startsWith('shell-')
          ? `${project.title} · terminal`
          : tail === 'docs'
            ? `${project.title} · docs terminal`
            : `${project.title} · card ${tail}`;
    }
    return { ...row, project: project ? project.name : '', label };
  });
});

ipcMain.handle('end-terminal-session', (event, name) => {
  // Drop any registered pty on this session first, then kill the tmux side.
  for (const id of sessions.list()) {
    if (`flow-${id}` === name) sessions.stop(id, { killTmux: true });
  }
  return sessions.killByName(name);
});

ipcMain.on('terminal-input', (event, id, data) => sessions.write(id, data));
ipcMain.on('terminal-resize', (event, id, cols, rows) => sessions.resize(id, cols, rows));
ipcMain.on('terminal-stop', (event, id) => sessions.stop(id));
// The global terminal ends outright when its pane closes, so reopening it is
// always a fresh shell rather than yesterday's leftovers.
ipcMain.on('terminal-kill', (event, id) => sessions.stop(id, { killTmux: true }));

// ── Board watching ──

function watchBoards() {
  if (boardWatcher) boardWatcher.close();

  const roots = projects.read().map((p) => p.boardRoot);
  for (const root of roots) board.ensureBoard(root);

  boardWatcher = chokidar.watch(roots, {
    ignored: /(^|[/\\])\./,
    persistent: true,
    ignoreInitial: true,
    depth: 3,
  });

  // One burst, one refresh (0329): events coalesce for a quiet beat before
  // a single batch reaches the renderer.
  const coalescer = watchCoalesce.createCoalescer((batch) =>
    sendToRenderer('board-changed', batch)
  );
  boardWatcher.on('all', (event, filePath) => coalescer.add(event, filePath));
}

ipcMain.handle('watch-boards', () => {
  watchBoards();
  return true;
});

// ── App lifecycle ──

app.whenReady().then(() => {
  // The format gate (0362): a root written by a newer Flow is refused
  // politely instead of being rewritten by an older understanding of it.
  try {
    const format = require('./src/main/format');
    const state = format.status(flowRoot.FLOW_ROOT);
    if (state.newer) {
      dialog.showErrorBox(
        'This board folder is from a newer Flow',
        `It is format ${state.version}; this build only knows ${state.current}. Update Flow, then open it again.`
      );
      app.quit();
      return;
    }
    // A clean current root gets its marker so the future can tell.
    if (!fs.existsSync(format.markerFile(flowRoot.FLOW_ROOT))) {
      format.stamp(flowRoot.FLOW_ROOT, format.CURRENT);
    }
  } catch (err) {
    // The gate must not stop a launch it cannot evaluate.
  }
  // Reconcile the process registry (0333): records with no exit whose pid
  // died (or was reused) while the app was away get closed as orphaned.
  try {
    const orphaned = require('./src/main/proc-registry').sweep();
    if (orphaned.length) console.log('[registry] closed orphaned records:', orphaned.join(', '));
  } catch (err) {
    // The sweep must never block launch.
  }
  logCrash(
    'launch',
    `commit ${launchedFrom.commit || 'unknown'} on ${launchedFrom.branch || 'unknown'} · electron ${process.versions.electron} · dumps in ${app.getPath('crashDumps')}`
  );
  buildMenu();
  if (flowRoot.NEEDS_SETUP) {
    createSetupWindow();
    return;
  }
  createWindow();

  // Dev updates announce, they don't act (0228, superseding the 0214-era
  // auto-reload): an agent working in this repo saves dozens of times an
  // hour, and every save used to bounce the window — or relaunch the whole
  // app into the Dock again. The watcher now only marks an update as
  // pending and tells the renderer, which wears a quiet Update pill; the
  // reload or relaunch happens when the user clicks it. `projects/` is
  // excluded — a card edit is content, not code. Real paths only, no
  // globs: chokidar 4 dropped glob support, and the original glob patterns
  // here watched files literally named "*.js" — matching nothing, firing
  // never.
  // Packaged builds ask GitHub whether a bigger Flow exists (0308); the
  // few-second delay keeps launch itself network-free.
  if (app.isPackaged) setTimeout(checkForRelease, 5000);

  if (!app.isPackaged && !process.env.FLOW_SHOT) {
    const appSrcWatcher = chokidar.watch(
      [
        'main.js',
        'preload.js',
        'index.html',
        'setup.html',
        'lib',
        'src',
      ].map((entry) => path.join(__dirname, entry)),
      {
        ignoreInitial: true,
        ignored: /node_modules|\.git|[/\\]projects[/\\]/,
        // Polling, deliberately: fsevents delivery depends on how the app
        // was launched (a LaunchServices `open` gets none), and a watcher
        // that only works from some launches is how stale instances
        // happen. A poll over this small set costs nothing.
        usePolling: true,
        interval: 1200,
      }
    );

    appSrcWatcher.on('change', (changedPath) => {
      const file = path.basename(changedPath);
      // Only the main process's own code forces a relaunch; src/renderer
      // (0239) reloads like any renderer file.
      const isMain =
        file === 'main.js' ||
        file === 'preload.js' ||
        changedPath.includes(`${path.sep}src${path.sep}main${path.sep}`);

      pendingDevUpdate.main = pendingDevUpdate.main || isMain;
      pendingDevUpdate.files.add(file);
      console.log(`[dev-update] ${file} changed — update pending`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('dev-update', {
          main: pendingDevUpdate.main,
          count: pendingDevUpdate.files.size,
        });
      }
    });
  }
});

// ── Release updates (0308) ──
// A packaged build checks GitHub once, shortly after launch. The nag fires
// only for a major or minor bump — a patch release is a quiet fix, not an
// errand — and clicking the pill opens the download page; nothing installs
// itself (unsigned builds can't self-update on macOS anyway).
const RELEASES_API = 'https://api.github.com/repos/AaronRutley/flow/releases/latest';
const RELEASES_PAGE = 'https://github.com/AaronRutley/flow/releases/latest';

function versionParts(v) {
  const m = String(v || '')
    .replace(/^v/, '')
    .match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? { major: +m[1], minor: +m[2], patch: +m[3] } : null;
}

function updateWorthNagging(current, latest) {
  const a = versionParts(current);
  const b = versionParts(latest);
  if (!a || !b) return false;
  if (b.major !== a.major) return b.major > a.major;
  return b.minor > a.minor;
}

async function checkForRelease() {
  try {
    const res = await fetch(RELEASES_API, { headers: { 'user-agent': 'flow-app' } });
    if (!res.ok) return;
    const release = await res.json();
    const latest = release.tag_name || release.name;
    if (updateWorthNagging(app.getVersion(), latest) && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('release-update', {
        version: String(latest).replace(/^v/, ''),
        current: app.getVersion(),
        // The first lines of the release notes ride along (0342), so the
        // pill can say what is in the update before anyone clicks out.
        notes: String(release.body || '').slice(0, 400),
        url: release.html_url || RELEASES_PAGE,
      });
    }
  } catch (err) {
    // Offline or rate-limited: silence. The next launch checks again.
  }
}

// What has changed on disk since this instance loaded. The renderer's
// Update pill applies it: a renderer-only change reloads the page, a
// main-process change relaunches the app — once, on purpose.
const pendingDevUpdate = { main: false, files: new Set() };

ipcMain.handle('dev-update-apply', () => {
  if (!pendingDevUpdate.files.size) return false;
  if (pendingDevUpdate.main) {
    // quit(), never exit(): exit skips before-quit, leaving live ptys
    // to abort the process from inside node-pty during teardown (0214).
    app.relaunch();
    app.quit();
    return true;
  }
  pendingDevUpdate.files.clear();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.reloadIgnoringCache();
  }
  return true;
});

app.on('before-quit', () => {
  // Detach rather than kill: tmux keeps every card's shell alive for next
  // launch. Immediate, not deferred — a pty living past this point fires
  // its callback into a dying JS environment and aborts the app (0214).
  sessions.stopAll({ immediate: true });
  if (boardWatcher) {
    boardWatcher.close();
    boardWatcher = null;
  }
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    if (flowRoot.NEEDS_SETUP) createSetupWindow();
    else createWindow();
  }
});
