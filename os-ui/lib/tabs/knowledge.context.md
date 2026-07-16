# Knowledge tab — build context

**Purpose:** Capture business workflows as structured knowledge, index them, and
retrieve grounded, cited context under governance (OPA gate + document-level grant
filter).

**Tools (MCP `knowledge`):**
- `author_knowledge(title, domain?, markdown?, steps[], rules[], tacit?)` — create
  a Personal draft workflow. Steps accept `{title, actor, actor_name, inputs,
  outputs, tacit}`. The top-level `tacit` string is the workflow-level TACIT.md
  (unstructured know-how that resists formalization — gotchas, cultural notes, the
  "why"). Per-step inline notes go in `steps[].tacit`.
- `index_knowledge(workflowId)` — chunk → embed → index; required before
  `search_knowledge` returns the workflow. Both per-step tacit notes and the
  workflow-level tacit doc are indexed as separate `type: "tacit"` units.
- `publish_knowledge(workflowId)` — Builder+ only; My → Domain.
- `retire_knowledge(workflowId, action?)` — `archive` (default, reversible) or
  `delete` (physical + index purge). Edit-gated (owner, or same-domain Builder+ for
  a Domain workflow). LINEAGE-AWARE: blocked (409) if any App/Agent still consumes
  it. `delete` also refuses a still-live workflow.
- `search_knowledge(query, k?)` — governed hybrid retrieval (dense + lexical,
  reranked) with provenance. OPA `retrieve` gate + DLS grant filter; returns only
  units you may see. Tacit units carry `type: "tacit"` in their provenance.

**Tacit knowledge:** two levels — per-step (`steps[].tacit` in `author_knowledge`,
stored as `> tacit:` blockquotes in workflow.md) and workflow-level (`tacit` param,
stored as sibling TACIT.md, split by heading into separately-retrievable chunks).
Both indexed by `index_knowledge` and surfaced by `search_knowledge`.

**In-app knowledge agent:** captures a workflow as structured steps + rules + tacit.
Three sections: "1. The workflow, step by step", "2. Rules and decisions",
"3. Tacit business context".

**Golden path:** author workflow (steps + rules + tacit) → index → `search_knowledge`
to ground an agent/answer with citations.

**Constraints:** default-deny OPA gate; DLS filters to owner / domain /
Company visibility; hits carry provenance — cite it.
