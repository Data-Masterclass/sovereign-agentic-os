/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { parseSystem, type System } from '../system-schema.ts';
import { resolveGrantedTools } from './os-tools.ts';
import { principalFor } from './runtime-contract.ts';
import { registerDurableGrantResolver } from '@/lib/infra/app-registry';
import { systemForScheduler } from '@/lib/agents/store';

/**
 * DURABLE GRANT REHYDRATION for agent-system principals.
 *
 * A Build writes an agent system's tool grants to OPA/LiteLLM AND mirrors them into
 * the in-memory app-registry `GRANTS` map. That map is wiped on every pod restart,
 * so after an os-ui redeploy the governed-tool endpoint (`/api/agents/tool`) would
 * fall through to the offline OPA mirror — which only knows the STATIC chart grants
 * — and DENY a dynamically-built agent's `query_data` until it is rebuilt (the
 * observed flip-flop).
 *
 * This resolver reads a `os-<systemId>` principal's granted tools back from the
 * DURABLE agent-system store (the SAME OpenSearch os-mirror `list_agent_systems`
 * reads), reproducing EXACTLY the vocabulary the Build granted:
 *   raw `grants.tools` ∪ their resolved MCP registry names ∪ enabled connection tools.
 * It NEVER broadens beyond what the persisted record already lists.
 *
 * FAIL-CLOSED: a non-agent principal, an unknown system, or a corrupt record
 * resolves to `null` — the app-registry then grants nothing and authorization falls
 * through to the existing OPA/deny path.
 *
 * Kept as its own tiny module so the store's grant-vocabulary can be reused without
 * an import cycle between the app-registry (dependency-free) and the store.
 */

const AGENT_PREFIX = 'os-';

/** The exact tool vocabulary a Build grants a system's principal (see live.ts). */
function grantedVocabulary(sys: System): string[] {
  const connections: string[] = [];
  for (const c of sys.grants.connections) {
    if (c.capability === 'Read' || c.capability === 'Write-approval' || c.capability === 'Write-bounded') {
      connections.push(`connection_${c.id}`);
    }
  }
  const resolved = resolveGrantedTools(sys).mcpNames;
  return [...new Set([...sys.grants.tools, ...resolved, ...connections])];
}

/**
 * Resolve an agent-system principal (`os-<systemId>`) to its persisted grant set,
 * or `null` when it is not a known agent-system principal (fail-closed).
 *
 * `systemLoader` is injected so this stays testable without the server-only store;
 * the default reads the durable `systemForScheduler(id)` record.
 */
export async function resolveAgentGrants(
  principal: string,
  systemLoader: (id: string) => { yaml: string } | null,
): Promise<string[] | null> {
  if (!principal.startsWith(AGENT_PREFIX)) return null;
  // `os-<id>[:node]` — the node suffix is authorization-irrelevant; the grant unit
  // is the system. Strip it so `principalFor(id)` and `os-<id>:node` both resolve.
  const systemId = principal.slice(AGENT_PREFIX.length).split(':')[0];
  if (!systemId) return null;
  // Belt-and-suspenders: only accept the canonical principal shape.
  if (principalFor(systemId) !== principal.split(':')[0]) return null;
  const rec = systemLoader(systemId);
  if (!rec) return null;
  let sys: System;
  try {
    sys = parseSystem(rec.yaml);
  } catch {
    return null; // corrupt stored source ⇒ grant nothing
  }
  return grantedVocabulary(sys);
}

/**
 * Register the durable resolver with the app-registry (server boundary). Wired from
 * the governed-tool route so a `os-<id>` principal's grants self-heal on the first
 * tool call after a restart. The pure {@link resolveAgentGrants} stays unit-testable
 * with an injected loader; this wiring binds it to the real durable store.
 */
export function registerDurableAgentGrantResolver(): void {
  registerDurableGrantResolver((principal) =>
    resolveAgentGrants(principal, (id) => systemForScheduler(id)),
  );
}
