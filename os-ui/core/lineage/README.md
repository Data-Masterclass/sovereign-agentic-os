<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
-->
# Lineage

`lib/lineage/` is a thin cross-artifact lineage dispatcher for the `get_lineage` MCP tool
(MCP-v2 P0.3). It owns no collector logic and holds no state — it parses a `kind:id`
reference, routes to the per-artifact lineage function that already exists in the owning
tab library, and normalises the result to the canonical `{ nodes, edges }` shape the MCP
surface and the Lineage UI panel consume.

## Public API

### `unified.ts`

The only file in this module. Everything is exported from here.

- **`LineageRefKind`** type — the set of routable kinds:
  `'dataset' | 'metric' | 'dashboard' | 'model' | 'listing' | 'bet' | 'app'`
- **`UnifiedNode`** — `{ id, kind, label, redacted? }`. Nodes the caller cannot view
  are returned as `{ redacted: true, kind }` — present in the graph but opaque.
- **`UnifiedEdge`** — `{ from, to, rel }`
- **`UnifiedLineage`** — `{ ref, kind, id, nodes, edges }` — the normalised output shape.
- **`parseRef(ref)`** — splits a `"kind:id"` string into `{ kind, id }`. Throws on
  unrecognised kind so callers get a clear 400, not a silent empty graph.
- **`getLineage(ref, user)`** — async dispatcher: parses the ref, checks that the
  root artifact is visible to `user` (403/404 on failure), delegates to the matching
  per-artifact collector, normalises and returns `UnifiedLineage`. Cross-scope nodes
  the user cannot see are replaced with a redacted stub rather than omitted, preserving
  graph shape.

Called from `app/api/lineage/route.ts` and the MCP `get_lineage` tool handler.

## Dependencies (dispatch targets)

This module dispatches into existing functions — it does not re-implement them:

| Kind | Dispatches to |
|------|--------------|
| `dataset` | `lib/data` (`lineageFor`, `getDataset`) |
| `metric` | `lib/metrics` |
| `dashboard` | `lib/dashboards` |
| `model` | `lib/science` |
| `listing` | `lib/marketplace` |
| `bet` | `lib/bigbets` |
| `app` | `lib/software` |

No other `lib/` modules depend on `lib/lineage`.

## Invariants

- **No state, no collector logic.** This module is a dispatch + normalisation shim only.
  Adding a new lineage source means adding a case to `getLineage` — not moving logic here.
- **Visibility enforced at the root.** An unviewable root artifact → 403/404 before any
  collector is called. Cross-scope unreachable nodes → `{ redacted: true, kind }`.
- **Stable output shape.** `UnifiedLineage` is the contract for both the MCP tool and
  the UI panel; collector internals are invisible above this layer.
