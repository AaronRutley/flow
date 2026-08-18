# Flow

A tool for product builders and vibe coders, to stay in the flow.

An IDE is where you develop code. Flow is where you develop a product: a
macOS app for people who build by directing AI coding agents rather than
typing every line themselves.

If that's you, you know the juggle. Planning notes split across Obsidian,
Notion and Google Docs. To-dos in Trello and stray markdown files. Three
terminal tabs of Claude sessions and prompts typed into the wrong one.
Reports stuck on your desktop. Flow puts the whole loop in one minimal app:
ideas, tasks, agents and results, side by side.

- **A board that works.** Every card is a task an agent can pick up. Drag
  it into Doing and Flow handles the setup: a persistent Claude Code
  session opens with the card as its brief, and the git plumbing happens
  behind the scenes. One card, one conversation, one branch, one PR.
- **Sessions that survive.** Terminals live in tmux, so quitting the app or
  rebooting loses nothing. Reopen a card and the same conversation resumes.
- **Context lives together.** Planning holds your docs and research;
  Analytics holds your reports and links. The agent can read them, and what
  it learns files back in.
- **Bring your own agent.** Claude, Codex, whatever you run on the command
  line. Flow drives the CLIs already on your Mac, with the login they
  already have. No API keys, no accounts.
- **Plain files, stored locally.** Everything is markdown and HTML on your
  disk, readable in a year, no cloud, no tracking.

Free and open source, MIT licensed.

## Run it locally

Flow runs from source for now; packaged downloads come later.

1. Install the two tools Flow drives: `brew install tmux`, and the
   [`claude` CLI](https://docs.anthropic.com/en/docs/claude-code), logged
   in.
2. Clone, install and start — Node 22 or newer (`nvm use` picks it up if
   you use nvm):

   ```sh
   git clone https://github.com/AaronRutley/flow.git
   cd flow
   npm install
   npm start
   ```

3. First launch asks where to keep your files. Pick a folder; everything
   Flow writes lives there as plain markdown and JSON.
4. Add your repo as a project, write your first card, drag it into Doing.

`npm test` runs the smoke suite. Architecture notes live in
[`docs/architecture.md`](docs/architecture.md) and contribution guidelines
in [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Will it run on my machine?

| | Status |
| --- | --- |
| macOS on Apple Silicon | Yes, this is what Flow is built and tested on (macOS 14+) |
| macOS on Intel | Untested |
| Windows / Linux | No |

And the CLIs, which Flow checks itself under **Global settings › On this
Mac**:

- `tmux` — required; without it sessions don't survive an app restart
- `claude`, logged in — required for anything agentic; a card stuck on
  "Asking Claude" means log in (there's a helper button on the failure)
- `gh`, logged in — optional, for draft PRs
- `codex` — optional, for second-opinion reviews

## How the agents run

Shape, Draft a plan, Research and Review are not a connection to a desktop
app and never ask for an API key. They spawn the `claude` CLI on your Mac
with the same login as any terminal. Commands Flow prepares for you arrive
pre-typed in the terminal for you to read; Enter stays yours.

## Your data is just files

Boards live in the folder you chose: one folder per project, one numbered
folder per column, one markdown file per card, with your docs in
`00-knowledge/`. Agents and editors can write there too; the board keeps
up. Nothing is locked in, ever.

## License

MIT — see [`LICENSE`](LICENSE). Every dependency is permissively licensed;
the audit lives in [`LICENSES.md`](LICENSES.md).
