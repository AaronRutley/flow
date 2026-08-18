const fs = require('fs');
const path = require('path');

// App-level settings: the prompts flow types or runs on your behalf. One JSON
// file next to projects.json in the flow folder's config/; the old ~/.flow
// location is read as a fallback until a write lands it here.
const { FLOW_ROOT } = require('./flow-root');
const { atomicWrite } = require('./atomic-write');

const FILE = path.join(FLOW_ROOT, 'config', 'settings.json');
const LEGACY_FILE = path.join(process.env.HOME, '.flow', 'settings.json');

function read() {
  for (const file of [FILE, LEGACY_FILE]) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (parsed && typeof parsed === 'object') return parsed;
    } catch (err) {
      // Missing or unreadable — try the next location.
    }
  }
  return {};
}

function write(changes) {
  const next = { ...read(), ...changes };
  // Empty strings mean "back to the default" and are not worth storing. A
  // false boolean is the same statement — the default — so it drops out too,
  // and an absent key reads as off.
  for (const key of Object.keys(next)) {
    if (!String(next[key] || '').trim()) delete next[key];
  }
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  atomicWrite(FILE, JSON.stringify(next, null, 2));
  return next;
}

// The default CLI, named once so the settings panel and every launch site
// agree on what "unset" means.
const DEFAULT_CLI = 'claude';

// Which CLI a session launches. Every launch site — cards, the board
// terminal, the docs terminal, the Chat button — resolves it here, so the
// default terminal command is one answer rather than one per caller.
// (Sandbox mode retired with 0418: a wrapper script is just a command now.
// Stored sandbox keys in settings.json pass through unread.)
function cli(settings = read()) {
  return String(settings.terminalCommand || '').trim() || DEFAULT_CLI;
}

module.exports = { read, write, cli, FILE, DEFAULT_CLI };
