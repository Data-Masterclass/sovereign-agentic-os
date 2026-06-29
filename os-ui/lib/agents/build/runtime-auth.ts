/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { timingSafeEqual } from 'node:crypto';
import { config } from '@/lib/config';

/**
 * Service-to-service auth for the runtime-facing endpoints (the governed-tool
 * chokepoint and the scheduled-run trigger). The caller is the agent-runtime Pod
 * or a schedule CronJob — NOT a browser user — so it presents the shared runtime
 * bearer instead of a session cookie. Constant-time compared; server-only.
 */
export function runtimeTokenOk(authHeader: string | null): boolean {
  const expected = config.agentRuntimeToken;
  const got = (authHeader ?? '').replace(/^Bearer\s+/i, '');
  if (!got || got.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(got), Buffer.from(expected));
  } catch {
    return false;
  }
}
