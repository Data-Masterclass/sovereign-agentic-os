<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
-->
# ADR 0003 — Durability via one shared OpenSearch mirror (`lib/os-mirror.ts`)

**Status:** Accepted (shipped in os-ui 0.1.32) · **Source:** `os-ui/lib/os-mirror.ts` + ~25 stores importing it

## Context

The OS UI keeps its registries (approvals, audit, artifacts, apps, agents,
datasets, knowledge, files, dashboards, users, domains, …) in in-process Maps —
fast and simple, but every pod roll wiped state. Per-store copy-pasted mirror
code had a fatal bug: a `_count` 404 on a fresh cluster (index not yet created)
was treated as "mirror down forever", so the index was never created and every
redeploy lost all artifacts written since the last roll.

## Decision

One shared mirror core, `lib/os-mirror.ts`, used by **every** user-facing
store. The in-process Map stays authoritative; the mirror is best-effort
write/delete-through to OpenSearch plus hydration on boot. Correct probe
semantics live in exactly one place: `_count` ok → healthy; `_count` 404 →
**create the index** (the bootstrap fix); network/5xx → unhealthy until a
lazy, throttled re-probe self-heals. An unreachable OpenSearch never throws
into a request — the store simply stays in-memory.

## Consequences

- Artifacts survive redeploys and node rolls; no re-seeding after a roll.
- OpenSearch must run on a **PVC** (not emptyDir) — see `docs/backups.md` and
  `deploy/opensearch-pvc-migration.sh`; without it the mirror itself is lost.
- Honest residual gap: writes dropped while the mirror is unhealthy are not
  replayed (in-process stays authoritative until the next roll), and the
  write-to-mirror race remains the only exposure window.
