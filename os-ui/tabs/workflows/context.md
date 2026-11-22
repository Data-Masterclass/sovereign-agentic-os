# Workflows tab — build context

**Purpose:** Document a business process as a workflow — ordered steps, the actors who carry them
out, rules and tacit know-how — so people and agent systems can read how work is done. A workflow
(`wf_…`) is NOT a knowledge note: a free-form report, answer or summary is saved with
`save_knowledge_note` (Knowledge tab), never with `author_workflow`. The tab runs nothing; to run
work, build an agent system.

**Tools (MCP `workflows`):**
- `author_workflow(title, domain?, markdown?, steps[], rules[], actors[]?, tacit?)` — create a
  Personal draft workflow. Steps accept `{title, actor, actor_name, inputs, outputs, tacit}`. The
  top-level `tacit` string is the process-level TACIT.md (unstructured know-how that resists
  formalization — gotchas, cultural notes, the "why"). Per-step inline notes go in `steps[].tacit`.
- `list_workflows` · `get_workflow(workflowId)` — discover and read workflows you can see.
- `index_workflow(workflowId)` — chunk → embed → index, so `search_knowledge` can return the
  workflow's text. Per-step tacit notes and the process-level tacit doc are indexed as separate
  `type: "tacit"` units.
- `publish_workflow(workflowId)` — Domain admin+ only; My → Domain.
- `retire_workflow(workflowId, action?)` — `archive` (default, reversible) or `delete` (physical +
  index purge). Edit-gated (owner, or same-domain Builder+ for a Domain workflow). LINEAGE-AWARE:
  blocked (409) if any App/Agent still consumes it. `delete` also refuses a still-live workflow.

**Tacit know-how:** two levels — per-step (`steps[].tacit`, stored as `> tacit:` blockquotes in
workflow.md) and process-level (`tacit`, stored as sibling TACIT.md, split by heading into
separately-retrievable chunks). Both indexed by `index_workflow`.

**Golden path:** `list_workflows` (dedupe) → `author_workflow` → `index_workflow` → verify with
`search_knowledge` → (Domain admin) `publish_workflow`.

**Constraints:** default-deny OPA gate; DLS filters to owner / domain / Company visibility.
