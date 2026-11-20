/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Restore the Agents tab's OPA state — each built system's grants and approval holds.
 * USER STORY: As the owner of an agent system I want it to keep its granted tools (and its
 *             write tools to stay held for approval) after OPA restarts or an admin recompiles
 *             the grants, without rebuilding the system.
 * ARCHITECTURE:
 *   - `agentGrants()` is the grant CONTRIBUTOR composed into OPA's whole `grants` document
 *     (`core/policy/opa-reconcile.ts publishGrantsDocument`), so no whole-document replace can
 *     drop a system's grants. `restoreRequiresApproval()` is the state SOURCE for the holds.
 *   - Both re-derive from the agent-system store with the Build's own `systemOpaGrants`.
 *   - `requires_approval` is one list shared with the chart seed: read, union, write (upsert),
 *     so the chart's entries are never removed. Registered from `instrumentation.ts`.
 */
import 'server-only';
import { publishOpa, readOpaData, type OpaWriteResult } from '@core/policy/opa-publish';
import type { OpaSourceResult } from '@core/policy/opa-reconcile';
import { ensureHydrated, listOpaGrantedSystemsInternal } from '@tabs/agents/lib/store';
import { systemOpaGrants } from '@tabs/agents/lib/build/live';

/** Union `tools` into OPA's `requires_approval` list (read → union → write). */
export async function mergeRequiresApproval(tools: string[]): Promise<OpaWriteResult> {
  const cur = await readOpaData('requires_approval');
  if (!cur.reachable) return { ok: false, status: null, detail: 'requires_approval: OPA unreachable' };
  const list = Array.isArray(cur.value) ? cur.value.map(String) : [];
  return publishOpa({ kind: 'data', path: 'requires_approval', value: [...new Set([...list, ...tools])] });
}

async function grantedSystems() {
  await ensureHydrated();
  return Promise.all(listOpaGrantedSystemsInternal().map((s) => systemOpaGrants(s.id, s.system)));
}

export async function agentGrants(): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const g of await grantedSystems()) out[g.principal] = g.tools;
  return out;
}

export async function restoreRequiresApproval(): Promise<OpaSourceResult> {
  const held = [...new Set((await grantedSystems()).flatMap((g) => g.held))];
  if (held.length === 0) return { ok: true, detail: 'no held tools' };
  const r = await mergeRequiresApproval(held);
  return r.ok ? { ok: true, detail: `${held.length} held tool(s)` } : { ok: false, detail: r.detail };
}
