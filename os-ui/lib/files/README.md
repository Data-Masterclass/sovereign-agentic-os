<!-- SPDX-License-Identifier: Apache-2.0 -->
# Files tab — `lib/files`

A store for **any file** (docs, images, video, audio, archives), **auto-indexed** so
agents can search & cite it, and **governed exactly like Data** (tiers / roles /
lifecycle). Files are **unstructured context products** in the context layer. The
surface shows only files / folders / tags / search + a status chip
(Processing → **Searchable ✓**); Docling, embeddings, OpenSearch, chunking, OPA/DLS
and Dagster all stay hidden.

> The governance lifecycle is **re-used read-only from the Data tab**
> (`lib/data/dataset-schema.ts`): the same `Tier` (dataset → asset → product), the
> same role gates (`canTransition`), tier walk (`tierAfter`) and visibility clamp
> (`visibilityFor`), and the same `grants` policy source. Files do **not** fork it.

## Live-or-mock — the dual pattern

Every backend adapter has a **live** implementation (the real service) and a
**deterministic mock** behind one interface, mirroring `lib/agents/build`. When the
service is reachable it runs for real; when it is off (kind, or the service is
absent) it falls back to the mock and **labels the mode honestly** — never a silent
failure. So the same code path runs in `kind` and on a deploy.

| Concern | Live | Mock (kind / unit tests) |
|---|---|---|
| Ingest by type | Docling / Whisper-ASR / OCR-caption (`ingest/live.ts`) | deterministic chunker (`ingest/mocks.ts`) |
| Embeddings | LiteLLM `/v1/embeddings` (`embed.ts`) | unit-norm hash vector at the configured dim |
| Hybrid index | OpenSearch `files` index (`index-store.ts`) | in-process index (authoritative in kind) |
| Catalog + lineage | OpenMetadata REST (`catalog.ts`) | in-process ring (`lineage.ts`) |
| Connectors | Google Drive / MS Graph (`connectors-live.ts`) | fake drive (`connectors.ts`) |
| Approvals | shared queue + OpenSearch write-through | in-process queue |

## Modules

- **`asset-schema.ts`** — `asset.yaml`, the single source of truth per file. Re-uses
  the Data lifecycle; adds the file envelope: `kind`, `folder`, `tags`,
  `sensitivity`, `freshness`, `version`, `deepLink`, `provenance`, `relationships`,
  `storage` (object-store | in-place), `indexing` ({mode, representations,
  chunkHashes}). Two invariants enforced in one place each: the **object-store
  prefix** (private→`s3://files/<owner>/`, shared→`s3://files/<domain>/`) and
  **`restricted` ⇒ stored-only** (never indexed).
- **`store.ts`** — the in-process registry (mirrors `lib/data/store`): upload,
  browse (mine / domain / marketplace + folder & tag facets), preview, move, retag,
  docs, re-upload versioning, index opt-out, delete, search, and the
  promote/certify lifecycle. `canView` derives from the compiled DLS.
- **`dls.ts`** — the **document-level security** compiler. Turns a reader's delegated
  identity (id + domains) + each file's tier/visibility/grants into **one OpenSearch
  bool filter**, enforced **live** (AND-ed into the `files` `_search`) and **in
  kind** (`evaluateDls` over asset metadata). One policy source; a non-member is
  denied by the *filter*, not ad-hoc UI logic.
- **`promotion.ts`** — the light docs gate (owner + description + ≥1 tag).
- **`ingest/`** — the `apply → verify` interface + per-type adapters (mock + live).
- **`embed.ts`** — the shared embedder. **The k-NN dimension is never hardcoded** —
  it comes from `config.filesEmbedDim`, wired by Helm from `retrieval.knnDimension`
  (the single source). Same model + dim at index and query → comparable vectors.
- **`index-store.ts`** — the hybrid index (semantic cosine fused with lexical/exact),
  DLS-filtered; in-process for kind + a best-effort OpenSearch mirror with a
  `knn_vector` mapping whose dimension comes from config.
- **`index-pipeline.ts`** + **`pipeline-server.ts`** — ingest → chunk + hash → embed
  **only new/changed chunks** (content-hash cache) → index. Stored-only files are
  held but never indexed. The server boundary bootstraps + re-indexes on edits.
- **`connectors*.ts`** — Drive/OneDrive Read sources; sync-state (folder|drive,
  copy|reference, cursor); re-govern under our tiers; overnight first pass (Dagster
  best-effort) + live-incremental on content-hash change.
- **`retrieve.ts`** + **`retrieve-rank.ts`** — the agent **`files_retrieve`** tool:
  runs under the delegated identity (`assertDelegated`), OPA-gated, hybrid retrieve
  with the compiled DLS, rerank by trust/freshness/authority, cited
  text/transcript/caption passages (original openable on demand — vision → STACKIT
  only when flagged, never called here), Langfuse-traced.
- **`use-as.ts`** — "Use as" handoffs: → Knowledge (parsed text → tacit note) and
  → Data (guided Bronze import via the re-used `lib/data` primitives), each with OM
  lineage.

## Routes

`/api/files` (list, upload) · `/api/files/search` · `/api/files/[id]`
(get/patch/delete) · `…/version` · `…/promote` · `…/transition` · `…/lineage` ·
`…/use-as` · `/api/files/retrieve` (the agent tool) · `/api/files/connectors`
(+`/[id]`, `/[id]/sync`). A `file_promote` approval is applied in
`/api/agent/approvals` (the shared Governance queue).

## Config (Helm-wired)

`FILES_INDEX`, `FILES_EMBED_MODEL`, **`FILES_EMBED_DIM` (from
`retrieval.knnDimension` — single source)**, and the optional ingest service URLs
`DOCLING_URL` / `TRANSCRIBE_URL` / `OCR_URL` (empty = off → mock).

## Tests

`node --test 'lib/**/*.test.ts'`. The pure cores (schema, store, DLS, promotion,
lineage, ingest, embed, pipeline, connectors, rerank) are TDD-covered, including the
live adapters against fake `fetch` and the offline fallback.
