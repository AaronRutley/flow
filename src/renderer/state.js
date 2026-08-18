// ── State ──
let projects = [];
let activeProject = null;
let cards = [];
let showAllDone = false;
let searchTerm = '';
// The branch the project's checkout is on, refreshed with each board load —
// it names checkout work in the Done column (0193).
let projectBranch = '';
// Live tmux session names, refreshed with the board: a Doing card whose
// session is running wears the working orb (0195).
let aliveTmux = new Set();

// Cards the board terminal's agent is working on (0219). The clear-todos goal
// moves each card into Doing while it works it, so a card that *arrives* in
// Doing from an outside edit — a file move the app didn't make — while the
// board terminal is attached is being worked, and wears the orb until it
// leaves the column. Dragging into Doing stays just a move (0217): the drop
// handler records its own moves so they never light up.
const agentWorking = new Set(); // card ids
const dragMovedIds = new Set(); // ids the next board load must not mark
let prevColumns = new Map(); // id -> column, from the previous load

// One open session per card, keyed by session id.
const openSessions = new Map();
let activeSessionId = null;
let saveTimeout = null;

// ── Startup marks (0326) ──
// Named milestones from script start to a working board, kept cheap enough
// to ship enabled. init.js prints the one-line summary when the board is up;
// later performance work is measured against these, not against feelings.
const startupMarks = [];
function startupMark(name) {
  startupMarks.push([name, Math.round(performance.now())]);
}
function startupSummary() {
  return startupMarks.map(([name, at]) => `${name}:${at}ms`).join(' ');
}
startupMark('scripts-start');

const md = window.marked.marked || window.marked;

// One door from markdown to the DOM (0319): marked parses, DOMPurify strips
// anything executable before innerHTML ever sees it. The html-only profile
// drops SVG and MathML wholesale — cards and docs never need them, and
// malicious SVG is a classic smuggling route. javascript: and data: script
// URLs die in the same pass; the app's own delegated click handling and the
// main process's URL policy (0316) decide where surviving links go.
function renderMarkdown(text) {
  return window.DOMPurify.sanitize(md.parse(text || ''), {
    USE_PROFILES: { html: true },
  });
}
md.setOptions({ breaks: true, gfm: true });

const turndownService = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
});

turndownService.addRule('lineBreaks', {
  filter: 'br',
  replacement: () => '  \n',
});

// Typing Enter in a contenteditable makes a <div> per line, and turndown's
// default treatment keeps a div's contents with no break — which is how a
// doc's paragraphs merged into one on save (0208). A div is a block.
turndownService.addRule('divBlocks', {
  filter: 'div',
  replacement: (content) => (content.trim() ? `\n${content}\n` : ''),
});

// Turndown escapes anything that could be read as markdown — `**Context:**`
// comes back as `\*\*Context:\*\*`. In a round trip that is corruption: the
// next render shows the backslashes instead of bold text, and every save adds
// more. These files are markdown by definition, so nothing needs escaping.
turndownService.escape = (text) => text;

// A card body that was already saved through the escaping version has to be
// repaired on the way in, or it stays broken forever.
function unescapeMarkdown(body) {
  return String(body || '').replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, '$1');
}

const $ = (id) => document.getElementById(id);
const icon = (name, size) => window.icon(name, size);

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

// Binding through these means markup can change without a missing element
// taking the whole renderer down on load — which is exactly what a stray
// `$('gone').addEventListener` does.
function on(id, event, handler) {
  const el = $(id);
  if (el) el.addEventListener(event, handler);
  return el;
}

function paint(selector, html) {
  const el = document.querySelector(selector);
  if (el) el.innerHTML = html;
}

// Long absolute paths read better shortened to ~ and ellipsized at the end,
// instead of RTL-truncated where the leading slash ends up trailing.
function tildePath(value) {
  return String(value || '').replace(/^\/Users\/[^/]+/, '~');
}

// ── Section names (0241) ──
// The three sections wear fixed names (0420: renaming is off for now —
// stored custom names are cleared at launch and the inputs left the
// Appearance area). Display only: the folders on disk (board columns,
// knowledgebase) keep their real names.
const SECTION_DEFAULTS = { planning: 'Planning', development: 'Development' };

function sectionName(id) {
  return SECTION_DEFAULTS[id] || id;
}

function applySectionNames() {
  paint('#tab-docs', `${icon('file', 17)}<span>${escapeHtml(sectionName('planning'))}</span>`);
  paint('#tab-board', `${icon('kanban', 17)}<span>${escapeHtml(sectionName('development'))}</span>`);
  paint('#tab-insights', `${icon('analytics', 17)}<span>Analytics</span>`);
}

// ── Escape leaves no residue (0277) ──
// Esc closes things all over the app, and the button or link that had
// focus would sit there wearing its focus/active dressing afterwards.
// Fields are exempt: their own Escape handling (rename revert, switcher
// close) owns the key, and blurring under them would fight it.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const el = document.activeElement;
  if (el && (el.tagName === 'BUTTON' || el.tagName === 'A')) el.blur();
});
