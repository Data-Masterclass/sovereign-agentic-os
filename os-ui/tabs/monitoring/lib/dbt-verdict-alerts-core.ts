/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Monitoring alert: dbt refused a domain's newest commit
 * USER STORY: As an engineer I want to see that dbt refused my commit, with dbt's own error, instead
 *             of a schedule that quietly never loads.
 * ARCHITECTURE:
 *   - Pure over the rows of `os_governance.commit_checks` with `check_name = 'dbt-parse'`, which the
 *     verdict copy (core/adapters/dagster/commit-checks.ts) writes from repo-sync's own `dbt parse`.
 *     The OS judges nothing: it relays dbt's verdict.
 *   - The newest row of a domain is its head. Failed head => warning. Passed or pending => nothing.
 *   - An unreadable store is a warning, never an empty list.
 */
import type { Alert } from '@tabs/monitoring/lib/types';

export type DbtVerdictRow = { domain: string; sha: string; status: 'pending' | 'passed' | 'failed' | 'error'; checkedAt: string; details: Record<string, unknown> };

const base = { owner: 'platform', disposition: 'notified' as const, source: 'live' as const };

export function dbtVerdictAlerts(rows: DbtVerdictRow[] | null, readError?: string): Alert[] {
  if (rows === null) {
    return [{ ...base, id: 'al-dbt-verdict-unreadable', severity: 'warning', domain: 'platform', cluster: true, title: 'dbt verdicts unreadable',
      detail: `The dbt parse verdicts could not be read (${(readError ?? 'unknown error').slice(0, 200)}), so a refused commit would not be seen.`,
      i18n: { title: { code: 'monitoring.alert.dbtUnreadable' }, detail: { code: 'monitoring.alert.dbtUnreadableDetail', params: { error: (readError ?? 'unknown error').slice(0, 200) } } } }];
  }
  const head = new Map<string, DbtVerdictRow>();
  for (const r of rows) {
    const cur = head.get(r.domain);
    if (!cur || Date.parse(r.checkedAt) >= Date.parse(cur.checkedAt)) head.set(r.domain, r);
  }
  const out: Alert[] = [];
  for (const r of [...head.values()].sort((a, b) => a.domain.localeCompare(b.domain))) {
    if (r.status !== 'failed' && r.status !== 'error') continue;
    const text = [r.details.errorSummary, r.details.error].find((x): x is string => typeof x === 'string' && x.trim() !== '');
    out.push({ ...base, id: `al-dbt-refused-${r.domain}`, severity: 'warning', domain: r.domain, owner: r.domain,
      title: `dbt refused the newest commit of ${r.domain}`,
      detail: `Commit ${r.sha.slice(0, 7)} did not pass dbt parse, so Dagster keeps running the last commit that passed. ${text ? `dbt says: ${text.slice(0, 600)}` : 'dbt gave no error text.'}`,
      i18n: {
        title: { code: 'monitoring.alert.dbtRefused', params: { domain: r.domain } },
        detail: text
          ? { code: 'monitoring.alert.dbtRefusedDetail', params: { sha: r.sha.slice(0, 7), text: text.slice(0, 600) } }
          : { code: 'monitoring.alert.dbtRefusedNoText', params: { sha: r.sha.slice(0, 7) } },
      } });
  }
  return out;
}
