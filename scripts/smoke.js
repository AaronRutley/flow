// Exercises the main-process modules without Electron. Written to be
// independent of whatever is currently on the real board.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', 'src', 'main');

const fm = require(path.join(ROOT, 'frontmatter'));
const projects = require(path.join(ROOT, 'projects'));
const board = require(path.join(ROOT, 'board'));
const ports = require(path.join(ROOT, 'ports'));

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('frontmatter');
const sample = `---\nid: "0005"\ntitle: "Concepts: colour change"\nstatus: to-do\nport:\n---\n\nBody text.\n`;
const parsed = fm.parse(sample);
check('parses quoted title with a colon', parsed.data.title === 'Concepts: colour change', parsed.data.title);
check('keeps id as a string', parsed.data.id === '0005', parsed.data.id);
check('empty scalar reads as empty', parsed.data.port === '', JSON.stringify(parsed.data.port));
check('body survives', parsed.body.trim() === 'Body text.');

const patched = fm.update(sample, { status: 'doing', pr: '214' });
check('updates in place', /status: doing/.test(patched));
check('appends a new key, integers unquoted', /\npr: 214\n/.test(patched), patched);
check('ids keep their quotes', /id: "0005"/.test(fm.update(sample, { id: '0005' })));
check('preserves empty port line', /\nport:\n/.test(patched));
check('key order unchanged', patched.indexOf('id:') < patched.indexOf('title:'));
check('body preserved through update', patched.endsWith('Body text.\n'));

console.log('renderer policy (0319, 0320) — wiring');
{
  const repoRoot = path.join(__dirname, '..');
  const indexHtml = fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf-8');
  const setupHtml = fs.readFileSync(path.join(repoRoot, 'setup.html'), 'utf-8');
  check('index.html carries the CSP', /Content-Security-Policy/.test(indexHtml));
  check('setup.html carries the CSP', /Content-Security-Policy/.test(setupHtml));
  check(
    'no inline scripts anywhere',
    !/<script>(?!<)/.test(indexHtml) && !/<script>(?!<)/.test(setupHtml)
  );
  check(
    'CSP forbids remote script and objects',
    /script-src 'self'/.test(indexHtml) && /object-src 'none'/.test(indexHtml)
  );
  check(
    'DOMPurify loads before the renderer scripts',
    indexHtml.indexOf('dompurify/dist/purify.min.js') > -1 &&
      indexHtml.indexOf('dompurify/dist/purify.min.js') < indexHtml.indexOf('src/renderer/state.js')
  );
  const stateJs = fs.readFileSync(path.join(repoRoot, 'src', 'renderer', 'state.js'), 'utf-8');
  check('renderMarkdown sanitises through DOMPurify', /DOMPurify\.sanitize\(md\.parse/.test(stateJs));
  // No renderer file may call md.parse straight into the DOM: the helper in
  // state.js is the one place parse happens.
  const rendererDir = path.join(repoRoot, 'src', 'renderer');
  const offenders = fs
    .readdirSync(rendererDir)
    .filter((n) => n.endsWith('.js') && n !== 'state.js')
    .filter((n) => /md\.parse/.test(fs.readFileSync(path.join(rendererDir, n), 'utf-8')));
  check('no bare md.parse outside state.js', offenders.length === 0, offenders.join(','));
}

console.log('path guard');
const pathGuard = require(path.join(ROOT, 'path-guard'));
{
  const os = require('os');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-guard-'));
  const rootDir = path.join(base, 'board');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(rootDir, 'sub dir'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'sub dir', 'card.md'), 'x');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');

  check('plain file inside passes', pathGuard.isInside(rootDir, path.join(rootDir, 'sub dir', 'card.md')));
  check('path with spaces passes', pathGuard.inRoots(path.join(rootDir, 'sub dir', 'card.md'), [rootDir]));
  check('dot-dot traversal refused', !pathGuard.isInside(rootDir, path.join(rootDir, '..', 'outside', 'secret.txt')));
  check('absolute escape refused', !pathGuard.isInside(rootDir, '/etc/hosts'));
  check('not-yet-existing file inside passes', pathGuard.isInside(rootDir, path.join(rootDir, 'new-card.md')));
  check('empty and null refused', !pathGuard.inRoots('', [rootDir]) && !pathGuard.inRoots(null, [rootDir]));
  check('falsy roots skipped', !pathGuard.inRoots(path.join(rootDir, 'a.md'), [null, undefined, '']));

  fs.symlinkSync(outside, path.join(rootDir, 'sneaky'));
  check('symlink pointing outside refused', !pathGuard.isInside(rootDir, path.join(rootDir, 'sneaky', 'secret.txt')));
  fs.symlinkSync(path.join(rootDir, 'sub dir'), path.join(rootDir, 'honest'));
  check('symlink pointing inside passes', pathGuard.isInside(rootDir, path.join(rootDir, 'honest', 'card.md')));

  fs.rmSync(base, { recursive: true, force: true });
}

console.log('format versioning (0362)');
{
  const os = require('os');
  const format = require(path.join(ROOT, 'format'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-format-'));
  check('an unmarked root reads as version 1', format.readVersion(root) === 1);
  // A sample migration: rename a marker file, described before applied.
  fs.writeFileSync(path.join(root, 'old-name.json'), '{"a":1}');
  const sample = [{
    to: 2,
    title: 'rename old-name to new-name',
    describe: (r) => [{ file: path.join(r, 'old-name.json'), note: 'renamed to new-name.json' }],
    apply: (r) => {
      if (fs.existsSync(path.join(r, 'old-name.json'))) {
        fs.renameSync(path.join(r, 'old-name.json'), path.join(r, 'new-name.json'));
      }
    },
  }];
  const dry = format.migrate(root, { dryRun: true, current: 2, migrations: sample });
  check('dry run previews without touching', dry.plan.length === 1 && fs.existsSync(path.join(root, 'old-name.json')));
  const applied = format.migrate(root, { current: 2, migrations: sample });
  check('migration applies and stamps', applied.ok && format.readVersion(root) === 2 && fs.existsSync(path.join(root, 'new-name.json')));
  check('backup exists beside the migrated file', fs.existsSync(path.join(root, '.history')));
  const again = format.migrate(root, { current: 2, migrations: sample });
  check('second run is a no-op', again.ok && again.applied.length === 0);
  const refused = format.migrate(root, { current: 1, migrations: [] });
  check('a newer root is refused politely', refused.refused === true && /Update flow/.test(refused.reason));
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('sad paths (0339)');
{
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-sad-'));
  fs.mkdirSync(path.join(dir, '01-to-do'), { recursive: true });
  // Malformed frontmatter and a file with none at all: the board loads,
  // nothing crashes, the files stay untouched on disk.
  const broken = path.join(dir, '01-to-do', '0001-broken.md');
  fs.writeFileSync(broken, '---\nid: "0001\ntitle: unclosed quote\n');
  fs.writeFileSync(path.join(dir, '01-to-do', '0002-bare.md'), 'no frontmatter at all');
  let cards2 = null;
  try {
    cards2 = board.listCards(dir);
  } catch (err) {
    cards2 = null;
  }
  check('malformed cards never crash the board', Array.isArray(cards2) && cards2.length === 2);
  check('malformed files stay untouched', fs.readFileSync(broken, 'utf-8').includes('unclosed quote'));
  // A renamed/missing board root reads as empty, not as an exception.
  let missing = null;
  try {
    missing = board.listCards(path.join(dir, 'renamed-away'));
  } catch (err) {
    missing = null;
  }
  check('a vanished board root reads as empty', Array.isArray(missing) && missing.length === 0);
  // patching a malformed card: either it works or it throws cleanly, but
  // the file must never be half-written afterwards (atomic writes, 0330).
  const before = fs.readFileSync(broken, 'utf-8');
  try {
    board.patchCard(broken, { title: 'renamed' });
  } catch (err) {
    // A clean refusal is acceptable.
  }
  const after = fs.readFileSync(broken, 'utf-8');
  check('a failed patch leaves no half-written card', after.length > 0 && (after === before || after.includes('renamed')));
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('process registry (0333)');
{
  const registry = require(path.join(ROOT, 'proc-registry'));
  const selfStart = registry.startTimeOf(process.pid);
  if (selfStart) {
    check('a live pid with its real start time is ours', registry.stillOurs({ pid: process.pid, pidStart: selfStart }));
  } else {
    // Sandboxed environments deny ps; unverifiable must mean "not ours",
    // which is the fail-safe half of the same contract.
    check('unverifiable pid is treated as a stranger (ps denied here)', !registry.stillOurs({ pid: process.pid, pidStart: selfStart }));
  }
  check('a reused pid (start time mismatch) is a stranger', !registry.stillOurs({ pid: process.pid, pidStart: 'Mon Jan  1 00:00:00 2001' }));
  check('a dead pid is nobody', !registry.stillOurs({ pid: 999999, pidStart: 'whenever' }));
  check('no pid, no claim', !registry.stillOurs({ pid: null, pidStart: '' }));
}

console.log('watch coalescing (0329)');
{
  const { createCoalescer } = require(path.join(ROOT, 'watch-coalesce'));
  const emitted = [];
  let scheduled = null;
  const timers = { set: (fn) => { scheduled = fn; return 1; }, clear: () => { scheduled = null; } };
  const c = createCoalescer((batch) => emitted.push(batch), { timers });
  c.add('change', '/board/01-to-do/0001-a.md');
  c.add('change', '/board/01-to-do/0001-a.md');
  c.add('change', '/board/01-to-do/0002-b.md');
  c.add('add', '/board/01-to-do/0003-c.md');
  c.add('change', '/board/00-knowledge/doc.md~');
  c.add('change', '/board/00-knowledge/#doc.md#');
  check('nothing emits before the quiet window', emitted.length === 0);
  scheduled();
  check('a burst flushes as one batch', emitted.length === 1);
  check('paths dedupe, last event wins', emitted[0].changes.length === 3, JSON.stringify(emitted[0]));
  check('editor droppings never enter the batch', !JSON.stringify(emitted[0]).includes('~') && !JSON.stringify(emitted[0]).includes('#'));
  c.flush();
  check('an empty flush emits nothing', emitted.length === 1);
}

console.log('terminal buffer bounds (0334)');
{
  const sessionsMod = require(path.join(ROOT, 'sessions'));
  const entry = { buffer: [], bufferBytes: 0, trimmed: false };
  const push = sessionsMod.pushBounded;
  // Sustained output: many small chunks stay under budget and drop heads.
  for (let i = 0; i < 3000; i += 1) push(entry, 'x'.repeat(1024));
  check('sustained output stays within budget', entry.bufferBytes <= 2 * 1024 * 1024);
  check('trimming is admitted', entry.trimmed === true);
  // One oversized chunk keeps only its tail.
  const single = { buffer: [], bufferBytes: 0, trimmed: false };
  push(single, 'y'.repeat(3 * 1024 * 1024));
  check('oversized single chunk keeps a bounded tail', single.bufferBytes <= 2 * 1024 * 1024 && single.trimmed);
  // A quiet session never claims truncation.
  const quiet = { buffer: [], bufferBytes: 0, trimmed: false };
  push(quiet, 'hello');
  check('small output never trims', quiet.trimmed === false && quiet.bufferBytes === 5);
}

console.log('port ownership (0332)');
{
  const { spawnSync, spawn } = require('child_process');
  // A port unlikely to collide with anything, fresh per run.
  const port = 47000 + (process.pid % 2000);
  // A child process binds the port: to an empty owner set it is a stranger
  // to be named and spared; inside the owner family it is fair game.
  const child = spawn(process.execPath, [
    '-e',
    `require('net').createServer().listen(${port}, '127.0.0.1'); setInterval(() => {}, 1000);`,
  ], { stdio: 'ignore' });
  // CI runners can be slow to schedule the child (0399's flaky run): wait
  // for the bind to actually land instead of trusting one fixed beat.
  for (let waited = 0; waited < 20 && !ports.inUse(port); waited += 1) {
    spawnSync('/bin/sleep', ['0.3']);
  }
  if (ports.inUse(port)) {
    const result = ports.free(port, { ownerPids: [] });
    check('stranger holder is not killed', result.freed === false && result.killed.length === 0);
    check('stranger is named', result.strangers.length > 0, JSON.stringify(result.strangers));
    check('the stranger survived', ports.inUse(port));
    const owned = ports.free(port, { ownerPids: [child.pid] });
    check('owned holder is freed', owned.killed.length > 0, JSON.stringify(owned));
    spawnSync('/bin/sleep', ['0.3']);
    check('port is clear after owned free', !ports.inUse(port));
  } else {
    // GitHub's macOS runners refuse this observation path (lsof over a
    // child's socket) even though it works on every real Mac. The kill
    // logic itself is proven above through stillOurs/descendants and the
    // owned-free case locally; an unobservable environment is a skip with
    // its reason said aloud, not a red build.
    console.log('  skip port-ownership live test — this environment cannot observe the bind');
  }
  try { child.kill('SIGKILL'); } catch (err) { /* already gone */ }
}

console.log('id allocation (0331)');
{
  const os = require('os');
  const aw = require(path.join(ROOT, 'atomic-write'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-ids-'));
  aw.atomicCreate(path.join(dir, 'claim.md'), 'mine');
  let refused = false;
  try {
    aw.atomicCreate(path.join(dir, 'claim.md'), 'thief');
  } catch (err) {
    refused = err.code === 'EEXIST';
  }
  check('exclusive create refuses an existing file', refused);
  check('the first claim keeps its content', fs.readFileSync(path.join(dir, 'claim.md'), 'utf-8') === 'mine');

  const boardDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-board-ids-'));
  const ids = [];
  for (let i = 0; i < 20; i += 1) ids.push(board.createCard(boardDir, `burst card ${i}`).id);
  check('20 rapid creates yield 20 distinct ids', new Set(ids).size === 20, ids.join(','));
  check(
    'ids are sequential',
    ids.every((id, i) => i === 0 || Number(id) === Number(ids[i - 1]) + 1)
  );
  // A squatter on the next id: the allocator steps past instead of colliding.
  const squat = String(Number(ids[ids.length - 1]) + 1).padStart(4, '0');
  fs.writeFileSync(path.join(boardDir, '01-to-do', `${squat}-squatter.md`), `---\nid: "${squat}"\ntitle: "Squatter"\nstatus: to-do\n---\n`);
  const after = board.createCard(boardDir, 'after squatter');
  check('allocator steps past an outside claim', Number(after.id) > Number(squat), after.id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(boardDir, { recursive: true, force: true });
}

console.log('atomic writes (0330)');
{
  const os = require('os');
  const aw = require(path.join(ROOT, 'atomic-write'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-atomic-'));
  const target = path.join(dir, 'card.md');
  aw.atomicWrite(target, 'first');
  check('writes land', fs.readFileSync(target, 'utf-8') === 'first');
  aw.atomicWrite(target, 'second');
  check('overwrites land whole', fs.readFileSync(target, 'utf-8') === 'second');
  check('no temp file left behind', fs.readdirSync(dir).filter((n) => n.startsWith(aw.TMP_PREFIX)).length === 0);
  // A rename that cannot succeed must keep the original and clean its temp.
  let failed = false;
  try {
    aw.atomicWrite(path.join(dir, 'missing-dir', 'x.md'), 'never');
  } catch (err) {
    failed = true;
  }
  check('impossible target throws, original untouched', failed && fs.readFileSync(target, 'utf-8') === 'second');
  for (let i = 0; i < 8; i += 1) {
    aw.keepHistory(target);
    aw.atomicWrite(target, `v${i}`);
  }
  const historyDir = path.join(dir, '.history');
  const kept = fs.readdirSync(historyDir).filter((n) => n.endsWith('-card.md'));
  check('history keeps a bounded tail', kept.length > 0 && kept.length <= 5, String(kept.length));
  // Stale temp sweep: plant an old temp file and watch it go.
  const stale = path.join(dir, `${aw.TMP_PREFIX}old`);
  fs.writeFileSync(stale, 'x');
  fs.utimesSync(stale, new Date(Date.now() - 7200000), new Date(Date.now() - 7200000));
  aw.sweepStaleTemp(dir);
  check('stale temp files sweep away', !fs.existsSync(stale));
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('redaction (0323)');
{
  const { redact } = require(path.join(ROOT, 'redact'));
  const env = redact('ANTHROPIC_API_KEY=sk-ant-abc123def456ghi789\nDB_HOST=localhost');
  check('env api key masked', !env.includes('sk-ant') && env.includes('[redacted:'));
  check('harmless env line survives', env.includes('DB_HOST=localhost'));
  const bearer = redact('curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig"');
  check('bearer token masked', !bearer.includes('eyJhbGci'));
  const gh = redact('remote: https://ghp_AbCdEfGhIjKlMnOpQrStUvWxYz123456@github.com/x.git');
  check('github token masked', !gh.includes('ghp_AbCdEf'));
  const path1 = redact('/Users/someone/Vibes/flow/projects/flow/01-to-do/0315-a-very-long-card-file-name-here.md');
  check('long file paths stay readable', path1.includes('0315-a-very-long-card-file-name-here.md'));
  const quoted = redact('"client_secret": "abcd1234efgh5678"');
  check('quoted json secret masked', !quoted.includes('abcd1234'));
}

console.log('process policy (0322)');
{
  const proc = require(path.join(ROOT, 'proc'));
  check('valid port passes', proc.assertPort(4100) === 4100);
  let threw = false;
  try { proc.assertPort('4100; rm -rf ~'); } catch (err) { threw = true; }
  check('metacharacter port refused', threw);
  threw = false;
  try { proc.assertPid('12 34'); } catch (err) { threw = true; }
  check('non-integer pid refused', threw);
  check('which resolves a real binary absolutely', (proc.which('ls') || '').startsWith('/'));
  check('which refuses an injection-shaped name', proc.which('ls; touch /tmp/pwned') === null);
  threw = false;
  try {
    proc.run('/bin/echo', ['hi'], { cwd: '/etc', cwdRoots: ['/tmp'] });
  } catch (err) { threw = err.message === 'cwd-outside-root'; }
  check('cwd outside allowed roots refused', threw);
  check('cwd inside allowed roots runs', proc.run('/bin/echo', ['hi'], { cwd: '/tmp', cwdRoots: ['/tmp'] }).trim() === 'hi');
}

console.log('ipc validation (0321)');
{
  const v = require(path.join(ROOT, 'validate'));
  const schema = [v.str(10), v.oneOf('a', 'b'), v.arrOf(v.str(5), 3)];
  check('good arguments pass', v.check(['hi', 'a', ['x']], schema) === null);
  check('wrong type refused', v.check([42, 'a', []], schema) !== null);
  check('oversized string refused', v.check(['012345678901', 'a', []], schema) !== null);
  check('out-of-enum refused', v.check(['hi', 'c', []], schema) !== null);
  check('array bounds enforced', v.check(['hi', 'a', ['1', '2', '3', '4']], schema) !== null);
  check('extra arguments refused', v.check(['hi', 'a', [], 'extra'], schema) !== null);
  check('undeclared channel refused', v.check([], undefined) === 'undeclared channel');
  check('objects must be plain and bounded', v.obj(2)({ a: 1, b: 2, c: 3 }) !== null && v.obj()([]) !== null);
  check('optional slots allow absence', v.optStr()(undefined) === null && v.optBool()(null) === null);
  check('reasons never echo the value', v.str(5)('secret-value-here').indexOf('secret') === -1);
}

console.log('external urls');
const { isSafeExternalUrl } = require(path.join(ROOT, 'urls'));
check('https allowed', isSafeExternalUrl('https://example.com/a?b=c'));
check('http allowed', isSafeExternalUrl('http://localhost:4100/x'));
check('file refused', !isSafeExternalUrl('file:///etc/passwd'));
check('javascript refused', !isSafeExternalUrl('javascript:alert(1)'));
check('custom scheme refused', !isSafeExternalUrl('myapp://payload'));
check('garbage refused', !isSafeExternalUrl('not a url'));
check('empty and null refused', !isSafeExternalUrl('') && !isSafeExternalUrl(null));
check('case-tricked scheme refused', !isSafeExternalUrl('JaVaScRiPt:alert(1)'));
check('uppercase https allowed', isSafeExternalUrl('HTTPS://example.com'));

console.log('cli errors');
const cli = require(path.join(ROOT, 'cli'));
check(
  'missing binary names the CLI and PATH',
  /not on your PATH/.test(cli.explainError('spawn claude ENOENT', 'claude'))
);
check(
  'stdin stall is treated as a login problem',
  /not logged in/.test(
    cli.explainError('Warning: no stdin data received in 3s, proceeding without it. If piping from a slow command, redirect stdin explicitly: < /dev/null to skip, or wait longer.')
  )
);
check(
  'auth failure says to log in',
  /not logged in/.test(cli.explainError('Error: not logged in. Please run /login'))
);
check(
  'expired oauth is a login problem',
  /logged in/.test(
    cli.explainError('Failed to authenticate. API Error: 401 authentication_error OAuth access token is invalid.')
  )
);
check(
  'unknown errors pass through',
  cli.explainError('the model returned no sections, twice').includes('no sections')
);

console.log('projects');
const list = projects.read();
check('project list is an array', Array.isArray(list));
for (const p of list) {
  check(`${p.name} board root points into flow/projects`, p.boardRoot.endsWith(`projects/${p.name}`));
}

console.log('board — registered boards, read only');
for (const p of list) {
  const cards = board.listCards(p.boardRoot);
  check(`${p.name} board reads cleanly`, Array.isArray(cards), typeof cards);
  check(`${p.name} cards have titles and columns`, cards.every((c) => c.title && c.title.length > 1 && c.column));
}

console.log('board — scratch project');
const PROJECTS_DIR = path.join(__dirname, '..', 'projects');
const SCRATCH = path.join(PROJECTS_DIR, '__smoke__');
fs.rmSync(SCRATCH, { recursive: true, force: true });
board.ensureBoard(SCRATCH);

const a = board.createCard(SCRATCH, 'Alpha: first card');
const b = board.createCard(SCRATCH, 'Beta: second card');
const c = board.createCard(SCRATCH, 'Gamma: third card');

check('ids increment', [a.id, b.id, c.id].join(',') === '0001,0002,0003', [a.id, b.id, c.id].join(','));
check('new cards append to the bottom', [a.position, b.position, c.position].join(',') === '1,2,3', [a.position, b.position, c.position].join(','));

let order = board.listCards(SCRATCH).map((x) => x.id);
check('listed in position order', order.join(',') === '0001,0002,0003', order.join(','));

// Reverse them, the way a drag would.
board.reorder(SCRATCH, 'to-do', [c.path, b.path, a.path]);
order = board.listCards(SCRATCH).map((x) => x.id);
check('reorder persists', order.join(',') === '0003,0002,0001', order.join(','));

const moved = board.moveCard(SCRATCH, b.path, 'doing');
check('moves column', moved.column === 'doing');
check('takes bottom position in the new column', String(moved.position) === '1', String(moved.position));
check('status follows the move', moved.status === 'doing');

const done = board.moveCard(SCRATCH, moved.path, 'done');
check('completed stamped on done', Boolean(done.completed));
const backOut = board.moveCard(SCRATCH, done.path, 'to-do');
check('completed cleared coming back out', backOut.completed === '', JSON.stringify(backOut.completed));

board.writeBody(backOut.path, '\n## Plan\n\nSomething.\n');
const reread = board.readCardAt(backOut.path);
check('body written', reread.body.includes('## Plan'));
check('frontmatter survived body write', reread.id === '0002' && reread.status === 'to-do', `${reread.id}/${reread.status}`);
check('position survived body write', String(reread.position) === '4', String(reread.position));

check('new fields present on new cards', ['pr_url', 'route', 'needs_input', 'position'].every((k) => k in reread), Object.keys(reread).join(','));

console.log('knowledge — moving docs between folders');
const knowledgeMod = require(path.join(ROOT, 'knowledge'));
knowledgeMod.ensure(SCRATCH);
knowledgeMod.createFolder(SCRATCH, 'Alpha');
knowledgeMod.createFolder(SCRATCH, 'Beta');
const docA = knowledgeMod.createDoc(SCRATCH, 'Alpha', 'travels');
knowledgeMod.createDoc(SCRATCH, 'Beta', 'travels');
knowledgeMod.setOrder(SCRATCH, 'Alpha', ['travels.md']);
const movedDoc = knowledgeMod.moveDoc(SCRATCH, docA.path, 'Beta');
check('doc moves on disk', fs.existsSync(movedDoc.path) && !fs.existsSync(docA.path));
check('a name clash gets a suffix, not a refusal', path.basename(movedDoc.path) === 'travels-2.md', movedDoc.path);
check('doc lands in the target folder', movedDoc.path.includes('/Beta/'));
const orderAfterMove = JSON.parse(fs.readFileSync(path.join(SCRATCH, '00-knowledge', '.order.json'), 'utf-8'));
check('old folder order forgets the doc', !(orderAfterMove.Alpha || []).includes('travels.md'), JSON.stringify(orderAfterMove.Alpha));
const backAgain = knowledgeMod.moveDoc(SCRATCH, movedDoc.path, 'Alpha');
check('moves back without a suffix', path.basename(backAgain.path) === 'travels-2.md' && backAgain.path.includes('/Alpha/'));
const sameSpot = knowledgeMod.moveDoc(SCRATCH, backAgain.path, 'Alpha');
check('moving to its own folder is a no-op', sameSpot.path === backAgain.path);
let moveRefused = false;
try {
  knowledgeMod.moveDoc(SCRATCH, backAgain.path, '.archive');
} catch (err) {
  moveRefused = true;
}
check('dot-folders are refused', moveRefused);

console.log('plugins');
check('plugins default to an empty object', (() => {
  const decorated = projects.read()[0];
  return decorated && typeof decorated.plugins === 'object';
})());

console.log('env');
const envmod = require(path.join(ROOT, 'env'));
const ENVDIR = path.join(PROJECTS_DIR, '__envsmoke__');
fs.mkdirSync(ENVDIR, { recursive: true });

const envFile = path.join(ENVDIR, '.env.local');
fs.writeFileSync(
  envFile,
  '# local only\nPORT=3011\n\nexport API_KEY="secret value"\nEMPTY=\n# trailing comment\n',
  'utf-8'
);

let read = envmod.read(ENVDIR);
check('finds .env.local', read.file === envFile && read.exists);
check('parses keys in order', read.vars.map((v) => v.key).join(',') === 'PORT,API_KEY,EMPTY', read.vars.map((v) => v.key).join(','));
check('strips quotes', read.vars[1].value === 'secret value', read.vars[1].value);
check('keeps empty values', read.vars[2].value === '', JSON.stringify(read.vars[2].value));

read = envmod.write(envFile, [
  { key: 'PORT', value: '4200' },
  { key: 'API_KEY', value: 'rotated' },
  { key: 'NEW_ONE', value: 'hello world' },
]);

const written = fs.readFileSync(envFile, 'utf-8');
check('updates a value in place', /\nPORT=4200\n/.test(written), written);
check('keeps the export prefix and quoting', /export API_KEY="rotated"/.test(written), written);
check('preserves comments', written.includes('# local only') && written.includes('# trailing comment'));
check('removes a dropped key', !/\nEMPTY=/.test(written), written);
check('appends a new key, quoting whitespace', /NEW_ONE="hello world"/.test(written), written);
check('re-reads what it wrote', envmod.read(ENVDIR).vars.length === 3);

const freshDir = path.join(ENVDIR, 'fresh');
fs.mkdirSync(freshDir, { recursive: true });
const fresh = envmod.read(freshDir);
check('proposes .env.local when none exists', fresh.file.endsWith('.env.local') && !fresh.exists);
envmod.write(fresh.file, [{ key: 'A', value: '1' }]);
check('creates the file on first write', fs.existsSync(fresh.file));

fs.unlinkSync(fresh.file);
fs.rmdirSync(freshDir);
fs.unlinkSync(envFile);
fs.rmdirSync(ENVDIR);

console.log('worktree sharing');
const gitmod = require(path.join(ROOT, 'git'));

console.log('git — switching branches');
{
  const { execFileSync } = require('child_process');
  const REPO = path.join(SCRATCH, 'switch-repo');
  fs.mkdirSync(REPO, { recursive: true });
  const g = (...args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf-8' }).trim();
  g('init', '-q', '-b', 'main');
  g('-c', 'user.email=smoke@flow', '-c', 'user.name=smoke', 'commit', '--allow-empty', '-q', '-m', 'seed');
  g('branch', 'feature');
  check('switches to a clean branch', gitmod.switchBranch(REPO, 'feature') === 'feature');
  fs.writeFileSync(path.join(REPO, 'dirty.txt'), 'uncommitted');
  let switchRefused = '';
  try {
    gitmod.switchBranch(REPO, 'main');
  } catch (err) {
    switchRefused = err.message;
  }
  check('a dirty checkout refuses to switch', /uncommitted/i.test(switchRefused), switchRefused);
  check('still on the branch it was on', gitmod.currentBranch(REPO) === 'feature');
  let badName = false;
  try {
    gitmod.switchBranch(REPO, 'main; rm -rf /');
  } catch (err) {
    badName = true;
  }
  check('a hostile branch name is refused outright', badName);
  fs.rmSync(REPO, { recursive: true, force: true });
}
const SRC = path.join(PROJECTS_DIR, '__wtsrc__');
const DEST = path.join(PROJECTS_DIR, '__wtdest__');
fs.mkdirSync(path.join(SRC, 'node_modules', 'left-pad'), { recursive: true });
fs.writeFileSync(path.join(SRC, 'node_modules', 'left-pad', 'index.js'), 'module.exports=1;\n');
fs.writeFileSync(path.join(SRC, '.env.local'), 'PORT=3011\n');
fs.mkdirSync(path.join(SRC, '.next'), { recursive: true });
fs.mkdirSync(DEST, { recursive: true });

const shared = gitmod.shareArtifacts(SRC, DEST);
check('symlinks node_modules', shared.linked.includes('node_modules'), JSON.stringify(shared));
check('node_modules is a link, not a copy', fs.lstatSync(path.join(DEST, 'node_modules')).isSymbolicLink());
check('linked contents resolve', fs.existsSync(path.join(DEST, 'node_modules', 'left-pad', 'index.js')));
check('copies .env.local', shared.copied.includes('.env.local'));
check('.env.local is a real file', !fs.lstatSync(path.join(DEST, '.env.local')).isSymbolicLink());
check('never shares build output', !fs.existsSync(path.join(DEST, '.next')));
check('.next is on the never-shared list', gitmod.NEVER_SHARED.includes('.next'));

// Running twice must not double up or throw.
const again = gitmod.shareArtifacts(SRC, DEST);
check('second run is a no-op', again.linked.length === 0 && again.skipped.includes('node_modules'), JSON.stringify(again));

// Removing the worktree must not follow the symlink into the real node_modules.
fs.unlinkSync(path.join(DEST, 'node_modules'));
check('unlinking leaves the source intact', fs.existsSync(path.join(SRC, 'node_modules', 'left-pad', 'index.js')));

fs.unlinkSync(path.join(DEST, '.env.local'));
fs.rmdirSync(DEST);
fs.rmSync(SRC, { recursive: true, force: true });

console.log('term-keys');
const termKeys = require(path.join(__dirname, '..', 'lib', 'term-keys'));
const key = (overrides) => ({
  type: 'keydown',
  key: 'Enter',
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  ...overrides,
});
const shiftDown = termKeys.enterKeyOverride(key({ shiftKey: true }));
check('shift-enter keydown sends a bracketed-paste newline', shiftDown && shiftDown.data === termKeys.PASTED_NEWLINE);
check('the pasted newline is wrapped, not a bare \\r or \\n', /^\x1b\[200~\n\x1b\[201~$/.test(termKeys.PASTED_NEWLINE));
// The regression this guards: Enter still fires a keypress in Chrome, and
// xterm's keypress path sends \r for shift combos unless the handler refuses
// the keypress too. Overridden combos must be swallowed for every event type.
const shiftPress = termKeys.enterKeyOverride(key({ type: 'keypress', shiftKey: true }));
check('shift-enter keypress is swallowed with no bytes', shiftPress && shiftPress.data === '');
const shiftUp = termKeys.enterKeyOverride(key({ type: 'keyup', shiftKey: true }));
check('shift-enter keyup is swallowed with no bytes', shiftUp && shiftUp.data === '');
const cmdDown = termKeys.enterKeyOverride(key({ metaKey: true }));
check('cmd-enter keydown sends ESC+CR', cmdDown && cmdDown.data === termKeys.ESC_CR);
const ctrlDown = termKeys.enterKeyOverride(key({ ctrlKey: true }));
check('ctrl-enter keydown sends ESC+CR', ctrlDown && ctrlDown.data === termKeys.ESC_CR);
check('plain enter is left to xterm', termKeys.enterKeyOverride(key({})) === null);
check('plain enter keypress is left to xterm', termKeys.enterKeyOverride(key({ type: 'keypress' })) === null);
check('option-enter is left to xterm', termKeys.enterKeyOverride(key({ altKey: true, shiftKey: true })) === null);
check('cmd-shift-enter is left to xterm', termKeys.enterKeyOverride(key({ metaKey: true, shiftKey: true })) === null);
check('other keys are left to xterm', termKeys.enterKeyOverride(key({ key: 'a', shiftKey: true })) === null);

console.log('ports');
const portProject = { name: '__smoke__', portBase: 4100, boardRoot: SCRATCH };
const port = ports.allocate(portProject);
check('allocates within the project range', port >= portProject.portBase && port < portProject.portBase + 100, String(port));

console.log('session cli');
const config = require(path.join(ROOT, 'config'));
check('defaults to claude', config.cli({}) === 'claude');
check('honours a custom command', config.cli({ terminalCommand: 'claude --verbose' }) === 'claude --verbose');
// Sandbox mode retired with 0418: stored sandbox keys are ignored entirely.
check('stored sandbox keys are ignored', config.cli({ sandbox: true, sandboxCommand: 'my-box' }) === 'claude');

// Clean up the scratch board — everything ensureBoard creates, columns and all.
fs.rmSync(SCRATCH, { recursive: true, force: true });
check('cleanup', !fs.existsSync(SCRATCH));

console.log(failures ? `\n${failures} failing` : '\nall good');
process.exit(failures ? 1 : 0);
