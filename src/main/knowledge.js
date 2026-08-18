// The product knowledgebase: markdown files in `00-knowledge/` beside the
// board, grouped one folder deep. The board holds what is happening; this
// holds what the product is.
const fs = require('fs');
const path = require('path');
const board = require('./board');

// One shelf, not six: the context a project runs on, split into what it is and
// how it is built. Seeded once with two guides to fill in, renameable and
// deletable after. The old scattered folders (Strategy, Marketing, and the
// rest) are gone — an empty folder named for a topic is just a prompt to feel
// guilty about.
const SEED_FOLDER = 'Context';

const SEED_DOCS = {
  'Product.md': [
    '# Product',
    '',
    'What this is, who it is for, and how to run it.',
    '',
    '## What it is',
    '',
    '## Who it is for',
    '',
    '## Running it',
    '',
    '## Configuration',
    '',
  ].join('\n'),
  'Engineering.md': [
    '# Engineering',
    '',
    'How the codebase is laid out and how to work on it.',
    '',
    '## Repository layout',
    '',
    '## Developing locally',
    '',
    '## Key flows',
    '',
    '## Dependencies',
    '',
  ].join('\n'),
};

// Two vaults share this module since 0385: the knowledgebase in
// `00-knowledge/` and the insights shelf in `07-analytics/`. Every entry point
// takes a trailing root name; the whitelist keeps an IPC argument from ever
// naming an arbitrary directory.
const ROOTS = { knowledge: 'knowledge', insights: 'insights' };

function normalizeRoot(rootName) {
  return ROOTS[rootName] ? rootName : 'knowledge';
}

function root(boardRoot, rootName) {
  return board.columnDir(boardRoot, normalizeRoot(rootName));
}

function ensure(boardRoot, rootName) {
  const base = root(boardRoot, rootName);
  const fresh = !fs.existsSync(base) || !fs.readdirSync(base).length;
  fs.mkdirSync(base, { recursive: true });
  if (normalizeRoot(rootName) === 'insights') {
    // The vault ships a hidden scripts shelf (0480): dot-named so the menu
    // never lists it, on disk so the agent can keep report-refreshing
    // scripts beside the reports they feed. Existing vaults grow it too.
    const scripts = path.join(base, '.scripts');
    if (!fs.existsSync(scripts)) {
      fs.mkdirSync(scripts, { recursive: true });
      fs.writeFileSync(
        path.join(scripts, 'README.md'),
        [
          '# Scripts',
          '',
          'A working shelf for the analytics vault. Files here never appear',
          'in the app menu — keep the scripts that fetch data and rebuild',
          'the reports in this folder, beside the reports they feed.',
          '',
        ].join('\n'),
        'utf-8'
      );
    }
  }
  if (fresh && normalizeRoot(rootName) === 'insights') {
    // Insights opens with its shelves named and empty — analytics and
    // reports are prompts to fill, not guides to write.
    for (const name of ['analytics', 'reports']) {
      fs.mkdirSync(path.join(base, name), { recursive: true });
    }
  } else if (fresh) {
    const context = path.join(base, SEED_FOLDER);
    fs.mkdirSync(context, { recursive: true });
    for (const [name, body] of Object.entries(SEED_DOCS)) {
      fs.writeFileSync(path.join(context, name), body, 'utf-8');
    }
  }
  return base;
}

// Guards every write path: a caller can only ever touch files under the
// project's own knowledge root. Realpath-resolved since 0315, so a symlink
// planted inside the root cannot point a read or write elsewhere.
const pathGuard = require('./path-guard');
const { atomicWrite, keepHistory } = require('./atomic-write');
const frontmatter = require('./frontmatter');

function within(boardRoot, target, rootName) {
  const base = root(boardRoot, rootName);
  if (!pathGuard.isInside(base, target)) {
    throw new Error('Path is outside the knowledgebase');
  }
  return path.resolve(target);
}

// Markdown for notes, HTML for the richer documents, images for the Inspo
// shelf (0194). All live side by side; the extension decides how the viewer
// renders each.
function isDoc(name) {
  return /\.(md|html|png|jpe?g|gif|webp)$/i.test(name) && !name.startsWith('.');
}

function docName(file) {
  return file.replace(/\.(md|html|png|jpe?g|gif|webp)$/i, '');
}

// The user's drag order, one array of file basenames per folder, in a hidden
// file the watcher and the sidebar both ignore. Files the order has never
// met sort after the ordered ones, alphabetically.
function orderFile(boardRoot, rootName) {
  return path.join(root(boardRoot, rootName), '.order.json');
}

function readOrder(boardRoot, rootName) {
  try {
    return JSON.parse(fs.readFileSync(orderFile(boardRoot, rootName), 'utf-8'));
  } catch (err) {
    return {};
  }
}

function setOrder(boardRoot, folder, names, rootName) {
  const order = readOrder(boardRoot, rootName);
  order[folder || ''] = names;
  atomicWrite(orderFile(boardRoot, rootName), `${JSON.stringify(order, null, 2)}\n`);
  return true;
}

// The folders' own left-to-right (well, top-to-bottom) order, kept under a
// key no real folder can be named (0202).
const FOLDER_ORDER_KEY = '__folders__';

function setFolderOrder(boardRoot, names, rootName) {
  const order = readOrder(boardRoot, rootName);
  order[FOLDER_ORDER_KEY] = names;
  atomicWrite(orderFile(boardRoot, rootName), `${JSON.stringify(order, null, 2)}\n`);
  return true;
}

// Renaming a folder carries its drag orders with it — the files' order under
// the old name, and the folder's own place in the row (0202).
// Folders live lowercase on disk (0299) — "My Research" is the display,
// my-research the directory — so the case a user types is a presentation
// choice, not a filesystem event.
function folderSlug(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/\//g, '');
}

function renameFolder(boardRoot, folderName, newName, rootName) {
  const base = root(boardRoot, rootName);
  const from = String(folderName || '').trim();
  const clean = folderSlug(newName);
  if (!from || from.startsWith('.')) throw new Error('Not a folder that can be renamed');
  if (!clean || clean.startsWith('.')) {
    throw new Error('A folder needs a plain name');
  }
  const src = within(boardRoot, path.join(base, from), rootName);
  const dst = within(boardRoot, path.join(base, clean), rootName);
  if (!fs.statSync(src).isDirectory()) throw new Error('Not a folder that can be renamed');
  if (src === dst) return true;
  // On the Mac's case-insensitive disk, "product" and "Product" are the
  // same directory — a case-only rename is legal, not a clash (0299).
  const sameDir = src.toLowerCase() === dst.toLowerCase();
  if (!sameDir && fs.existsSync(dst)) throw new Error('A folder with that name already exists');
  fs.renameSync(src, dst);

  const order = readOrder(boardRoot, rootName);
  if (order[from]) {
    order[clean] = order[from];
    delete order[from];
  }
  if (Array.isArray(order[FOLDER_ORDER_KEY])) {
    order[FOLDER_ORDER_KEY] = order[FOLDER_ORDER_KEY].map((n) => (n === from ? clean : n));
  }
  atomicWrite(orderFile(boardRoot, rootName), `${JSON.stringify(order, null, 2)}\n`);
  return true;
}

function applyOrder(files, saved) {
  if (!Array.isArray(saved) || !saved.length) return files;
  const rank = new Map(saved.map((name, i) => [name, i]));
  return [...files].sort((a, b) => {
    const ra = rank.has(path.basename(a.path)) ? rank.get(path.basename(a.path)) : Infinity;
    const rb = rank.has(path.basename(b.path)) ? rank.get(path.basename(b.path)) : Infinity;
    if (ra !== rb) return ra - rb;
    return a.name.localeCompare(b.name);
  });
}

// One level of folders, files sorted inside each; loose top-level docs come
// first under the empty folder name. A saved drag order beats the alphabet.
function list(boardRoot, rootName) {
  const base = ensure(boardRoot, rootName);
  const order = readOrder(boardRoot, rootName);
  const tree = [];
  const looseFiles = [];

  for (const entry of fs.readdirSync(base).sort((a, b) => a.localeCompare(b))) {
    if (entry.startsWith('.')) continue;
    // The attachments shelf (0386): files docs point at, parked out of the
    // sidebar. The folder exists to be linked into, not browsed.
    if (entry.toLowerCase() === 'attachments') continue;
    const full = path.join(base, entry);
    if (fs.statSync(full).isDirectory()) {
      const files = fs
        .readdirSync(full)
        .filter(isDoc)
        .sort((a, b) => a.localeCompare(b))
        .map((file) => ({
          name: docName(file),
          path: path.join(full, file),
          mtime: fs.statSync(path.join(full, file)).mtimeMs,
        }));
      tree.push({ folder: entry, files: applyOrder(files, order[entry]) });
    } else if (isDoc(entry)) {
      looseFiles.push({ name: docName(entry), path: full, mtime: fs.statSync(full).mtimeMs });
    }
  }

  // Folders follow their saved order, alphabet for the unranked; loose
  // top-level docs sit under the last folder (0295) — where a fresh doc
  // lands, and where the eye goes after reading the shelves.
  const rank = new Map((order[FOLDER_ORDER_KEY] || []).map((name, i) => [name, i]));
  tree.sort((a, b) => {
    const ra = rank.has(a.folder) ? rank.get(a.folder) : Infinity;
    const rb = rank.has(b.folder) ? rank.get(b.folder) : Infinity;
    if (ra !== rb) return ra - rb;
    return a.folder.localeCompare(b.folder);
  });

  if (looseFiles.length) tree.push({ folder: '', files: applyOrder(looseFiles, order['']) });
  return tree;
}

function read(boardRoot, docPath, rootName) {
  const resolved = within(boardRoot, docPath, rootName);
  const body = fs.readFileSync(resolved, 'utf-8');
  // A bookmark doc opens as the site itself, not as its stub of markdown
  // (0385). New bookmarks carry `kind: bookmark` frontmatter; the regex
  // recognises the old plain form (`# host`, the link, maybe a Tags line).
  if (resolved.endsWith('.md')) {
    const url = bookmarkUrl(body);
    if (url) return { path: resolved, kind: 'bookmark', url, body };
  }
  return {
    path: resolved,
    kind: resolved.endsWith('.html') ? 'html' : 'md',
    body,
  };
}

function bookmarkUrl(body) {
  const fm = frontmatter.parse(body);
  const url = fm.data.kind === 'bookmark' ? String(fm.data.url || '').trim() : legacyBookmarkUrl(body);
  return /^https?:\/\//i.test(url) ? url : null;
}

function legacyBookmarkUrl(body) {
  const match = String(body || '').match(
    /^#[^\n]*\n+(https?:\/\/\S+)\s*(?:\n+Tags:[^\n]*)?\s*$/
  );
  return match ? match[1] : '';
}

// Flat list of every doc, for the quick switcher and for link resolution —
// name plus the folder it sits in.
function allDocs(boardRoot, rootName) {
  const docs = [];
  for (const group of list(boardRoot, rootName)) {
    for (const file of group.files) docs.push({ ...file, folder: group.folder || '' });
  }
  return docs;
}

// Every doc that links to the named one with a `[[wiki link]]`. The scan is a
// plain substring pass over each doc's text — a vault this size is nothing to
// read, and it keeps backlinks honest without an index to maintain.
function backlinks(boardRoot, docName, rootName) {
  const target = String(docName || '').trim().toLowerCase();
  if (!target) return [];
  const found = [];
  for (const doc of allDocs(boardRoot, rootName)) {
    if (doc.name.toLowerCase() === target) continue;
    // An image can be linked to, but holds no [[links]] itself (0203).
    if (!/\.(md|html)$/i.test(doc.path)) continue;
    let body;
    try {
      body = fs.readFileSync(doc.path, 'utf-8');
    } catch (err) {
      continue;
    }
    const links = body.match(/\[\[([^\]]+)\]\]/g) || [];
    if (links.some((l) => l.slice(2, -2).trim().toLowerCase() === target)) {
      found.push({ name: doc.name, path: doc.path, folder: doc.folder });
    }
  }
  return found;
}

// A bookmark saved as-is (0194): the link and its tags land as a small doc
// named for the site, no agent involved. The processed path lives in the
// pipeline beside research.
function saveBookmark(boardRoot, folder, url, tags, rootName) {
  const base = ensure(boardRoot, rootName);
  const clean = String(url || '').trim();
  if (!clean) throw new Error('A bookmark needs a link');
  const dir = path.join(base, folder || 'Bookmarks');
  within(boardRoot, dir, rootName);
  fs.mkdirSync(dir, { recursive: true });

  let host = clean;
  try {
    host = new URL(clean).hostname.replace(/^www\./, '');
  } catch (err) {
    // Not a parseable URL; the raw text names the file instead.
  }
  const slug = board.slugify(host);
  let file = path.join(dir, `${slug}.md`);
  let n = 2;
  while (fs.existsSync(file)) file = path.join(dir, `${slug}-${n++}.md`);
  // Frontmatter names the kind so the viewer opens the site, not the stub
  // (0385). The body below stays readable outside the app.
  const fm = ['---', 'kind: bookmark', `url: ${clean}`, tags ? `tags: ${tags}` : null, '---']
    .filter((line) => line !== null)
    .join('\n');
  const body = [fm, '', `# ${host}`, '', clean, tags ? `\nTags: ${tags}` : '', ''].join('\n');
  fs.writeFileSync(file, body, 'utf-8');
  return { path: file };
}

// Plain keyword search over every doc's text (0182): case-insensitive, one
// snippet around the first hit. The vault is small enough to read whole.
function search(boardRoot, term, rootName) {
  const q = String(term || '').trim().toLowerCase();
  if (q.length < 2) return [];
  const found = [];
  for (const doc of allDocs(boardRoot, rootName)) {
    // Images have no text to search (0203).
    if (!/\.(md|html)$/i.test(doc.path)) continue;
    let body;
    try {
      body = fs.readFileSync(doc.path, 'utf-8');
    } catch (err) {
      continue;
    }
    const at = body.toLowerCase().indexOf(q);
    if (at === -1) continue;
    const from = Math.max(0, at - 40);
    const raw = body.slice(from, at + q.length + 60).replace(/\s+/g, ' ').trim();
    found.push({ ...doc, snippet: `${from > 0 ? '…' : ''}${raw}…` });
  }
  return found;
}

function write(boardRoot, docPath, body, rootName) {
  const resolved = within(boardRoot, docPath, rootName);
  // The previous version survives every save (0330): a short .history
  // beside the doc, then the crash-safe overwrite.
  keepHistory(resolved);
  atomicWrite(resolved, body);
  return { path: resolved };
}

function createDoc(boardRoot, folder, name, rootName) {
  const base = ensure(boardRoot, rootName);
  const clean = board.slugify(name || 'untitled');
  const dir = folder ? path.join(base, folder) : base;
  within(boardRoot, dir, rootName);
  fs.mkdirSync(dir, { recursive: true });

  let file = path.join(dir, `${clean}.md`);
  let n = 2;
  while (fs.existsSync(file)) file = path.join(dir, `${clean}-${n++}.md`);
  fs.writeFileSync(file, `# ${name || 'Untitled'}\n\n`, 'utf-8');

  // A fresh doc lands at the very bottom of its shelf (0295): the saved
  // order — seeded from what is on screen now if it never existed — gets
  // the new name appended, so "last made" reads as "last in the list".
  const order = readOrder(boardRoot, rootName);
  const key = folder || '';
  if (!Array.isArray(order[key])) {
    order[key] = fs
      .readdirSync(dir)
      .filter(isDoc)
      .filter((entry) => entry !== path.basename(file))
      .sort((a, b) => a.localeCompare(b));
  }
  order[key].push(path.basename(file));
  atomicWrite(orderFile(boardRoot, rootName), `${JSON.stringify(order, null, 2)}\n`);
  return { path: file };
}

function createFolder(boardRoot, name, rootName) {
  const base = ensure(boardRoot, rootName);
  const dir = within(boardRoot, path.join(base, folderSlug(name) || 'new-folder'), rootName);
  fs.mkdirSync(dir, { recursive: true });
  return { path: dir };
}

// Dragging a doc into another folder (0222): the file moves on disk with its
// name intact — a clash gets a numbered suffix rather than a refusal — and
// both folders' saved drag orders stay coherent: the name leaves the old
// list and lands in the new one.
function moveDoc(boardRoot, docPath, targetFolder, rootName) {
  const base = ensure(boardRoot, rootName);
  const src = within(boardRoot, docPath, rootName);
  const folder = String(targetFolder || '').trim();
  if (folder.startsWith('.') || folder.includes('/')) {
    throw new Error('Not a folder docs can move to');
  }
  const destDir = folder ? within(boardRoot, path.join(base, folder), rootName) : base;
  if (!fs.existsSync(destDir) || !fs.statSync(destDir).isDirectory()) {
    throw new Error('No such folder');
  }
  if (path.dirname(src) === destDir) return { path: src };

  const baseName = path.basename(src);
  const ext = path.extname(baseName);
  const stem = ext ? baseName.slice(0, -ext.length) : baseName;
  let dst = path.join(destDir, baseName);
  let n = 2;
  while (fs.existsSync(dst)) dst = path.join(destDir, `${stem}-${n++}${ext}`);
  fs.renameSync(src, dst);

  const order = readOrder(boardRoot, rootName);
  const fromKey = path.dirname(src) === base ? '' : path.basename(path.dirname(src));
  if (Array.isArray(order[fromKey])) {
    order[fromKey] = order[fromKey].filter((name) => name !== baseName);
  }
  if (Array.isArray(order[folder])) order[folder].push(path.basename(dst));
  atomicWrite(orderFile(boardRoot, rootName), `${JSON.stringify(order, null, 2)}\n`);
  return { path: dst };
}

function renameDoc(boardRoot, docPath, newName, rootName) {
  const resolved = within(boardRoot, docPath, rootName);
  // slugify falls back to 'card' on empty input, so emptiness is checked on
  // the raw name (0190).
  if (!String(newName || '').trim()) throw new Error('A doc needs a name');
  const clean = board.slugify(newName);
  // The rename keeps the document's own format — .md, .html or an image's
  // extension alike (0194).
  const ext = path.extname(resolved) || '.md';
  const target = within(boardRoot, path.join(path.dirname(resolved), `${clean}${ext}`), rootName);
  // Never silently clobber a neighbour that already wears the name (0190) —
  // though on a case-insensitive disk, a case-only rename is the same file,
  // not a neighbour (0299).
  const sameFile = target.toLowerCase() === resolved.toLowerCase();
  if (target !== resolved && !sameFile && fs.existsSync(target)) {
    throw new Error('A doc with that name already exists here');
  }
  if (target !== resolved) fs.renameSync(resolved, target);
  return { path: target };
}

// Docs are never destroyed, and never even "trashed": archiving moves them
// to a hidden .archive beside the folders, stamped so names never collide
// (0161). The old .trash stays readable for anything already in it.
function removeDoc(boardRoot, docPath, rootName) {
  const resolved = within(boardRoot, docPath, rootName);
  const archive = path.join(root(boardRoot, rootName), '.archive');
  fs.mkdirSync(archive, { recursive: true });
  fs.renameSync(resolved, path.join(archive, `${Date.now()}-${path.basename(resolved)}`));
  return true;
}

// A compact map of the knowledgebase for a session's system prompt: folder
// and doc names only, HTML docs marked (they cost more to read and are
// usually rendered reports, not notes). The content is never included — the
// index tells the agent what exists so it can read files on demand, the same
// index-in-context, content-on-demand pattern as a memory file. Capped so a
// grown vault cannot flood the prompt.
function contextIndex(boardRoot, cap = 80) {
  const lines = [];
  for (const group of list(boardRoot)) {
    for (const file of group.files) {
      const label = group.folder ? `${group.folder}/${file.name}` : file.name;
      lines.push(file.path.endsWith('.html') ? `${label} (html report)` : label);
    }
  }
  const over = lines.length - cap;
  const kept = over > 0 ? lines.slice(0, cap) : lines;
  if (over > 0) kept.push(`…and ${over} more — list ${root(boardRoot)} for the rest`);
  return kept;
}

// ── The docs stylesheet ──
// HTML docs share one look: light paper, dark ink whatever the app's theme,
// the app's own type. `.styles/docs.css` holds it — generated once from the
// project (logo included when the project has an icon image), then the
// user's to edit.
function docsCss(hasLogo) {
  return [
    '/* The docs look: generated once by flow, yours to edit. HTML docs link',
    '   this with <link rel="stylesheet" href="../.styles/docs.css">. Light',
    '   paper and dark ink always, whatever theme the app is wearing. */',
    ':root {',
    '  --paper: #fbfbfa;',
    '  --ink: #1f1f1f;',
    '  --ink-dim: #5c5c5c;',
    '  --line: #e2e2df;',
    '  --accent: #2f6f9f;',
    '}',
    '',
    'html { background: var(--paper); }',
    '',
    'body {',
    '  margin: 0 auto;',
    '  padding: 56px 40px 96px;',
    '  max-width: 760px;',
    '  background: var(--paper);',
    '  color: var(--ink);',
    "  font: 15px/1.65 -apple-system, 'SF Pro Text', system-ui, sans-serif;",
    '  -webkit-font-smoothing: antialiased;',
    '}',
    '',
    'h1, h2, h3 {',
    '  font-weight: 650;',
    '  letter-spacing: -0.01em;',
    '  line-height: 1.25;',
    '}',
    '',
    'h1 { font-size: 27px; margin: 0 0 18px; }',
    'h2 { font-size: 19px; margin: 40px 0 10px; padding-top: 18px; border-top: 1px solid var(--line); }',
    'h3 { font-size: 15.5px; margin: 24px 0 6px; }',
    '',
    'p, ul, ol { margin: 0 0 14px; }',
    'a { color: var(--accent); }',
    '',
    'code, pre {',
    "  font-family: 'JetBrainsMono Nerd Font Mono', 'JetBrains Mono', 'SF Mono', monospace;",
    '  font-size: 12.5px;',
    '}',
    '',
    'pre {',
    '  padding: 14px 16px;',
    '  border: 1px solid var(--line);',
    '  border-radius: 8px;',
    '  background: #f4f4f2;',
    '  overflow-x: auto;',
    '}',
    '',
    'table { border-collapse: collapse; width: 100%; margin: 0 0 18px; }',
    'th, td { padding: 8px 12px; border: 1px solid var(--line); text-align: left; font-size: 14px; }',
    'th { background: #f4f4f2; font-weight: 600; }',
    '',
    'img { max-width: 100%; }',
    '',
    hasLogo
      ? '.doc-logo { width: 44px; height: 44px; border-radius: 50%; display: block; margin-bottom: 22px; }'
      : '',
    '.muted { color: var(--ink-dim); }',
    '',
  ].join('\n');
}

// Idempotent: creates `.styles/docs.css` (and copies the project icon in as
// the logo) the first time a project's docs are listed. Existing files are
// never overwritten — they are the user's.
function ensureStyles(project) {
  const base = ensure(project.boardRoot);
  const stylesDir = path.join(base, '.styles');
  const cssFile = path.join(stylesDir, 'docs.css');
  if (fs.existsSync(cssFile)) return;

  fs.mkdirSync(stylesDir, { recursive: true });

  let hasLogo = false;
  if (project.imageIcon && fs.existsSync(project.imageIcon)) {
    try {
      fs.copyFileSync(project.imageIcon, path.join(stylesDir, 'logo.png'));
      hasLogo = true;
    } catch (err) {
      // A doc without a logo is still a doc.
    }
  }

  fs.writeFileSync(cssFile, docsCss(hasLogo), 'utf-8');
}

// A whole folder can retire the same way a doc does: into .archive with a
// stamp, contents and all, never destroyed (0164). Only real folders inside
// the root qualify — never the root itself, never a hidden directory.
function removeFolder(boardRoot, folderName, rootName) {
  const base = root(boardRoot, rootName);
  const name = String(folderName || '').trim();
  if (!name || name.startsWith('.')) throw new Error('Not a folder that can be archived');
  const resolved = within(boardRoot, path.join(base, name), rootName);
  if (resolved === base || !fs.statSync(resolved).isDirectory()) {
    throw new Error('Not a folder that can be archived');
  }
  const archive = path.join(base, '.archive');
  fs.mkdirSync(archive, { recursive: true });
  fs.renameSync(resolved, path.join(archive, `${Date.now()}-${name}`));
  return true;
}

// The doc the user is looking at, recorded for the terminal's agent: "this
// doc" resolves through this file. Hidden, so the watcher and the sidebar
// both ignore it.
function noteCurrent(boardRoot, docPath, rootName) {
  const base = ensure(boardRoot, rootName);
  fs.writeFileSync(path.join(base, '.current-doc'), docPath ? `${docPath}\n` : '', 'utf-8');
  return true;
}

module.exports = {
  root,
  ensure,
  normalizeRoot,
  ensureStyles,
  contextIndex,
  list,
  allDocs,
  backlinks,
  search,
  read,
  write,
  createDoc,
  createFolder,
  moveDoc,
  renameDoc,
  removeDoc,
  removeFolder,
  renameFolder,
  saveBookmark,
  setOrder,
  setFolderOrder,
  noteCurrent,
};
