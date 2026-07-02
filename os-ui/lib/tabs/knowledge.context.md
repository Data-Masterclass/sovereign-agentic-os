# Knowledge tab — build context

**Purpose:** Capture business workflows as structured knowledge, index them, and retrieve grounded, cited context under governance (OPA gate + document-level grant filter).

**Tools (MCP `knowledge`):**
- `search_knowledge(query, k?)` — governed hybrid retrieval (dense + lexical, reranked) with provenance. OPA `retrieve` gate + DLS grant filter; returns only units you may see.

**In-app knowledge agent:** captures a workflow as markdown with three sections — "1. The workflow, step by step", "2. Rules and decisions", "3. Tacit business context".

**Golden path:** capture workflow (3 sections) → index → `search_knowledge` to ground an agent/answer with citations.

**Constraints:** default-deny OPA gate; DLS filters to owner / domain-shared / marketplace visibility; hits carry provenance — cite it.
