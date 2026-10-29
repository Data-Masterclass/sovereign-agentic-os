<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
-->
# Prefs

`lib/prefs/` manages per-user UI preferences — currently the tile ordering for tileboard
surfaces (the home-screen tiles and per-tab tile grids). The module is split into three
layers following the platform pattern: pure logic, server store, and client hook.

## Public API

### `tile-order-pure.ts` — pure logic, no IO

- **`TILE_ORDER_SURFACES`** — the exhaustive list of surface keys that support
  custom tile ordering (e.g. `'home'`, per-tab surface keys).
- **`TileOrderSurface`** type — `(typeof TILE_ORDER_SURFACES)[number]`
- **`ORDER_LIMIT`** — maximum number of tile IDs accepted in a single order array (500).
  Guards against oversized payloads.
- **`applyTileOrder<T>(tiles, order)`** — sorts `tiles` by the position of each tile's
  ID in `order`; tiles not present in `order` fall to the end in original sequence.
  Pure function; unit-tested in `tile-order.test.ts`.

### `tile-order.ts` — server store (`server-only`)

Re-exports all pure exports, plus:

- **`getTileOrder(userId, surface)`** — returns the stored tile-ID array for the user +
  surface pair. Reads from the globalThis-pinned Map; hydrates from the `os-user-prefs`
  OpenSearch index on first access. Returns `[]` if no preference is stored.
- **`setTileOrder(userId, surface, order)`** — validates length ≤ `ORDER_LIMIT`, writes
  to the in-process Map, and upserts to `os-user-prefs`.
- **`__resetForTests()`** — test-only: clears the in-process Map.

Called from `app/api/prefs/tile-order/route.ts`.

### `useTileOrder.ts` — client React hook

- **`useTileOrder(surface)`** — fetches and mutates tile order via
  `GET/PUT /api/prefs/tile-order?surface=…`. Returns `{ order, setOrder, isLoading }`.
  Used by tileboard components to persist drag-and-drop reordering.

## Dependencies

- **`lib/infra/os-mirror`** — `osMirror` OpenSearch client for `os-user-prefs` index
  reads and upserts (server store only).
- No other `lib/` dependencies.

## Invariants

- **Session-user only.** The route layer enforces that `userId` in `getTileOrder` /
  `setTileOrder` matches the authenticated session user. This module does not re-check.
- **Pure logic is IO-free.** `tile-order-pure.ts` has no imports; it is safe to import
  from any layer including client components and tests.
- **Dual-store consistency.** Same write-through pattern as `lib/marketplace` and
  `lib/notifications`: in-process Map for speed, OpenSearch for durability across pod
  restarts.
