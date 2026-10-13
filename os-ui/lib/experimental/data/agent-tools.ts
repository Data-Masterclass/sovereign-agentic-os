/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import {
  type AgentScope,
  type Claims,
  assertOwnSandbox,
  delegate,
  propagate,
} from './identity.ts';
import { assertScopedToSelf } from './personal-lane.ts';

export type { AgentScope } from './identity.ts';

/**
 * The scoped data-agent tools (data-architecture-model.md §"The data agent's data
 * access"). Acting under the user's DELEGATED identity (R2), the agent reaches exactly
 * three scopes — nothing else, all through ONE governed engine (Trino):
 *
 *   • `personal`     → Trino AS the owner: only their OWN `personal_<uid>` tables.
 *   • `domain`       → Trino: their domain's assets + products (OPA-scoped).
 *   • `marketplace`  → Trino: only the products they've imported (OPA grants).
 *
 * SINGLE-ENGINE: the personal lane is no longer a separate DuckDB engine — a user's
 * own data is a physical Iceberg table read through the SAME governed Trino path, run
 * AS the owner so Trino's OPA plugin governs `personal_<uid>` ownership.
 *
 * Enforcement is layered: delegation (R2) + OPA (tool/domain) + Trino RLS (the
 * forwarded user, R3) + Cube securityContext (R3) + per-user prefix binding. Pure —
 * the backends are injected — so the scoping is unit-tested without live services; the
 * route wires the real governed executors.
 */

export type ToolKind = 'query' | 'metrics';
export type AgentToolInput = { scope: AgentScope; kind: ToolKind; sql?: string; query?: unknown };

export type Grid = { columns: string[]; rows: string[][] };

export type Executors = {
  authorize(principal: string, tool: string): Promise<{ allowed: boolean; policy: string }>;
  trinoQuery(sql: string, principal: string): Promise<Grid>;
  cubeQuery(query: unknown, securityContext: Record<string, unknown>): Promise<{ rows: Record<string, unknown>[] }>;
  trace(event: Record<string, unknown>): Promise<boolean>;
};

export type AgentToolResult = {
  ok: boolean;
  scope: AgentScope;
  policy: string;
  source: 'trino' | 'cube';
  columns?: string[];
  rows?: string[][];
  data?: Record<string, unknown>[];
  traced: boolean;
  error?: string;
};

export class AgentToolError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'AgentToolError';
    this.status = status;
  }
}

export async function runAgentTool(claims: Claims, input: AgentToolInput, ex: Executors): Promise<AgentToolResult> {
  // R2 — a user-bound, downscoped token (delegate() refuses a service account).
  const token = delegate(claims, input.scope);
  // R3 — the same identity for Trino (user+groups) + Cube (securityContext) + sandbox.
  const ids = propagate(token);

  const authz = await ex.authorize(token.sub, input.kind);
  if (!authz.allowed) {
    return { ok: false, scope: input.scope, policy: authz.policy, source: 'trino', traced: false, error: `OPA denied ${token.sub} → ${input.kind}` };
  }

  if (input.scope === 'personal') {
    if (input.kind !== 'query') throw new AgentToolError('the personal lane is a query lane — use a query, not metrics', 400);
    const sql = input.sql ?? '';
    assertScopedToSelf(sql); // never reach a governed mart from the personal lane
    assertOwnSandbox(token, ids.sandboxPrefix!); // only the caller's own prefix
    // SINGLE-ENGINE: personal data is a physical Iceberg table read AS the owner
    // (token.sub), so Trino's OPA plugin governs `personal_<uid>` ownership — the
    // same governed path domain/marketplace use, no separate personal engine.
    const grid = await ex.trinoQuery(sql, token.sub);
    const traced = await ex.trace({ principal: token.sub, scope: 'personal', tool: 'query', source: 'trino' });
    return { ok: true, scope: 'personal', policy: authz.policy, source: 'trino', columns: grid.columns, rows: grid.rows, traced };
  }

  // domain / marketplace — governed Trino (ad-hoc) or Cube (metrics) under the user.
  if (input.kind === 'query') {
    const grid = await ex.trinoQuery(input.sql ?? '', ids.trino.user); // principal → Trino OPA RLS
    const traced = await ex.trace({ principal: token.sub, scope: input.scope, tool: 'query', source: 'trino' });
    return { ok: true, scope: input.scope, policy: authz.policy, source: 'trino', columns: grid.columns, rows: grid.rows, traced };
  }
  const res = await ex.cubeQuery(input.query ?? {}, ids.cube.securityContext); // R3 securityContext
  const traced = await ex.trace({ principal: token.sub, scope: input.scope, tool: 'metrics', source: 'cube' });
  return { ok: true, scope: input.scope, policy: authz.policy, source: 'cube', data: res.rows, traced };
}
