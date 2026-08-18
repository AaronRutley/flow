---
name: flow-todo
description: Capture a task, idea, or "remind me later" as a card on the flow board instead of a TODO in the repo. Use when the user asks to add a to-do, note something for later, or queue work while you are in a session launched by the flow app (FLOW_BOARD_ROOT is set).
---

# flow-todo

You are running inside flow, a kanban app. Tasks live on its board as markdown
cards, never as TODO comments or task files in the working repo.

## Where

`$FLOW_BOARD_ROOT/01-to-do/` — one file per card. If `FLOW_BOARD_ROOT` is not
set, say so and ask where the board lives instead of guessing.

## How

1. Find the next id: the highest four-digit prefix across all of
   `$FLOW_BOARD_ROOT`'s numbered folders (01-to-do, 02-doing, 03-done,
   04-archive, 05-backlog), plus one, zero-padded to four digits.
2. Write `NNNN-<slug>.md` in `01-to-do/`, where the slug is the lowercased
   title, non-alphanumerics collapsed to hyphens, trimmed to 48 chars.
3. Frontmatter must match the board's other cards:

```markdown
---
id: "NNNN"
title: "Lead: short plain description"
status: to-do
position: <highest position in 01-to-do plus one>
created: "YYYY-MM-DD"
updated: "YYYY-MM-DD"
branch:
pr:
pr_url:
worktree:
port:
route:
claude_session:
needs_input: false
completed:
---

<the user's ask, verbatim or lightly tidied, as the body>
```

4. Titles are plain technical English: no emoji, no em dashes.
5. Confirm with one line: the id and title you filed. Do not start the work —
   capture is the whole job.

## Shaping on capture

A card the user types by hand may stay bare: the one-line ask is the card.
But when you are filing more than a couple of cards at once, or any card
derived from a report, audit, or research doc, shape each card as you file
it — the same structure the Shape pipeline produces, grounded in the source
material and the repo, not just a summary line:

- The original ask (or the source finding), then:
- `## Plan` — prose saying how this gets done in this codebase: which files
  or subsystems, what approach, what to watch for.
- `## Build` — a checklist of checkable steps naming real files where known.
- `## QA` — a checklist of verifiable checks someone could actually run.
- `## Done when` — one falsifiable sentence.

The minimum bar: Plan says how in this codebase, Build steps are checkable,
QA checks are verifiable, Done when can be judged true or false. A batch
card that can't clear that bar isn't ready to file — read the source and
the repo until it can.

Run `node scripts/board-check.js` (in the flow repo) to list to-do cards
missing shaped sections; hand-typed quick captures are allowed to be bare,
so treat its output as a review list, not an error.
