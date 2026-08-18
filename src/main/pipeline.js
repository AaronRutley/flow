const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const board = require('./board');
const knowledge = require('./knowledge');
const git = require('./git');
const ports = require('./ports');
const sessions = require('./sessions');
const config = require('./config');
const cli = require('./cli');

// The envelope a `claude -p --output-format json` run prints: the result
// text and metadata. Bad JSON degrades to the raw text — never to a failure.
function parseClaudeEnvelope(stdout) {
  try {
    const envelope = JSON.parse(stdout);
    return { text: typeof envelope.result === 'string' ? envelope.result : '', envelope };
  } catch (err) {
    return { text: String(stdout || ''), envelope: null };
  }
}

function sessionId(project, card) {
  return `${project.name}-${card.id}`;
}

// Claude Code files each conversation as ~/.claude/projects/<cwd-slug>/<uuid>.jsonl.
// The card stores the uuid at start, before anyone presses Enter, so a failed
// first launch (not logged in, command never run) leaves an id with no file.
// Resume must not fire against that ghost.
function claudeSessionLog(project, card) {
  if (!card.claude_session) return null;
  for (const cwd of [card.worktree, project.path].filter(Boolean)) {
    const slug = String(cwd).replace(/[/.]/g, '-');
    const log = path.join(
      process.env.HOME,
      '.claude',
      'projects',
      slug,
      `${card.claude_session}.jsonl`
    );
    if (fs.existsSync(log)) return log;
  }
  return null;
}

// The four headings a card needs before it is worth handing to an agent.
const SECTIONS = ['## Plan', '## Build', '## QA', '## Done when'];

function hasStructure(body) {
  return SECTIONS.some((heading) => body.includes(heading));
}

/**
 * Drafts the card's structure in the background, before any worktree or branch
 * exists. Headless rather than interactive: this is a first pass to react to,
 * not a conversation.
 */
function planPrompt(cardPath, title, { quick = false } = {}) {
  return [
    `Fill in the task file at ${cardPath} for the card "${title}".`,
    '',
    // A shape has to come back in seconds, not minutes: the wandering
    // repository survey is what made it slow, so the quick pass is told to
    // glance rather than study. Draft-a-plan keeps the deep read.
    quick
      ? 'Glance at the repository only as far as this card needs — a directory listing and at most three or four file reads, no survey of the whole codebase. Then write these four sections into that file:'
      : 'Read the repository you are in for context, then write these four sections into that file:',
    '',
    '## Plan — a short paragraph on the approach.',
    '## Build — a checklist of the implementation steps, each one a `- [ ]` item.',
    '## QA — a checklist of checks that prove the work is right afterwards.',
    '## Done when — the observable conditions that mean this card is finished.',
    '',
    'How to write it:',
    '- Plain English. Explain it the way you would to someone who knows the product but not this part of the code.',
    '- No jargon where an ordinary word works. No abbreviations the reader has to look up.',
    '- Short sentences. Say what happens and why, not how clever it is.',
    '- Where a decision is genuinely open, say so in one line rather than inventing an answer.',
    '',
    'Leave the frontmatter between the --- markers exactly as it is. Change nothing else in the repository.',
  ].join('\n');
}

function planCard(project, cardPath) {
  const found = cli.resolve('claude');
  if (!found.ok) return Promise.resolve(found);

  const card = board.readCardAt(cardPath);
  const args = [
    '-p',
    planPrompt(cardPath, card.title),
    '--permission-mode',
    'acceptEdits',
    '--add-dir',
    project.boardRoot,
    '--output-format',
    'json',
  ];

  return new Promise((resolve) => {
    cli.runFile(
      found.bin,
      args,
      {
        cwd: project.path,
        timeout: 5 * 60 * 1000,
        maxBuffer: 8 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (err) {
          resolve({
            ok: false,
            error: cli.explainError((stderr || err.message || '').toString().trim(), 'claude'),
          });
          return;
        }
        const { text } = parseClaudeEnvelope(stdout);
        // The card can move columns or be deleted while the agent runs; a
        // throw here would be an uncaught exception in the main process.
        let written;
        try {
          written = board.readCardAt(cardPath);
        } catch (readErr) {
          resolve({ ok: false, error: 'The card moved or was deleted while it was being written' });
          return;
        }
        resolve({
          ok: hasStructure(written.body),
          card: written,
          output: text.trim().slice(-2000),
        });
      }
    );
  });
}

/**
 * Shapes a raw card: tidies the title and drafts the four sections, on a small
 * model so several can run at once without costing anything to speak of.
 *
 * Unlike planCard this may rewrite the frontmatter title — a quick-added card's
 * title is one dashed-off line, and turning it into a proper card is the point.
 */
function shapeCard(project, cardPath, onStream) {
  const card = board.readCardAt(cardPath);

  // A global setting can replace the whole shaping brief. Custom briefs were
  // written for the file-editing agent, so they keep the agentic path — that
  // agent edits the card file itself, so there is no document to stream.
  const custom = (config.read().shapePrompt || '').trim();
  if (custom) {
    return runShape(project, cardPath,
      custom.split('{path}').join(cardPath).split('{title}').join(card.title));
  }

  return runShapeFast(project, cardPath, card, onStream);
}

/**
 * What the fast shaper gets instead of a repository to wander: the top-level
 * file listing plus the head of the README and package.json, gathered here in
 * milliseconds rather than by an agent in turns.
 */
function repoGlance(projectPath) {
  const parts = [];
  try {
    const entries = fs
      .readdirSync(projectPath)
      .filter((name) => !name.startsWith('.') && name !== 'node_modules')
      .slice(0, 50);
    parts.push(`Top-level entries: ${entries.join(', ')}`);
  } catch (err) {
    // No listing, the model shapes from the card alone.
  }
  for (const name of ['README.md', 'readme.md', 'package.json']) {
    try {
      const text = fs.readFileSync(path.join(projectPath, name), 'utf-8').slice(0, 1600);
      parts.push(`--- ${name}, first part ---\n${text}`);
    } catch (err) {
      // Absent — fine.
    }
  }
  return parts.join('\n\n');
}

/**
 * The whole shape in one model call. The old path spawned a full agent that
 * started a session, listed the repo, read files and edited the card over
 * six-plus round trips — tens of seconds on a good day. Here the context
 * travels in the prompt, Haiku answers once with the finished document, and
 * the file is written back in-process.
 */
// Cards whose last shape died on the timeout (0242). Selecting Shape again
// on one of these runs with five minutes instead of thirty seconds — the
// user has said "no, really, wait for it". In memory only, per card, and
// cleared when the retry finishes either way, so nothing lingers past a
// restart or leaks onto other cards.
const shapeTimedOut = new Set();

// Live shape runs by card path (0249). A card archived mid-shape must take
// its model call down with it — otherwise the run keeps burning and, on the
// agentic path, can even recreate the file it was shaping.
const activeShapes = new Map();

function cancelShape(cardPath) {
  const run = activeShapes.get(cardPath);
  if (!run) return false;
  run.cancelled = true;
  try {
    run.kill();
  } catch (err) {
    // Already gone — cancelled either way.
  }
  return true;
}

// The built-in shaping brief, named so the settings screen can pre-fill
// with it (0429): what the user edits is exactly what runs.
const SHAPE_INSTRUCTIONS = [
  'You are shaping a task card for the product described below. Reply with',
  'plain markdown ONLY - no preamble, no code fences, and use no tools.',
  '',
  'First line: `TITLE: ` then a tidied card title in the shape',
  '"Lead: rest of the title" - a one or two word lead, a colon, then a short',
  'plain description, in title case (Capitalise the Main Words). Plain',
  'technical English: no emoji, no em dashes, no decoration.',
  'Then a blank line, then exactly these four sections:',
  '## Plan - a short paragraph on the approach, plain English.',
  '## Build - a checklist of the implementation steps, each a `- [ ]` item.',
  '## QA - a checklist of checks that prove the work is right afterwards.',
  '## Done when - the observable conditions that mean this card is finished.',
  '',
  'Write for someone who knows the product but not this part of the code.',
  'Short sentences. No jargon. Where a decision is genuinely open, say so in',
  'one line rather than inventing an answer.',
  '',
  'The context below is the spec, not a rough draft to summarise (0458):',
  'carry every concrete detail into the sections - names, paths, numbers,',
  'quoted phrases, edge cases, and every item of any list the writer already',
  'made. Condense wording, never information. If the context lists steps or',
  'requirements, keep them as their own Build items in the same order rather',
  'than folding them into broader ones. Losing a detail is worse than an',
  'untidy checklist.',
].join('\n');

// The default way the shaper starts the model, also shown in settings.
const SHAPE_COMMAND = 'claude -p';

// The model shaping runs on when the user has not said otherwise (0450) —
// small on purpose: several shapes run at once and cost next to nothing.
const SHAPE_MODEL = 'haiku';

// What Start work hands the agent (0457), editable in settings with
// [card-path], [task-name] and [project-name] substituted at fire time.
// The card is already planned by the time this runs, so the brief is about
// following the plan, not writing another one.
const START_PROMPT =
  "Start this work: read the card at [card-path]. It's already planned — follow it: " +
  'work through the Build checklist, ticking items as they land, run the QA checks, ' +
  'and keep the card updated as you go.';

function runShapeFast(project, cardPath, card, onStream, attempt = 1) {
  // The command and brief are user preference since 0429, pre-filled with
  // the defaults above. A custom command's own flags (say, --model sonnet)
  // replace the built-in haiku pick; the streaming plumbing always rides
  // along, because the parser below depends on it.
  const settings = config.read();
  const commandTokens = String(settings.shapeCommand || '').trim().split(/\s+/).filter(Boolean);
  const found = cli.resolve(commandTokens[0] || 'claude');
  if (!found.ok) return Promise.resolve(found);
  const instructions = String(settings.shapeInstructions || '').trim() || SHAPE_INSTRUCTIONS;

  const prompt = [
    instructions,
    '',
    `The card's title: ${card.title}`,
    card.body.trim() ? `The card's context:\n${card.body.trim()}` : 'The card has no context yet.',
    '',
    'The repository, at a glance:',
    repoGlance(project.path),
  ].join('\n');

  const leadArgs = commandTokens.length > 1 ? commandTokens.slice(1) : ['-p'];
  // The Model field wins when filled (0450) — it rides after the command's
  // own flags, so a --model typed there is overridden by the explicit
  // choice. Unset, a custom command keeps its own flags; the default
  // command falls back to the built-in model.
  const model = String(settings.shapeModel || '').trim();
  const modelArgs = model
    ? ['--model', model]
    : commandTokens.length
      ? []
      : ['--model', SHAPE_MODEL];

  return new Promise((resolve) => {
    // Streamed rather than collected: each text delta goes out through
    // onStream as the model writes it, so a clicked card can show the shape
    // being written instead of a spinner.
    const child = cli.runSpawn(
      found.bin,
      // No MCP servers: a pure-generation call has no use for them, and
      // skipping their startup is most of the difference between a shape
      // that feels instant and one you wait on.
      [...leadArgs, prompt, ...modelArgs, '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
       '--output-format', 'stream-json', '--include-partial-messages', '--verbose'],
      { cwd: project.path }
    );

    // A shape is one Haiku call. If nothing has come back in half a minute
    // the CLI is stuck (usually a dead login), not thinking. The old 150s
    // timeout plus a silent retry left first-time users watching a spinner
    // for five minutes. Except on a deliberate retry after a timeout
    // (0242): then the long wait is exactly what was asked for.
    const extendedWait = shapeTimedOut.has(cardPath);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, (extendedWait ? 5 * 60 : 30) * 1000);
    const run = { cancelled: false, kill: () => child.kill('SIGKILL') };
    activeShapes.set(cardPath, run);
    let streamed = '';
    let finalText = null;
    let streamError = null;
    let stderr = '';
    let pending = '';

    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.on('data', (chunk) => {
      // One JSON event per line; a chunk can end mid-line, so the tail waits
      // for its other half.
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch (parseErr) {
          continue;
        }
        const delta = event.type === 'stream_event' && event.event && event.event.delta;
        if (delta && delta.type === 'text_delta') {
          streamed += delta.text;
          // The whole text so far, not the delta: the listener can always
          // just replace what it shows, whatever it missed before — and a
          // retry simply starts the text over.
          if (onStream) onStream(streamed);
        }
        if (event.type === 'error') {
          streamError = String(event.error || event.message || event.result || line);
        }
        if (event.type === 'result') {
          if (event.is_error) streamError = String(event.result || event.error || 'claude returned an error');
          else if (typeof event.result === 'string') finalText = event.result;
        }
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      if (activeShapes.get(cardPath) === run) activeShapes.delete(cardPath);
      resolve({ ok: false, error: cli.explainError(err.message, 'claude') });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (activeShapes.get(cardPath) === run) activeShapes.delete(cardPath);
      if (run.cancelled) {
        resolve({ ok: false, cancelled: true });
        return;
      }
      if (timedOut) {
        // First timeout arms the long retry; a timeout of the long retry
        // itself disarms it — back to the quick check.
        if (extendedWait) shapeTimedOut.delete(cardPath);
        else shapeTimedOut.add(cardPath);
        resolve({
          ok: false,
          error: extendedWait
            ? 'The claude CLI did not reply in 5 minutes. Use Log in with claude, press Enter, sign in if it asks, then try Shape again.'
            : 'The claude CLI did not reply in 30s. A healthy shape is a few seconds. Shape again to wait up to 5 minutes — or use Log in with claude first if you have not signed in.',
        });
        return;
      }
      shapeTimedOut.delete(cardPath);
      if (streamError) {
        resolve({ ok: false, error: cli.explainError(streamError, 'claude') });
        return;
      }
      // A single-shot generation has flaky failure modes a loop would have
      // absorbed — an off-script reply, a slow start. Retry only a quick
      // empty failure, never a timeout or an auth error.
      const retry = () => resolve(runShapeFast(project, cardPath, card, onStream, attempt + 1));
      if (code !== 0) {
        const detail = [streamError, stderr, streamed].filter(Boolean).join('\n').trim()
          || `claude exited with code ${code}`;
        console.error(`[shape] attempt ${attempt} failed on "${card.title}": ${detail.slice(-300)}`);
        const fatal = /401|oauth|not logged in|stdin|enoent/i.test(detail);
        if (attempt === 1 && !fatal) return retry();
        resolve({ ok: false, error: cli.explainError(detail, 'claude') });
        return;
      }
      const text = (finalText !== null ? finalText : streamed).trim();
      const titleMatch = text.match(/^TITLE:\s*(.+)$/m);
      const sectionsStart = text.indexOf('## ');
      if (sectionsStart === -1) {
        console.error(`[shape] attempt ${attempt} returned no sections for "${card.title}": ${text.slice(0, 200)}`);
        if (attempt === 1) return retry();
        resolve({ ok: false, error: 'the model returned no sections, twice' });
        return;
      }
      const sections = text.slice(sectionsStart).trim();
      try {
        // Re-read before writing: the context may have been edited while
        // the model was thinking, and the card may have moved entirely.
        const fresh = board.readCardAt(cardPath);
        const context = fresh.body.split(/\n##\s/)[0].trim();
        board.writeBody(cardPath, `\n${context ? `${context}\n\n` : ''}${sections}\n`);
        if (titleMatch) board.patchCard(cardPath, { title: titleMatch[1].trim() });
        const written = board.readCardAt(cardPath);
        resolve({ ok: hasStructure(written.body), card: written });
      } catch (readErr) {
        resolve({ ok: false, error: 'The card moved or was deleted while it was being shaped' });
      }
    });
  });
}

function runShape(project, cardPath, prompt) {
  const found = cli.resolve('claude');
  if (!found.ok) return Promise.resolve(found);

  return new Promise((resolve) => {
    const child = cli.runFile(
      found.bin,
      ['-p', prompt, '--model', 'haiku', '--permission-mode', 'acceptEdits',
       '--add-dir', project.boardRoot, '--output-format', 'json'],
      {
        cwd: project.path,
        timeout: 4 * 60 * 1000,
        maxBuffer: 8 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (activeShapes.get(cardPath) === run) activeShapes.delete(cardPath);
        if (run.cancelled) {
          resolve({ ok: false, cancelled: true });
          return;
        }
        if (err) {
          resolve({
            ok: false,
            error: cli.explainError((stderr || err.message || '').toString().trim(), 'claude'),
          });
          return;
        }
        // Same guard as planCard: the file may have moved mid-shape.
        let written;
        try {
          written = board.readCardAt(cardPath);
        } catch (readErr) {
          resolve({ ok: false, error: 'The card moved or was deleted while it was being shaped' });
          return;
        }
        resolve({ ok: hasStructure(written.body), card: written });
      }
    );
    const run = { cancelled: false, kill: () => child.kill('SIGKILL') };
    activeShapes.set(cardPath, run);
  });
}

/**
 * Runs a second pair of eyes over a card's work — Claude or Codex, headless, in
 * the card's worktree — and appends the result to the card under `## Review`.
 *
 * The reviewer only writes to stdout; the app owns the file append. That keeps
 * the document's shape predictable however the reviewer feels about markdown.
 */
function reviewPrompt(card) {
  return [
    `You are reviewing the work-in-progress for the task "${card.title}".`,
    `The task brief is the markdown file at ${card.path} — read it first.`,
    'Then review the changes in this working directory: run',
    '`git diff main...HEAD` and `git status --short`, and read the touched files.',
    '',
    'Write a review in plain markdown, nothing else in your output:',
    '- One verdict line first: ship it, needs work, or not safe to merge — and why.',
    '- Then numbered findings, most serious first. Each names the file and line,',
    '  says what is wrong in one or two sentences, and what to do instead.',
    '- Note what was checked and found sound, in one line at the end.',
    'Do not modify any file. Do not include preamble or sign-off.',
  ].join('\n');
}

function reviewCard(project, cardPath, reviewer) {
  const card = board.readCardAt(cardPath);
  const cwd = card.worktree && fs.existsSync(card.worktree) ? card.worktree : project.path;

  const name = reviewer === 'codex' ? 'codex' : 'claude';
  const found = cli.resolve(name);
  if (!found.ok) return Promise.resolve(found);

  const args =
    reviewer === 'codex'
      ? ['exec', '--full-auto', reviewPrompt(card)]
      : ['-p', reviewPrompt(card), '--add-dir', project.boardRoot, '--output-format', 'json'];

  return new Promise((resolve) => {
    cli.runFile(
      found.bin,
      args,
      {
        cwd,
        timeout: 10 * 60 * 1000,
        maxBuffer: 8 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr || err.message || '').toString().trim();
          resolve({
            ok: false,
            error: cli.explainError(err.code === 'ENOENT' ? `spawn ${name} ENOENT` : detail, name),
          });
          return;
        }
        let text = (stdout || '').trim();
        if (name === 'claude') {
          text = parseClaudeEnvelope(stdout).text.trim();
        }
        if (!text) {
          resolve({ ok: false, error: 'the reviewer returned nothing' });
          return;
        }
        try {
          appendReview(cardPath, reviewer, text);
        } catch (writeErr) {
          resolve({ ok: false, error: 'The card moved or was deleted while it was being reviewed' });
          return;
        }
        resolve({ ok: true });
      }
    );
  });
}

// Newest review first, all of them kept: a card can be reviewed, fixed and
// reviewed again, and the history is the point.
function appendReview(cardPath, reviewer, text) {
  const card = board.readCardAt(cardPath);
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const name = reviewer === 'codex' ? 'Codex' : 'Claude';
  const entry = `### ${name} · ${stamp}\n\n${text.trim()}\n`;

  let body = card.body;
  if (/^## Review\s*$/m.test(body)) {
    body = body.replace(/^## Review\s*$/m, (heading) => `${heading}\n\n${entry}`);
  } else {
    body = `${body.trim()}\n\n## Review\n\n${entry}\n`;
  }
  board.writeBody(cardPath, body);
}

/**
 * The standing rules for a card session, appended to the system prompt so
 * they hold for the whole conversation rather than fading with the first
 * user message. Identity, routing (to-dos belong on the board, never in the
 * repo), the knowledgebase contract, and a names-only index of what the
 * knowledgebase holds — content is read on demand, never preloaded.
 */
function systemContext(project, card) {
  const knowledgeRoot = knowledge.root(project.boardRoot);
  const index = knowledge.contextIndex(project.boardRoot);
  return [
    `You are a coding session running inside flow, a kanban app, working on card ${card.id} "${card.title}" for the project "${project.name}". The card file ${card.path} is the shared document for this session; the human reads it live in a pane beside you.`,
    '',
    'Standing rules:',
    `- Task capture: when the human asks to add a to-do, note an idea, or "remind me later", create a markdown card in ${project.boardRoot}/01-to-do/ (one file per item, filename NNNN-slug.md continuing the highest existing four-digit id, frontmatter matching the other cards there). Never write TODO comments, task files, or issue stubs into the working repo for these.`,
    `- Knowledge: the product knowledgebase lives in ${knowledgeRoot}. Before building anything with product context (competitors, positioning, prior research, past decisions), check the index below and read the relevant doc. If research the task depends on is missing, do the research as part of the work and save it back as a doc there, so the knowledgebase grows as a side effect.`,
    '- Durable state (decisions, findings, follow-ups) belongs in the card file or the knowledgebase, not only in this conversation.',
    '',
    index.length ? 'Knowledge index (names only — read files on demand):' : 'The knowledgebase is empty so far.',
    ...index.map((line) => `- ${line}`),
  ].join('\n');
}

/**
 * The docs terminal's standing brief: it lives in the knowledgebase, so it
 * gets the board's shape (folders and frontmatter), the format contract
 * (markdown canonical, HTML for reports, styled by .styles/docs.css), and
 * where the receipts live for "what shipped this week" questions.
 */
function docsContext(project, rootName) {
  const knowledgeRoot = knowledge.root(project.boardRoot, rootName);
  const vault =
    knowledge.normalizeRoot(rootName) === 'insights'
      ? 'the insights vault (analytics, reports and other findings)'
      : 'the product knowledgebase';
  return [
    `You are the docs session for the project "${project.name}", running inside flow, a kanban app. Your working directory is ${vault} (${knowledgeRoot}); the project's repo is ${project.path} and is readable beside you.`,
    '',
    'The board lives beside the knowledgebase:',
    `- ${project.boardRoot}/01-to-do, 02-doing, 03-done, 04-archive and 05-backlog hold one markdown card per task, with frontmatter (id, title, status, position, created, updated, branch, pr, pr_url, completed and more).`,
    `- "What shipped this week" style questions are answered from done and archived cards' frontmatter (completed dates, pr numbers) plus ${project.path}/changelog.md — read those before spelunking git.`,
    `- ${knowledgeRoot}/.current-doc names the doc the human has open, when they say "this doc".`,
    '',
    'Format contract:',
    '- Markdown is the canonical format for notes and working docs — cheapest to read and edit.',
    '- Reports and richer documents are self-contained HTML files linking ../.styles/docs.css (light paper, dark ink, inline SVG for charts, assets embedded). Keep everything in the one file so a doc never breaks when moved.',
    '- New research and findings are saved back here as docs, so the knowledgebase grows as a side effect of the work.',
    ...(knowledge.normalizeRoot(rootName) === 'insights'
      ? [
          `- ${knowledgeRoot}/.scripts holds the scripts that fetch data and rebuild reports; it never shows in the app menu. Keep report-refreshing code there and run it from here, so a report can be updated without rewriting it by hand.`,
        ]
      : []),
  ].join('\n');
}

function seedPrompt(cardPath, title) {
  return [
    `You are starting work on the card "${title}".`,
    `The task file is ${cardPath} — it is the shared document for this session, and I am reading it live in a pane next to you.`,
    '',
    'Do this in order:',
    '1. Ask me a couple of rounds of questions until the task is genuinely clear. One round at a time, not a wall of questions.',
    '2. Then write the task file, filling in these four sections and keeping the frontmatter exactly as it is:',
    '   ## Plan — a short paragraph on the approach.',
    '   ## Build — a checklist of the implementation steps.',
    '   ## QA — a checklist you can run yourself afterwards to prove the work is right.',
    '   ## Done when — the observable conditions that mean this card is finished.',
    '3. If this work has a specific page to look at, set `route:` in the frontmatter to that path (for example /admin). I get a clickable link to it.',
    '4. If you need a decision from me and cannot continue, set `needs_input: true` in the frontmatter — the card shows it on the board.',
    '5. Wait for my go-ahead before implementing.',
  ].join('\n');
}

/**
 * Runs the start sequence for a card. Every step is skipped when its
 * frontmatter field is already set, so retrying after a failure resumes rather
 * than duplicating work.
 *
 * @param {(step: string, detail?: string) => void} onProgress
 */
async function startCard(project, cardPath, onProgress = () => {}) {
  let card = board.readCardAt(cardPath);

  // 1. Move to doing.
  if (card.column !== 'doing') {
    onProgress('move', 'moving card to doing');
    card = board.moveCard(project.boardRoot, card.path, 'doing');
  }

  const repoPath = project.path;
  const notes = [];

  if (!fs.existsSync(repoPath)) {
    throw new Error(`Project folder is missing: ${repoPath}`);
  }
  const isRepo = git.isRepo(repoPath);
  if (!isRepo) notes.push('not a git repo — no branch, worktree or PR');

  // 2. Branch and worktree.
  let worktree = card.worktree;
  let branch = card.branch;

  // A project can opt out of worktrees and work straight on the checkout — the
  // way flow itself is built. No branch, no draft PR, sessions in the repo.
  const onMain = project.mode === 'main';
  if (onMain && !worktree) {
    notes.push('working on the checkout (project mode: main)');
  }

  if (!onMain && isRepo && (!worktree || !fs.existsSync(worktree))) {
    branch = branch || `flow/${card.id}-${board.slugify(card.title)}`;
    onProgress('worktree', `creating worktree on ${branch}`);
    try {
      worktree = git.addWorktree(repoPath, project.name, card.id, branch);
      board.patchCard(card.path, { branch, worktree });

      // Symlink the heavy directories rather than reinstalling them.
      const shared = git.shareArtifacts(repoPath, worktree);
      if (shared.linked.length) {
        onProgress('worktree', `shared ${shared.linked.join(', ')}`);
      }
      if (shared.skipped.length) {
        notes.push(`not shared: ${shared.skipped.join(', ')}`);
      }
    } catch (err) {
      notes.push(`worktree failed: ${err.message}`);
      worktree = '';
      branch = '';
    }
  }

  const cwd = worktree && fs.existsSync(worktree) ? worktree : repoPath;

  // 3. Draft PR — non-fatal. No remote or no gh auth just means no number yet.
  if (isRepo && branch && !card.pr) {
    onProgress('pr', 'opening draft pull request');
    try {
      const result = git.openDraftPr(cwd, branch, card.title);
      if (result.pr) {
        board.patchCard(card.path, { pr: result.pr, pr_url: result.url || '' });
        onProgress('pr', `draft PR #${result.pr}`);
      } else if (result.skipped) {
        notes.push(`no draft PR: ${result.skipped}`);
      }
    } catch (err) {
      notes.push(`no draft PR: ${err.message}`);
    }
  }

  // 4. Port.
  let port = card.port;
  if (!port) {
    onProgress('port', 'allocating a port');
    const allocated = ports.allocate(project);
    if (allocated) {
      port = String(allocated);
      board.patchCard(card.path, { port });
    } else {
      notes.push('no free port in the project range');
    }
  }

  // 5. Claude session. The uuid is stored so the session can be resumed by id
  // after the app or the machine restarts. A uuid with no transcript is not a
  // conversation — minting the id happens before Enter, so a start that never
  // ran (or ran while logged out) must open with --session-id, not --resume.
  let claudeSession = card.claude_session;
  const fresh = !claudeSessionLog(project, card);
  if (!claudeSession) {
    claudeSession = crypto.randomUUID();
    board.patchCard(card.path, { claude_session: claudeSession });
  }

  card = board.readCardAt(card.path);

  const id = sessionId(project, card);
  const prompt = seedPrompt(card.path, card.title);
  // The CLI to launch is the default terminal command — `claude` unless
  // settings say otherwise. Plan mode always: a card starts by proposing,
  // never by running unattended.
  const cli = config.cli();
  // Fresh sessions carry the standing rules in the system prompt; a resumed
  // session already has them from its first life.
  const command = fresh
    ? `${cli} --session-id ${claudeSession} --permission-mode plan --append-system-prompt ${JSON.stringify(
        systemContext(project, card)
      )} ${JSON.stringify(prompt)}`
    : `${cli} --resume ${claudeSession}`;

  onProgress('session', 'terminal ready — review the command and press Enter');
  // A ghost resume lives in an existing tmux pane that already failed
  // `--resume`. Kill it so the new --session-id command is what gets typed.
  if (fresh) {
    sessions.stop(id, { killTmux: true });
    sessions.killTmuxSession(`flow-${id}`);
  }
  // Pre-filled, not fired: the command lands in the input line for you to read
  // and edit, and starts only when you press Enter.
  sessions.start(id, cwd, {
    command,
    prefill: true,
    env: {
      ...(port ? { PORT: String(port) } : {}),
      ...flowEnv(project, card.path),
    },
    tmuxName: `flow-${id}`,
  });

  return { card, sessionId: id, cwd, notes };
}

// The identity layer: any session can answer "where am I, which card, where
// is the board, where is the knowledge" from its environment alone. Costs no
// tokens; skills and prompts resolve paths from it instead of hardcoding.
function flowEnv(project, cardPath) {
  return {
    FLOW_PROJECT: project.name,
    FLOW_BOARD_ROOT: project.boardRoot,
    FLOW_KNOWLEDGE_ROOT: knowledge.root(project.boardRoot),
    // The main checkout, which a card session in a worktree still writes to:
    // a worktree keeps its git objects and refs in the repo's own .git, so a
    // sandbox that allowed only the worktree would break `git commit`.
    FLOW_REPO: project.path,
    ...(cardPath ? { FLOW_CARD: cardPath } : {}),
  };
}

function serverSessionId(project, card) {
  return `${sessionId(project, card)}-server`;
}

/**
 * Boots this card's branch on its own port. The port is freed first — the same
 * move umami-wizzard's start.sh makes, because a stale dev server holding the
 * port is the usual reason a restart does nothing.
 *
 * Always restarts: pressing the button on a running server is a request for a
 * working server, not a no-op.
 */
// ── Knowledgebase agents ──
// Research and generation both land as new docs; the difference is where they
// look. Research goes out to the web on the big model; the Development
// generators read the repository itself.

function runKnowledgeAgent(project, args, targetDir, timeoutMinutes) {
  const found = cli.resolve('claude');
  if (!found.ok) return Promise.resolve(found);

  return new Promise((resolve) => {
    cli.runFile(
      found.bin,
      [...args, '--output-format', 'json'],
      {
        cwd: project.path,
        timeout: timeoutMinutes * 60 * 1000,
        maxBuffer: 16 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (err) {
          resolve({
            ok: false,
            error: cli.explainError((stderr || err.message || '').toString().trim(), 'claude'),
          });
          return;
        }
        // Success is a doc on disk, not a happy exit code.
        const wrote = fs.existsSync(targetDir) && fs.readdirSync(targetDir).some((f) => f.endsWith('.md'));
        resolve(wrote ? { ok: true } : { ok: false, error: 'the agent wrote no document' });
      }
    );
  });
}

/**
 * Deep research on the big model, with the web: the result is a new markdown
 * doc in the chosen knowledge folder. Competitor teardowns are the canonical
 * case, but the topic is free text.
 */
function researchDoc(project, folder, topic) {
  const base = knowledge.ensure(project.boardRoot);
  const dir = folder ? path.join(base, folder) : base;
  fs.mkdirSync(dir, { recursive: true });

  const prompt = [
    `Research this topic for the product team: ${topic}`,
    '',
    'Use web search and web fetch to ground every claim; this is research, not',
    'recall. Then write ONE new markdown file into this folder:',
    dir,
    `Name it ${board.slugify(topic)}.md (add a suffix if taken). Structure:`,
    'a one-paragraph summary first, then the findings with their sources as',
    'links, then what it means for us, then open questions. Plain English,',
    'short sentences, no filler. Create only that one file and change nothing',
    'else anywhere.',
  ].join('\n');

  return runKnowledgeAgent(
    project,
    ['-p', prompt, '--model', 'opus', '--permission-mode', 'acceptEdits', '--add-dir', base],
    dir,
    15
  );
}

/**
 * A bookmark saved with an agent's eyes on it (0194): the link is fetched,
 * summarized and filed as a markdown doc in the chosen folder, tags kept.
 */
function bookmarkDoc(project, folder, url, tags) {
  const base = knowledge.ensure(project.boardRoot);
  const dir = path.join(base, folder || 'Bookmarks');
  fs.mkdirSync(dir, { recursive: true });

  const prompt = [
    `Process this bookmark for the product team: ${url}`,
    tags ? `The human filed it under: ${tags}.` : '',
    '',
    'Fetch the page (web fetch; search only if the fetch fails). Then write',
    `ONE new markdown file into this folder: ${dir}`,
    'Name it after the page (a short slug; add a suffix if the name is taken).',
    'Structure: the link itself on the first line, a one-paragraph summary of',
    'what it is and why it might matter to us, then the few points worth',
    'keeping, then a "Tags:" line carrying the tags the human gave, if any.',
    'Plain English, short sentences, no filler. Create only that one file and',
    'change nothing else anywhere.',
  ]
    .filter(Boolean)
    .join('\n');

  return runKnowledgeAgent(
    project,
    ['-p', prompt, '--model', 'opus', '--permission-mode', 'acceptEdits', '--add-dir', base],
    dir,
    10
  );
}

/**
 * Development docs drawn from the code itself: a system diagram (mermaid in a
 * fenced block) and a plain-English overview of what the product does and for
 * whom. Both land in the Development folder.
 */
function generateDevDocs(project, kind) {
  const base = knowledge.ensure(project.boardRoot);
  const dir = path.join(base, 'Development');
  fs.mkdirSync(dir, { recursive: true });

  const briefs = {
    diagram: [
      'Read this repository and draw its system architecture.',
      `Write ONE file: ${path.join(dir, 'system-diagram.md')} (overwrite if present).`,
      'Lead with a mermaid diagram in a fenced ```mermaid block showing the',
      'real components and how data moves between them, then a short legend',
      'explaining each box in one line. Nothing invented: only what the code',
      'actually contains. Change nothing else anywhere.',
    ],
    overview: [
      'Read this repository and explain the product.',
      `Write ONE file: ${path.join(dir, 'product-overview.md')} (overwrite if present).`,
      'Cover: what the product does, who it is for, the main flows a user',
      'walks through, and what is deliberately out of scope — all in plain',
      'English for someone who knows the market but not the code. Ground every',
      'statement in what the code actually implements. Change nothing else',
      'anywhere.',
    ],
  };
  const brief = briefs[kind];
  if (!brief) return Promise.resolve({ ok: false, error: `Unknown generator: ${kind}` });

  return runKnowledgeAgent(
    project,
    ['-p', brief.join('\n'), '--permission-mode', 'acceptEdits', '--add-dir', base],
    dir,
    10
  );
}

function startServer(project, card, onProgress = () => {}) {
  require('./events').logEvent('server-start', { project: project.name, card: card.id });
  const cwd = card.worktree && fs.existsSync(card.worktree) ? card.worktree : project.path;
  const id = serverSessionId(project, card);
  let port = card.port || '';
  const notes = [];

  // A card without a port would run the raw dev script, and a script that
  // pins its own port collides with whatever already runs there — the classic
  // "can't boot a server" with the user's own dev server on the pinned port.
  // Allocate one on demand and write it back so the card keeps it.
  if (!port && card.path) {
    port = String(ports.allocate(project));
    board.patchCard(card.path, { port });
    onProgress('server', `assigned port ${port}`);
    notes.push(`assigned port ${port}`);
  }

  // Drop any previous shell for this card's server before reusing the port, and
  // end its tmux session outright. A surviving session would be *attached* to
  // rather than created, and an attached session is never seeded with the dev
  // command — so the restart would look successful and run nothing.
  // Ownership before the kill (0332): the pane pids are the proof a port
  // holder is ours, and they are only readable while the session lives.
  const ownerPids = sessions.panePids(`flow-${id}`);
  if (sessions.has(id)) {
    onProgress('server', 'stopping the previous server');
    sessions.stop(id, { killTmux: true });
  }
  sessions.killTmuxSession(`flow-${id}`);

  if (port) {
    onProgress('server', `freeing port ${port}`);
    const { freed, killed, strangers } = ports.free(Number(port), { ownerPids });
    if (killed.length) notes.push(`stopped pid ${killed.join(', ')} on ${port}`);
    if (strangers.length) {
      notes.push(
        `port ${port} is held by ${strangers.map((sp) => `${sp.command} (pid ${sp.pid})`).join(', ')} — not flow's, left alone`
      );
    } else if (!freed) {
      notes.push(`port ${port} is still held — the server may pick another`);
    }
  }

  const command = serverCommand(project, port);
  onProgress('server', `running ${command}`);

  sessions.start(id, cwd, {
    command,
    env: port ? { PORT: String(port) } : {},
    tmuxName: `flow-${id}`,
  });
  // Stamp the server's registry row with its card and project (0333).
  try {
    require('./proc-registry').record({
      id,
      kind: 'server',
      pid: sessions.panePids(`flow-${id}`)[0] || null,
      command,
      project: project.name,
      card: card.id || '',
      tmuxName: `flow-${id}`,
    });
  } catch (err) {
    // Registry is memory, never a gate.
  }

  return {
    sessionId: id,
    cwd,
    port: port || null,
    url: port ? `http://localhost:${port}` : '',
    command,
    notes,
  };
}

// A start command may take the port as a placeholder — `npm run dev -- --port
// {port}` — which is the only reliable way in when a script hardcodes its own.
// Otherwise PORT goes in the environment and it is up to the script to read it.
function serverCommand(project, port) {
  const command = project.devCommand || project.startCommand || './start.sh';
  if (!port) return command;
  if (command.includes('{port}')) return command.split('{port}').join(String(port));
  return `PORT=${port} ${command}`;
}

/**
 * What the server is actually doing, as opposed to what we asked for. A shell
 * can be alive while nothing listens — which is exactly what happens when a
 * start script hardcodes a port and ignores the one we gave it.
 */
function serverStatus(project, card) {
  const id = serverSessionId(project, card);
  const shell = sessions.has(id);
  const port = Number(card.port) || null;
  const listening = port ? ports.inUse(port) : false;

  // Why it stopped, from the registry (0333): a dead server can explain
  // itself without anyone scrolling a terminal tail.
  let exitReason = '';
  if (!shell) {
    try {
      const last = require('./proc-registry').lastExit(id);
      if (last && last.exit) exitReason = `${last.exit.reason} at ${last.exit.at}`;
    } catch (err) {
      // No registry, no story.
    }
  }

  return {
    shell,
    listening,
    port: card.port || null,
    url: listening ? `http://localhost:${card.port}` : '',
    command: serverCommand(project, card.port || ''),
    log: shell && !listening ? sessions.log(id, 24) : '',
    exitReason,
  };
}

// Stops a card's server and gives the port back. The worktree, branch and pull
// request are left exactly as they are.
function stopServer(project, card) {
  require('./events').logEvent('server-stop', { project: project.name, card: card.id });
  const id = serverSessionId(project, card);
  const running = sessions.has(id);

  const ownerPids = sessions.panePids(`flow-${id}`);
  sessions.stop(id, { killTmux: true });
  if (card.port) ports.free(Number(card.port), { ownerPids });

  return { sessionId: id, wasRunning: running };
}

function serverRunning(project, card) {
  return sessions.has(serverSessionId(project, card));
}

// Ends a card: stop its shells, drop the worktree, move it to done.
function finishCard(project, cardPath) {
  const card = board.readCardAt(cardPath);
  const id = sessionId(project, card);

  sessions.stop(id, { killTmux: true });
  sessions.stop(`${id}-server`, { killTmux: true });

  if (card.worktree && fs.existsSync(card.worktree)) {
    git.removeWorktree(project.path, card.worktree);
  }

  return board.moveCard(project.boardRoot, card.path, 'done');
}

/**
 * Pauses a card that is leaving "doing": the dev server stops, the port goes
 * back to the project's pool, and the Claude session's shell ends outright —
 * a card sitting in to-do should have nothing running on its behalf. What took
 * work to make survives: the worktree, branch and pull request stay put, and
 * the claude_session id is kept so restarting the card resumes the
 * conversation rather than opening a new one.
 *
 * Every step tolerates already-stopped state, so pausing a card whose server
 * died on its own is a no-op rather than an error.
 */
function pauseCard(project, cardPath, onProgress = () => {}) {
  const card = board.readCardAt(cardPath);

  onProgress('pause', 'stopping the dev server');
  stopServer(project, card);

  const id = sessionId(project, card);
  onProgress('pause', 'ending the Claude session');
  sessions.stop(id, { killTmux: true });
  // A session from a previous app run is only in tmux, not in the live map.
  sessions.killTmuxSession(`flow-${id}`);

  // The port field is the claim ports.allocate honours; clearing it is what
  // actually returns the number to the pool.
  if (card.port) board.patchCard(cardPath, { port: '' });

  return { paused: true, port: card.port || null };
}

// Closing a tab is not abandoning the work: the server and its port go, the
// Claude session detaches (tmux keeps it), and the worktree, branch and pull
// request all stay put.
function closeCard(project, cardPath) {
  const card = board.readCardAt(cardPath);
  const result = stopServer(project, card);
  sessions.stop(sessionId(project, card));
  return { stoppedServer: result.wasRunning, port: card.port || null };
}

module.exports = {
  SHAPE_INSTRUCTIONS,
  SHAPE_COMMAND,
  SHAPE_MODEL,
  START_PROMPT,
  cancelShape,
  researchDoc,
  bookmarkDoc,
  generateDevDocs,
  planCard,
  shapeCard,
  reviewCard,
  hasStructure,
  SECTIONS,
  startCard,
  startServer,
  stopServer,
  serverRunning,
  serverSessionId,
  closeCard,
  pauseCard,
  finishCard,
  sessionId,
  claudeSessionLog,
  flowEnv,
  docsContext,
};
