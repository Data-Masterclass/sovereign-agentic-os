/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    dbt's parse verdict per commit, copied into `commit_checks` (WP-16; 10 F10)
 * USER STORY: As a data engineer I want one place that says, per commit, whether dbt accepted my
 *             project — the verdict repo-sync's real `dbt parse` produced, with dbt's own text.
 * ARCHITECTURE:
 *   - repo-sync is the single dbt gate. This copies, never decides: for each domain in
 *     `status.json`, the head's verdict (`/verdicts/<domain>/<sha>.json`) becomes the row
 *     `(domain, sha, 'dbt-parse')` with status `passed` / `failed` and dbt's text in `details`.
 *   - A head repo-sync has not parsed yet is `pending`; a feed that cannot be read writes nothing.
 *   - Idempotent upsert; a verdict never moves backwards (a recorded `failed`/`passed` is not
 *     overwritten by `pending`).
 */
import type pg from 'pg';
import type { Fetched } from '@core/adapters/_contract';
import { repoStatus, repoVerdict } from '@core/adapters/dagster/graphql-read';
import { scheduleEvery } from '@core/reconcile/runtime';

export const DBT_PARSE_CHECK = 'dbt-parse';

export type Copied = { domain: string; sha: string; status: 'passed' | 'failed' | 'pending' };

export async function copyDbtParseVerdicts(pool: pg.Pool, deps: Parameters<typeof repoStatus>[0] = {}): Promise<Fetched<Copied[]>> {
  const st = await repoStatus(deps);
  if (!st.ok) return st;
  const out: Copied[] = [];
  for (const [domain, s] of Object.entries(st.value)) {
    if (!s.head || !/^[0-9a-f]{40}$/.test(s.head)) continue;
    const v = await repoVerdict(domain, s.head, deps);
    if (!v.ok) return v;
    const status: Copied['status'] = v.value === null ? 'pending' : v.value.ok ? 'passed' : 'failed';
    const details = v.value === null ? { current: s.current } : { error: v.value.error ?? null, errorSummary: v.value.errorSummary ?? null, parsedAt: v.value.parsedAt ?? null, current: s.current };
    await pool.query(
      `INSERT INTO os_governance.commit_checks (domain, sha, check_name, status, details)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (domain, sha, check_name) DO UPDATE SET status = EXCLUDED.status, details = EXCLUDED.details, checked_at = pg_catalog.clock_timestamp()
         WHERE os_governance.commit_checks.status = 'pending' OR EXCLUDED.status <> 'pending'`,
      [domain, s.head, DBT_PARSE_CHECK, status, JSON.stringify(details)],
    );
    out.push({ domain, sha: s.head, status });
  }
  return { ok: true, value: out, at: new Date().toISOString() };
}

/** Copy the verdicts every `everyMs` through the one reconcile timer (core/reconcile/runtime.ts). */
export function startDbtParseVerdictCopy(pool: () => pg.Pool, everyMs = 30_000): () => void {
  return scheduleEvery('dbt-parse-verdicts', everyMs, async () => {
    const r = await copyDbtParseVerdicts(pool());
    if (!r.ok) throw new Error(`dbt-parse verdicts not copied — ${r.reason}: ${r.detail}`);
  });
}
