const fs = require('fs');
const path = require('path');

// Boards live directly in the flow folder, one `<name>/` per project, so a
// project repo stays untouched by the board and one folder holds every card.
const { FLOW_ROOT } = require('./flow-root');
const { atomicWrite } = require('./atomic-write');
const PROJECTS_ROOT = FLOW_ROOT;

// Config lives in the same folder — visible next to the boards it describes,
// not tucked into a hidden dot-folder. The old ~/.flow location is read once
// as a legacy fallback and never written again.
const CONFIG_DIR = path.join(FLOW_ROOT, 'config');
const CONFIG_FILE = path.join(CONFIG_DIR, 'projects.json');
const LEGACY_CONFIG_FILE = path.join(process.env.HOME, '.flow', 'projects.json');

const DEFAULTS = [
  {
    name: 'flow',
    path: path.join(process.env.HOME, 'Vibes', 'flow'),
    portBase: 4100,
  },
  {
    name: 'umami-wizzard',
    path: path.join(process.env.HOME, 'Vibes', 'umami-wizzard'),
    portBase: 4200,
  },
];

/**
 * The command that boots a worktree on its own port.
 *
 * A repo's own `./start.sh` is usually the wrong answer here: those scripts
 * pin one port and free it by killing whoever holds it, which is right for one
 * checkout and fatal for several. So the default goes to the dev script with
 * the port passed explicitly — `--port` is understood by next, vite and
 * remix alike — and `{port}` is substituted at run time.
 */
function defaultDevCommand(projectPath) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectPath, 'package.json'), 'utf-8'));
    const scripts = pkg.scripts || {};
    if (scripts.dev) return 'npm run dev -- --port {port}';
    if (scripts.start) return 'npm start -- --port {port}';
  } catch (err) {
    // Not a node project, or no package.json.
  }
  return fs.existsSync(path.join(projectPath, 'start.sh')) ? 'PORT={port} ./start.sh' : '';
}

function boardRoot(project) {
  return path.join(PROJECTS_ROOT, project.name);
}

function decorate(project) {
  return {
    ...project,
    // The name keys everything on disk — board folder, tmux sessions — and
    // stays put. The title is what the user reads and renames freely: "flow"
    // can become "Flow" without a single file moving.
    title: project.title || project.name,
    boardRoot: boardRoot(project),
    devCommand: project.devCommand || defaultDevCommand(project.path),
    // Straight on the checkout is the default: a card moving to Doing works in
    // the repo itself, no branch or worktree until a project opts into one.
    mode: project.mode === 'worktree' ? 'worktree' : 'main',
    // Plugins are opt-in per project (0220): absent means off, so a new
    // project starts with none of them.
    plugins:
      project.plugins && typeof project.plugins === 'object' ? project.plugins : {},
  };
}

// Persists a change to one project, keyed by name.
function update(name, changes) {
  const current = read().find((p) => p.name === name);
  if (!current) return read();

  const next = read().map((p) => (p.name === name ? { ...p, ...changes } : p));
  save(next);
  return next.map((p) => decorate(p));
}

function read() {
  let projects = null;
  for (const file of [CONFIG_FILE, LEGACY_CONFIG_FILE]) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (Array.isArray(parsed) && parsed.length) {
        projects = parsed;
        // Legacy config migrates on first read: written to the repo location,
        // which every write after this one targets anyway.
        if (file === LEGACY_CONFIG_FILE) save(projects);
        break;
      }
    } catch (err) {
      // Missing or unreadable — try the next location.
    }
  }

  if (!projects) {
    projects = DEFAULTS.filter((p) => fs.existsSync(p.path));
    if (!projects.length) projects = DEFAULTS;
    save(projects);
  }

  return projects.map(decorate);
}

function save(projects) {
  const bare = projects.map(({ boardRoot: _ignored, ...rest }) => rest);
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    atomicWrite(CONFIG_FILE, JSON.stringify(bare, null, 2));
  } catch (err) {
    // An unwritable config is not worth taking the app down for — the
    // defaults still work, they just do not persist.
    console.error('[projects] could not write config:', err.message);
  }
  return bare;
}

function add(projectPath) {
  const resolved = path.resolve(projectPath);
  const projects = read();
  const existing = projects.find((p) => p.path === resolved);
  if (existing) return projects;

  const next = [
    ...projects,
    {
      name: path.basename(resolved),
      title: path.basename(resolved),
      path: resolved,
      devCommand: defaultDevCommand(resolved),
      portBase: 4100 + projects.length * 100,
    },
  ];
  save(next);
  return next.map(decorate);
}

/**
 * Renames a project, board folder and all.
 *
 * The name is the key: it decides where the board lives, so the folder moves
 * with it rather than leaving the cards behind under the old name. Sessions
 * already open keep their old ids until they are closed — harmless, since a
 * session id only has to be unique, not accurate.
 */
function rename(oldName, newName) {
  const name = String(newName || '').trim();
  if (!name) throw new Error('A project needs a name');
  if (name === oldName) return read();
  if (/[/\\:]/.test(name)) throw new Error('A name cannot contain slashes or colons');

  const projects = read();
  const project = projects.find((p) => p.name === oldName);
  if (!project) throw new Error(`Unknown project: ${oldName}`);
  if (projects.some((p) => p.name === name)) throw new Error(`${name} is already taken`);

  const from = path.join(PROJECTS_ROOT, oldName);
  const to = path.join(PROJECTS_ROOT, name);
  if (fs.existsSync(to)) throw new Error(`A board folder named ${name} already exists`);
  if (fs.existsSync(from)) fs.renameSync(from, to);

  save(projects.map((p) => (p.name === oldName ? { ...p, name } : p)));
  return read();
}

function remove(projectPath) {
  const next = read().filter((p) => p.path !== projectPath);
  save(next);
  return next.map(decorate);
}

function find(name) {
  return read().find((p) => p.name === name) || null;
}

module.exports = {
  CONFIG_DIR,
  read,
  save,
  add,
  remove,
  rename,
  update,
  find,
  boardRoot,
  defaultDevCommand,
  PROJECTS_ROOT,
  CONFIG_FILE,
};
