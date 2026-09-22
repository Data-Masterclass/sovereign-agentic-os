/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { listDatasets, ensureHydrated as ensureDataHydrated } from '@/lib/experimental/data/store';
import { listWorkflows, ensureHydrated as ensureWorkflowsHydrated } from '@/lib/experimental/knowledge/store';
import { listPersonalKnowledge, ensureHydrated as ensurePersonalHydrated } from '@/lib/experimental/knowledge/personal-store';
import { listMetrics } from '@/lib/experimental/metrics/store';
import { listConnectionsForUser } from '@/lib/experimental/connections';
import { listFiles, ensureHydrated as ensureFilesHydrated } from '@/lib/experimental/files/store';
import { resolveManual } from '@/lib/experimental/knowledge/manual';
import { listPillars } from '@/lib/experimental/strategy/pillars';
import { listBets, ensureHydrated as ensureBetsHydrated } from '@/lib/experimental/bigbets/store';
import {
  MANUAL_SCOPES,
  planGrantId,
  manualLabel,
  manualAvailableScope,
  pillarPlanId,
  bigBetPlanId,
} from '@/lib/agents/plan-grants';
import type { CurrentUser } from '@/lib/core/auth';
import type { AgentGrantKind } from '@/lib/agents/assistant-suggestions';

/**
 * GRANTABLE-CONTEXT FEED for the Agents Grant-stage assistant — the artifacts of a given
 * kind the caller can actually SEE + grant, resolved through the SAME DLS/RLS-scoped
 * listers the `grants/available` route uses (personal + own-domain shared + marketplace).
 *
 * This is the server helper the Grant-stage chat prompt grounds on so the assistant only
 * ever proposes ids the caller may actually grant — never their whole catalog and never a
 * hallucinated id. It intentionally mirrors the route's per-kind logic (kept in sync by
 * hand rather than importing a Next route module here). NAME + id + scope only — no
 * content, no folder trees (the chat prompt just needs the grantable ids by name).
 */

export type GrantableItem = { id: string; name: string; scope: 'personal' | 'domain' | 'marketplace' };
export type GrantableGroups = Partial<Record<AgentGrantKind, GrantableItem[]>>;

function pillarScopeBucket(scope: 'personal' | 'tenant' | string): 'personal' | 'domain' | 'marketplace' {
  if (scope === 'personal') return 'personal';
  if (scope === 'tenant') return 'marketplace';
  return 'domain';
}

/** Resolve the grantable feed for ONE kind (the caller's DLS-scoped, grantable set). */
async function listOne(systemId: string, user: CurrentUser, kind: AgentGrantKind): Promise<GrantableItem[]> {
  const principal = { id: user.id, domains: user.domains, role: user.role };
  if (kind === 'data') {
    await ensureDataHydrated();
    const g = listDatasets(principal);
    return [
      ...g.mine.map((d) => ({ id: d.id, name: d.name, scope: 'personal' as const })),
      ...g.domain.map((d) => ({ id: d.id, name: d.name, scope: 'domain' as const })),
      ...g.marketplace.map((d) => ({ id: d.id, name: d.name, scope: 'marketplace' as const })),
    ];
  }
  if (kind === 'knowledge') {
    await Promise.all([ensureWorkflowsHydrated(), ensurePersonalHydrated()]);
    const wf = listWorkflows(principal);
    const pk = listPersonalKnowledge(principal);
    return [
      ...wf.mine.map((w) => ({ id: w.id, name: w.title, scope: 'personal' as const })),
      ...wf.domain.map((w) => ({ id: w.id, name: w.title, scope: 'domain' as const })),
      ...wf.marketplace.map((w) => ({ id: w.id, name: w.title, scope: 'marketplace' as const })),
      ...pk.mine.map((p) => ({ id: p.id, name: p.title, scope: 'personal' as const })),
      ...pk.domain.map((p) => ({ id: p.id, name: p.title, scope: 'domain' as const })),
      ...pk.marketplace.map((p) => ({ id: p.id, name: p.title, scope: 'marketplace' as const })),
    ];
  }
  if (kind === 'files') {
    await ensureFilesHydrated();
    const g = listFiles(principal);
    return [
      ...g.mine.map((f) => ({ id: f.id, name: f.name, scope: 'personal' as const })),
      ...g.domain.map((f) => ({ id: f.id, name: f.name, scope: 'domain' as const })),
      ...g.marketplace.map((f) => ({ id: f.id, name: f.name, scope: 'marketplace' as const })),
    ];
  }
  if (kind === 'metric') {
    await ensureDataHydrated();
    const g = listMetrics(principal);
    const nm = (m: { datasetName: string; name: string }) => `${m.datasetName} · ${m.name}`;
    return [
      ...g.mine.map((m) => ({ id: m.id, name: nm(m), scope: 'personal' as const })),
      ...g.domain.map((m) => ({ id: m.id, name: nm(m), scope: 'domain' as const })),
      ...g.marketplace.map((m) => ({ id: m.id, name: nm(m), scope: 'marketplace' as const })),
    ];
  }
  if (kind === 'operating-manual') {
    return MANUAL_SCOPES
      .filter((scope) => resolveManual(scope, user).canView)
      .map((scope) => ({ id: planGrantId(scope), name: manualLabel(scope), scope: manualAvailableScope(scope) }));
  }
  if (kind === 'strategy') {
    const pillars = await listPillars(user);
    return pillars.map((p) => ({ id: pillarPlanId(p.id), name: p.name, scope: pillarScopeBucket(p.scope) }));
  }
  if (kind === 'big-bets') {
    await ensureBetsHydrated();
    const bets = listBets(principal);
    return bets.map((b) => ({
      id: bigBetPlanId(b.id),
      name: b.name,
      scope: b.owner === user.id ? ('personal' as const) : b.crossDomain ? ('marketplace' as const) : ('domain' as const),
    }));
  }
  // connections
  const conns = await listConnectionsForUser(user);
  return conns.map((c) => ({
    id: c.id,
    name: c.name,
    scope: c.visibility === 'Certified' ? ('marketplace' as const) : c.visibility === 'Shared' ? ('domain' as const) : ('personal' as const),
  }));
}

/**
 * Resolve the grantable feed for several kinds at once. `systemId` is accepted for parity
 * with the route (and future per-system scoping); the feed itself is the caller's own
 * DLS-scoped grantable set. A kind whose lister throws is omitted (fail-soft), so one bad
 * store never sinks the whole grounding block.
 */
export async function listGrantableForKinds(
  systemId: string,
  user: CurrentUser,
  kinds: readonly AgentGrantKind[],
): Promise<GrantableGroups> {
  const out: GrantableGroups = {};
  await Promise.all(
    kinds.map(async (kind) => {
      try {
        out[kind] = await listOne(systemId, user, kind);
      } catch {
        out[kind] = [];
      }
    }),
  );
  return out;
}
