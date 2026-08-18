---
name: flow-knowledge
description: Ground work in the flow project's knowledgebase before building product-facing things, and save missing research back into it. Use when a task touches competitors, positioning, prior research, or past product decisions and you are in a session launched by the flow app (FLOW_KNOWLEDGE_ROOT is set).
---

# flow-knowledge

The product knowledgebase lives at `$FLOW_KNOWLEDGE_ROOT` (folders one level
deep, markdown notes plus self-contained HTML reports). It is the ground truth
for product context: who the competitors are, what has been researched, what
was decided and why.

## Before building

1. Search by topic first — grep is the tool at this vault's size:
   `grep -ril "<topic>" "$FLOW_KNOWLEDGE_ROOT"` and skim the hits.
2. Read only the docs that matter to the task. Never bulk-load the vault into
   context; the folder listing is your index.
3. Ground the work in what you find: "don't look like our competitors" means
   reading `Competitors/` before styling anything.

## When research is missing

If the task depends on knowledge that is not there, do the research as part of
the work and save it back:

- Notes and findings: a markdown doc in the fitting folder (create the folder
  if none fits), `# Title` first line.
- Reports with charts or layout: a self-contained HTML doc linking
  `../.styles/docs.css`, assets inline.

Tell the user what you added and where. The knowledgebase grows as a side
effect of work — that is the point.

## If FLOW_KNOWLEDGE_ROOT is not set

You are probably not inside flow; ask where product context lives rather than
guessing.
