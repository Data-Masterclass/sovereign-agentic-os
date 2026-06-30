/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { adminCtx, fail } from '../_ctx';
import { recompile } from '../_compile';

export const dynamic = 'force-dynamic';

/** The compiled identity→OPA result (cross-linked from Governance's policy view). */
export async function GET() {
  try {
    await adminCtx();
    const { compiled, publish } = await recompile();
    return NextResponse.json({ compiled, publish });
  } catch (e) {
    return fail(e);
  }
}
