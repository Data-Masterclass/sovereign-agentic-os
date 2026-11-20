/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       testing/postgres
 * FEATURE:    The Postgres adapter's `Fetched` calls, unwrapped for the integration tests
 * USER STORY: As an engineer I want the real-Postgres tests to read like the SQL they prove: a
 *             refused write is a rejected promise carrying Postgres's own SQLSTATE.
 * ARCHITECTURE:
 *   - `must()` returns `value` for `ok:true` and throws for `ok:false`, with `code` = the SQLSTATE
 *     the adapter put first in `detail` and `reason` = the contract's reason. Test-only.
 */
import type { Fetched } from '@core/adapters/_contract';
import * as audit from '@core/adapters/postgres/audit';
import * as migrate from '@core/adapters/postgres/migrate';

export function must<T>(f: Fetched<T>): T {
  if (f.ok) return f.value;
  const code = /^([0-9A-Z]{5}) /.exec(f.detail)?.[1];
  throw Object.assign(new Error(f.detail), { code, reason: f.reason });
}

export const appendAuditEvent = async (...a: Parameters<typeof audit.appendAuditEvent>) => must(await audit.appendAuditEvent(...a));
export const verifyAuditChain = async (...a: Parameters<typeof audit.verifyAuditChain>) => must(await audit.verifyAuditChain(...a));
export const migrateGovernance = async (...a: Parameters<typeof migrate.migrateGovernance>) => must(await migrate.migrateGovernance(...a));
export { AUDIT_GENESIS_HASH } from '@core/adapters/postgres/audit';
export { MIGRATIONS_SCHEMA, MIGRATIONS_TABLE } from '@core/adapters/postgres/migrate';
