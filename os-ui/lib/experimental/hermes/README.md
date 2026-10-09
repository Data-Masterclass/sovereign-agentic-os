<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
-->
# Hermes

`lib/hermes/` models the autonomous Hermes-runtime integration — the Layer-1 self-hosted
agentic runtime (Hermes 4.x, vLLM-backed, gated off by default via `hermesEnabled` in
`lib/core/config`). **This module is pure** (no `server-only`, no network IO) so every
function is unit-tested directly without mocking a server.

## Wiring note

`lib/hermes` files are **not directly imported** by any other `lib/` module or
`app/api/` route. The runtime is wired at the config level (`lib/core/config`:
`hermesEnabled`, `hermesGatewayUrl`), as the `'hermes'` Runtime type in
`lib/agents/system-schema.ts`, and as the `hermes-gateway` system agent entry in
`lib/agents/system-agents.ts`. The provisioner profile this module builds is
serialised and sent to the Hermes gateway API by the agent routes
(`app/api/agents/route.ts`, `app/api/agents/systems/[id]/route.ts`) — not through an
import of this lib. **Do NOT delete**: these types and profile-building functions are the
spec artefact and machine-checked contract for the Hermes integration.

## Public API

### `model.ts`

- **`HermesModelTier`** type and **`HERMES_MODEL_TIERS`** — the three vLLM-backed
  Hermes 4.3 size tiers: 14B (CPU), 36B (GPU), 70B (GPU).
- **`DEFAULT_HERMES_MODEL`** — `'hermes-4-3-14b'`
- **`HERMES_WEIGHTS_LICENSE`** — the Llama 3.1 Community License notice (must accompany
  any weights redistribution check).
- **`selectHermesModel({ gpuPool })`** — picks the appropriate tier based on available
  hardware.
- **`validateToolCall(schema, call)`** / **`parseAndValidateToolCall(raw, schema)`** —
  schema-adherence validation for tool calls returned by the Hermes runtime.
  `ValidationResult`: `{ valid, errors }`.

### `provisioner.ts`

- **`buildHermesProfile(input)`** — converts `(user, domain, safetyPreset,
  availableTools)` into a fully-governed `HermesProfile` config ready for the gateway
  API. Applies egress allowlist, secrets-from-manager, kernel-isolated sandbox, and
  LiteLLM-only model access.
- **`toolsIncludeForPreset(preset, available)`** — returns the tool allow-list for a
  given `ProfilePreset` (`SafetyPreset | 'in-tab'`).
- **`assertNoBypass(profile)`** — returns `NoBypassViolation[]`. A non-empty array means
  the profile violates the no-bypass plan and must be rejected before gateway submission.
  This is the **machine-checkable form of the no-bypass invariant**.

### `mcp-binding.ts`

- **`bindPlatformMcp(input)`** — registers the Platform MCP as an HTTP MCP server
  inside a `HermesProfile`: HTTP transport, Ory OAuth / mTLS auth, `/api/mcp` URL.
- **`validateBinding(binding)`** — returns `BindingViolation[]`. Checks: HTTP transport,
  auth present, non-empty `tools.include`, correct URL pattern.
- **`visibleTools(offered, toolsInclude)`** — intersection of offered tools and the
  profile's allow-list.

### `sandbox.ts`

RuntimeClass selection logic (kata / gvisor) for the kernel-isolation layer.

### `skills.ts`

Hermes skills registry — the set of tools the Hermes runtime is permitted to call.

All five files have matching `*.test.ts` suites.

## Dependencies

- **`lib/governance`** — `SafetyPreset` type (import type only).
- No server IO, no `server-only` guard, no OpenSearch or HTTP calls.

## Invariants

- **`assertNoBypass` is the gate.** Any profile with a violation (raw model access,
  non-platform MCP, no egress allowlist, no sandbox) is refused before the HTTP call to
  the gateway.
- **Pure module.** No side effects at import time; no global state. Safe to import in
  tests, edge functions, and client build steps alike.
- **Gated off by default.** `hermesEnabled` is `false` in the default Helm values;
  the gateway URL is empty. Enabling Hermes is an explicit admin action.
