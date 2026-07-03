# Files tab — build context

**Purpose:** A governed drive for unstructured files (docs, transcripts, policies). Upload → auto-chunk + embed → hybrid search; promote a file from Personal to a shared DOMAIN asset.

**Tools (MCP `files`):**
- `upload_file(name, folder?, text?, tags?, sensitivity?, domain?)` — create a private file at v1; `text` is chunked + embedded for search. `restricted` = stored, not indexed. Runs as you.
- `promote_file(fileId, visibility?, grants?)` — Personal → DOMAIN asset. **Builder+** only (the creator lockdown); re-governs the object-store prefix + DLS.

**Golden path:** `upload_file` (with extracted text + ≥1 tag + a description via the file’s docs) → a Builder runs `promote_file` to share it.

**Constraints:** identity + role floor come from your session, never the request. A creator uploads in their own domain but cannot promote. Every write is OPA-checked + Langfuse-audited, exactly like the Files tab.
