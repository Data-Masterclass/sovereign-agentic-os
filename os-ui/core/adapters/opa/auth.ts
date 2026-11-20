/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The OS's identity on OPA's REST API.
 * USER STORY: As an operator I want only the OS reconciler to write OPA's data and policies, so a
 *             workload that can reach OPA cannot change who may do what.
 * ARCHITECTURE:
 *   - OPA bearer-token authentication (`--authentication=token`, https://www.openpolicyagent.org/docs/security):
 *     every request carries `Authorization: Bearer <OPA_TOKEN>`; the chart's `system.authz`
 *     decides what that identity may do. OPA_TOKEN is the chart Secret `opa-tokens` key `writer`.
 *   - No token configured (a laptop without the chart) = no header; OPA without
 *     `--authorization` ignores the header, so sending it is always safe.
 */
import { config } from '@core/kernel/config';

export function opaHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return config.opaToken ? { ...extra, authorization: `Bearer ${config.opaToken}` } : { ...extra };
}
