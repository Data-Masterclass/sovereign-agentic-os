<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
-->
# Extensions / experimental — quarantine policy

This repo draws one boundary: **base** (the platform the OS cannot run without)
versus **extensions** (everything opt-in, bespoke, or still proving itself).
The goal is that someone landing on the repo can tell what is core, what is
optional, and where to look, in five minutes — without reading every file.

## Where the boundary lives

- `images/base/` vs `images/extensions/` — Docker build contexts.
- `charts/sovereign-agentic-os/templates/base/` vs `.../templates/extensions/`
  — Helm templates. Helm resolves templates by name, not by file path, so this
  split changes nothing about what renders; it only changes where a
  contributor looks.
- `os-ui/lib/experimental/` (see epic #15 / task #27) is the same idea applied
  to the OS UI's TypeScript modules — tracked separately, not covered by this
  file.

## What "base" means

Base is the smallest set of components the OS needs to boot and demonstrate
its core promise: a governed agent, talking to a governed model, over a
governed data path, with tracing. Concretely: `agent-runtime`, `os-ui`,
`mock-model`, `web-fetch`, `egress-proxy` (images), and their
matching chart templates (`agent-runtime`, `litellm`, `langfuse`, `mock-model`,
`opa`, `os-ui`, `postgres`, `clickhouse`, `valkey`, `object-storage`,
`network`, plus the
chart-wide `_helpers.tpl`, `priority-classes.yaml`, `ingress.yaml`,
`NOTES.txt`).

Base must build, type-check, and run **with every extension deleted**. That
invariant is what Phase 3 (epic #15) verifies end-to-end.

## What "extensions" means

Everything else: the analytics/BI stack (dbt, superset, cube, openmetadata,
metrics, trino, query-tool, dashboards-adjacent lakehouse jobs), the Science/ML layer (mlflow,
ml-agent, ml-trainer, science templates — Layer 4, off by default), developer
tooling (terminal-broker, workbench-broker, sandbox-shell, ci-builder,
code-server-workbench, software/forgejo CI), connectivity extras (docling,
connections, egress add-ons, hermes, wireguard), backups, mail, and the
sales-assistant vertical slice.

An extension being here is **not** a judgment that it's low-quality or
unmaintained — it means: not required for the base promise, and it can be
deleted or disabled without touching base's build/type-check/render/run.

## Re-entry checklist

A module moves from `extensions/` back into `base/` only when **all** of the
following hold:

1. **Load-bearing** — the OS cannot demonstrate a governed agent / governed
   model / governed data path / tracing without it.
2. **Universal** — every deployment needs it, no matter which extensions
   are enabled.
3. **Needed by a base-feature smoke** — one of the five base smokes
   (in-process agent path, pod agent path, generic HTTP MCP, Langfuse,
   LiteLLM) would fail without it, not just work worse.
4. **Still passes with all other extensions removed** — after the move,
   `helm template`, `tsc`, and `build` must still work. The move must not
   secretly depend on another extension.
5. **Needs sign-off** — moving something into base affects everyone's
   deployment size and complexity, so a maintainer must approve it first.

If it fails any of the five, it stays in `extensions/`. Before
moving something from `extensions/` into `base/`: confirm it meets all three
above, confirm it doesn't drag in another extension as a dependency, re-run
`helm template` to confirm output still matches expectations, and get a
maintainer to review the move before merging.
