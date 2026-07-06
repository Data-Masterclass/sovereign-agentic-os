# Marketplace tab — build context

**Purpose:** The certified cross-domain catalogue. Reuse = a governed grant (RLS-scoped), never a bytes copy.

**Tools (MCP `marketplace`):**
- `browse_marketplace(q?, type?, domain?, tag?)` — search the certified catalogue.
- `get_listing(listingId)` — one product: detail, trust signals, RLS-filtered preview (your rows only), lineage, ratings, your grants.
- `import_product(listingId, mode?)` — reuse it: open-policy read-grant compiled NOW; approval-policy → a pending handle (owner domain approves via `decide_approval`). fork/deploy-instance/template are Builder+.
- `rate_listing(listingId, stars)` — 1–5 star upsert.
- `get_lineage(ref)` — normalized lineage graph (also spans other tabs).

**Certify IN:** `request_certification(kind, id)` (Builder/Domain-admin in the artifact's domain) → Admin `decide_approval`.

**Golden path** (slash command `reuse_from_marketplace`): `whoami` → `browse_marketplace` → `get_listing` → `import_product` → `rate_listing`.

**Constraints:** browse/get/rate + read-grant import floor at creator (consuming shared = creator right); fork/instance/template re-gate to Builder+ in-lib. Preview never leaks out-of-entitlement rows. Deprecate/hard-remove is Admin-only in the tab UI.
