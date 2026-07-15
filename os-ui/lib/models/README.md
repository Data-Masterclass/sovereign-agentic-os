<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
-->
# Models

`lib/models/` is the model-context registry and role-resolution layer for the governed LLM
tier. It answers two questions the rest of the platform must never answer from memory:
*"how big is this model's context window?"* and *"which model alias handles this logical
role?"*. Both are driven entirely by configuration — no model name or tier is hardcoded in
application logic.

## Public API

### `context-windows.ts`

The single source of truth for context-window sizes.

- **`DEFAULT_MODEL_CONTEXTS`** — built-in window/reserved-output pairs for every
  known model alias. Conservative fallback via `UNKNOWN_MODEL_CONTEXT` (32 k / 2 k).
- **`parseOverrides(raw)`** — deserialises the `MODEL_CONTEXT_WINDOWS` env-var (JSON
  map of `modelId → { contextWindow, reservedOutput }`). Malformed entries are skipped
  with a warning; valid entries override defaults without a rebuild.
- **`modelContext(modelName, overrides?)`** — looks up the effective `ModelContext`
  for a given alias (env overrides win; fallback to built-in; fallback to unknown).
- **`inputBudget(modelName, overrides?)`** — `contextWindow − reservedOutput − safetyHeadroom`.
  Called by `lib/assistant` and the agent harness before every LLM call to prevent
  `ContextWindowExceededError`.
- **`safetyHeadroom(contextWindow)`** — internal headroom calculation (exposed for tests).

### `roles.ts`

Pure role-to-alias resolver. No network I/O.

- **`ModelRole`** type — `'reasoning' | 'standard' | 'tools' | 'embeddings'`
- **`roleDefault(role)`** — returns the compile-time default alias for a role.
- **`roleModel(role)`** — reads the matching `*_MODEL` env var; falls back to
  `roleDefault`. This is the function the rest of the platform calls.
- **`roleModels()`** — returns a `Record<ModelRole, string>` snapshot of all four
  current aliases (used by the Admin model-settings panel).
- **`MOCK_MODEL`** — sentinel alias (`'sovereign-mock'`) used in tests to skip live
  LLM calls.

Both files are unit-tested in `context-windows.test.ts` and `roles.test.ts`.

## Dependencies

- **`lib/core/config`** — for the env-var read helpers used in `roles.ts`.
- No `server-only` guard — both files are pure and may be imported from any layer
  (server, edge, tests). IO-less by design.

## Invariants

- **Models are never hardcoded.** Every reference in `lib/assistant`, `lib/agents`,
  and MCP routes goes through `roleModel(role)` or `inputBudget(modelName)`.
- **Admin override without rebuild.** Setting `MODEL_CONTEXT_WINDOWS` in the Helm
  values overrides context sizes immediately on pod restart; no image rebuild required.
- **Safe unknown-model fallback.** An unrecognised alias gets `UNKNOWN_MODEL_CONTEXT`
  (32 k / 2 k), logging a warning — never a crash or an oversized prompt.
