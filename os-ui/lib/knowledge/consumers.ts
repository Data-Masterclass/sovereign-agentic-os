/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { Principal } from './store.ts';
import { listAllAppsInternal } from '../software/apps.ts';
import { listSystems, getSystem } from '../agents/store.ts';

/**
 * The LINEAGE guard for retiring a knowledge workflow: who still depends on it?
 *
 * A workflow is CONSUMED when another governed artifact wires it in as context:
 *   • an App records `use_knowledge` as a `consumes` edge, ref `knowledge:workflow:<id>`
 *     (the "context out" handover — see /api/knowledge/suggest + platform-mcp);
 *   • an Agent system grants it via `grants.knowledge[].id === <id>`.
 *
 * Mirrors `dependentsOf` in software/lifecycle.ts (the app-delete lineage guard):
 * a retire that would orphan a live dependency is BLOCKED. Apps are scanned through
 * the unscoped internal list (the same source that lifecycle's guard uses) so a
 * consuming app the caller can't otherwise see still counts; agent systems are read
 * through the caller's own governed view.
 */
export type KnowledgeConsumer = { by: string; kind: 'app' | 'agent_system' };

export async function knowledgeConsumers(
  workflowId: string,
  user: Principal,
): Promise<KnowledgeConsumer[]> {
  const ref = `knowledge:workflow:${workflowId}`;
  const out: KnowledgeConsumer[] = [];

  const apps = await listAllAppsInternal();
  for (const app of apps) {
    if (app.consumes.some((c) => c.kind === 'knowledge' && c.ref === ref)) {
      out.push({ by: app.id, kind: 'app' });
    }
  }

  const groups = listSystems(user, { includeArchived: true });
  for (const summary of [...groups.mine, ...groups.domain, ...groups.marketplace]) {
    // The summary omits grants; read the full system (view-scoped) to inspect them.
    const { system } = getSystem(summary.id, user);
    if (system.grants.knowledge.some((g) => g.id === workflowId)) {
      out.push({ by: summary.id, kind: 'agent_system' });
    }
  }

  return out;
}
