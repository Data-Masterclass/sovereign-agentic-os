/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import 'server-only';
import { compileAndPublish, type CompiledPolicy, type PublishResult } from '@/lib/platform-admin/policy-compiler';
import { compilerView as domainView } from '@/lib/platform-admin/domains';
import { listAllowlist } from '@/lib/platform-admin/security';
import { enabledMap } from '@/lib/platform-admin/models';
import { compileUsers } from '@/lib/platform-admin/tenant-users';
import { currentTenantId } from '@/lib/platform-admin/tenant';

/**
 * Gather the one identity/structure source and compile it to OPA. Called after
 * any change to users, domains, egress, or models so the compiled rights land in
 * OPA (Governance's policy view then reflects them) — and returned so the UI can
 * show the compiled result + publish status even offline.
 */
export async function recompile(): Promise<{ compiled: CompiledPolicy; publish: PublishResult }> {
  const users = await compileUsers();
  return compileAndPublish({
    tenant: currentTenantId(),
    users,
    domains: domainView(),
    egressAllowlist: listAllowlist(),
    models: enabledMap(),
  });
}
