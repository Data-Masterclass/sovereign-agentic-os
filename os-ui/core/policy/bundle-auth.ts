/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The bearer OPA presents to os-ui's bundle and status routes.
 * USER STORY: As an operator I want only the platform's own OPA instances to download policy
 *             data or post status, never a browser or another workload.
 * ARCHITECTURE:
 *   - OPA's service credentials `bearer.token_path` (https://www.openpolicyagent.org/docs/configuration#bearer-token)
 *     read the chart's shared service bearer Secret (`agent-runtime-token`, key `token`), the same
 *     Secret os-ui reads as AGENT_RUNTIME_TOKEN. Constant-time comparison.
 */
import { timingSafeEqual } from 'node:crypto';
import { config } from '@core/kernel/config';

export function opaBearerOk(authHeader: string | null): boolean {
  const expected = config.agentRuntimeToken;
  const got = (authHeader ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!expected || !got || got.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}
