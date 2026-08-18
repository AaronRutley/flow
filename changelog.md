# Changelog

All notable changes to Flow are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each release lists changes under **Added**, **Changed**, **Fixed**, **Removed**,
**Deprecated**, or **Security** as needed. Unreleased work collects at the top;
when a version ships, its section is dated and a fresh Unreleased block takes
its place.

## [Unreleased]

## [1.0.0] — 2026-08-18

The first release. What Flow does:

- **The board.** Kanban columns of markdown cards, one file per card,
  shaped with a plan and checklists by the local `claude` CLI.
- **Cards become sessions.** Drag a card into Doing and a persistent
  Claude Code session opens with the card as its brief; the git branch,
  worktree and draft PR happen behind the scenes.
- **Sessions survive.** Every terminal lives in tmux, so quitting the app
  or rebooting loses nothing; reopening a card resumes the conversation.
- **Planning and Analytics.** Two vaults of docs beside the board — notes,
  research, reports and links — with an inline markdown editor, folders,
  search and a knowledge index the agent can read.
- **Plain files, locally.** Boards, docs and config are markdown and JSON
  in a folder you choose. No accounts, no cloud, no tracking; crash-safe
  atomic writes and a documented stability contract for the formats.
- **Hardened where it counts.** Path containment and schema validation on
  every IPC channel, a strict CSP, sanitised markdown, one policy for
  child processes and external URLs, and an honest opt-in sandbox story.

The path here, in detail, lives in the repo's development history.
