/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { adminCtx, fail } from '../_ctx';
import { authenticate } from '@core/kernel/auth';
import { authorize } from '@core/infra/governed';
import { audit } from '@tabs/admin/lib/audit';
import { runKeyOp } from '@tabs/admin/lib/encryption-keys';
import * as km from '@core/infra/key-manager';
import { PROVIDERS } from '@core/infra/key-providers';
import { ensureSecretsHydrated, reloadSecretKeys, secretStoreStatus } from '@core/infra/secrets';

export const dynamic = 'force-dynamic';

/**
 * Platform → Encryption keys (and the install wizard's key step). GET: the active
 * provider, its health (`?health=1` runs a real round trip), recovery-key state, data keys, history
 * — never key material. POST: one operation (tabs/admin/lib/encryption-keys.ts): every one requires
 * the admin's password again and is audited.
 */
export async function GET(req: Request) {
  try {
    await adminCtx();
    await ensureSecretsHydrated();
    const store = secretStoreStatus();
    const managed = km.keyManagerStatus() !== 'unconfigured';
    if (managed && new URL(req.url).searchParams.get('health') === '1') await km.checkProviderHealth();
    return NextResponse.json({
      managed,
      // Local dev runs the in-memory store: nothing durable to protect, so no key management.
      note: managed ? '' : 'Key management applies to the durable credential store (a cluster). This process uses the in-memory store.',
      store: { status: store.status, count: store.count, sealedUnderPreviousKey: store.sealedUnderPreviousKey, unreadable: store.unreadable },
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
    // FATAL governance decision before any effect (adminCtx's OPA check is report-only): every key
    // operation is an admin action OPA must allow — and it is audited as denied when OPA says no.
    const authz = await authorize(`user:${user.id}`, 'admin');
    if (!authz.allowed) {
      audit({ tenant: tenant.id, actor: user.id, role: user.role, action: 'encryption-keys.denied', target: 'connection-keys', detail: `OPA: ${authz.policy}`, result: 'denied' });
      return NextResponse.json({ error: 'forbidden', policy: authz.policy }, { status: 403 });
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
