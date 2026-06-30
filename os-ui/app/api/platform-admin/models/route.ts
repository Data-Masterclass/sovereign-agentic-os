/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { adminCtx, fail } from '../_ctx';
import { listModels, getDefaults, listProviderKeys, registerProviderKey } from '@/lib/platform-admin/models';
import { putSecret, secretFingerprint } from '@/lib/secrets';
import { audit } from '@/lib/platform-admin/audit';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await adminCtx();
    return NextResponse.json({ models: listModels(), defaults: getDefaults(), keys: listProviderKeys() });
  } catch (e) {
    return fail(e);
  }
}

/**
 * Add a provider key. The raw value is written ONCE to the secrets manager
 * server-side; this route keeps only the resulting REFERENCE + a non-reversible
 * fingerprint and returns those. The raw value is never stored in the catalog,
 * returned, or logged. (Secrets-never-raw invariant.)
 */
export async function POST(req: Request) {
  try {
    const { user, tenant } = await adminCtx();
    const body = await req.json();
    const provider = String(body?.provider ?? '').trim();
    const rawValue = String(body?.value ?? '');
    if (!provider || !rawValue) return NextResponse.json({ error: 'A provider and a key value are required' }, { status: 400 });

    const ref = putSecret(`provider-${provider}`, 'api_key', rawValue); // raw value goes ONLY here
    const fingerprint = secretFingerprint(ref);
    const pk = registerProviderKey({ provider, ref, fingerprint, addedBy: user.id });

    audit({ tenant: tenant.id, actor: user.id, role: user.role, action: 'model.provider-key', target: `provider:${provider}`, detail: `Stored ${provider} key via secrets manager (${fingerprint}); raw value never surfaced` });
    return NextResponse.json({ key: pk }, { status: 201 });
  } catch (e) {
    return fail(e);
  }
}
