/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { adminCtx, fail } from '../_ctx';
import { listModels, getDefaults, getAssistantModelId, isAssistantExplicit } from '@tabs/admin/lib/models';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await adminCtx();
    return NextResponse.json({ models: listModels(), defaults: getDefaults(), assistant: getAssistantModelId(), assistantExplicit: isAssistantExplicit() });
  } catch (e) {
    return fail(e);
  }
}
