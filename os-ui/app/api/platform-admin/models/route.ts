/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { adminCtx, fail } from '../_ctx';
import { getDefaults, getAssistantModelId, isAssistantExplicit } from '@tabs/admin/lib/models';

export const dynamic = 'force-dynamic';

/**
 * What the OS itself decides about models: the per-role defaults and the assistant pin. The model
 * LIST is LiteLLM's and is served live by `GET /api/agents/models` — this route no longer returns an
 * OS-held list (there is none), so there is nothing here that can disagree with the gateway.
 */
export async function GET() {
  try {
    await adminCtx();
    return NextResponse.json({ defaults: getDefaults(), assistant: getAssistantModelId(), assistantExplicit: isAssistantExplicit() });
  } catch (e) {
    return fail(e);
  }
}
