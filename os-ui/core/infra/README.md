<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
-->
# Infra

`lib/infra` is the **governed spine and the sole gateway to every external
system**. It is the only layer permitted to call OPA, Trino, Cube, OpenSearch,
LiteLLM, MinIO, Forgejo, Kubernetes, the OS-mirror, Secrets Manager, and the
transactional mailer. All data-tool calls and agent tool calls flow through the
two `governed*.ts` spines here — the rest of the codebase may not bypass them.

## Golden path

Every data-tool invocation follows this sequence inside `governed.ts`:

1. **Authorize** — `authorize(user, action, resource)` calls OPA. The call is
   **fail-closed**: any non-200 response or network error denies the request.
2. **Execute** — `cubeLoad()` / `cubeScalar()` / `queryRun()` / `executeRun()`
   hit the appropriate backend (Cube API, query-tool, or Trino directly).
3. **Trace** — `trace()` records the decision, inputs, and outputs to Langfuse.
   Steps 1 and 3 are not optional and cannot be elided by callers.

Agent tool calls follow the same pattern through `agent-governed.ts`, with
additional graph-node context attached to each trace span.

## Public API

- **`governed.ts`** — the DATA tool spine (`server-only`): `authorize()`,
  `trace()`, `cubeLoad()`, `cubeScalar()`, `queryRun()`, `executeRun()`. The
  single import every data store uses instead of calling backends directly.
- **`agent-governed.ts`** — the AGENT tool spine for multi-node agent graphs.
  Same contract as `governed.ts` but carries graph-execution context.
- **`os-mirror.ts`** — dual in-process + OpenSearch durable-mirror pattern.
  Every tab store calls this to keep the global artifact index consistent.
- **`app-registry.ts`** — software app registry; maps app slugs to metadata and
  deployment manifests.
- **`capability-compiler.ts`** — compiles a connection's capability profile into
  an OPA bundle. Called by the connections store on every capability update.
- **`secrets.ts`** — Kubernetes Secret read/write client. The only code allowed
  to hold a raw credential value (transiently, never logged).
- **`k8s.ts`** — Kubernetes API client scoped to the platform namespace; used for
  job dispatch and pod status queries.
- **`identity-server.ts`** — server-side helpers for resolving users and domain
  memberships from the identity store.
- **`mailer.ts`** — pluggable transactional mailer: prefers Microsoft Graph,
  falls back to SMTP, no-ops when neither is configured.
- **`tool-proxy.ts`** — reverse proxy for embedded console tools (Superset,
  OpenSearch Dashboards). Injects session cookies and rewrites URLs.
- **`tool-sso-langfuse.ts`** — injects a short-lived Langfuse SSO session so the
  Langfuse UI opens authenticated without exposing credentials.
- **`context/`** — per-request context helpers (request-id, user, domain).

Test coverage: `governed-failclosed.test.ts`, `governed-execute.test.ts`, and
`governed-rls-scrub.test.ts` are the policy-correctness regression suite; they
must pass on every PR that touches `governed.ts`.

## Invariants

- **OPA is fail-closed.** A timeout, network error, or unexpected status from OPA
  is treated as a denial — never as a grant.
- **Secrets are transient.** `secrets.ts` returns raw values only to the calling
  frame; callers must not store them in logs, traces, or database records.
- **One spine per call type.** Data calls go through `governed.ts`; agent calls
  go through `agent-governed.ts`. Bypassing either breaks the audit trail.
- **Mirror writes are synchronous.** Every artifact mutation writes to the
  OS-mirror before returning `200` — the mirror is not eventually consistent.

## Dependencies

| Imports from | — |
|---|---|
| Internal `lib/` | `lib/core` only |
| External | OPA, Cube, Trino, OpenSearch, LiteLLM, MinIO, Forgejo, k8s API |

`lib/core` must **not** import `lib/infra`. Tab stores import `lib/infra` and
`lib/core`; they do not call external services directly.
