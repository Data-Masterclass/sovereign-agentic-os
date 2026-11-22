/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Reads dbt's parse verdicts (`commit_checks`) for the Monitoring alert
 * USER STORY: As a data engineer whose commit dbt refused, I see dbt's own text as an alert in Monitoring.
 * ARCHITECTURE: the read itself lives in core/adapters/dagster/commit-checks.ts (the door to the
 *   governance database). No governance database configured => no verdicts are copied either, so
 *   there is nothing to alert on (empty list).
 */
import 'server-only';
import type { Alert } from '@tabs/monitoring/lib/types';
import { newestDbtVerdicts } from '@core/adapters/dagster/commit-checks';
import { dbtVerdictAlerts } from '@tabs/monitoring/lib/dbt-verdict-alerts-core';

export async function collectDbtVerdictAlerts(read: typeof newestDbtVerdicts = newestDbtVerdicts): Promise<Alert[]> {
  try {
    const rows = await read();
    return rows === null ? [] : dbtVerdictAlerts(rows);
  } catch (e) {
    return dbtVerdictAlerts(null, e instanceof Error ? e.message : String(e));
  }
}
