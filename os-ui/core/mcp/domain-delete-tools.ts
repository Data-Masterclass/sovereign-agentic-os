/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    `delete_domain` — the admin-only MCP twin of Admin → Domains → Delete
 * USER STORY: As the tenant admin working through my own MCP session I want to read the full
 *             delete plan of a domain, and run it with the same confirmation and backup gate as
 *             the page.
 * ARCHITECTURE:
 *   - The SAME engine and the SAME component list as POST /api/platform-admin/domains/:id/delete
 *     (`core/kernel/domain-delete.ts` + `domainDeleteWiring()`, registered at boot by
 *     `domain-delete-sources.ts`). `dryRun` defaults to true. Admin re-checked in the engine.
 *   - OPA is asked first (`authorize`, GLUE-7); a deny refuses before anything is read.
 *   - Agent runs may never call it (AGENT_FORBIDDEN_TOOLS): deleting a domain is an operator act.
 */
import 'server-only';
import type { McpTool } from '@core/mcp/server';
import { fail, str, bool } from '@core/mcp/write-common';
import { authorize } from '@core/infra/governed';
import { deleteDomain, domainDeleteWiring, planLines } from '@core/kernel/domain-delete';

export const domainDeleteTools: McpTool[] = [
  {
    name: 'delete_domain',
    tab: 'governance',
    minRole: 'admin',
    description:
      'ADMIN ONLY. Delete a whole domain and every artifact in it, every owner\'s, through each ' +
      'component\'s own API (OS stores, Trino DROP TABLE with Polaris purge, the domain git repo + ' +
      'Dagster reload, OPA data, LiteLLM team and keys, members, the domain record). DRY RUN BY ' +
      'DEFAULT: returns the plan — every object per component that will be removed, and every ' +
      'object KEPT because something outside the domain still maps to it. A run needs ' +
      '`dryRun:false`, `confirm` equal to the domain id, and a Velero backup from the last 2 h (or ' +
      '`iHaveABackup:true`). Stops at the first failing step; re-run to resume. Every step is audited.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'The domain id.' },
        dryRun: { type: 'boolean', description: 'Default true: return the plan, remove nothing.' },
        confirm: { type: 'string', description: 'For a run: the domain id again.' },
        iHaveABackup: { type: 'boolean', description: 'Override the 2 h backup check (you state a backup exists).' },
      },
      required: ['domain'],
      examples: [{ domain: 'sales' }, { domain: 'sales', dryRun: false, confirm: 'sales' }],
    },
    call: async (user, args) => {
      if (user.role !== 'admin') fail('delete_domain requires an admin', 403);
      const decision = await authorize(`user:${user.id}`, 'admin');
      if (decision.policy === 'opa-deny') fail('OPA denied the admin scope', 403);
      const domain = str(args.domain).trim();
      if (!domain) fail('delete_domain needs `domain`', 400);
      const w = domainDeleteWiring();
      const report = await deleteDomain(
        domain,
        { dryRun: args.dryRun !== false, confirm: str(args.confirm) || undefined, iHaveABackup: bool(args.iHaveABackup) },
        {
          actor: { id: user.id, role: user.role, domains: user.allDomains },
          components: w.components(),
          backup: w.backup,
          audit: w.audit({ id: user.id, role: user.role }),
        },
      );
      return { ...report, summary: planLines(report.plan) };
    },
  },
];
