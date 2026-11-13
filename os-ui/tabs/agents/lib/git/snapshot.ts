/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    Agent-project snapshot — the pure data view of a domain the git generator reads
 * USER STORY: As a maintainer I want generation to be a pure function of OS state, so the same
 *             state always yields the same `agents/**` tree (so an unchanged save commits nothing)
 *             and the generator is testable with literal fixtures, no store and no cluster.
 * ARCHITECTURE:
 *   - `AgentProjectSnapshot` = the domain's LIVE (non-archived) systems, each as the fields that
 *     belong in a repository: identity, scope, the canonical `system.yaml`, the operational
 *     switches an engineer would commit (running, schedule, disabled agents, folder) and the
 *     last BUILD outcome. Deliberately absent: `activity`, `runCheckpoint`, `lastRun`,
 *     `lastActivity` — run artefacts (and `lastBuild.litellmKeyRef`, a secret reference).
 *   - `projectSnapshot(domain)` is the ONLY impure step (it reads the store). `generateAgentFiles`
 *     never touches the store.
 *   - Systems are sorted by id, so every downstream path and file is byte-stable.
 */
import { systemsForProject, type SystemRecord } from '@tabs/agents/lib/store';

export type SnapshotSystem = {
  id: string;
  name: string;
  owner: string;
  visibility: SystemRecord['visibility'];
  origin: SystemRecord['origin'];
  sourceId?: string;
  running: boolean;
  schedule: SystemRecord['schedule'];
  disabledAgents: string[];
  folder: string;
  /** The canonical source — the ONE file everything else is derived from. */
  yaml: string;
  /** Highest recorded version of `yaml` (0 when the source was never versioned). */
  version: number;
  /** Last BUILD outcome only (never the key reference, never a run). */
  lastBuild?: { ok: boolean; at: number };
};

export type AgentProjectSnapshot = {
  domain: string;
  /** Sorted by `id`. */
  systems: SnapshotSystem[];
};

/** Project one store record onto the committable fields (pure — used by the hook's capture too). */
export function snapshotSystem(rec: SystemRecord, version: number): SnapshotSystem {
  return {
    id: rec.id,
    name: rec.name,
    owner: rec.owner,
    visibility: rec.visibility,
    origin: rec.origin,
    ...(rec.sourceId ? { sourceId: rec.sourceId } : {}),
    running: rec.running,
    schedule: rec.schedule,
    disabledAgents: [...rec.disabledAgents].sort(),
    folder: rec.folder,
    yaml: rec.yaml,
    version,
    ...(rec.lastBuild ? { lastBuild: { ok: rec.lastBuild.ok, at: rec.lastBuild.at } } : {}),
  };
}

/**
 * Read the store (unscoped, server-side) into a pure snapshot. `captured` is the read taken
 * SYNCHRONOUSLY in the writer's turn (the commit hook passes it) so two rapid writes cannot both
 * snapshot the later state and mis-attribute the first commit — the same rule as the data side.
 */
export function projectSnapshot(domain: string, captured?: SnapshotSystem[]): AgentProjectSnapshot {
  const systems = captured ?? systemsForProject(domain).map(({ rec, version }) => snapshotSystem(rec, version));
  return { domain, systems: [...systems].sort((a, b) => a.id.localeCompare(b.id)) };
}
