# Files tab — build context

**Purpose:** A governed drive for unstructured files (docs, transcripts, policies). Upload → auto-chunk + embed → hybrid search; promote a file from My to a DOMAIN asset.

**Tools (MCP `files`):**
- `upload_file(name, folder?, text?, tags?, sensitivity?, domain?)` — create a private file at v1; `text` is chunked + embedded for search. `restricted` = stored, not indexed. Runs as you.
- `request_promotion(kind, id, visibility?, grants?)` — Creator files a promotion request (Personal → DOMAIN asset). Set `kind: "file"`. Requires `description` + ≥1 tag or returns `bad_request`.
- `approve_promotion(requestId)` — **Builder+** only; applies the filed request, re-governs the object-store prefix + DLS.

**Golden path:** `upload_file` (with extracted text + ≥1 tag + a description) → Creator calls `request_promotion` (kind `"file"`) → a Builder runs `approve_promotion`.

**Constraints:** identity + role floor come from your session, never the request. A creator uploads in their own domain but cannot promote. Every write is OPA-checked + Langfuse-audited, exactly like the Files tab.
