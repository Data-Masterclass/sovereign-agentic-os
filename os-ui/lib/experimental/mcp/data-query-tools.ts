/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { McpTool } from '@/lib/mcp/server';
import { fail, str } from '@/lib/mcp/write-common';
import { authorize, queryRun, trace } from '@/lib/infra/governed';
import { readPrincipalFor } from '@/lib/experimental/data/store-fqn';
import { sanitizeSingleStatement } from '@/lib/experimental/data/sql-guard';

/** #28: extracted from server.ts so it stops statically importing
 *  `@/lib/experimental/data/{store-fqn,sql-guard}` (data tab, non-base). */
export const dataQueryTools: McpTool[] = [
  {
    name: 'query_data',
    description:
      'Run a read-only SQL query over the governed Iceberg marts (Trino). OPA-authorized on your domain and Langfuse-audited, exactly like the UI data tool.',
    minRole: 'creator',
    tab: 'data',
    inputSchema: {
      type: 'object',
      properties: { sql: { type: 'string', description: 'A read-only SQL statement.' } },
      required: ['sql'],
    },
    call: async (user, args) => {
      const rawSql = str(args.sql).trim();
      if (!rawSql) fail('query_data needs a `sql` string', 400);
      // Normalize a model's trailing `;` (Trino rejects a bare separator) before the
      // governed read runs; a surviving internal `;` is a real multi-statement request
      // → a clear, actionable error, NOT a Trino syntax stack trace.
      const sanitized = sanitizeSingleStatement(rawSql);
      if (!sanitized.ok) fail(sanitized.reason, 400);
      const sql = sanitized.sql;
      // TWO distinct principals here:
      //  - TOOL-ACCESS authz (`agentic.authz`) is granted by DOMAIN/agent-key —
      //    `data.grants[<domain>]` holds `query` — so the access gate runs on the
      //    caller's domain principal (a uid has no grant of its own).
      //  - The TRINO SESSION USER (data-governance principal for row/column + the
      //    personal-lane `is_owned_personal` hard-deny) MUST be the OWNER uid when the
      //    SQL touches the caller's OWN personal lane (`personal_<uid>.*`) — even the
      //    owner is DENIED reading their own personal table under the domain principal.
      //    Every other read stays on the domain principal so cross-domain governance is
      //    intact. Derived server-side from session + SQL text (same rule preview/profile
      //    use), never from the request body; only the caller's OWN lane flips it.
      const domainPrincipal = user.domains[0] ?? user.id;
      const trinoPrincipal = readPrincipalFor(sql, { id: user.id, domains: user.domains });
      const authz = await authorize(domainPrincipal, 'query');
      if (!authz.allowed) fail(`OPA denied ${domainPrincipal} → query (${authz.policy})`, 403);
      const result = await queryRun(sql, trinoPrincipal);
      const traced = await trace({ principal: trinoPrincipal, tool: 'query', input: sql, output: result.rows });
      return { principal: trinoPrincipal, authorized: true, policy: authz.policy, traced, ...result };
    },
  },
];
