// ── The link pane (0408) ──
// Insights links open inside Flow again — but not through <webview>, which
// 0317 turned off for good reason. This is the hardened shape: one
// WebContentsView owned by the main process, laid over the doc pane at
// bounds the renderer reports. The page runs sandboxed in its own storage
// partition with no preload and no permissions; navigation and popups are
// fenced to http(s) by the same policy as every other exit (0316).
const { WebContentsView, session } = require('electron');
const { isSafeExternalUrl } = require('./urls');

let view = null;
let host = null;

function ensureView(mainWindow) {
  if (view) return view;
  host = mainWindow;

  const ses = session.fromPartition('link-pane');
  // A page in the pane asks for nothing: no camera, mic, location, or
  // notifications — silently denied rather than prompted.
  ses.setPermissionRequestHandler((wc, permission, callback) => callback(false));

  view = new WebContentsView({
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'link-pane',
    },
  });

  const wc = view.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    // target=_blank stays in the pane; anything unsafe goes nowhere.
    if (isSafeExternalUrl(url)) wc.loadURL(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (event, url) => {
    if (!isSafeExternalUrl(url)) event.preventDefault();
  });
  // Cmd+[ and Cmd+] page back and forward, the browser muscle memory.
  wc.on('before-input-event', (event, input) => {
    if (!input.meta || input.type !== 'keyDown') return;
    if (input.key === '[' && wc.navigationHistory.canGoBack()) {
      wc.navigationHistory.goBack();
      event.preventDefault();
    }
    if (input.key === ']' && wc.navigationHistory.canGoForward()) {
      wc.navigationHistory.goForward();
      event.preventDefault();
    }
  });

  return view;
}

function roundBounds(bounds) {
  return {
    x: Math.round(bounds.x || 0),
    y: Math.round(bounds.y || 0),
    width: Math.max(0, Math.round(bounds.width || 0)),
    height: Math.max(0, Math.round(bounds.height || 0)),
  };
}

function open(mainWindow, url, bounds) {
  if (!isSafeExternalUrl(url)) return false;
  const v = ensureView(mainWindow);
  mainWindow.contentView.addChildView(v);
  v.setBounds(roundBounds(bounds));
  v.webContents.loadURL(url);
  return true;
}

function setBounds(bounds) {
  if (view) view.setBounds(roundBounds(bounds));
}

function close() {
  if (!view || !host) return;
  try {
    host.contentView.removeChildView(view);
    // Blank the page so audio/timers stop and the last site is not kept
    // warm off-screen.
    view.webContents.loadURL('about:blank');
  } catch (err) {
    // The window may be tearing down; nothing left to detach.
  }
}

module.exports = { open, setBounds, close };
