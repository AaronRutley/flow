# Architecture notes

A map, not a novel. Read alongside the README's "The pieces".

## Two processes, one boundary

- **Main** (`main.js` + `src/main/*`): owns disk, git, tmux, child
  processes, and every policy: path containment (`path-guard`), IPC
  argument validation (`validate` + the schema table in main.js), the
  process-launch policy (`proc`), atomic writes (`atomic-write`), the
  process registry (`proc-registry`), URL policy (`urls`), redaction
  (`redact`).
- **Renderer** (`src/renderer/*`, loaded in order by `index.html`): classic
  scripts sharing one global scope — each file's top-level functions are the
  next file's vocabulary. `state.js` first (shared state + `renderMarkdown`),
  `init.js` last (boot sequence). No bundler by design.
- **Preload** (`preload.js`): the entire bridge. If it isn't in
  `window.api`, the renderer can't do it.

## Boards are files

One folder per project under the Flow root; numbered column folders
(`01-to-do` … `05-backlog`, plus `00-knowledge`, `06-attachments`); one
markdown file per card with frontmatter as state. Everything the app knows
is re-derivable by reading the folder, and outside writers (agents, editors)
are first-class: the chokidar watcher coalesces their changes into refreshes,
and id allocation claims filenames with exclusive creates so nobody mints
the same id twice.

## Sessions are tmux

Every terminal — card sessions, the board/docs terminals — is a pty attached
to a tmux session named `flow-*`. The app dying detaches; reopening
reattaches; the process registry records who ran and how it ended. Servers
and agents are children of panes, which is also how port cleanup proves
ownership before killing anything.

## The knowledge vault

`00-knowledge/` under each board: folders one level deep, markdown and HTML
docs, a `.order.json` for drag order, `.history/` for doc save history.
`knowledge.js` guards every path within the vault.

## Where to start reading

`src/main/board.js` (cards on disk), `src/renderer/board.js` (cards on
screen), `src/main/sessions.js` (the tmux substrate), `src/main/pipeline.js`
(what "drag a card to Doing" actually does).
