/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * GET /api/platform-admin/models/roles — Platform → Models: the catalog (LiteLLM's, read-only) and the
 *      role mapping (the OS's), each role with its current model and that model's price per 1M tokens,
 *      the warnings (a role pointing at a model the catalog no longer has, drift the OS repaired) and a
 *      link to LiteLLM.
 * PUT  /api/platform-admin/models/roles — map the three roles ({ roles: { sovereign-strong, sovereign-worker,
 *      sovereign-embedding } }). Admin only, audited. A model that is not in the LiteLLM catalog is refused
 *      (422, `code: "unknown_catalog_model"`). The mapping is committed as `os/models.yml` in the platform
 *      repository and enforced at LiteLLM's `router_settings.model_group_alias` at once.
 *
 * ARCHITECTURE: logic in `core/models/role-reconcile.ts`; the real wiring in `role-live.ts`.
 */
import { NextResponse } from 'next/server';
import { adminCtx, fail } from '../../_ctx';
import { authorize } from '@core/infra/governed';
import { audit } from '@tabs/admin/lib/audit';
import { readGatewayCatalog } from '@core/models/gateway-catalog';
import { liveRoleIo } from '@core/models/role-live';
import { ROLE_NAMES, ModelMappingError } from '@core/models/role-mapping';
import { applyRoleMapping, lastRoleReport } from '@core/models/role-reconcile';

export const dynamic = 'force-dynamic';

const LITELLM_UI = '/tools/litellm/ui';

export async function GET() {
  try {
    await adminCtx();
    const io = liveRoleIo();
    let mapping = null;
    let fileError: string | undefined;
    try {
      mapping = await io.readMapping();
    } catch (e) {
      fileError = (e as Error).message;
    }
    const read = await readGatewayCatalog();
    const catalog = read.ok ? read.data.models : [];
    const byName = new Map(catalog.map((m) => [m.name, m]));
    const roles = mapping
      ? ROLE_NAMES.map((role) => {
          const model = mapping![role];
          const m = byName.get(model);
          return { role, model, inCatalog: Boolean(m), cost: m?.cost ?? null };
        })
      : [];
    const report = lastRoleReport();
    const warnings: string[] = [];
    if (fileError) warnings.push(`os/models.yml cannot be read: ${fileError}`);
    if (read.ok) for (const r of roles) if (!r.inCatalog) warnings.push(`${r.role} points at ${r.model}, which is not in the LiteLLM catalog (removed there?). Calls on ${r.role} fail until you map it to a model that exists — the OS does not fall back to another one.`);
    for (const d of report?.drift ?? []) warnings.push(`${d.alias} was changed in LiteLLM (${d.have} instead of ${d.want}); the OS put it back.`);
    if (report && !report.ok && report.error) warnings.push(`The last check could not complete: ${report.error}`);
    return NextResponse.json({
      mapping,
      roles,
      catalog: catalog.map((m) => ({ name: m.name, management: m.management, mode: m.mode, cost: m.cost, litellmModels: m.litellmModels })),
      source: read.ok ? 'litellm' : 'unavailable',
      ...(read.ok ? {} : { error: `LiteLLM could not be read: ${read.error}` }),
      report: report ? { at: report.at, state: report.state, ok: report.ok } : null,
      warnings,
      litellmUi: LITELLM_UI,
      ownedBy: { catalog: 'LiteLLM', roles: 'OS' },
    });
  } catch (e) {
    return fail(e);
  }
}

export async function PUT(req: Request) {
  try {
    const { user, tenant } = await adminCtx();
    const authz = await authorize(`user:${user.id}`, 'admin');
    if (!authz.allowed) return NextResponse.json({ error: `Policy did not allow this admin action (${authz.policy}).`, code: 'policy_denied' }, { status: 403 });
    let body: { roles?: unknown };
    try {
      body = (await req.json()) as { roles?: unknown };
    } catch {
      return NextResponse.json({ error: 'The request body must be JSON: {"roles": {"sovereign-strong": "…", "sovereign-worker": "…", "sovereign-embedding": "…"}}' }, { status: 400 });
    }
    let report;
    try {
      report = await applyRoleMapping(liveRoleIo(), body.roles, user.id);
    } catch (e) {
      if (e instanceof ModelMappingError) {
        return NextResponse.json({ error: e.message, code: e.code, ...(e.role ? { role: e.role } : {}), ...(e.model ? { model: e.model } : {}) }, { status: e.status });
      }
      throw e;
    }
    audit({
      tenant: tenant.id, actor: user.id, role: user.role, action: 'models.roles.set', target: 'models:roles',
      detail: `Mapped ${ROLE_NAMES.map((r) => `${r} → ${(body.roles as Record<string, string>)[r]}`).join(', ')} (os/models.yml, enforced at LiteLLM: ${report.state}).`,
      data: { roles: body.roles },
    });
    return NextResponse.json({ report: { at: report.at, state: report.state, ok: report.ok, missing: report.missing, drift: report.drift, ...(report.error ? { error: report.error } : {}) } });
  } catch (e) {
    return fail(e);
  }
}
