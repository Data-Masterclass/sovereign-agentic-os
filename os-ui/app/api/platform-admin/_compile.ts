/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import 'server-only';
import { compileAndPublish, type CompiledPolicy, type PublishResult } from '@tabs/admin/lib/policy-compiler';
import { compilerView as domainView, ensureHydrated as ensureDomainsHydrated } from '@tabs/admin/lib/domains';
import { listAllowlist } from '@tabs/admin/lib/security';
import { enabledMap } from '@tabs/admin/lib/models';
import { compileUsers } from '@tabs/admin/lib/tenant-users';
import { currentTenantId } from '@tabs/admin/lib/tenant';
import { knownDomains } from '@tabs/admin/lib/users';

/**
 * Gather the one identity/structure source and compile it to OPA. Called after
 * any change to users, domains, egress, or models so the compiled rights land in
 * OPA (Governance's policy view then reflects them) — and returned so the UI can
 * show the compiled result + publish status even offline.
 */
export async function recompile(): Promise<{ compiled: CompiledPolicy; publish: PublishResult }> {
  // Ensure the domain registry reflects the tenant's real domains before it feeds
  // the compiler (so grants are compiled for the derived domains, not an empty set).
  await ensureDomainsHydrated(knownDomains);
  const users = await compileUsers();
  return compileAndPublish({
    tenant: currentTenantId(),
    users,
    domains: domainView(),
    egressAllowlist: listAllowlist(),
    models: enabledMap(),
  });
}
