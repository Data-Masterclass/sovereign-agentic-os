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
 *   - WP-11: every source but the guardrails is `bundled`: the os-data bundle compiler
 *     (`core/policy/bundle.ts`) runs exactly these restores in capture mode, so the bundle holds
 *     what the pushes held. Two bundle-only documents join them: `os_data.users` (10 F7, with the
 *     attribute allow-list) and `os_data.app_grants` (10 F17). Each refuses (ok:false) while its
 *     store is not the durable snapshot, so a partial bundle is never compiled.
 *   - WP-30 (`OS_GUARDRAILS_DATA`): the guardrails are bundled too — `os_data.guardrails`, read from
 *     every domain repository's committed `guardrails.json` and decided by the chart's platform
 *     policy `os.guardrails`; no policy module is uploaded. Off = the interim module upload.
 */
import 'server-only';
import { registerGrantContributor, registerOpaStateSource } from '@core/policy/opa-reconcile';
import { recompile } from '@/app/api/platform-admin/_compile';
import { agentGrants, restoreRequiresApproval } from '@tabs/agents/lib/build/opa-state';
import { restoreDataGovernance } from '@tabs/data/lib/policy/opa-state';
import { recompileExposures } from '@tabs/connections/lib/exposure-policy';
import { restoreGuardrails } from '@tabs/knowledge/lib/guardrails-apply';
import { restoreGuardrailsFromGit } from '@tabs/knowledge/lib/guardrails-data';
import { compilerView, ensureHydrated as ensureDomainsHydrated } from '@tabs/admin/lib/domains';
import { knownDomains, listUsers, userDirectoryAuthoritative } from '@tabs/admin/lib/users';
import { appRegistryHydrated, listAllAppsInternal } from '@tabs/software/lib/apps';
import { normalizeAgentGrants } from '@tabs/software/lib/app-agent-grants';
import { config } from '@core/kernel/config';
import { publishOpa } from '@core/policy/opa-publish';
import { compileOsDataUsers } from '@core/policy/bundle';

async function restoreOsDataUsers() {
  if (!(await userDirectoryAuthoritative())) {
    return { ok: false, detail: 'user directory is not the durable snapshot (offline or unloaded) — os_data.users not compiled' };
  }
  const users = compileOsDataUsers(await listUsers(), config.abacAttributes);
  const r = await publishOpa({ kind: 'data', path: 'os_data/users', value: users });
  return r.ok ? { ok: true, detail: `${Object.keys(users).length} user(s)` } : { ok: false, detail: r.detail };
}

async function restoreAppGrants() {
  if (!(await appRegistryHydrated())) {
    return { ok: false, detail: 'app registry not hydrated — os_data.app_grants not compiled' };
  }
  const grants: Record<string, string[]> = {};
  for (const app of await listAllAppsInternal()) {
    const ids = normalizeAgentGrants(app.agents).map((g) => g.id);
    if (ids.length > 0) grants[app.id] = [...new Set(ids)].sort();
  }
  const r = await publishOpa({ kind: 'data', path: 'os_data/app_grants', value: grants });
  return r.ok ? { ok: true, detail: `${Object.keys(grants).length} app(s)` } : { ok: false, detail: r.detail };
}

export function registerOpaStateSources(): void {
  registerGrantContributor({ name: 'agent-systems', grants: agentGrants });
  registerOpaStateSource({
    name: 'grants',
    bundled: true,
    restore: async () => {
      const { publish } = await recompile();
      return { ok: publish.status === 'published', detail: publish.detail };
    },
  });
  registerOpaStateSource({
    name: 'governance',
    bundled: true,
    restore: () =>
      restoreDataGovernance(async () => {
        await ensureDomainsHydrated(knownDomains);
        return compilerView().filter((d) => !d.archived).map((d) => d.id);
      }),
  });
  registerOpaStateSource({
    name: 'exposures',
    bundled: true,
    restore: async () => {
      const r = await recompileExposures();
      return { ok: r.ok, detail: r.detail };
    },
  });
  registerOpaStateSource({ name: 'approval-holds', bundled: true, restore: restoreRequiresApproval });
  registerOpaStateSource({ name: 'os-data-users', bundled: true, restore: restoreOsDataUsers });
  registerOpaStateSource({ name: 'app-grants', bundled: true, restore: restoreAppGrants });
  if (config.guardrailsData) {
    // WP-30: committed OPA data from git, in the os-data bundle; the policy is a chart file.
    registerOpaStateSource({ name: 'guardrails', bundled: true, restore: () => restoreGuardrailsFromGit() });
  } else {
    // Interim (rollback): a policy module (PUT /v1/policies) plus its data, outside the bundle's roots.
    registerOpaStateSource({ name: 'guardrails', restore: restoreGuardrails });
  }
}
