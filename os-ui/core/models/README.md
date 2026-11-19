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

### `capabilities.ts`

The single source of truth for **which models may be sent an image**. Sending an image is a
data-egress decision, so the answer is an explicit list of exact gateway aliases that an admin
controls — never a guess from the model's name.

- **`canReceiveImages(model)`** — THE decision. `true` only when `model` is exactly on the
  effective allowlist; unknown names, look-alikes (`my-vl-model`, `acme-vision`), other casing
  and role names are all `false`. **Pass the final LiteLLM `model_name` that goes into the
  request's `model` field** — after `roleModel(role)` and after any per-agent pin. A role name
  (`'reasoning'`) or an upstream id (`'openai/Qwen/…'`) is not an alias and returns `false`.
- **`DEFAULT_IMAGE_MODELS`** — the built-in list: `sovereign-reasoning`, `sovereign-vision`,
  `sovereign-premium`, `sovereign-reasoning-fast` (the aliases the STACKIT profile points at
  Qwen3-VL-235B on STACKIT, EU). `sovereign-default`, `sovereign-mock` and `sovereign-embed`
  are not on it.
- **`MODEL_IMAGE_ALLOWLIST`** (env; chart key `osUI.imageAllowlist`) — the admin override: a
  JSON array of model names that **replaces** the built-in list (not merged), so a model can be
  removed as well as added. Unset/blank → built-in list. `[]` → no model at all. Not JSON, not
  an array, or no usable name → built-in list plus a logged warning. There is no wildcard and
  no value that means "all models". Read on every lookup; a pod restart applies a chart change.
- **`imageAllowlist()`** / **`parseImageAllowlist(raw)`** — the list in force with its source
  (`default` | `override`) and any warnings, for display and tests.
- **`modelCapabilities(model)`** — `{ images: boolean }` for listings; built on `canReceiveImages`.

Shown read-only in Platform → Models & Providers ("Images: yes/no" per model) and returned by
`GET /api/agents/models` (`images` per row, `imageInput` for the list in force). **Nothing in
the model call path consults it yet.** It does not decide which *files* may be shown — a file's
sensitivity is a separate gate, and no setting here can open it. The list names aliases, not
endpoints: re-pointing a listed alias in the gateway config, or adding a router fallback from a
listed alias to an unlisted one, needs the list updated in the same change.

Unit-tested in `capabilities.test.ts` (including a source-level check that no second
image-capability function exists in `os-ui`); the chart wiring by
`scripts/check-image-allowlist-chart.mjs`.

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
- **An image is never sent on a guess.** Only `canReceiveImages` answers "may this model see an
  image?", by exact name against an explicit list. An unknown model is always `false`.
- **Safe unknown-model fallback.** An unrecognised alias gets `UNKNOWN_MODEL_CONTEXT`
  (32 k / 2 k), logging a warning — never a crash or an oversized prompt.
