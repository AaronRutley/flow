// ── Card modal ──
// A to-do card opened for reading and editing. Nothing starts: no worktree, no
// session, no port. The same renderer and save path as the session view, so the
// two can never disagree about what a document is.
let modalCard = null;
let modalSaveTimer = null;

// The card element the modal grew from, kept so closing can morph back down to
// it. Cleared when it would be stale (a board reload replaces the element).
let modalTrigger = null;

// The first word carries the title (0260): shape writes "Lead: rest"
// titles, so the lead word lands bolder than the rest. The markup lives
// inside the rename field; edits read through textContent untouched, and a
// blur paints the decoration back over whatever was typed.
function decorateModalTitle(text) {
  const el = $('card-modal-title');
  if (!el) return;
  const title = String(text != null ? text : (modalCard && modalCard.title) || '');
  const match = title.match(/^(\S+)([\s\S]*)$/);
  el.innerHTML = match
    ? `<b>${escapeHtml(match[1])}</b>${escapeHtml(match[2])}`
    : escapeHtml(title);
}

// Wired once: leaving the rename field paints the bold lead back over the
// plain edit, from whatever now stands in the field — the save may still
// be in flight.
on('card-modal-title', 'blur', () => {
  setTimeout(() => {
    const el = $('card-modal-title');
    if (el && document.activeElement !== el) {
      decorateModalTitle(el.textContent.trim().replace(/\s+/g, ' '));
    }
  }, 0);
});

async function openCardModal(card, trigger = null) {
  modalTrigger = trigger;
  modalCard = await window.api.readCard(card.path);
  // A fresh open starts with nothing to hand over (0451).
  modalHandoverPending = false;
  const handoverButton = $('card-modal-update-agent');
  if (handoverButton) handoverButton.classList.add('hidden');

  decorateModalTitle();
  // The id, so a card is easy to name aloud or reference — the same four-digit
  // form it wears on disk. After the actions since 0260: present, not first.
  $('card-modal-id').textContent = modalCard.id ? `#${modalCard.id}` : '';
  // The footer shows only for parked cards (save / shape). A doing card's
  // session is already attached beside it (0422 took its Open terminal),
  // and done or archived cards are just read; the header close serves them.
  $('card-modal-footer').classList.toggle(
    'hidden',
    modalCard.column === 'doing' || modalCard.column === 'done' || modalCard.column === 'archive'
  );

  // One home per kind of action (0199): the header's icons manage the card,
  // the footer manages the document and the ways in. A shaped card offers
  // Chat and "Start work" (0436, named plainly by 0452) — Chat opens the
  // session for questions first; Start work fires the agent and walks the
  // card into Doing. An unshaped card shapes first.
  const secondary = $('card-modal-save');
  const primary = $('card-modal-go');
  const chat = $('card-modal-chat');
  const startRaw = $('card-modal-start-raw');
  secondary.textContent = 'Save and Close';
  secondary.onclick = closeCardModal;
  if (hasStructure(modalCard.body)) {
    chat.classList.remove('hidden');
    startRaw.classList.add('hidden');
    primary.classList.remove('hidden');
    primary.textContent = 'Start work';
    primary.onclick = startWorkFromModal;
  } else {
    // Shaping first stays the primary, but an unshaped task can still
    // start (0456): the raw ask is the agent's brief.
    chat.classList.add('hidden');
    startRaw.classList.remove('hidden');
    primary.classList.remove('hidden');
    primary.textContent = 'Save and shape';
    primary.onclick = saveAndShapeFromModal;
  }

  // Shape stays available for every to-do card — a shaped card can be
  // re-shaped after its context changes — and goes quiet only while the
  // card is mid-edit (an unsaved document is not what you want shaped) or
  // a shape is already running.
  const shapeButton = $('card-modal-shape');
  const inFlight = shaping.has(modalCard.path);
  shapeButton.classList.toggle('hidden', modalCard.column !== 'to-do');
  shapeButton.disabled = inFlight;
  shapeButton.innerHTML = icon('magic', 15);
  shapeButton.dataset.tip = inFlight
    ? 'Asking claude…'
    : hasStructure(modalCard.body)
      ? 'Re-shape the plan'
      : 'Shape the plan';

  renderCardModalBody();

  // The clock appears when this card's prior session transcript exists on
  // disk (0196): what happened last time is one click from the card.
  const logButton = $('card-session-log');
  if (logButton) {
    logButton.classList.add('hidden');
    if (modalCard.claude_session && window.api.cardSessionLog) {
      const forPath = modalCard.path;
      window.api
        .cardSessionLog(activeProject.name, forPath)
        .then((log) => {
          if (log && modalCard && modalCard.path === forPath) {
            logButton.classList.remove('hidden');
          }
        })
        .catch(() => {});
    }
  }

  const parked = modalCard.column === 'to-do' || modalCard.column === 'backlog';
  $('card-modal-archive').classList.toggle('hidden', !parked);

  wireTitleField(
    'card-modal-title',
    () => (modalCard ? modalCard.title : ''),
    async (next) => {
      lastSelfWrite = Date.now();
      modalCard = await window.api.patchCard(modalCard.path, { title: next });
      lastSelfWrite = Date.now();
      loadBoard();
    }
  );

  // A card clicked mid-shape shows the document being written, live, in place
  // of the stale body it had before the shape began.
  if (shaping.has(modalCard.path)) renderShapeStream(shapeStreams.get(modalCard.path));

  // Two columns for every card again (0449, walking back the single-column
  // states of 0435/0436): the document left, a terminal right. The shell
  // arrives bare — nothing launches until Chat or Let's go fires (0436's
  // contract, kept) — and a doing card still attaches its live session.
  $('card-modal-panel').classList.add('with-terminal');
  $('card-modal-term').classList.remove('hidden');
  openModalShell();

  $('card-view').classList.remove('hidden');
  morphPanelFrom($('card-modal-panel'), trigger);
}

// The card's document, rendered fresh from modalCard: the tabs, the wiring,
// the autosave. Called on open and again whenever the file changes under an
// open card (a checklist quick-add, for one — 0197).
function renderCardModalBody() {
  const body = unescapeMarkdown(modalCard.body);
  const failed = shapeErrors.get(modalCard.path);
  const banner = failed
    ? `<div class="shape-error">
        <p>${escapeHtml(failed)}</p>
        <button type="button" class="text-button" id="shape-claude-login">Log in with claude</button>
      </div>`
    : '';
  $('card-modal-body').innerHTML = `${banner}<div class="markdown-body">${renderMarkdown(body)}</div>`;
  wireShapeLoginButton();

  const markdown = $('card-modal-body').querySelector('.markdown-body');
  buildSections(markdown, null, modalCard, { tabs: true });
  wireChecklist(modalCard.path, markdown);
  wireQaEdits(modalCard.path, markdown);
  if (String(modalCard.needs_input) === 'true') wireInputDirectives(markdown, modalCard);

  markdown.addEventListener('input', () => {
    showSaveStatus('saving');
    setModalShapeIdle(false);
    if (modalSaveTimer) clearTimeout(modalSaveTimer);
    modalSaveTimer = setTimeout(async () => {
      modalSaveTimer = null;
      await saveBody(modalCard.path, markdown);
      setModalShapeIdle(true);
      // A saved edit is context the agent has not seen (0451).
      noteModalEdit();
    }, 800);
  });
}

async function closeCardModal() {
  if (!modalCard) return;

  closeModalShell();

  // A pending edit goes to disk before the panel disappears.
  if (modalSaveTimer) {
    clearTimeout(modalSaveTimer);
    modalSaveTimer = null;
    await saveBody(modalCard.path, $('card-modal-body').querySelector('.markdown-body'));
  }

  modalCard = null;
  const trigger = modalTrigger;
  modalTrigger = null;
  morphPanelClosed($('card-view'), $('card-modal-panel'), trigger, () => {
    $('card-view').classList.add('hidden');
    loadBoard();
  });
}

// The reverse of the opening morph: the panel shrinks back toward the card it
// came from and fades, then the overlay is taken down. A missing trigger (or
// reduced motion) just hides without the flourish.
function morphPanelClosed(overlay, panel, trigger, done) {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const t = trigger && trigger.getBoundingClientRect();
  if (reduce || !panel || !t || !t.width) {
    done();
    return;
  }
  const p = panel.getBoundingClientRect();
  panel.style.transformOrigin = `${t.left + t.width / 2 - p.left}px ${
    t.top + t.height / 2 - p.top
  }px`;
  overlay.classList.add('closing');
  panel.classList.add('morph-out');
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    panel.classList.remove('morph-out');
    panel.style.transformOrigin = '';
    overlay.classList.remove('closing');
    done();
  };
  panel.addEventListener('animationend', finish, { once: true });
  setTimeout(finish, 260);
}

// ── Input directives ──
// A card flagged needs_input can ask its questions as real controls: the body
// text `[input: name]` becomes a text box and `[options: name: a, b, c]` a
// picker. Answers live in the frontmatter under one `answers` key (JSON), so
// filling them in never touches the body text.
function cardAnswers(card) {
  try {
    return JSON.parse(card.answers || '{}');
  } catch (err) {
    return {};
  }
}

const DIRECTIVE_RE = /(\[(?:input|options):[^\]]+\])/;

function directiveControl(part, answers) {
  const input = part.match(/^\[input:\s*([^\]]+)\]$/);
  if (input) {
    const name = input[1].trim();
    const el = document.createElement('input');
    el.type = 'text';
    el.className = 'card-input';
    el.dataset.field = name;
    el.dataset.directive = part;
    el.placeholder = name;
    el.spellcheck = false;
    el.value = answers[name] || '';
    return el;
  }
  const options = part.match(/^\[options:\s*([^:\]]+):\s*([^\]]+)\]$/);
  if (options) {
    const name = options[1].trim();
    const el = document.createElement('select');
    el.className = 'card-select';
    el.dataset.field = name;
    el.dataset.directive = part;
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = name;
    el.appendChild(blank);
    for (const choice of options[2].split(',').map((c) => c.trim()).filter(Boolean)) {
      const opt = document.createElement('option');
      opt.value = choice;
      opt.textContent = choice;
      el.appendChild(opt);
    }
    el.value = answers[name] || '';
    return el;
  }
  return null;
}

function wireInputDirectives(markdown, card) {
  const answers = cardAnswers(card);

  const walker = document.createTreeWalker(markdown, NodeFilter.SHOW_TEXT);
  const targets = [];
  while (walker.nextNode()) {
    if (DIRECTIVE_RE.test(walker.currentNode.nodeValue)) targets.push(walker.currentNode);
  }
  if (!targets.length) return;

  for (const node of targets) {
    const frag = document.createDocumentFragment();
    for (const part of node.nodeValue.split(new RegExp(DIRECTIVE_RE, 'g'))) {
      const control = directiveControl(part, answers);
      if (control) frag.appendChild(control);
      else if (part) frag.appendChild(document.createTextNode(part));
    }
    node.parentNode.replaceChild(frag, node);
  }

  // Typing in a control is answering, not editing the document: stop the
  // event before the modal's body-save listener reads it as a body edit.
  markdown.addEventListener(
    'input',
    (e) => {
      if (e.target.matches && e.target.matches('.card-input, .card-select')) {
        e.stopPropagation();
      }
    },
    true
  );

  let answerTimer = null;
  const saveAnswers = async () => {
    const next = {};
    for (const el of markdown.querySelectorAll('.card-input, .card-select')) {
      if (el.value) next[el.dataset.field] = el.value;
    }
    lastSelfWrite = Date.now();
    await window.api.patchCard(card.path, { answers: JSON.stringify(next) });
    lastSelfWrite = Date.now();
    showSaveStatus('saved');
  };

  markdown.addEventListener('input', (e) => {
    if (!e.target.matches || !e.target.matches('.card-input, .card-select')) return;
    showSaveStatus('saving');
    if (answerTimer) clearTimeout(answerTimer);
    answerTimer = setTimeout(saveAnswers, 600);
  });
  markdown.addEventListener('change', (e) => {
    if (!e.target.matches || !e.target.matches('.card-input, .card-select')) return;
    if (answerTimer) clearTimeout(answerTimer);
    saveAnswers();
  });
}

// A title is a field wherever it appears: it saves itself as you type (on the
// same debounce as the document), Enter just ends the edit, Escape puts the
// last saved title back. No modal, no separate save step — editing in place.
function wireTitleField(id, currentTitle, commit) {
  const el = $(id);
  if (!el) return;

  let titleTimer = null;

  const save = async () => {
    const next = el.textContent.trim().replace(/\s+/g, ' ');
    if (!next || next === currentTitle()) return;
    await commit(next);
    showSaveStatus('saved');
  };

  el.oninput = () => {
    showSaveStatus('saving');
    if (titleTimer) clearTimeout(titleTimer);
    titleTimer = setTimeout(() => {
      titleTimer = null;
      save();
    }, 800);
  };

  el.onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      el.blur();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      if (titleTimer) clearTimeout(titleTimer);
      titleTimer = null;
      el.textContent = currentTitle();
      el.blur();
    }
  };

  el.onblur = async () => {
    if (titleTimer) clearTimeout(titleTimer);
    titleTimer = null;
    const next = el.textContent.trim().replace(/\s+/g, ' ');
    if (!next || next === currentTitle()) {
      // An emptied title keeps the previous text rather than saving nothing.
      el.textContent = currentTitle();
      return;
    }
    await save();
    // The main process may have tidied the title (emoji, dashes); show what
    // was actually saved once the edit is over.
    el.textContent = currentTitle();
  };
}

on('card-modal-close', 'click', closeCardModal);


// The footer buttons are re-aimed per card in openCardModal (onclick, not
// addEventListener, so nothing stacks). closeCardModal always flushes any
// pending edit to disk before the panel goes.
// ── The shaped card's shell (0175) ──
// A shaped to-do card opens two-up: the document on the left, a fresh shell
// on the right. The shell is a per-card tmux session with nothing typed and
// nothing run; the actions beneath it are the three ways into the work.
let modalTerm = null;

async function openModalShell(intent = null) {
  closeModalShell();
  const frame = $('card-modal-term-frame');
  frame.innerHTML = '';
  // A Doing card whose work session is alive in tmux shows that session
  // (0230) — the agent's history and whatever is running now — instead of
  // a fresh side shell. Anything else gets the card's own shell (0229).
  let result = null;
  if (modalCard.column === 'doing' && modalCard.id && window.api.attachCardSession) {
    const attach = await window.api
      .attachCardSession(activeProject.name, modalCard.id)
      .catch(() => null);
    if (attach && attach.sessionId) result = attach;
  }
  if (!result) {
    result = await window.api
      .openShell(activeProject.name, `card-${modalCard.id}`)
      .catch((err) => ({ error: err.message }));
  }
  if (!result || result.error) {
    frame.innerHTML = `<div class="empty-state"><p>${escapeHtml(
      (result && result.error) || 'Could not open a shell'
    )}</p></div>`;
    return;
  }
  const wrapper = document.createElement('div');
  wrapper.className = 'term-wrapper';
  frame.appendChild(wrapper);
  const { term, fitAddon } = buildTerminal(result.sessionId, wrapper);
  // A shell born for this open and never touched is not worth keeping
  // (0229); one that was reattached carries history and always is. Any
  // keystroke counts as touching it.
  modalTerm = { id: result.sessionId, term, fitAddon, fresh: !result.reattached, used: false };
  term.onData(() => {
    if (modalTerm) modalTerm.used = true;
  });
  requestAnimationFrame(() => fitSession(modalTerm));
  // A fresh shell stays bare until asked (0436, kept through 0449's
  // always-present pane): with an intent, the preferred agent launches
  // with the prompt as its opening argument — Let's go fires the work in
  // the same breath; without one, only `clear` runs. The `clear` is 0426:
  // tmux spawns at 80x24 and the xterm fit resizes it a beat later, which
  // smears zsh's inverse-% partial-line marker — wiping the scratch line
  // gives every card a clean opening frame.
  // A reattached session keeps whatever it was doing — an intent's prompt
  // is only typed there, never fired, since something may be mid-flight.
  if (modalTerm.fresh) {
    const forId = result.sessionId;
    refreshSessionCli().then((cmd) => {
      if (!modalTerm || modalTerm.id !== forId) return;
      const line =
        intent && intent.prompt
          ? `clear; ${cmd} "${intent.prompt.replace(/"/g, '\\"')}"`
          : 'clear';
      window.api.sendTerminalInput(forId, `${line}\r`);
      if (intent) {
        modalTerm.used = true;
        modalTerm.term.focus();
      }
    });
  } else if (intent && intent.prompt) {
    // A reattached pane may be a bare shell (0453) — firing the prompt
    // there lands it in zsh as a command that isn't. Ask tmux what the
    // pane runs: a shell at rest gets the agent launched with the prompt,
    // the same as a fresh open; anything mid-flight, or a pane the main
    // process can't vouch for, only gets the text typed, never fired.
    const forId = modalTerm.id;
    const state = window.api.sessionIdle
      ? await window.api.sessionIdle(forId).catch(() => null)
      : null;
    if (!modalTerm || modalTerm.id !== forId) return;
    if (state && state.idle) {
      const cmd = await refreshSessionCli();
      if (!modalTerm || modalTerm.id !== forId) return;
      window.api.sendTerminalInput(
        forId,
        `clear; ${cmd} "${intent.prompt.replace(/"/g, '\\"')}"\r`
      );
    } else {
      window.api.sendTerminalInput(forId, intent.prompt);
    }
    modalTerm.used = true;
    modalTerm.term.focus();
  }
}

function closeModalShell() {
  if (!modalTerm) return;
  if (modalTerm.fresh && !modalTerm.used) {
    // Never used: end the tmux session too, so closed cards don't bank
    // empty shells (0229).
    window.api.killTerminal(modalTerm.id);
  } else {
    // Only the stream stops; tmux keeps the shell, so reopening the card
    // resumes a chat mid-flight rather than losing it.
    window.api.stopTerminal(modalTerm.id);
  }
  modalTerm.term.dispose();
  modalTerm = null;
  $('card-modal-term-frame').innerHTML = '';
}

// ── The handover (0451) ──
// Edits to the document and new checklist items are context the working
// agent has not seen. While the card's session is engaged, they light the
// footer's handover button; clicking types the re-read line into the
// session — typed, never sent, the same contract as the session view's
// Update agent pill.
let modalHandoverPending = false;

function noteModalEdit() {
  modalHandoverPending = true;
  refreshModalHandover();
}

function refreshModalHandover() {
  const btn = $('card-modal-update-agent');
  if (!btn) return;
  const show = Boolean(modalHandoverPending && modalCard && modalTerm && modalTerm.used);
  btn.classList.toggle('hidden', !show);
  // Doing cards keep their footer hidden until there is a handover to host.
  if (modalCard && modalCard.column !== 'to-do' && modalCard.column !== 'backlog') {
    $('card-modal-footer').classList.toggle('hidden', !show);
  }
}

on('card-modal-update-agent', 'click', () => {
  if (!modalCard || !modalTerm) return;
  const line = `I've updated the task file at ${modalCard.path}. Re-read it and continue.`;
  window.api.sendTerminalInput(modalTerm.id, line);
  modalHandoverPending = false;
  refreshModalHandover();
  modalTerm.term.focus();
});

// The ways in (0436): the terminal pane stays away until summoned. Both
// doors slide it in and launch the preferred agent; Let's go hands it the
// work as its opening argument, Chat hands it the conversation brief.
function expandCardTerminal(intent) {
  $('card-modal-panel').classList.add('with-terminal');
  $('card-modal-term').classList.remove('hidden');
  openModalShell(intent);
}

// The raw start (0456): same walk into Doing, but the brief owns up that
// no plan exists yet — the agent shapes its own path through the ask.
function startRawFromModal() {
  if (!modalCard) return;
  startWorkFromModal(
    (path) =>
      `Start this task: read the card at ${path}. It hasn't been shaped yet — ask me anything unclear, then do the work and keep the card updated as you go.`
  );
}

on('card-modal-start-raw', 'click', startRawFromModal);

// buildPrompt, when given, is called with the card's post-move path — the
// move into Doing renames the file, so a prompt built any earlier would
// point the agent at a card that no longer exists.
async function startWorkFromModal(buildPrompt = null) {
  if (!modalCard) return;
  // Starting IS the work beginning (0452): the card walks into Doing with
  // the same click. The move renames the file, so the fresh path feeds
  // everything after — the wiring, the autosave, and the prompt itself.
  const moved = await window.api.moveCard(activeProject.name, modalCard.path, 'doing');
  // Our own move, not the agent's (0219).
  if (modalCard.id) dragMovedIds.add(modalCard.id);
  lastSelfWrite = Date.now();
  modalCard = await window.api.readCard(moved.path);
  renderCardModalBody();
  // The card wears its doing state now: the footer actions, Shape and
  // Archive step aside — the session is the story.
  $('card-modal-footer').classList.add('hidden');
  $('card-modal-shape').classList.add('hidden');
  $('card-modal-archive').classList.add('hidden');
  let prompt;
  if (typeof buildPrompt === 'function') {
    prompt = buildPrompt(modalCard.path);
  } else {
    // The go-ahead is a settings template since 0457, pre-filled with the
    // built-in and substituted at fire time — after the move, so the path
    // is the card's real one. Substituted values drop the characters zsh
    // would expand inside the quoted argument.
    const stored = await window.api.readSettings().catch(() => null);
    const defaults = await window.api.shapeDefaults().catch(() => null);
    const template =
      String((stored && stored.startPrompt) || '').trim() ||
      (defaults && defaults.start) ||
      "Start this work: read the card at [card-path]. It's already planned — follow it: work through the Build checklist, ticking items as they land, run the QA checks, and keep the card updated as you go.";
    const clean = (value) => String(value || '').replace(/[`$\\]/g, '');
    prompt = template
      .split('[card-path]').join(clean(modalCard.path))
      .split('[task-name]').join(clean(modalCard.title))
      .split('[project-name]').join(clean(activeProject && activeProject.title));
  }
  expandCardTerminal({ prompt });
  loadBoard();
}

on('card-modal-chat', 'click', () => {
  if (!modalCard) return;
  expandCardTerminal({
    prompt: `Read the card at ${modalCard.path} and chat with me about this task: questions, approach, trade-offs. Don't write any code until I say so.`,
  });
  $('card-modal-chat').classList.add('hidden');
});

async function saveAndShapeFromModal() {
  const card = modalCard;
  await closeCardModal();
  if (card) shapeCardAt(card);
}

// A title mid-rename is an edit too: Shape waits for the blur to commit it.
// Wired once — the title element outlives every modal open.
on('card-modal-title', 'focus', () => setModalShapeIdle(false));
on('card-modal-title', 'blur', () => setModalShapeIdle(true));

// While an edit is pending, Shape sits disabled with the reason on hover;
// the moment the save lands it wakes back up.
function setModalShapeIdle(idle) {
  const button = $('card-modal-shape');
  if (!button || !modalCard || shaping.has(modalCard.path)) return;
  button.disabled = !idle;
  if (!idle) button.dataset.tip = 'Saving your edit first — Shape enables when it lands';
  else if (modalCard) {
    button.dataset.tip = hasStructure(modalCard.body)
      ? 'Re-shape: redraft the plan and checklists'
      : 'Shape: draft the plan and checklists';
  }
}

on('card-modal-shape', 'click', async () => {
  if (!modalCard) return;
  // Anything still on the debounce timer goes to disk before the agent reads
  // the file, so it always shapes what you actually wrote.
  if (modalSaveTimer) {
    clearTimeout(modalSaveTimer);
    modalSaveTimer = null;
    await saveBody(modalCard.path, $('card-modal-body').querySelector('.markdown-body'));
  }
  shapeCardAt(modalCard);
});

on('card-session-log', 'click', () => {
  if (!modalCard) return;
  window.api.cardSessionLog(activeProject.name, modalCard.path, true);
});

// One archive routine for both doors — the header icon and the Move menu
// row (0443). It keeps the app's one-confirmation contract: archiving asks,
// the same sentence everywhere.
async function archiveFromModal() {
  if (!modalCard) return;
  const ok = await confirmAction(
    `Archive "${modalCard.title}"? The card keeps its markdown.`,
    'Archive'
  );
  if (!ok) return;
  const card = modalCard;
  modalCard = null;
  closeModalShell();
  $('card-view').classList.add('hidden');
  await window.api.archiveCard(activeProject.name, card.path);
  await loadBoard();
  showToast('Archived');
}

on('card-modal-archive', 'click', archiveFromModal);

// The Move menu (0430, growing 0312's project list): one place for every
// relocation — the board's columns first, then the other projects. Leaving
// doing pauses the card first, the same contract as dragging it out.
function moveMenuItem(menu, label, act) {
  const item = document.createElement('button');
  item.className = 'menu-item';
  item.textContent = label;
  item.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    menu.classList.add('hidden');
    if (!modalCard) return;
    const card = modalCard;
    modalCard = null;
    closeModalShell();
    $('card-view').classList.add('hidden');
    await act(card);
  });
  menu.appendChild(item);
}

on('card-modal-move', 'click', (e) => {
  e.stopPropagation();
  const menu = $('card-modal-move-menu');
  menu.innerHTML = '';
  if (!modalCard) {
    menu.classList.add('hidden');
    return;
  }

  // The columns read as a radio group (0442): every destination listed,
  // the current one wearing the filled dot. Picking where the card already
  // is just closes the menu — no move, no re-save, no flicker.
  const columns = [
    { key: 'to-do', label: 'To do' },
    { key: 'doing', label: 'Doing' },
    { key: 'done', label: 'Done' },
    { key: 'backlog', label: 'Backlog' },
  ];
  for (const col of columns) {
    const current = col.key === modalCard.column;
    const item = document.createElement('button');
    item.className = `menu-item${current ? ' checked' : ''}`;
    item.innerHTML = `<span class="menu-radio"></span><span>${escapeHtml(col.label)}</span>`;
    item.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      menu.classList.add('hidden');
      if (current || !modalCard) return;
      const card = modalCard;
      modalCard = null;
      closeModalShell();
      $('card-view').classList.add('hidden');
      if (card.column === 'doing') {
        // Server, port and session shell stop; the worktree stays (0217).
        for (const session of [...openSessions.values()]) {
          if (session.cardPath === card.path) closeSessionTab(session.id);
        }
        await window.api.pauseCard(activeProject.name, card.path);
      }
      await moveCardTo(card, col.key);
    });
    menu.appendChild(item);
  }

  // Archive rides with the columns (0443), above the projects: this
  // project's own destinations first. An action, not a state — it keeps
  // the archive confirmation, so no radio dot.
  const archiveItem = document.createElement('button');
  archiveItem.className = 'menu-item';
  archiveItem.innerHTML = `<span class="menu-radio menu-radio-empty"></span><span>Archive</span>`;
  archiveItem.addEventListener('click', (ev) => {
    ev.stopPropagation();
    menu.classList.add('hidden');
    archiveFromModal();
  });
  menu.appendChild(archiveItem);

  const head = document.createElement('div');
  head.className = 'menu-group';
  head.textContent = 'To another project';
  menu.appendChild(head);
  const others = projects.filter((p) => !activeProject || p.name !== activeProject.name);
  for (const target of others) {
    moveMenuItem(menu, target.title || target.name, async (card) => {
      await window.api.transferCard(activeProject.name, card.path, target.name);
      await loadBoard();
      showToast(`Moved to ${target.title || target.name}`);
    });
  }
  if (!others.length) {
    const empty = document.createElement('div');
    empty.className = 'menu-item';
    empty.textContent = 'No other projects';
    menu.appendChild(empty);
  }
  menu.classList.toggle('hidden');
});

document.addEventListener('click', (e) => {
  const menu = $('card-modal-move-menu');
  if (menu && !e.target.closest('.card-move-wrap')) menu.classList.add('hidden');
});

// An attachment reads as a chip until asked (0198): clicking a thumbnail in
// a card document swaps it between compact and full size. Knowledge docs
// keep their images full — a doc's figures are content, a card's
// screenshots are receipts.
document.addEventListener('click', (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement)) return;
  if (img.closest('.kb-editor') || img.classList.contains('kb-image')) return;
  if (!img.closest('.markdown-body') && !img.closest('.doc-context')) return;
  img.classList.toggle('expanded');
});

// ── Screenshot paste ──
// One handler for the whole window: an image on the clipboard lands as a file
// in the board's attachments folder, then goes wherever you were typing — the
// document gets the image inline, the terminal gets the file's path.
async function clipboardImage(e) {
  const items = e.clipboardData ? [...e.clipboardData.items] : [];
  const item = items.find((entry) => entry.type.startsWith('image/'));
  if (!item) return null;
  const blob = item.getAsFile();
  if (!blob) return null;
  return new Uint8Array(await blob.arrayBuffer());
}

// Pasting a screenshot while writing a new card: there is no card yet to file
// the image under, so it lands in attachments under a neutral key and the
// textarea gets the markdown reference the finished card will carry.
document.addEventListener('paste', async (e) => {
  if (!activeProject) return;
  if (!(e.target && e.target.id === 'card-add-input')) return;
  const items = e.clipboardData ? [...e.clipboardData.items] : [];
  if (!items.some((entry) => entry.type.startsWith('image/'))) return;
  e.preventDefault();

  const bytes = await clipboardImage(e);
  if (!bytes) return;
  const saved = await window.api.saveAttachment(activeProject.name, 'new-card', bytes);

  const input = e.target;
  const at = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? at;
  // Short sequential names (0198): the ref reads image-1, image-2 in the
  // text, however long the path behind it is.
  const n = (input.value.match(/!\[image-/g) || []).length + 1;
  const md = `![image-${n}](${saved.path})`;
  input.value = `${input.value.slice(0, at)}${md}${input.value.slice(end)}`;
  input.setSelectionRange(at + md.length, at + md.length);
  input.dispatchEvent(new Event('input', { bubbles: true }));
});

document.addEventListener('paste', async (e) => {
  if (!activeProject) return;

  // The card modal sits over the board, so "the board is visible" is not a
  // reason to bail while it is open — a paste into the modal is a paste into
  // that card's document.
  const inModal = modalCard && e.target.closest && e.target.closest('#card-modal-body');
  const session = openSessions.get(activeSessionId);
  const inSessionView = session && !isBoardVisible();
  if (!inModal && !inSessionView) return;

  const inDoc = inModal || (e.target.closest && e.target.closest('#doc-content'));
  const inTerm = !inModal && e.target.closest && e.target.closest('#term-pane');
  if (!inDoc && !inTerm) return;

  const bytes = await clipboardImage(e);
  if (!bytes) return;
  e.preventDefault();
  e.stopPropagation();

  // Attachments file under the card's id (0289): short, quotable names —
  // 0289-1.png is "card 0289, attachment 1". Duplicate ids heal on every
  // board load, and next-unused numbering never overwrites regardless.
  const cardKey =
    (inModal ? modalCard.id : session.cardId) ||
    (inModal ? modalCard.path : session.cardPath).split('/').pop().replace(/\.md$/, '');
  const saved = await window.api.saveAttachment(activeProject.name, cardKey, bytes);

  if (inTerm) {
    // The agent wants a path it can read, not pixels.
    window.api.sendTerminalInput(session.id, `${saved.path} `);
    return;
  }

  const root = inModal ? $('card-modal-body') : $('doc-content');
  const context = root.querySelector('.doc-context') || root.querySelector('.markdown-body');
  if (!context) return;

  const img = document.createElement('img');
  img.src = saved.path;
  img.alt = `image-${context.querySelectorAll('img').length + 1}`;

  const selection = window.getSelection();
  if (selection.rangeCount && context.contains(selection.anchorNode)) {
    const range = selection.getRangeAt(0);
    range.collapse(false);
    range.insertNode(img);
  } else {
    context.appendChild(img);
  }

  if (inModal) {
    // The modal's own input listener debounces the save and shows the receipt.
    context.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }

  session.dirty = true;
  refreshUpdateAgent(session);
  debouncedSave(session);
}, true);

// Cmd+F as well as Cmd+K: one is the habit from every editor, the other from
// every command palette, and both mean "let me find something". What you
// find follows where you stand (0182): the knowledgebase searches its docs,
// anywhere else searches the board's cards.
document.addEventListener('keydown', (e) => {
  if (e.metaKey && (e.key === 'k' || e.key === 'f')) {
    e.preventDefault();
    if (isDocsVisible()) {
      openKbSwitcher();
      return;
    }
    if (!isBoardVisible()) showBoard();
    openSearch();
    return;
  }

  if (e.key === 'Escape') {
    if (!$('search-overlay').classList.contains('hidden')) closeSearch();
    else if (!$('settings-modal').classList.contains('hidden')) closeSettings();
    else if (!$('card-add-modal').classList.contains('hidden')) closeCardAdd();
    else if (!$('card-view').classList.contains('hidden')) closeCardModal();
  }
});

// Clicking the backdrop dismisses it, the same as Escape.
on('search-overlay', 'mousedown', (e) => {
  if (e.target.id === 'search-overlay') closeSearch();
});

// ── Starting a card ──
async function startCard(card, fromRect = null) {
  openPlaceholderSession(card);

  // Dropped into Doing, the card itself appears to become the workspace:
  // the session view scales out of the card's last board position (0177).
  if (fromRect && fromRect.width) {
    morphPanelFrom($('session-view'), { getBoundingClientRect: () => fromRect });
  }

  const result = await window.api.startCard(activeProject.name, card.path);
  await loadBoard();

  if (result.error) {
    showSessionError(card, result.error);
    return;
  }

  // The file moved to doing/ during start, so match the fresh path, not the id
  // — ids can collide when card files are written by hand.
  const startedPath = (result.card && result.card.path) || card.path;
  const started = cards.find((c) => c.path === startedPath) || result.card;
  await attachSession(started, result.sessionId, result.notes);
}

function showSessionError(card, message) {
  $('term-status').textContent = 'failed';
  $('doc-content').innerHTML = `
    <div class="empty-state">
      <p><strong>Could not start this card.</strong></p>
      <p>${escapeHtml(message)}</p>
      <p>The card is in Doing. Click it again to retry. Steps that already
      succeeded are skipped.</p>
    </div>
  `;
}

window.api.onStartProgress(({ step, detail }) => {
  const status = $('term-status');
  if (status) status.textContent = detail || step;
});
