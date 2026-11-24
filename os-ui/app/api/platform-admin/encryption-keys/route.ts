/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { adminCtx, fail } from '../_ctx';
import { recompile } from '../_compile';
import { authenticate } from '@core/kernel/auth';
import { authorize } from '@core/infra/governed';
import { audit } from '@tabs/admin/lib/audit';
import { runKeyOp } from '@tabs/admin/lib/encryption-keys';
import { runtimeTokenOk } from '@tabs/agents/lib/build/runtime-auth';
import * as km from '@core/infra/key-manager';
import { PROVIDERS } from '@core/infra/key-providers';
import { ensureSecretsHydrated, reloadSecretKeys, secretStoreStatus } from '@core/infra/secrets';

export const dynamic = 'force-dynamic';

/**
 * Platform → Encryption keys (and the install wizard's key step).
 *
 * GET (admin session): the active provider, its health (`?health=1` runs a real round trip),
 * recovery-key state, data keys, history — never key material.
 * GET `?summary=1` with the shared SERVICE BEARER (AGENT_RUNTIME_TOKEN — the one os-ui already
 * validates for its CronJob service paths): only `{ status, provider, recovery }` from the record this
 * process VERIFIED (HMAC) plus the unknown-key count. This is what the prod release smoke test reads,
 * IN-CLUSTER (`kubectl exec` into os-ui → 127.0.0.1) — the unauthenticated /api/health says only
 * ok/degraded.
 *
 * POST: one operation (tabs/admin/lib/encryption-keys.ts) — a FATAL OPA decision first, then the
 * admin's password again, then audit. FIRST-ADMIN RACE: a brand-new admin (the install wizard runs
 * right after the bootstrap account is created) may not be in OPA's data yet — the compiled grants
 * reach OPA when an admin route recompiles. So on `opa-deny` this route recompiles the policy from the
 * one identity source (exactly what the other Platform-Admin routes do on every change; the caller is
 * already requireAdmin-verified) and asks OPA once more. Still denied → 403, audited, and the UI says why.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    if (url.searchParams.get('summary') === '1' && runtimeTokenOk(req.headers.get('authorization'))) {
      await ensureSecretsHydrated();
      return NextResponse.json({ connectionKeys: km.keyHealthSummary(), unknownKey: secretStoreStatus().unknownKey }, { headers: { 'cache-control': 'no-store' } });
    }
    await adminCtx();
    await ensureSecretsHydrated();
    const store = secretStoreStatus();
    const managed = km.keyManagerStatus() !== 'unconfigured';
    if (managed && url.searchParams.get('health') === '1') await km.checkProviderHealth();
    return NextResponse.json({
      managed,
      // Local dev runs the in-memory store: nothing durable to protect, so no key management.
      note: managed ? '' : 'Key management applies to the durable credential store (a cluster). This process uses the in-memory store.',
      store: { status: store.status, count: store.count, sealedUnderPreviousKey: store.sealedUnderPreviousKey, unreadable: store.unreadable, unknownKey: store.unknownKey },
      summary: km.keyHealthSummary(),
      view: managed ? km.keyView() : null,
      providers: PROVIDERS,
    }, { headers: { 'cache-control': 'no-store' } });
  } catch (e) {
    return fail(e);
  }
}

export async function POST(req: Request) {
  try {
    const { user, tenant } = await adminCtx();
    // FATAL governance decision before any effect (adminCtx's OPA check is report-only).
    let authz = await authorize(`user:${user.id}`, 'admin');
    if (!authz.allowed && authz.policy === 'opa-deny') {
      // First-admin race (see the header): publish the compiled grants, then ask once more.
      await recompile();
      authz = await authorize(`user:${user.id}`, 'admin');
    }
    if (!authz.allowed) {
      audit({ tenant: tenant.id, actor: user.id, role: user.role, action: 'encryption-keys.denied', target: 'connection-keys', detail: `OPA: ${authz.policy}`, result: 'denied' });
      return NextResponse.json({ error: 'forbidden', code: 'opa-denied', policy: authz.policy }, { status: 403 });
    }
    await ensureSecretsHydrated();
    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const r = await runKeyOp({ user, tenant }, body, { authenticate, audit, km, reload: reloadSecretKeys });
    return NextResponse.json(r.body, { status: r.status, headers: { 'cache-control': 'no-store' } });
  } catch (e) {
    return fail(e);
  }
}
