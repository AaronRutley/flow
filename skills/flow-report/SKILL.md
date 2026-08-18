---
name: flow-report
description: Build a "what shipped / what happened" report for a flow project from its board cards and changelog. Use when the user asks what was done this week, wants a progress or shipping report, or asks for a project summary while in a session launched by the flow app (FLOW_BOARD_ROOT is set).
---

# flow-report

The receipts live on the board and in the changelog — read those before
spelunking git.

## Sources, in order

1. `$FLOW_BOARD_ROOT/03-done/` and `04-archive/` — one markdown card per task.
   Frontmatter carries the facts: `completed` (date), `pr` and `pr_url`,
   `branch`, `title`. The `## Recap` section in each card says what actually
   happened, in prose written at finish time.
2. The project repo's `changelog.md` (repo path is usually the git checkout
   above; in a docs session it was handed to you with --add-dir).
3. Git history only for detail the cards lack.

## Filtering a period

"This week" means cards whose `completed` falls in the period. Group by PR
(`pr` field) the way the board's Done column does — a PR is one delivery.

## Output

- A quick spoken answer: plain prose, deliveries grouped by PR, dates and PR
  numbers cited.
- A report artifact: a self-contained HTML doc in
  `$FLOW_KNOWLEDGE_ROOT/<fitting folder>/`, linking `../.styles/docs.css`,
  charts as inline SVG, assets embedded. Say where you saved it.

Plain technical English throughout: no emoji, no em dashes, no filler.
