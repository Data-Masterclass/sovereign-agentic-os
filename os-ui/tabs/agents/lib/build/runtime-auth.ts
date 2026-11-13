/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { timingSafeEqual } from 'node:crypto';
import { config } from '@core/kernel/config';

/**
 * Service-to-service auth for the SERVICE paths: the agent scheduled-run trigger, the
 * metrics data-sync sweep and the connections catalog-refresh sweep. The caller is one of
 * the OS's own CronJobs — NOT a browser user — so it presents the shared service bearer
 * instead of a session cookie. Constant-time compared; server-only.
 *
 * A5: the governed-tool chokepoint this also guarded (`/api/agents/tool`, the Python
 * agent-runtime's callback door) is deleted. The engine runs in this process and calls
 * `handleRpc(user, …)` directly, so no external caller executes a tool any more.
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
