// Symlinks the repo's skills into ~/.claude/skills so every session launched
// by flow (and any other Claude Code session) can use them. Idempotent: an
// existing correct link is left alone, a stale one is repointed, and a real
// directory in the way is reported, never overwritten.
const fs = require('fs');
const path = require('path');
const os = require('os');

const source = path.join(__dirname, '..', 'skills');
const target = path.join(os.homedir(), '.claude', 'skills');

fs.mkdirSync(target, { recursive: true });

for (const name of fs.readdirSync(source)) {
  const from = path.join(source, name);
  if (!fs.statSync(from).isDirectory()) continue;
  const to = path.join(target, name);

  let existing = null;
  try {
    existing = fs.lstatSync(to);
  } catch (err) {
    // Nothing there — the clean case.
  }

  if (existing && existing.isSymbolicLink()) {
    if (fs.readlinkSync(to) === from) {
      console.log(`ok      ${name} (already linked)`);
      continue;
    }
    fs.unlinkSync(to);
  } else if (existing) {
    console.log(`SKIP    ${name} — ${to} exists and is not a symlink; move it aside first`);
    continue;
  }

  fs.symlinkSync(from, to);
  console.log(`linked  ${name} -> ${to}`);
}
