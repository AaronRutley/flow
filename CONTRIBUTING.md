# Contributing to Flow

Thanks for looking under the hood. Flow is a solo-built macOS Electron app;
contributions are welcome as long as they respect how the thing is built.

## Getting set up

- macOS on Apple Silicon, Node 22+ (`nvm use` reads the `.nvmrc`)
- `npm install` — also wires the pre-commit hook and fixes node-pty perms
- `npm start` — the dev app, live-reloading on file changes
- `tmux` and a logged-in `claude` CLI make the whole app work; without them
  you can still develop the board and docs surfaces

There's no separate fixture project: `scripts/smoke.js` creates and destroys
its own scratch boards, and the dev app points at `projects/` (gitignored),
so your own boards are your fixtures.

## Before you open a PR

- `npm run lint` — zero errors (warnings are tolerated, don't add new ones)
- `npm test` — the smoke suite, all green
- The pre-commit hook runs both; `--no-verify` is for emergencies
- Match the house style you see: comments explain why, not what; no
  AI-attribution trailers in commits or PR bodies
- One concern per PR; UI changes come with a screenshot

## Where things live

Read `docs/architecture.md` for the map: main-process domains under
`src/main/`, the classic-script renderer under `src/renderer/`, boards as
markdown on disk, sessions in tmux.

## Questions and bugs

Open an issue with the template. Security problems go through
[GitHub security advisories](https://github.com/AaronRutley/flow/security/advisories/new),
privately, not the tracker.

## Conduct

Be someone it's pleasant to build software with. Harassment, personal
attacks or bad-faith dogpiling get one warning, then a block. (If this repo
grows real contributor volume, a fuller code of conduct comes with it.)
