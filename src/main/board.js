const fs = require('fs');
const path = require('path');
const fm = require('./frontmatter');
const { atomicWrite, atomicCreate } = require('./atomic-write');

const COLUMNS = ['to-do', 'doing', 'done'];

// The resting places beyond the active board: backlog for work queued but not
// started, archive for work finished or abandoned. Cards there are listed and
// movable like any other, they just never render as board columns.
const SHELVES = ['backlog', 'archive'];

// On disk the folders are numbered so a file manager shows the flow in order;
// the code keeps the logical names and maps here, in one place.
const DIRS = {
  knowledge: '00-knowledge',
  insights: '07-analytics',
  'to-do': '01-to-do',
  doing: '02-doing',
  done: '03-done',
  archive: '04-archive',
  backlog: '05-backlog',
  attachments: '06-attachments',
};

// A folder name back to its logical name: `03-done` and plain `done` both
// read as done, so boards from before the numbering keep working.
function logicalName(dirName) {
  return dirName.replace(/^\d\d-/, '');
}

// A board root is `<flow>/projects/<project-name>`. Cards live here rather than
// inside the project repo, so they never end up in that repo's history or
// collide with its own `board/` folder.
function columnDir(boardRoot, column) {
  return path.join(boardRoot, DIRS[column] || column);
}

function ensureBoard(boardRoot) {
  // A board from before the numbering migrates itself: a bare folder is
  // renamed when the numbered one does not exist yet, and merged into it when
  // it does — an app instance still on old code can recreate bare folders,
  // and what it writes there must not become invisible.
  for (const [logical, numbered] of Object.entries(DIRS)) {
    const oldDir = path.join(boardRoot, logical);
    const newDir = path.join(boardRoot, numbered);
    if (!fs.existsSync(oldDir)) continue;
    if (!fs.existsSync(newDir)) {
      fs.renameSync(oldDir, newDir);
      continue;
    }
    for (const file of fs.readdirSync(oldDir)) {
      const target = path.join(newDir, file);
      if (!fs.existsSync(target)) fs.renameSync(path.join(oldDir, file), target);
    }
    if (!fs.readdirSync(oldDir).length) fs.rmdirSync(oldDir);
  }
  for (const dir of Object.values(DIRS)) {
    fs.mkdirSync(path.join(boardRoot, dir), { recursive: true });
  }
}

function today() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// Titles stay plain technical English: no emoji, no em or en dashes. The
// shaping prompt asks the model for the same; this makes it a guarantee, on
// creation and on every rename, wherever the write comes from.
function cleanTitle(title) {
  return String(title || '')
    .replace(/\p{Extended_Pictographic}|\p{Emoji_Modifier}|️|‍/gu, '')
    .replace(/\s*[—–]\s*/g, ' - ')
    .replace(/\s+/g, ' ')
    .trim();
}

function slugify(title) {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'card'
  );
}

function readCard(boardRoot, column, file) {
  const fullPath = path.join(columnDir(boardRoot, column), file);
  const raw = fs.readFileSync(fullPath, 'utf-8');
  const { data, body } = fm.parse(raw);
  return {
    ...data,
    id: data.id || file.slice(0, 4),
    title: data.title || file.replace(/\.md$/, ''),
    column,
    file,
    path: fullPath,
    body,
  };
}

function readCardAt(cardPath) {
  return readCard(
    path.dirname(path.dirname(cardPath)),
    logicalName(path.basename(path.dirname(cardPath))),
    path.basename(cardPath)
  );
}

function listCards(boardRoot) {
  ensureBoard(boardRoot);
  const cards = [];
  for (const column of [...COLUMNS, ...SHELVES]) {
    let files = [];
    try {
      files = fs.readdirSync(columnDir(boardRoot, column));
    } catch (err) {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.md') || file.startsWith('.')) continue;
      try {
        cards.push(readCard(boardRoot, column, file));
      } catch (err) {
        console.error(`[board] could not read ${column}/${file}:`, err.message);
      }
    }
  }
  // Hand-ordered first, by the position written into each card. Cards without
  // one (anything created outside flow) fall to the bottom in id order.
  cards.sort((a, b) => {
    const pa = Number(a.position);
    const pb = Number(b.position);
    const aHas = Number.isFinite(pa);
    const bHas = Number.isFinite(pb);
    if (aHas && bHas && pa !== pb) return pa - pb;
    if (aHas !== bHas) return aHas ? -1 : 1;
    return String(a.id).localeCompare(String(b.id));
  });
  return cards;
}

// Writes 1-based positions for a column in the order given. Called after a
// drag, so the order survives a restart.
function reorder(boardRoot, column, orderedPaths) {
  orderedPaths.forEach((cardPath, index) => {
    try {
      patchCard(cardPath, { position: index + 1, status: column });
    } catch (err) {
      console.error(`[board] could not reposition ${cardPath}:`, err.message);
    }
  });
  return listCards(boardRoot);
}

function bottomPosition(boardRoot, column) {
  const positions = listCards(boardRoot)
    .filter((c) => c.column === column)
    .map((c) => Number(c.position))
    .filter(Number.isFinite);
  return (positions.length ? Math.max(...positions) : 0) + 1;
}

function nextId(boardRoot) {
  let highest = 0;
  for (const card of listCards(boardRoot)) {
    const n = parseInt(card.id, 10);
    if (Number.isFinite(n) && n > highest) highest = n;
  }
  return String(highest + 1).padStart(4, '0');
}

// Two files claiming one id happens when something outside the app — an
// agent, a script, a hand edit — picks an id from a stale view of the board
// while the app allocates the same one. Routing is by path so nothing breaks,
// but the collision used to sit there toasting until someone fixed it by
// hand (0162). Now the board heals itself on load: the oldest file keeps the
// id, and any newer claimant that has nothing attached yet (no branch,
// session, PR or worktree) is renumbered to the next free id, file name and
// frontmatter together. A claimant with real state attached is left alone
// for the warning to name — renumbering under a live session is worse than
// a toast.
function healDuplicateIds(boardRoot) {
  const groups = new Map();
  for (const card of listCards(boardRoot)) {
    if (!card.id) continue;
    if (!groups.has(card.id)) groups.set(card.id, []);
    groups.get(card.id).push(card);
  }

  let healed = false;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    // Should never fire since 0331 made allocation an exclusive create;
    // if it does, an outside writer raced the board and this is the story
    // worth investigating, not background noise.
    console.warn(
      '[board] duplicate id healed — allocation raced an outside writer:',
      group.map((c) => c.path)
    );
    const byAge = [...group].sort((a, b) => {
      try {
        return fs.statSync(a.path).mtimeMs - fs.statSync(b.path).mtimeMs;
      } catch (err) {
        return 0;
      }
    });
    for (const card of byAge.slice(1)) {
      if (card.branch || card.claude_session || card.pr || card.worktree) continue;
      // A file written seconds ago is likely one half of a move in progress
      // (destination written, original not yet removed). Renumbering it
      // would yank the file out from under the mover — wait it out; a real
      // duplicate is still here next load (0186).
      let age = Infinity;
      try {
        age = Date.now() - fs.statSync(card.path).mtimeMs;
      } catch (err) {
        continue;
      }
      if (age < 10000) continue;
      const id = nextId(boardRoot);
      const target = path.join(
        path.dirname(card.path),
        `${id}-${path.basename(card.path).replace(/^\d+-?/, '')}`
      );
      try {
        patchCard(card.path, { id });
        fs.renameSync(card.path, target);
        console.warn(`[board] duplicate id ${card.id}: renumbered ${card.path} -> ${id}`);
        healed = true;
      } catch (err) {
        console.error(`[board] could not renumber ${card.path}:`, err.message);
      }
    }
  }
  return healed;
}

function createCard(boardRoot, title, column = 'to-do') {
  ensureBoard(boardRoot);
  title = cleanTitle(title) || 'untitled';
  const date = today();

  // Allocation and claim are one atomic act (0331): the id is only ours
  // once the exclusive create lands. An agent scanning the same board in
  // the same instant loses with EEXIST and we step to the next number,
  // instead of both minting the same id for the healer to untangle later.
  let id = nextId(boardRoot);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const file = `${id}-${slugify(title)}.md`;
    const content = fm.build(
      {
        id,
        title,
        status: column,
        position: bottomPosition(boardRoot, column),
        created: date,
        updated: date,
        branch: '',
        pr: '',
        pr_url: '',
        worktree: '',
        port: '',
        route: '',
        claude_session: '',
        needs_input: 'false',
        completed: '',
      },
      '\n'
    );
    try {
      atomicCreate(path.join(columnDir(boardRoot, column), file), content);
      return readCard(boardRoot, column, file);
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      id = String(Number(id) + 1).padStart(4, '0');
    }
  }
  throw new Error('Could not allocate a card id');
}

// Patches frontmatter in place, always bumping `updated`.
function patchCard(cardPath, changes) {
  if ('title' in changes) changes = { ...changes, title: cleanTitle(changes.title) };
  const raw = fs.readFileSync(cardPath, 'utf-8');
  const next = fm.update(raw, { ...changes, updated: today() });
  atomicWrite(cardPath, next);
  return next;
}

// Archive is a resting place, not a column: cards moved there leave the board
// but keep their markdown, so nothing typed into a card is ever lost.
function archiveCard(boardRoot, cardPath) {
  const dir = columnDir(boardRoot, 'archive');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, path.basename(cardPath));
  fs.renameSync(cardPath, target);
  patchCard(target, { status: 'archive' });
  return target;
}

function moveCard(boardRoot, cardPath, toColumn) {
  if (![...COLUMNS, ...SHELVES].includes(toColumn)) {
    throw new Error(`Unknown column: ${toColumn}`);
  }

  const file = path.basename(cardPath);
  const target = path.join(columnDir(boardRoot, toColumn), file);
  if (target === cardPath) return readCard(boardRoot, toColumn, file);

  ensureBoard(boardRoot);

  // Work out the landing position before the move, or the card counts itself
  // and every move lands one slot lower than it should.
  const position = bottomPosition(boardRoot, toColumn);
  fs.renameSync(cardPath, target);

  const changes = { status: toColumn, position };
  // Done stamps the finish date; archive keeps whatever the card already
  // carries (an archived done card should not forget when it shipped); any
  // move back into play clears it.
  if (toColumn === 'done') changes.completed = today();
  else if (toColumn !== 'archive') changes.completed = '';
  patchCard(target, changes);

  return readCard(boardRoot, toColumn, file);
}

// Moving a card to another project (0312): the words travel, the plumbing
// stays. The card takes the target board's next id (ids are per-project
// sequences, so keeping the old one could collide), its referenced
// attachments move and renumber with it, and branch, PR, worktree, port and
// session state are cleared — they belong to the old repo; the new project
// starts that work fresh. It lands at the bottom of the target's to-do.
function transferCard(boardRoot, cardPath, targetBoardRoot) {
  ensureBoard(targetBoardRoot);
  const card = readCardAt(cardPath);
  const id = nextId(targetBoardRoot);
  const title = card.title || 'untitled';
  const target = path.join(columnDir(targetBoardRoot, 'to-do'), `${id}-${slugify(title)}.md`);

  // Attachments the body points at come along, renamed to the new id's
  // numbering, with the body's links following.
  let body = card.body || '';
  const sourceDir = columnDir(boardRoot, 'attachments');
  const targetDir = columnDir(targetBoardRoot, 'attachments');
  for (const match of [...body.matchAll(/\]\(([^)]*06-attachments\/[^)]+)\)/g)]) {
    const ref = match[1];
    const source = path.join(sourceDir, path.basename(ref));
    if (!fs.existsSync(source)) continue;
    fs.mkdirSync(targetDir, { recursive: true });
    const renamed = path.join(
      targetDir,
      `${id}-${nextAttachmentNumber(targetDir, id)}${path.extname(source).toLowerCase()}`
    );
    fs.renameSync(source, renamed);
    body = body.split(ref).join(renamed);
  }

  const content = fm.build(
    {
      id,
      title,
      status: 'to-do',
      position: bottomPosition(targetBoardRoot, 'to-do'),
      created: card.created || today(),
      updated: today(),
      branch: '',
      pr: '',
      pr_url: '',
      worktree: '',
      port: '',
      route: '',
      claude_session: '',
      needs_input: 'false',
      completed: '',
    },
    body.startsWith('\n') ? body : `\n${body}`
  );

  // Same exclusive claim as createCard (0331): a colliding id on the
  // target board refuses rather than overwriting someone's card.
  atomicCreate(target, content);
  fs.unlinkSync(cardPath);
  return readCardAt(target);
}

// Replaces everything below the frontmatter, leaving the frontmatter untouched.
function writeBody(cardPath, body) {
  const raw = fs.readFileSync(cardPath, 'utf-8');
  const { raw: fmRaw } = fm.parse(raw);
  const next = fmRaw ? `---\n${fmRaw}\n---\n${body}` : body;
  atomicWrite(cardPath, next);
  patchCard(cardPath, {});
}

// ── Attachment numbering (0289) ──
// Attachments carry their card's number: 0289-1.png, 0289-2.png — short,
// stable, and quotable as "card 0289, attachment 1". Numbers only ever go
// up (next = max + 1), so deleting one never renumbers the rest.
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function nextAttachmentNumber(dir, key) {
  const pattern = new RegExp(`^${escapeRegExp(key)}-(\\d+)\\.[a-z0-9]+$`, 'i');
  let top = 0;
  for (const file of fs.readdirSync(dir)) {
    const match = file.match(pattern);
    if (match) top = Math.max(top, parseInt(match[1], 10));
  }
  return top + 1;
}

// A new card's pasted images were filed under the neutral new-card key —
// there was no id yet. Once the card exists, its attachments take its
// number: each referenced file renames to <id>-<n> and the body's links
// follow.
function adoptAttachments(boardRoot, cardPath) {
  const card = readCardAt(cardPath);
  const dir = columnDir(boardRoot, 'attachments');
  if (!card.id || !fs.existsSync(dir)) return card;

  const owned = new RegExp(`^${escapeRegExp(card.id)}-\\d+\\.[a-z0-9]+$`, 'i');
  let body = card.body;
  let changed = false;
  for (const match of [...body.matchAll(/\]\(([^)]*06-attachments\/[^)]+)\)/g)]) {
    const ref = match[1];
    const base = path.basename(ref);
    if (owned.test(base)) continue;
    const source = path.join(dir, base);
    if (!fs.existsSync(source)) continue;
    const target = path.join(
      dir,
      `${card.id}-${nextAttachmentNumber(dir, card.id)}${path.extname(base).toLowerCase()}`
    );
    fs.renameSync(source, target);
    body = body.split(ref).join(target);
    changed = true;
  }
  if (changed) writeBody(cardPath, body);
  return readCardAt(cardPath);
}

module.exports = {
  nextAttachmentNumber,
  adoptAttachments,
  archiveCard,
  COLUMNS,
  SHELVES,
  DIRS,
  columnDir,
  logicalName,
  ensureBoard,
  listCards,
  healDuplicateIds,
  readCard,
  readCardAt,
  createCard,
  patchCard,
  moveCard,
  transferCard,
  reorder,
  bottomPosition,
  writeBody,
  slugify,
  cleanTitle,
  today,
};
