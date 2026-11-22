/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Reads dbt's parse verdicts (`commit_checks`) for the Monitoring alert
 * ARCHITECTURE: one read-only query: the newest `dbt-parse` row per domain. No governance database
 *   configured => no verdicts are copied either, so there is nothing to alert on (empty list).
 */
import 'server-only';
import type { Alert } from '@tabs/monitoring/lib/types';
import { config } from '@core/kernel/config';
import { governanceRuntimePool } from '@core/adapters/postgres/pool';
import { dbtVerdictAlerts, type DbtVerdictRow } from '@tabs/monitoring/lib/dbt-verdict-alerts-core';

type Queryable = { query: (sql: string) => Promise<{ rows: Record<string, unknown>[] }> };

export const NEWEST_VERDICT_SQL = `SELECT DISTINCT ON (domain) domain, sha, status, checked_at, details
  FROM os_governance.commit_checks WHERE check_name = 'dbt-parse' ORDER BY domain, checked_at DESC`;

export async function readDbtVerdicts(pool: Queryable): Promise<DbtVerdictRow[]> {
  const r = await pool.query(NEWEST_VERDICT_SQL);
  return r.rows.map((x) => ({
    domain: String(x.domain), sha: String(x.sha), status: x.status as DbtVerdictRow['status'],
    checkedAt: x.checked_at instanceof Date ? x.checked_at.toISOString() : String(x.checked_at),
    details: (x.details ?? {}) as Record<string, unknown>,
  }));
}

export async function collectDbtVerdictAlerts(pool?: Queryable): Promise<Alert[]> {
  if (!pool && !config.governanceDatabaseUrl) return [];
  try {
    return dbtVerdictAlerts(await readDbtVerdicts(pool ?? governanceRuntimePool()));
  } catch (e) {
    return dbtVerdictAlerts(null, e instanceof Error ? e.message : String(e));
  }
}
