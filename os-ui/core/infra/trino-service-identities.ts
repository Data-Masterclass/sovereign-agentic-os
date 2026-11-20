/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The Trino service identities (WP-14), in ONE list
 * USER STORY: As an admin I can never create an OS user that shares an id with a Trino service
 *             identity, and OPA never lets anyone impersonate one (verifier finding B1).
 * ARCHITECTURE:
 *   - `IMPERSONATING_SERVICE_USERS` may act for someone else on Trino (OPA decides for whom).
 *   - Everything with the `svc-` prefix and every name in `SERVICE_IDENTITY_NAMES` is reserved:
 *     never an OS user id (`tabs/admin/lib/users.ts` createUser / bootstrap rename) and never an
 *     impersonation target (`policies/trino_impersonation.rego`).
 *   - The chart's OPA data file `charts/sovereign-agentic-os/policies/service_identities.json` is
 *     `renderServiceIdentitiesJson()` byte for byte (asserted by the test beside this file).
 */

export const IMPERSONATING_SERVICE_USERS = ['svc-dagster-runner', 'svc-os-ui', 'svc-os-worker'] as const;

export const SERVICE_IDENTITY_PREFIXES = ['svc-'] as const;

/** Direct service users (own password, act as themselves) and the legacy service users. */
export const SERVICE_IDENTITY_NAMES = [
  ...IMPERSONATING_SERVICE_USERS,
  'dbt-runner',
  'northpeak-marts',
  'os-domain-delete',
  'query-agent',
] as const;

export function isServiceIdentity(id: string): boolean {
  const v = id.trim().toLowerCase();
  return SERVICE_IDENTITY_PREFIXES.some((p) => v.startsWith(p)) || (SERVICE_IDENTITY_NAMES as readonly string[]).includes(v);
}

/** The OPA data document (`data.service_identities`) the chart ships. */
export function renderServiceIdentitiesJson(): string {
  return `${JSON.stringify({ service_identities: { prefixes: [...SERVICE_IDENTITY_PREFIXES], names: [...SERVICE_IDENTITY_NAMES], impersonators: [...IMPERSONATING_SERVICE_USERS] } }, null, 2)}\n`;
}
