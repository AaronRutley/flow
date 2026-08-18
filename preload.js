const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Projects
  listProjects: () => ipcRenderer.invoke('list-projects'),
  addProject: () => ipcRenderer.invoke('add-project'),
  removeProject: (projectName) => ipcRenderer.invoke('remove-project', projectName),
  pickProjectIcon: (projectName) => ipcRenderer.invoke('pick-project-icon', projectName),

  // Cards
  listCards: (projectName) => ipcRenderer.invoke('list-cards', projectName),
  createCard: (projectName, title) => ipcRenderer.invoke('create-card', projectName, title),
  moveCard: (projectName, cardPath, toColumn) =>
    ipcRenderer.invoke('move-card', projectName, cardPath, toColumn),
  transferCard: (projectName, cardPath, targetProjectName) =>
    ipcRenderer.invoke('transfer-card', projectName, cardPath, targetProjectName),
  reorderColumn: (projectName, column, orderedPaths) =>
    ipcRenderer.invoke('reorder-column', projectName, column, orderedPaths),
  readCard: (cardPath) => ipcRenderer.invoke('read-card', cardPath),
  archiveCard: (projectName, cardPath) =>
    ipcRenderer.invoke('archive-card', projectName, cardPath),
  recordStartupMarks: (marks) => ipcRenderer.invoke('startup-marks', marks),
  copyDiagnostics: () => ipcRenderer.invoke('copy-diagnostics'),
  linkOpen: (url, bounds) => ipcRenderer.invoke('link-open', url, bounds),
  linkBounds: (bounds) => ipcRenderer.invoke('link-bounds', bounds),
  linkClose: () => ipcRenderer.invoke('link-close'),
  readSettings: () => ipcRenderer.invoke('read-settings'),
  appVersion: () => ipcRenderer.invoke('app-version'),
  writeSettings: (changes) => ipcRenderer.invoke('write-settings', changes),
  sessionCli: () => ipcRenderer.invoke('session-cli'),
  resolveCommand: (command) => ipcRenderer.invoke('resolve-command', command),
  shapeDefaults: () => ipcRenderer.invoke('shape-defaults'),
  sessionIdle: (id) => ipcRenderer.invoke('session-idle', id),
  listTerminalSessions: () => ipcRenderer.invoke('list-terminal-sessions'),
  endTerminalSession: (name) => ipcRenderer.invoke('end-terminal-session', name),
  saveAttachment: (projectName, cardId, bytes) =>
    ipcRenderer.invoke('save-attachment', projectName, cardId, bytes),
  adoptAttachments: (projectName, cardPath) =>
    ipcRenderer.invoke('adopt-attachments', projectName, cardPath),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  writeCardBody: (cardPath, body) => ipcRenderer.invoke('write-card-body', cardPath, body),
  patchCard: (cardPath, changes) => ipcRenderer.invoke('patch-card', cardPath, changes),

  // Sessions
  startCard: (projectName, cardPath) => ipcRenderer.invoke('start-card', projectName, cardPath),
  attachCardSession: (projectName, cardId) =>
    ipcRenderer.invoke('attach-card-session', projectName, cardId),
  planCard: (projectName, cardPath) => ipcRenderer.invoke('plan-card', projectName, cardPath),
  shapeCard: (projectName, cardPath) => ipcRenderer.invoke('shape-card', projectName, cardPath),
  cliStatus: () => ipcRenderer.invoke('cli-status'),
  reviewCard: (projectName, cardPath, reviewer) =>
    ipcRenderer.invoke('review-card', projectName, cardPath, reviewer),
  openShell: (projectName, suffix, opts) => ipcRenderer.invoke('open-shell', projectName, suffix, opts),
  currentBranch: (projectName) => ipcRenderer.invoke('current-branch', projectName),
  cardSessionLog: (projectName, cardPath, reveal) =>
    ipcRenderer.invoke('card-session-log', projectName, cardPath, reveal),
  openGlobalTerminal: (projectName, kind) =>
    ipcRenderer.invoke('open-global-terminal', projectName, kind),
  globalTerminalRunning: (projectName) =>
    ipcRenderer.invoke('global-terminal-running', projectName),
  stopServer: (projectName, cardPath) => ipcRenderer.invoke('stop-server', projectName, cardPath),
  updateProject: (projectName, changes) =>
    ipcRenderer.invoke('update-project', projectName, changes),
  closeCard: (projectName, cardPath) => ipcRenderer.invoke('close-card', projectName, cardPath),
  pauseCard: (projectName, cardPath) => ipcRenderer.invoke('pause-card', projectName, cardPath),
  backfillPrUrl: (projectName, cardPath) =>
    ipcRenderer.invoke('backfill-pr-url', projectName, cardPath),

  // Knowledgebase. The trailing root ('knowledge' | 'insights') picks the
  // vault; absent means the knowledgebase (0385).
  kbList: (projectName, root) => ipcRenderer.invoke('kb-list', projectName, root),
  kbAllDocs: (projectName, root) => ipcRenderer.invoke('kb-all-docs', projectName, root),
  kbBacklinks: (projectName, docName, root) =>
    ipcRenderer.invoke('kb-backlinks', projectName, docName, root),
  kbRead: (projectName, docPath, root) => ipcRenderer.invoke('kb-read', projectName, docPath, root),
  kbWrite: (projectName, docPath, body, root) =>
    ipcRenderer.invoke('kb-write', projectName, docPath, body, root),
  kbCreate: (projectName, folder, name, root) =>
    ipcRenderer.invoke('kb-create', projectName, folder, name, root),
  kbCreateFolder: (projectName, name, root) =>
    ipcRenderer.invoke('kb-create-folder', projectName, name, root),
  kbRename: (projectName, docPath, newName, root) =>
    ipcRenderer.invoke('kb-rename', projectName, docPath, newName, root),
  kbDelete: (projectName, docPath, root) =>
    ipcRenderer.invoke('kb-delete', projectName, docPath, root),
  kbRemoveFolder: (projectName, folderName, root) =>
    ipcRenderer.invoke('kb-remove-folder', projectName, folderName, root),
  kbRenameFolder: (projectName, folderName, newName, root) =>
    ipcRenderer.invoke('kb-rename-folder', projectName, folderName, newName, root),
  kbMove: (projectName, docPath, folder, root) =>
    ipcRenderer.invoke('kb-move', projectName, docPath, folder, root),
  kbFolderOrder: (projectName, names, root) =>
    ipcRenderer.invoke('kb-folder-order', projectName, names, root),
  kbReorder: (projectName, folder, names, root) =>
    ipcRenderer.invoke('kb-reorder', projectName, folder, names, root),
  kbReveal: (projectName, docPath, root) =>
    ipcRenderer.invoke('kb-reveal', projectName, docPath, root),
  kbSearch: (projectName, term, root) => ipcRenderer.invoke('kb-search', projectName, term, root),
  kbBookmark: (projectName, folder, url, tags, processIt, root) =>
    ipcRenderer.invoke('kb-bookmark', projectName, folder, url, tags, processIt, root),
  kbNoteCurrent: (projectName, docPath, root) =>
    ipcRenderer.invoke('kb-note-current', projectName, docPath, root),
  kbResearch: (projectName, folder, topic) =>
    ipcRenderer.invoke('kb-research', projectName, folder, topic),



  sendTerminalInput: (id, data) => ipcRenderer.send('terminal-input', id, data),
  sendTerminalResize: (id, cols, rows) => ipcRenderer.send('terminal-resize', id, cols, rows),
  stopTerminal: (id) => ipcRenderer.send('terminal-stop', id),
  killTerminal: (id) => ipcRenderer.send('terminal-kill', id),

  // Events
  onTerminalEvent: (callback) =>
    ipcRenderer.on('terminal-event', (event, payload) => callback(payload)),
  onStartProgress: (callback) =>
    ipcRenderer.on('start-progress', (event, payload) => callback(payload)),
  onBoardChanged: (callback) =>
    ipcRenderer.on('board-changed', (event, payload) => callback(payload)),
  onShapeStream: (callback) =>
    ipcRenderer.on('shape-stream', (event, payload) => callback(payload)),
  onCloseTab: (callback) => ipcRenderer.on('close-tab', () => callback()),
  onNewCard: (callback) => ipcRenderer.on('new-card', () => callback()),
  onOpenPreferences: (callback) => ipcRenderer.on('open-preferences', () => callback()),
  onDevUpdate: (callback) => ipcRenderer.on('dev-update', (event, payload) => callback(payload)),
  applyDevUpdate: () => ipcRenderer.invoke('dev-update-apply'),
  onReleaseUpdate: (callback) =>
    ipcRenderer.on('release-update', (event, payload) => callback(payload)),

  closeWindow: () => ipcRenderer.invoke('close-window'),

  handshake: () => ipcRenderer.invoke('renderer-main-handshake'),

  watchBoards: () => ipcRenderer.invoke('watch-boards'),

  // First launch: pick the folder flow keeps its files in.
  chooseFlowRoot: () => ipcRenderer.invoke('choose-flow-root'),
});
