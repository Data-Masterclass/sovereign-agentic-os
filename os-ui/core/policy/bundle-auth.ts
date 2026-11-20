/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The bearer OPA presents to os-ui's bundle and status routes.
 * USER STORY: As an operator I want only the platform's own OPA instances to download policy
 *             data or post status, never a browser or another workload.
 * ARCHITECTURE:
 *   - OPA's service credentials `bearer.token_path` (https://www.openpolicyagent.org/docs/configuration#bearer-token)
 *     read the DEDICATED Secret `opa-bundle-token` (generated in the cluster), which only OPA and
 *     the os-ui web process hold (OS_OPA_BUNDLE_TOKEN): not the shared service bearer, which run
 *     pods and Dagster user code also hold. Unset → every caller is refused. Constant-time.
 */
import { timingSafeEqual } from 'node:crypto';
import { config } from '@core/kernel/config';

export function opaBearerOk(authHeader: string | null): boolean {
  const expected = config.opaBundleToken;
  const got = (authHeader ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!expected || !got || got.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}
