// Lists to-do cards that arrived unshaped — missing the Plan / Build / QA /
// Done when structure batch-filed cards are meant to carry (0365). A review
// list, not a gate: hand-typed quick captures are allowed to stay bare, so
// a listed card is something to look at, not necessarily something wrong.
//
// Usage: node scripts/board-check.js [board-root]
// The board root defaults to $FLOW_BOARD_ROOT, then ./projects/flow.
const fs = require('fs');
const path = require('path');

const root =
  process.argv[2] ||
  process.env.FLOW_BOARD_ROOT ||
  path.join(__dirname, '..', 'projects', 'flow');
const todoDir = path.join(root, '01-to-do');

if (!fs.existsSync(todoDir)) {
  console.error(`no to-do folder at ${todoDir}`);
  process.exit(1);
}

const SECTIONS = ['## Plan', '## Build', '## QA', '## Done when'];
const cards = fs
  .readdirSync(todoDir)
  .filter((name) => name.endsWith('.md'))
  .sort();

let bare = 0;
for (const name of cards) {
  const body = fs.readFileSync(path.join(todoDir, name), 'utf8');
  const missing = SECTIONS.filter((s) => !body.includes(s));
  if (!missing.length) continue;
  bare += 1;
  console.log(`${name}\n  missing: ${missing.join(', ')}`);
}

if (!bare) console.log(`all ${cards.length} to-do cards are shaped`);
else console.log(`\n${bare} of ${cards.length} to-do cards missing shaped sections`);
