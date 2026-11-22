# Knowledge tab — build context

**Purpose:** Keep knowledge notes — titled, free-form markdown documents — in My knowledge, and
retrieve grounded, cited context from them under governance (OPA gate + document-level grant filter).
A knowledge note (`pk_…`) is NOT a workflow: a workflow (steps + actors, the documentation of a
business process, `wf_…`) belongs to the Workflows tab and its own tools (`author_workflow`, …).

**Tools (MCP `knowledge`):**
- `save_knowledge_note(title, md, folder?, domain?, sourceKey?)` — save a free-form
  markdown NOTE into My knowledge, optionally in a folder. Personal and owner-only; share it
  with `request_promotion({kind:"personal_knowledge"})`. Repeating a call with the same
  `sourceKey` returns the note already saved. The note is indexed so `search_knowledge`
  finds it — for its owner only (`searchable` says whether it is). Use this whenever the task
  says "save as knowledge", "keep this result", "store the report".
- `list_knowledge(folder?)` — the notes you can see (My · Domain · Company).
- `get_knowledge(id)` — one note by its `pk_…` id.
- `search_knowledge(query, k?)` — governed hybrid retrieval (dense + lexical,
  reranked) with provenance. OPA `retrieve` gate + DLS grant filter; returns only
  units you may see. The index also holds the text of indexed workflows (ids `wf_…`);
  tacit units carry `type: "tacit"` in their provenance.
- `export_okf_bundle(workflowId)` — export a workflow as an **OKF (Open Knowledge
  Format) v0.2** bundle — a portable, human-readable directory of markdown + YAML
  frontmatter, zipped and written as a governed Files-tab artifact (returns its `fileId` +
  `deepLink`; MCP can't return a zip inline). The interchange format ONLY — the OpenSearch
  retrieval engine is untouched. Conformance is validated on export.
- `import_okf_bundle(base64Content, domain?)` — import an OKF v0.2 bundle (zip as
  base64). Validated for conformance, then its concepts land as governed artifacts at
  **Personal tier with you as owner**, through the normal author ladder (never a
  bypass). Idempotent. Zip-slip-safe with hard caps (≤ 50 MB, ≤ 2,000 files).

**Not here:** authoring, indexing, publishing or retiring a workflow — see the Workflows tab
(`author_workflow`, `index_workflow`, `publish_workflow`, `retire_workflow`, `list_workflows`,
`get_workflow`).

**Golden path:** `list_knowledge` / `search_knowledge` (dedupe) → `save_knowledge_note` →
optionally `request_promotion({kind:"personal_knowledge"})` → grant it to an agent system under
*Knowledge*.

**Constraints:** default-deny OPA gate; DLS filters to owner / domain / Company visibility;
hits carry provenance — cite it.
