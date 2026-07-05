# Connections tab — build context

**Purpose:** Connect governed external data sources (Google Drive, Notion, Salesforce, Slack, databases, MCP/API endpoints) so apps and agents can consume them BY REFERENCE — the raw credential is stored server-side and never leaves the OS.

**Tools (MCP `connections`):**
- `list_connections` — the connections you can see (reuse first).
- `get_connection(connId)` — one connection (metadata + sync state, never the secret).
- `create_connection(name, template, endpoint?, credential?, domain?)` — a PERSONAL connection.
- `test_connection(connId)` — probe it (live | offline).
- `promote_connection(connId)` — Builder+: Personal → a SHARED domain source.

**Golden path:** `list_connections` (reuse) → `create_connection` (Personal) → `test_connection` → ⛔ Builder+ `promote_connection` → apps consume via `use_connection(appId, ref)` BY REFERENCE.

**Constraints:** any user may connect a PERSONAL account; SHARED (service-credential) templates and promotion require a Builder/Admin. The model NEVER sees raw credentials — the reference is the contract. External endpoints must be on the egress allowlist. Every action runs as you, OPA-checked and audited.
