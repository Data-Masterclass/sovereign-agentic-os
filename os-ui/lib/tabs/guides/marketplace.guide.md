# Marketplace — golden path

The internal Marketplace is the **certified cross-domain catalogue**: products one
domain has vouched for (certified) and published so other domains can reuse them.
Reuse here is a **governed grant**, never a bytes copy — you get RLS-scoped access
compiled to OPA / Cube / OpenSearch-DLS, so two importers see two different,
correctly-scoped row sets.

## Tool sequence
1. `whoami`.
2. `browse_marketplace` — search the certified catalogue by free-text `q`, `type`,
   owning `domain`, or `tag`.
3. `get_listing` — one product's detail, trust signals (certified, imports,
   rating), a **RLS-filtered preview** (your rows only), lineage (upstream +
   importer domains), and the grants you already hold.
4. `import_product` — reuse it. An open-policy read-grant is compiled NOW; an
   approval-policy import returns a pending handle (the owner domain approves via
   `decide_approval`). fork / deploy-instance / template modes are Builder+.
5. `rate_listing` — 1–5 stars (upsert), signalling quality back to the catalogue.

## Certifying INTO the marketplace
Publishing a domain asset to the marketplace is the rung-2 ladder step:
`request_certification` (a Builder/Domain-admin in the artifact's domain files it) →
a platform Admin runs `decide_approval`. The domain vouches; the Admin certifies.

## Governance
- `browse_marketplace`, `get_listing`, `rate_listing` and a read-grant
  `import_product` floor at **creator** — consuming shared assets is a creator
  right (the nav labels the tab Builder/Admin, but the lib gate is the authority).
- fork / deploy-instance / template imports re-gate to **Builder+** in-lib.
- The preview never leaks rows outside your entitlement; an unknown id is a typed
  `not_found` (indistinguishable from not-visible).

Excluded (deliberate): deprecating / hard-removing a listing is Admin-only and
lineage-aware — it lives in the tab UI so importers are warned, never silently cut.
