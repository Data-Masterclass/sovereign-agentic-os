/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The wiring of every tab's OPA restore source into the kernel's OPA state reconciler.
 * USER STORY: As an operator I want one list of everything os-ui pushes into OPA at runtime, so
 *             an OPA restart restores all of it and nothing is forgotten.
 * ARCHITECTURE:
 *   - Lives beside `instrumentation.ts` (the one place allowed to know both the kernel and the
 *     tabs); `instrumentation.ts` calls it at boot and the real-OPA integration test calls it too,
 *     so the test exercises the wiring that ships.
 *   - Runtime OPA writers covered (design 04 §3.2): W1 admin grants (`grants`), agent-system grants
 *     (grant contributor) and approval holds (`requires_approval`), W2 per-user role grants are
 *     superseded by W1's whole document, W3 data governance tables + principals (every domain's
 *     self-principal and the user roster), W4 exposure tables, W5 knowledge guardrail policies.
 *     Approved access grants are composed by the kernel itself. Promote releases are transient
 *     (pushed and withdrawn around one CTAS) and deliberately not restored.
 */
import 'server-only';
import { registerGrantContributor, registerOpaStateSource } from '@core/policy/opa-reconcile';
import { recompile } from '@/app/api/platform-admin/_compile';
import { agentGrants, restoreRequiresApproval } from '@tabs/agents/lib/build/opa-state';
import { restoreDataGovernance } from '@tabs/data/lib/policy/opa-state';
import { recompileExposures } from '@tabs/connections/lib/exposure-policy';
import { restoreGuardrails } from '@tabs/knowledge/lib/guardrails-apply';
import { compilerView, ensureHydrated as ensureDomainsHydrated } from '@tabs/admin/lib/domains';
import { knownDomains } from '@tabs/admin/lib/users';

export function registerOpaStateSources(): void {
  registerGrantContributor({ name: 'agent-systems', grants: agentGrants });
  registerOpaStateSource({
    name: 'grants',
    restore: async () => {
      const { publish } = await recompile();
      return { ok: publish.status === 'published', detail: publish.detail };
    },
  });
  registerOpaStateSource({
    name: 'governance',
    restore: () =>
      restoreDataGovernance(async () => {
        await ensureDomainsHydrated(knownDomains);
        return compilerView().filter((d) => !d.archived).map((d) => d.id);
      }),
  });
  registerOpaStateSource({
    name: 'exposures',
    restore: async () => {
      const r = await recompileExposures();
      return { ok: r.ok, detail: r.detail };
    },
  });
  registerOpaStateSource({ name: 'approval-holds', restore: restoreRequiresApproval });
  registerOpaStateSource({ name: 'guardrails', restore: restoreGuardrails });
}
