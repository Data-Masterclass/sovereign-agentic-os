/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        knowledge
 * FEATURE:    WP-50 — the DRY-RUN migration plan for the existing live knowledge records
 * USER STORY: As an operator I want the OKF files each domain repository would gain from the
 *             workflow records that live only in the store today, and every record that cannot
 *             move with its reason, before anything is written.
 * ARCHITECTURE:
 *   - PURE: reads an operator's read-only export (an array of records, or a `_search` response over
 *     `os-knowledge-records`). It writes nothing and opens no connection. It previews with the SAME
 *     generator a save uses, so the plan cannot drift from what a save would commit.
 *   - Personal drafts are counted, not planned: they are My scope and never enter a domain repo.
 *   - The operating manual has NO durable copy to export (it lives in memory only, design 11 A21);
 *     the plan says so instead of pretending to migrate it.
 */
import { generateKnowledgeFiles, type BundleWorkflow } from '@tabs/knowledge/lib/git/bundle';

export type KnowledgeMigrationPlan = {
  mode: 'dry-run';
  domains: { domain: string; files: string[]; workflows: string[] }[];
  refused: { id: string; domain: string; reason: string }[];
  personal: number;
  archived: number;
  manual: 'not-exportable: the operating manual has no durable store copy (design 11 A21); it is committed on its next edit';
};

export function knowledgeRecordsFromJson(text: string): BundleWorkflow[] {
  const raw = JSON.parse(text) as unknown;
  const list = Array.isArray(raw) ? raw : ((raw as { hits?: { hits?: unknown[] } })?.hits?.hits ?? []);
  return list.map((x) => ((x as { _source?: unknown })?._source ?? x) as BundleWorkflow);
}

export function planKnowledgeMigration(records: BundleWorkflow[]): KnowledgeMigrationPlan {
  const plan: KnowledgeMigrationPlan = {
    mode: 'dry-run', domains: [], refused: [], personal: 0, archived: 0,
    manual: 'not-exportable: the operating manual has no durable store copy (design 11 A21); it is committed on its next edit',
  };
  const byDomain = new Map<string, BundleWorkflow[]>();
  for (const r of records.filter(Boolean)) {
    if (r.archived) { plan.archived++; continue; }
    if (r.visibility === 'Personal') { plan.personal++; continue; }
    try {
      generateKnowledgeFiles(r.domain, { workflows: [r], manual: null });
    } catch (e) {
      plan.refused.push({ id: r.id, domain: r.domain, reason: (e as Error).message });
      continue;
    }
    byDomain.set(r.domain, [...(byDomain.get(r.domain) ?? []), r]);
  }
  for (const [domain, recs] of [...byDomain.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const files = [...generateKnowledgeFiles(domain, { workflows: recs, manual: null }).keys()].sort();
    plan.domains.push({ domain, files, workflows: recs.map((r) => r.id).sort() });
  }
  return plan;
}
