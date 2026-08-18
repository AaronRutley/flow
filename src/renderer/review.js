// ── The shared to-do list ──
// You queue small jobs in the card while the agent works; nothing interrupts a
// running turn until you press send, which hands over every unchecked item at
// once. The agent's etiquette (requested in the handover): tick each item off
// in the file and leave a one-line note under it saying what was done.
// The QA queue's heading in the file. Older cards used "## To do"; both are
// recognised so nothing already written gets stranded.
const QA_HEADING = /^##\s+(QA queue|To do)\s*$/i;

async function appendTodoAt(cardPath, text) {
  const card = await window.api.readCard(cardPath);
  const lines = unescapeMarkdown(card.body).split('\n');
  const item = `- [ ] ${text}`;

  const heading = lines.findIndex((line) => QA_HEADING.test(line));
  if (heading === -1) {
    lines.push('', '## Follow ups', '', item);
  } else {
    // After the last list item already under the heading, so order holds.
    let end = heading + 1;
    for (let i = heading + 1; i < lines.length; i++) {
      if (/^##\s/.test(lines[i])) break;
      if (lines[i].trim()) end = i + 1;
    }
    lines.splice(end, 0, item);
  }

  lastSelfWrite = Date.now();
  await window.api.writeCardBody(cardPath, lines.join('\n'));
  lastSelfWrite = Date.now();
  showSaveStatus('saved');
}

async function appendTodo(session, text) {
  await appendTodoAt(session.cardPath, text);
  await loadDoc(session);
}

async function unsentTodos(session) {
  if (!session.cardPath) return [];
  const card = await window.api.readCard(session.cardPath);
  const lines = unescapeMarkdown(card.body).split('\n');
  const heading = lines.findIndex((line) => QA_HEADING.test(line));
  if (heading === -1) return [];

  const items = [];
  for (let i = heading + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break;
    const match = lines[i].match(/^\s*[-*]\s+\[ \]\s+(.*)$/);
    if (match) items.push(match[1].trim());
  }
  return items;
}

// One handover button: visible whenever there is something the agent has not
// seen — edited context, new follow ups, or both.
async function refreshUpdateAgent(session) {
  const button = $('update-agent');
  if (!button || !session || session.id !== activeSessionId) return;
  const items = await unsentTodos(session);
  button.classList.toggle('hidden', !session.dirty && !items.length);
}

on('update-agent', 'click', async () => {
  const session = openSessions.get(activeSessionId);
  if (!session) return;

  if (saveTimeout) clearTimeout(saveTimeout);
  if (session.dirty) await saveDoc(session);

  const items = await unsentTodos(session);
  const lines = [`I've updated the task file at ${session.cardPath}. Re-read it and continue.`];
  if (items.length) {
    lines.push('New follow ups in its "## Follow ups" section:');
    lines.push(...items.map((item) => `- ${item}`));
    lines.push(
      'Work through them. In that file, tick each one off as you finish it and',
      'add one indented line underneath saying what you actually did. If an item',
      'is unclear, put your question on that line instead and leave it unticked.'
    );
  }

  // Bracketed paste, so the newlines arrive as one block instead of submitting
  // line by line. Typed, not sent: Enter stays yours.
  window.api.sendTerminalInput(session.id, `\x1b[200~${lines.join('\n')}\x1b[201~`);

  session.dirty = false;
  $('update-agent').classList.add('hidden');
  session.term.focus();
});

// ── Review ──
// Runs in the background: no tab, no terminal. The result is written into the
// card, and the working session is handed a typed (not sent) instruction to
// read it — you decide when the interruption happens.
const reviewing = new Map();

function wireReview(session, card) {
  for (const reviewer of ['claude', 'codex']) {
    const button = $(`review-${reviewer}`);
    if (!button) continue;
    button.addEventListener('click', async () => {
      reviewing.set(card.path, reviewer);
      loadDoc(session);

      // The reviewer you use is the reviewer you prefer: remember it per
      // project so it leads the pair next time.
      if (activeProject && activeProject.reviewer !== reviewer) {
        projects = await window.api.updateProject(activeProject.name, { reviewer });
        activeProject = projects.find((p) => p.name === activeProject.name) || activeProject;
      }

      const result = await window.api.reviewCard(activeProject.name, card.path, reviewer);
      reviewing.delete(card.path);
      await loadDoc(session);

      if (!result.ok) {
        showToast(`Review failed: ${result.error || 'unknown'}`);
        return;
      }

      const name = reviewer === 'codex' ? 'Codex' : 'Claude';
      window.api.sendTerminalInput(
        session.id,
        `A ${name} review just landed in ${card.path} under "## Review". Read the newest entry and address its findings.`
      );
    });
  }
}

// What "get this PR ready" means when a project has not said otherwise. `{pr}`
// is substituted at press time. A project can replace the whole brief by
// setting `preparePrompt` in ~/.flow/projects.json.
const DEFAULT_PREPARE_PROMPT = [
  'Get pull request #{pr} ready for review, in this order.',
  'First read the full diff so everything after is grounded in it.',
  'Run the lint and checks this repo actually has and fix what they raise.',
  'Update any changelog or readme this change touches.',
  'Rewrite the PR description with gh pr edit {pr} --body-file:',
  'plain English for someone who has not seen the code, the one-sentence version first,',
  'then what a reviewer should look at, then anything deliberately left out.',
  'Update the task card: tick what is done, note what is not.',
  'Push everything, and only then mark the PR ready for review with gh pr ready {pr}.',
].join(' ');

/**
 * Types the prepare-for-review brief into the session rather than sending it.
 * The agent has the diff and the card in front of it; you get to read the
 * instruction and press Enter, or edit it first — the difference between a
 * shortcut and a surprise.
 */
function wirePrPrepare(session, card) {
  const button = $('pr-prepare');
  if (!button) return;

  button.addEventListener('click', () => {
    const template = activeProject.preparePrompt || DEFAULT_PREPARE_PROMPT;
    window.api.sendTerminalInput(session.id, template.split('{pr}').join(card.pr));
    activateSession(session.id);
    session.term.focus();
  });

  const describe = $('pr-describe');
  if (!describe) return;
  describe.addEventListener('click', () => {
    window.api.sendTerminalInput(
      session.id,
      DESCRIBE_PR_PROMPT.split('{pr}').join(card.pr)
    );
    activateSession(session.id);
    session.term.focus();
  });
}

// Just the description, nothing else: read the diff, then explain the change
// so someone who has never seen the code understands it.
const DESCRIBE_PR_PROMPT = [
  'Rewrite the description of pull request #{pr} with gh pr edit {pr} --body-file.',
  'Read the full diff first. Then write it in plain English for someone who has',
  'not seen the code: the one-sentence version first, then what changed and why,',
  'what a reviewer should look at, how it was tested, and anything deliberately',
  'left out. No jargon, no filler.',
].join(' ');

/**
 * Checklists are the point of these documents, so the boxes are real controls:
 * clicking one rewrites that line in the file rather than editing the HTML.
 *
 * The line is found by matching the item's text, not by counting boxes — an
 * agent writing into the document while you click would otherwise shift the
 * indexes underneath you.
 */
function wireChecklist(cardPath, markdown) {
  // `**bold**`, `` `code` `` and `[text](url)` all survive into the rendered
  // text without their punctuation, so both sides are flattened before matching.
  const flatten = (value) =>
    String(value)
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[`*_~]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();

  for (const box of markdown.querySelectorAll('input[type="checkbox"]')) {
    box.disabled = false;
    box.classList.add('check-input');

    const item = box.closest('li');
    if (!item) continue;

    // Wrap everything after the box (except a nested reply list) in one label
    // span: one flex child, so inline code and line wraps stay on the line.
    const label = document.createElement('span');
    label.className = 'check-label';
    while (box.nextSibling && box.nextSibling.tagName !== 'UL') {
      label.appendChild(box.nextSibling);
    }
    box.after(label);

    // The state is drawn as an icon, not a form control: a quiet circle that
    // becomes a ticked one, matching the rest of the icon language.
    const mark = document.createElement('span');
    mark.className = 'check-mark';
    mark.innerHTML = icon(box.checked ? 'tickCircle' : 'circle', 17);
    box.before(mark);

    mark.addEventListener('mousedown', (e) => e.preventDefault());
    mark.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();

      const next = !box.checked;
      box.checked = next;
      mark.innerHTML = icon(next ? 'tickCircle' : 'circle', 17);

      // Match on the item's own text only: a nested agent reply is part of the
      // li's textContent but not part of the line in the file.
      const clone = item.cloneNode(true);
      for (const nested of clone.querySelectorAll('ul')) nested.remove();
      const wanted = flatten(clone.textContent);
      const card = await window.api.readCard(cardPath);
      const lines = unescapeMarkdown(card.body).split('\n');

      const index = lines.findIndex((line) => {
        const match = line.match(/^\s*[-*]\s+\[[ xX]\]\s+(.*)$/);
        return match && flatten(match[1]) === wanted;
      });

      if (index === -1) {
        box.checked = !next;
        mark.innerHTML = icon(box.checked ? 'tickCircle' : 'circle', 17);
        return;
      }

      lines[index] = lines[index].replace(/\[[ xX]\]/, next ? '[x]' : '[ ]');
      lastSelfWrite = Date.now();
      await window.api.writeCardBody(cardPath, lines.join('\n'));
      lastSelfWrite = Date.now();
      showSaveStatus('saved');
      updateSectionMeta(markdown);
    });
  }
}

// The dev-server start/stop wiring and its readiness poll left with 0375;
// localhost returns later as a plugin. stopPolling stays because every view
// change calls it, and serverPoll with it, quietly idle until then.
let serverPoll = null;

// Drafting runs headless in the background — no tab, no terminal. The card
// file is being written underneath, so the watcher redraws when it lands.
function wirePlanDraft(session) {
  const button = $('plan-draft');
  if (!button) return;

  button.addEventListener('click', async () => {
    button.disabled = true;

    // It reads the repository before writing, which takes about a minute.
    // A counter is the difference between working and hung.
    const started = Date.now();
    const tick = setInterval(() => {
      const seconds = Math.round((Date.now() - started) / 1000);
      button.innerHTML = `${icon('magic', 15)} Asking Claude… ${seconds}s`;
    }, 1000);
    button.innerHTML = `${icon('magic', 15)} Asking Claude… 0s`;

    const result = await window.api.planCard(activeProject.name, session.cardPath);
    clearInterval(tick);

    if (!result.ok) {
      button.disabled = false;
      button.innerHTML = `${icon('magic', 15)} Draft a plan`;
      const prompt = $('plan-prompt');
      if (prompt) {
        const message = document.createElement('p');
        message.className = 'plan-error';
        message.textContent = result.error
          ? `Could not draft it: ${result.error}`
          : 'Claude ran but wrote no sections. Try again, or write the plan yourself.';
        prompt.appendChild(message);
      }
      return;
    }

    loadDoc(session);
  });
}

function stopPolling() {
  if (serverPoll) clearInterval(serverPoll);
  serverPoll = null;
}

function debouncedSave(session) {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => saveDoc(session), 800);
}

// ── The autosave receipt ──
// Every edit in the doc pane saves itself; this status word is the only
// acknowledgement. "Saving…" appears the moment an edit is pending, flips to
// "Saved" once the write lands, and fades out shortly after. It targets
// whichever editor is in front: the card modal when it is open, otherwise the
// session's doc pane.
let saveStatusTimer = null;

function showSaveStatus(state) {
  const el = $(modalCard ? 'modal-save-status' : 'doc-save-status');
  if (!el) return;

  if (saveStatusTimer) {
    clearTimeout(saveStatusTimer);
    saveStatusTimer = null;
  }

  el.textContent = state === 'saving' ? 'Saving…' : 'Saved';
  el.classList.add('visible');

  if (state === 'saved') {
    saveStatusTimer = setTimeout(() => {
      el.classList.remove('visible');
      saveStatusTimer = null;
    }, 1500);
  }
}

/**
 * Saves the half of the document you can edit and leaves the rest of the file
 * exactly as it is on disk.
 *
 * Turndown has no rule for task list items, so round-tripping the whole
 * document through it quietly rewrote `- [ ] step` as `- step` and threw every
 * checkbox away. Only the context above the first `##` is ever regenerated;
 * from that heading down, the file's own text is kept verbatim.
 */
/**
 * The context is plaintext-only, so its markdown is its text: typed newlines
 * are the formatting, and turndown — built to reverse rendered HTML — was
 * collapsing them under HTML whitespace rules. This walks the nodes instead:
 * text comes through verbatim, breaks and block edges become newlines, and a
 * pasted screenshot survives as its image tag.
 */
// The context's DOM back to markdown, structure kept (0208): lists get
// their markers back, checkboxes their brackets, headings their hashes,
// code its fences and inline emphasis its stars — where the old pass
// flattened all of them to bare text and the next render read one big
// paragraph.
function contextToMarkdown(root) {
  const serialize = (node) => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent;
    if (node.nodeName === 'BR') return '\n';
    // An answer control stands in for its directive; the directive is what
    // belongs in the file.
    if (node.dataset && node.dataset.directive) return node.dataset.directive;
    if (node.nodeName === 'IMG') {
      return `![${node.alt || ''}](${node.getAttribute('src') || ''})`;
    }
    if (node.nodeName === 'UL' || node.nodeName === 'OL') {
      const items = [...node.children].filter((li) => li.nodeName === 'LI');
      const lines = items.map((li, i) => {
        const box = li.querySelector(':scope > input[type="checkbox"]');
        const text = [...li.childNodes]
          .filter((child) => child !== box)
          .map(serialize)
          .join('')
          .trim();
        const marker = node.nodeName === 'OL' ? `${i + 1}.` : '-';
        const check = box ? (box.checked ? '[x] ' : '[ ] ') : '';
        return `${marker} ${check}${text}`;
      });
      return `${lines.join('\n')}\n\n`;
    }
    if (node.nodeName === 'PRE') {
      return `\`\`\`\n${node.textContent.replace(/\n$/, '')}\n\`\`\`\n\n`;
    }
    const inner = [...node.childNodes].map(serialize).join('');
    const heading = node.nodeName.match(/^H([1-6])$/);
    if (heading) return `${'#'.repeat(Number(heading[1]))} ${inner.trim()}\n\n`;
    if (node.nodeName === 'STRONG' || node.nodeName === 'B') return `**${inner}**`;
    if (node.nodeName === 'EM' || node.nodeName === 'I') return `*${inner}*`;
    if (node.nodeName === 'CODE') return `\`${inner}\``;
    if (node.nodeName === 'BLOCKQUOTE') {
      return `${inner
        .trim()
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')}\n\n`;
    }
    const isBlock = /^(P|DIV|LI)$/.test(node.nodeName);
    return isBlock ? `${inner}\n\n` : inner;
  };
  return [...root.childNodes]
    .map(serialize)
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function saveBody(cardPath, root) {
  if (!root) return;

  const context = root.querySelector('.doc-context');
  const editable = context || root;
  const written = context
    ? contextToMarkdown(context)
    : turndownService.turndown(editable.innerHTML).trim();

  let tail = '';
  if (context) {
    const card = await window.api.readCard(cardPath);
    const lines = unescapeMarkdown(card.body).split('\n');
    const start = lines.findIndex((line) => /^##\s/.test(line));
    if (start !== -1) tail = lines.slice(start).join('\n');
  }

  const next = tail ? `\n${written}\n\n${tail.trim()}\n` : `\n${written}\n`;
  lastSelfWrite = Date.now();
  await window.api.writeCardBody(cardPath, next);
  lastSelfWrite = Date.now();
  showSaveStatus('saved');
}

async function saveDoc(session) {
  await saveBody(session.cardPath, $('doc-content').querySelector('.markdown-body'));
}


// Cmd+W closes the tab you are looking at. Only when there is nothing left to
// close does it fall through to closing the window.
window.api.onCloseTab(async () => {
  if (!isBoardVisible() && activeSessionId && openSessions.has(activeSessionId)) {
    await closeSession(activeSessionId);
    return;
  }
  // The board is home, not a tab — nothing to close but the window.
  window.api.closeWindow();
});

document.addEventListener('keydown', (e) => {
  if (e.metaKey && e.key === 's') {
    e.preventDefault();
    const session = openSessions.get(activeSessionId);
    if (session) {
      if (saveTimeout) clearTimeout(saveTimeout);
      saveDoc(session);
    }
  }
});
