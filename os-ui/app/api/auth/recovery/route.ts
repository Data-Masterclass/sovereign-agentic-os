/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/core/auth';
import { config } from '@/lib/core/config';
import { generateMasterKey, recoveryFileBody } from '@/lib/recovery';
import { recoveryConfigured, setRecoveryKey } from '@/lib/users';

export const dynamic = 'force-dynamic';

/** Admin: whether a recovery key has been configured (UI badge). */
export async function GET() {
  try {
    await requireAdmin();
    return NextResponse.json({ configured: await recoveryConfigured() });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}

/**
 * Admin: generate (or rotate) the master recovery key. The plaintext key + a
 * ready-to-save recovery file are returned EXACTLY ONCE; only a scrypt hash is
 * stored server-side. Generating again invalidates the previous key.
 */
export async function POST() {
  try {
    await requireAdmin();
    const key = generateMasterKey();
    await setRecoveryKey(key);
    const file = recoveryFileBody(key, config.deploymentTenant || 'sovereign-agentic-os');
    return NextResponse.json({ key, file, filename: 'sovereign-os-recovery-key.txt' });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
