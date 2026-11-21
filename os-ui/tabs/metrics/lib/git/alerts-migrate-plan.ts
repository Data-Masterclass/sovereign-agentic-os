/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        metrics
 * FEATURE:    WP-50 (alerts) — the DRY-RUN migration plan from the `os-alert-rules` store to git
 * USER STORY: As an operator I want to see, before anything moves, which `metrics/alerts/*.yml` each
 *             domain would gain from today's alert rules, and which rules cannot move and why.
 * ARCHITECTURE: PURE. Input = an export (array of rules, or an OpenSearch `_search` response) and each
 *   domain's committed dbt YAML; output = per-domain files + pending reasons. Nothing is written.
 */
import { generateAlertFiles, type AlertFileRule } from '@tabs/metrics/lib/git/alerts-native';

const COMPARATORS = new Set(['lt', 'lte', 'gt', 'gte']);

/** Rules from an export: a JSON array of records or a `_search` response. Malformed rows are refused. */
export function alertRulesFromJson(text: string): { rules: AlertFileRule[]; refused: { id: string; reason: string }[] } {
  const doc = JSON.parse(text) as unknown;
  const rows = Array.isArray(doc) ? doc : ((doc as { hits?: { hits?: { _source?: unknown }[] } })?.hits?.hits ?? []).map((h) => h._source);
  const rules: AlertFileRule[] = [];
  const refused: { id: string; reason: string }[] = [];
  for (const raw of rows) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const id = String(r.id ?? '');
    if (!id || typeof r.member !== 'string' || !COMPARATORS.has(String(r.comparator)) || typeof r.threshold !== 'number' || typeof r.owner !== 'string' || typeof r.domain !== 'string') {
      refused.push({ id: id || '(no id)', reason: 'not an alert rule record (id, member, comparator, threshold, owner, domain)' });
      continue;
    }
    rules.push({ id, member: r.member, comparator: r.comparator as AlertFileRule['comparator'], threshold: r.threshold, owner: r.owner, domain: r.domain });
  }
  return { rules, refused };
}

export type AlertMigrationPlan = {
  mode: 'dry-run';
  domains: { domain: string; files: string[]; dbtFiles: number }[];
  pending: { domain: string; id: string; reason: string }[];
  refused: { id: string; reason: string }[];
};

/** The plan. `dbtFilesOf(domain)` returns that domain's committed dbt YAML (empty: no repo). */
export function planAlertMigration(rules: AlertFileRule[], refused: { id: string; reason: string }[], dbtFilesOf: (domain: string) => Map<string, string>): AlertMigrationPlan {
  const plan: AlertMigrationPlan = { mode: 'dry-run', domains: [], pending: [], refused };
  for (const domain of [...new Set(rules.map((r) => r.domain))].sort()) {
    const dbt = dbtFilesOf(domain);
    const { files, pending } = generateAlertFiles(domain, rules, dbt);
    plan.domains.push({ domain, files: [...files.keys()], dbtFiles: dbt.size });
    for (const p of pending) plan.pending.push({ domain, ...p });
  }
  return plan;
}
