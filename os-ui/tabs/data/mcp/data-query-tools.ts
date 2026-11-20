/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { McpTool } from '@core/mcp/server';
import { fail, str } from '@core/mcp/write-common';
import { authorize, queryRun, trace } from '@core/infra/governed';
import { routeFor } from '@core/infra/trino-source';
import { ARTIFACT_OUTPUT_SCHEMA, tableArtifact } from '@core/runtime/chat-artifacts';
import { readPrincipalFor } from '@tabs/data/lib/store-fqn';
import { sanitizeSingleStatement } from '@tabs/data/lib/sql-guard';
import { datasetVersionReadTools } from '@tabs/data/mcp/dataset-version-tools';

/** #28: extracted from server.ts so it stops statically importing
 *  `@/lib/experimental/data/{store-fqn,sql-guard}` (data tab, non-base). */
export const dataQueryTools: McpTool[] = [
  {
    name: 'query_data',
    description:
      'Run a read-only SQL query over the governed Iceberg marts. The SQL runs on Trino, so write Trino SQL (not PostgreSQL or T-SQL): e.g. listagg(x, \', \') WITHIN GROUP (ORDER BY x) for string aggregation, LIMIT n, and the fully qualified table name from get_dataset → `queryable.fqn`. OPA-authorized on your domain and Langfuse-audited, exactly like the UI data tool. A Trino SQL mistake returns code `sql_error` with a hint.',
    minRole: 'creator',
    tab: 'data',
    inputSchema: {
      type: 'object',
      properties: { sql: { type: 'string', description: 'One read-only statement in Trino SQL.' } },
      required: ['sql'],
    },
    // C7 — the typed payload the Ask-the-OS drawer renders and an external MCP client
    // validates. C5 is the point of it: the query-tool's `truncated` / `rowLimit` /
    // `message` travel STRUCTURALLY to the surface, so a clipped result cannot reach the
    // user as a confident total merely because the model forgot to mention the clipping.
    outputSchema: ARTIFACT_OUTPUT_SCHEMA,
    artifacts: (result, args) => [
      tableArtifact(result, {
        // C6 — labelled ad-hoc: the aggregation and the joins here were chosen by whoever
        // wrote the SQL, not by the governed metric definition everyone else reads.
        source: 'ad-hoc-sql',
        sql: typeof args.sql === 'string' ? args.sql : undefined,
        title: 'query_data (ad-hoc SQL)',
      }),
    ],
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
      const result = await queryRun(sql, trinoPrincipal, routeFor(user, 'data-query'));
      const traced = await trace({ principal: trinoPrincipal, tool: 'query', input: sql, output: result.rows });
      return { principal: trinoPrincipal, authorized: true, policy: authz.policy, traced, ...result };
    },
  },
  // WP-37: a dataset's DATA versions (its Iceberg snapshots), read as the caller.
  ...datasetVersionReadTools,
];
