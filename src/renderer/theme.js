// ── Theme ──
// Rough perceptual luminance of a hex colour, 0 (black) to 1 (white). Used
// only to decide whether a custom theme reads as light or dark.
function isDarkColor(hex) {
  const m = String(hex).trim().match(/^#?([0-9a-f]{6})$/i);
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5;
}

function getTerminalTheme() {
  const mode = document.documentElement.dataset.theme;

  // Rainbow is the light terminal on warm paper: the inks keep their
  // dark-on-light contrast, only the ground joins the theme.
  if (mode === 'rainbow') {
    return {
      background: '#faf4f1',
      foreground: '#3a3a3a',
      cursor: '#3a3a3a',
      cursorAccent: '#faf4f1',
      selectionBackground: '#ecdce3',
      selectionForeground: '#1f1f1f',
      black: '#3a3a3a',
      red: '#c0384a',
      green: '#3f7d4e',
      yellow: '#8f6200',
      blue: '#2f6f9f',
      magenta: '#8b5fc0',
      cyan: '#2a7a8c',
      white: '#4a4a4a',
      brightBlack: '#767676',
      brightRed: '#c0384a',
      brightGreen: '#3f7d4e',
      brightYellow: '#8f6200',
      brightBlue: '#2f6f9f',
      brightMagenta: '#8b5fc0',
      brightCyan: '#2a7a8c',
      brightWhite: '#1f1f1f',
    };
  }
  // Matrix: phosphor on black. Greens carry the identity; red stays red
  // because an invisible error is worse than a broken aesthetic.
  if (mode === 'matrix') {
    return {
      background: '#030503',
      foreground: '#46f97e',
      cursor: '#46f97e',
      cursorAccent: '#030503',
      selectionBackground: '#134a26',
      selectionForeground: '#c8ffd9',
      black: '#0a140a',
      red: '#ff6b6b',
      green: '#46f97e',
      yellow: '#a8d34a',
      blue: '#38b26a',
      magenta: '#5ce0a1',
      cyan: '#5ce0a1',
      white: '#7dfa9f',
      brightBlack: '#1e7038',
      brightRed: '#ff6b6b',
      brightGreen: '#6cffa0',
      brightYellow: '#c6e96a',
      brightBlue: '#38b26a',
      brightMagenta: '#5ce0a1',
      brightCyan: '#5ce0a1',
      brightWhite: '#d9ffe6',
    };
  }
  return mode === 'dark' ? DARK_TERM : LIGHT_TERM;
}

// Aaron's ghostty palette (ar-styles-light): same hue roles as the dark theme,
// darkened to hold contrast on light paper.
const LIGHT_TERM = {
  background: '#f4f4f4',
  foreground: '#3a3a3a',
  cursor: '#3a3a3a',
  cursorAccent: '#f4f4f4',
  selectionBackground: '#d6dce3',
  selectionForeground: '#1f1f1f',
  black: '#3a3a3a',
  red: '#c0384a',
  green: '#3f7d4e',
  yellow: '#8f6200',
  blue: '#2f6f9f',
  magenta: '#2a7a8c',
  cyan: '#2a7a8c',
  white: '#4a4a4a',
  brightBlack: '#767676',
  brightRed: '#c0384a',
  brightGreen: '#3f7d4e',
  brightYellow: '#8f6200',
  brightBlue: '#2f6f9f',
  brightMagenta: '#2a7a8c',
  brightCyan: '#2a7a8c',
  brightWhite: '#1f1f1f',
};

// Aaron's ghostty palette (ar-styles-dark), so a session here looks like a
// session there: magenta reads blue-teal, diff green and red are softened, and
// dim grey is lifted enough to stay legible.
const DARK_TERM = {
  background: '#141414',
  foreground: '#ffffff',
  cursor: '#ffffff',
  cursorAccent: '#141414',
  selectionBackground: '#303030',
  selectionForeground: '#ffffff',
  black: '#2a2a2a',
  red: '#e06c75',
  green: '#a3d9a5',
  yellow: '#ebcb8b',
  blue: '#81a1c1',
  magenta: '#88c0d0',
  cyan: '#88c0d0',
  white: '#d8dee9',
  brightBlack: '#808080',
  brightRed: '#e06c75',
  brightGreen: '#a3d9a5',
  brightYellow: '#ebcb8b',
  brightBlue: '#81a1c1',
  brightMagenta: '#88c0d0',
  brightCyan: '#88c0d0',
  brightWhite: '#ffffff',
};

// The built-in moods. The custom-theme workshop left for the plugin
// archive (0376); the cycle is the built-ins.
const BUILTIN_THEMES = ['light', 'dark', 'rainbow', 'matrix'];

function themeCycle() {
  return [...BUILTIN_THEMES];
}

function nextTheme(theme) {
  const cycle = themeCycle();
  const at = cycle.indexOf(theme);
  return cycle[(at + 1) % cycle.length];
}

function themeLabel(id) {
  return id;
}

// The toggle crossfades (0405): a short-lived class turns colour
// transitions on everywhere, the theme flips beneath it, and the class
// leaves once the fade lands — so the blend costs nothing outside the
// moment of switching, and reduced-motion users keep the instant flip.
let themeFadeTimer = null;

function fadeThemeSwap(apply) {
  const root = document.documentElement;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    apply();
    return;
  }
  root.classList.add('theme-fading');
  apply();
  if (themeFadeTimer) clearTimeout(themeFadeTimer);
  themeFadeTimer = setTimeout(() => {
    root.classList.remove('theme-fading');
    themeFadeTimer = null;
  }, 320);
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const btn = $('toggle-theme');
  if (btn) {
    // One icon for every theme — a half-filled circle reads as "appearance"
    // whatever the mode, and adding themes never means redrawing the button.
    // The tooltip still says where a click goes.
    btn.innerHTML = icon('contrast', 17);
    btn.title = `Switch to ${themeLabel(nextTheme(theme))} theme`;
  }
  for (const session of openSessions.values()) {
    session.term.options.theme = getTerminalTheme();
  }
  for (const t of Object.values(homeTerms)) {
    if (t) t.term.options.theme = getTerminalTheme();
  }
}

function initTheme() {
  // A chosen theme sticks; before any choice the app opens dark. A saved theme
  // that no longer exists (a deleted custom one) falls back to dark.
  const saved = localStorage.getItem('theme') || 'dark';
  applyTheme(themeCycle().includes(saved) ? saved : 'dark');
}

$('toggle-theme').addEventListener('click', () => {
  const next = nextTheme(document.documentElement.dataset.theme);
  localStorage.setItem('theme', next);
  fadeThemeSwap(() => applyTheme(next));
});

// ── Split resize ──
function initResize() {
  for (const handle of document.querySelectorAll('.resize-handle')) {
    const isBoard = handle.dataset.resize === 'board';
    const paneId = isBoard ? 'board-term-pane' : 'term-pane';

    const refit = () => {
      if (isBoard) {
        const t = currentHomeTerm();
        if (t) fitSession(t);
        return;
      }
      const session = openSessions.get(activeSessionId);
      if (session) fitSession(session);
    };

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      const pane = $(paneId);
      const container = pane.parentElement;
      const startWidth = pane.offsetWidth;
      const startHeight = pane.offsetHeight;
      // Docked along the bottom, the same handle works the other axis.
      const vertical = isBoard && termDock() === 'bottom';
      handle.classList.add('active');

      // The drag used to refit the terminal on every pixel, which is heavy
      // enough that the pane trailed the pointer and never felt like it
      // landed. Size now follows through one animation frame at a time,
      // clamped to sane bounds, parking exactly at half when close — and the
      // terminal itself refits once, on release.
      let width = startWidth;
      let height = startHeight;
      let raf = null;

      const apply = () => {
        raf = null;
        if (vertical) pane.style.height = `${height}px`;
        else pane.style.width = `${width}px`;
      };

      const onMouseMove = (moveEvent) => {
        if (vertical) {
          height = startHeight - (moveEvent.clientY - startY);
          height = Math.max(160, Math.min(height, container.clientHeight * 0.8));
          const half = Math.round(container.clientHeight / 2);
          if (Math.abs(height - half) < 24) height = half;
        } else {
          width = startWidth - (moveEvent.clientX - startX);
          width = Math.max(300, Math.min(width, container.clientWidth * 0.75));
          const half = Math.round(container.clientWidth / 2);
          if (Math.abs(width - half) < 24) width = half;
        }
        if (!raf) raf = requestAnimationFrame(apply);
      };

      const onMouseUp = () => {
        handle.classList.remove('active');
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        if (raf) cancelAnimationFrame(raf);
        apply();
        refit();
        // The board pane keeps its chosen size, per axis, for the next open.
        if (isBoard && vertical) {
          localStorage.setItem(termHeightKey(), String(Math.round(height)));
        } else if (isBoard) {
          localStorage.setItem(termWidthKey(), String(Math.round(width)));
        }
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  }
}

window.addEventListener('resize', () => {
  const session = openSessions.get(activeSessionId);
  if (session) fitSession(session);
  const home = currentHomeTerm();
  if (home) fitSession(home);
  if (modalTerm) fitSession(modalTerm);
});
