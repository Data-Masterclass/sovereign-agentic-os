/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/core/auth';
import { audit } from '@/lib/platform-admin/audit';
import { currentTenantId } from '@/lib/platform-admin/tenant';

// Each artifact store owns its own persistence discipline (parse/serialize +
// write-through to its durable mirror). We reuse the per-store `move*Domain`
// setter each one exposes — this module never reaches into a store's private
// state, it just drives the setters and audits the result.
import { moveArtifactsDomain } from '@/lib/core/artifacts';
import { moveDatasetsDomain, ensureHydrated as ensureDatasetsHydrated } from '@/lib/data/store';
import { moveDashboardsDomain, ensureHydrated as ensureDashboardsHydrated } from '@/lib/dashboards/store';
import { moveFilesDomain, ensureHydrated as ensureFilesHydrated } from '@/lib/files/store';
import { moveWorkflowsDomain, ensureHydrated as ensureWorkflowsHydrated } from '@/lib/knowledge/store';
import { movePersonalKnowledgeDomain, ensureHydrated as ensurePersonalKnowledgeHydrated } from '@/lib/knowledge/personal-store';
import { moveSystemsDomain, ensureHydrated as ensureSystemsHydrated } from '@/lib/agents/store';
import { moveModelsDomain, ensureModelsHydrated } from '@/lib/science/model-service';
import { movePillarsDomain, ensureHydrated as ensurePillarsHydrated } from '@/lib/strategy/pillars';
import { moveBetsDomain, ensureHydrated as ensureBetsHydrated } from '@/lib/bigbets/store';
import { moveConnectionsDomain } from '@/lib/connections/store';
import { moveAppsDomain, ensureHydrated as ensureAppsHydrated } from '@/lib/software/apps';

/**
 * Governance: reassign an artifact's owning DOMAIN — a superadmin-only mutation.
 *
 * Moving an artifact across domains changes WHO can see it (0.6.11's domain
 * scoping reads the stored `domain`), so this is a governed, audited, admin-only
 * operation. This module is the single seam that:
 *   • enumerates every artifact kind that carries a `domain` (the registry below),
 *   • moves ONE artifact (`moveArtifactDomain`) or bulk-assigns every UNASSIGNED
 *     record to a target domain (`moveUnassignedToDomain`), and
 *   • writes an audit entry for each action through the shared Platform-Admin log.
 *
 * The role gate is enforced HERE (throw 403) as well as at the route wrapper, so
 * the mechanism is safe no matter who calls it.
 */

/** A per-kind adapter: hydrate its store, then drive its own domain-move setter. */
type MoveSel = { id?: string; onlyUnassigned?: boolean };
type Adapter = {
  kind: string;
  /** Ensure the store's in-process cache is populated before the sweep/move. */
  ensure: () => Promise<void>;
  /** Apply the move to matching records; returns the ids actually moved. */
  move: (sel: MoveSel, target: string) => string[] | Promise<string[]>;
};

const NOOP = async (): Promise<void> => {};

/**
 * The registry of every store that carries a movable `domain`. Metrics are NOT
 * listed: a metric is a measure ON a dataset (lib/metrics/store derives read-only
 * from lib/data/store), so it has no domain of its own — it inherits the dataset's
 * and is covered transitively by the `dataset` adapter.
 */
export const ADAPTERS: Adapter[] = [
  { kind: 'artifact', ensure: NOOP, move: moveArtifactsDomain },
  { kind: 'dataset', ensure: ensureDatasetsHydrated, move: moveDatasetsDomain },
  { kind: 'dashboard', ensure: ensureDashboardsHydrated, move: moveDashboardsDomain },
  { kind: 'file', ensure: ensureFilesHydrated, move: moveFilesDomain },
  { kind: 'workflow', ensure: ensureWorkflowsHydrated, move: moveWorkflowsDomain },
  { kind: 'knowledge', ensure: ensurePersonalKnowledgeHydrated, move: movePersonalKnowledgeDomain },
  { kind: 'agent', ensure: ensureSystemsHydrated, move: moveSystemsDomain },
  { kind: 'model', ensure: ensureModelsHydrated, move: moveModelsDomain },
  { kind: 'pillar', ensure: ensurePillarsHydrated, move: movePillarsDomain },
  { kind: 'bigbet', ensure: ensureBetsHydrated, move: moveBetsDomain },
  { kind: 'connection', ensure: NOOP, move: moveConnectionsDomain },
  { kind: 'app', ensure: ensureAppsHydrated, move: moveAppsDomain },
];

/** The artifact kinds this governance move can reassign (for the UI's picker). */
export const MOVABLE_KINDS: string[] = ADAPTERS.map((a) => a.kind);

function requireAdmin(user: CurrentUser): void {
  if (user.role !== 'admin') {
    const err = new Error('Reassigning an artifact domain requires an admin');
    (err as Error & { status?: number }).status = 403;
    throw err;
  }
}

function requireTarget(target: string): string {
  const t = (target ?? '').trim();
  if (!t) {
    const err = new Error('A target domain is required');
    (err as Error & { status?: number }).status = 400;
    throw err;
  }
  return t;
}

/**
 * Move ONE artifact of a known `kind` to `targetDomain`. Admin-only + audited.
 * Throws 400 for an unknown kind / empty target, 404 when the id wasn't found.
 */
export async function moveArtifactDomain(
  user: CurrentUser,
  input: { kind: string; id: string; targetDomain: string },
): Promise<{ kind: string; id: string; targetDomain: string }> {
  requireAdmin(user);
  const target = requireTarget(input.targetDomain);
  const adapter = ADAPTERS.find((a) => a.kind === input.kind);
  if (!adapter) {
    const err = new Error(`Unknown artifact kind "${input.kind}"`);
    (err as Error & { status?: number }).status = 400;
    throw err;
  }
  await adapter.ensure();
  const moved = await adapter.move({ id: input.id }, target);
  if (moved.length === 0) {
    // Either the id doesn't exist or it was already in the target domain — the
    // caller asked to move a specific record, so surface a 404 for honesty.
    const err = new Error(`No ${input.kind} "${input.id}" to move (missing or already in "${target}")`);
    (err as Error & { status?: number }).status = 404;
    throw err;
  }
  audit({
    tenant: currentTenantId(),
    actor: user.id,
    role: user.role,
    action: 'artifact.domain.move',
    target: `${input.kind}:${input.id}`,
    detail: `Moved ${input.kind} "${input.id}" to domain "${target}"`,
  });
  return { kind: input.kind, id: input.id, targetDomain: target };
}

export type BulkMoveResult = {
  targetDomain: string;
  /** Per-kind ids moved. */
  counts: Record<string, number>;
  total: number;
};

/**
 * Bulk-assign EVERY unassigned artifact (empty/missing domain) across every kind
 * to `targetDomain`. Admin-only + audited. Records that already carry a domain
 * are left untouched. Returns per-kind counts.
 */
export async function moveUnassignedToDomain(user: CurrentUser, targetDomain: string): Promise<BulkMoveResult> {
  requireAdmin(user);
  const target = requireTarget(targetDomain);
  const counts: Record<string, number> = {};
  let total = 0;
  for (const adapter of ADAPTERS) {
    await adapter.ensure();
    const moved = await adapter.move({ onlyUnassigned: true }, target);
    counts[adapter.kind] = moved.length;
    total += moved.length;
  }
  audit({
    tenant: currentTenantId(),
    actor: user.id,
    role: user.role,
    action: 'artifact.domain.bulk-assign',
    target: `domain:${target}`,
    detail: `Assigned ${total} unassigned artifact(s) to domain "${target}" (${Object.entries(counts)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${k}:${n}`)
      .join(', ') || 'none'})`,
    guarded: true,
  });
  return { targetDomain: target, counts, total };
}
