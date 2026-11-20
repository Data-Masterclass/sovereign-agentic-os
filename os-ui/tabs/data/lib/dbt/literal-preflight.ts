/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Read-only preflight for the literal-safety rules — which stored datasets would the
 *             generator now refuse, and how to rename each refused value
 * USER STORY: As an operator rolling out stricter identifier rules I want the list of live objects
 *             that would stop being generated BEFORE I deploy, each with a concrete rename plan, so
 *             nothing silently drops out of a domain's dbt project.
 * ARCHITECTURE:
 *   - Pure: `preflightDatasets(datasets)` runs the generator's own `datasetLiteralIssues` over each
 *     dataset and attaches a plan per refused field. It reads nothing and writes nothing.
 *   - `datasetsFromJson(text)` accepts the shapes an operator can export read-only: an array of
 *     dataset objects, an array of store records (`{ yaml }`), or an OpenSearch `_search` response
 *     over the datasets index (`hits.hits[]._source.yaml`). The CLI is
 *     `os-ui/scripts/preflight-literal-safety.mjs`.
 */
import { parseDataset, type Dataset } from '@tabs/data/lib/dataset-schema';
import { datasetLiteralIssues, type LiteralIssue } from '@tabs/data/lib/dbt/literal';

export type PreflightFinding = LiteralIssue & { dataset: string; name: string; domain: string; owner: string; plan: string };

/** A conformant suggestion for a refused SQL identifier (lowercase, `_` for anything else). */
export function suggestIdentifier(value: string): string {
  const core = value.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 120);
  return /^[a-z_]/.test(core) ? core || 'col' : `c_${core}`;
}

function planFor(field: string, value: string): string {
  if (/^columns\[/.test(field)) {
    return `rename the column to '${suggestIdentifier(value)}' (Silver transform: a rename op), then save the documentation with the new name`;
  }
  if (/^checks\[.*\]\.(column|toColumn)$/.test(field)) return `point the rule at the renamed column '${suggestIdentifier(value)}' (remove and re-add the rule)`;
  if (/^checks\[.*\]\.toDataset$/.test(field) || /^upstreams\[/.test(field)) return 'the referenced id is not an OS dataset id: remove the rule / upstream and re-create it from the UI';
  if (field === 'sync.connectionId') return 'create the connection again (the OS mints a conformant id), then set the sync to the new connection';
  if (field === 'sync.source.schema' || field === 'sync.source.table' || field.startsWith('connected.source.')) {
    return `expose the source under an identifier name (a view '${suggestIdentifier(value)}' in the source system or the exposure), then set the sync to it`;
  }
  if (field === 'sync.cursor.column' || field.startsWith('sync.mergeKeys')) return `use the source column under an identifier name ('${suggestIdentifier(value)}', via a source view), then save the sync`;
  if (field === 'sync.schedule.cron') {
    const collapsed = value.trim().split(/\s+/).join(' ');
    return collapsed !== value ? `save the schedule as '${collapsed}' (single spaces)` : 'save the schedule again with a 5-field cron from the schedule picker';
  }
  if (field === 'owner') return 'reassign the dataset to a user whose id is conformant (Admin → reassign owner)';
  if (field === 'domain') return 'move the dataset to a domain whose id is conformant';
  if (field === 'slug') return `pin the slug to '${suggestIdentifier(value)}' (a physical rename: copy the table, then update the record)`;
  return 'correct the value in the dataset definition';
}

/** Every refused value across `datasets`, with its rename plan. Empty = safe to deploy. */
export function preflightDatasets(datasets: Dataset[]): PreflightFinding[] {
  const out: PreflightFinding[] = [];
  for (const d of datasets) {
    for (const issue of datasetLiteralIssues(d)) {
      out.push({ ...issue, dataset: d.id, name: d.name, domain: d.domain, owner: d.owner, plan: planFor(issue.field, issue.value) });
    }
  }
  return out.sort((a, b) => (a.dataset + a.field).localeCompare(b.dataset + b.field));
}

/** Parse an exported dataset list (see the file header for the accepted shapes). */
export function datasetsFromJson(text: string): Dataset[] {
  const raw = JSON.parse(text) as unknown;
  const hits = (raw as { hits?: { hits?: { _source?: unknown }[] } })?.hits?.hits;
  const items: unknown[] = Array.isArray(raw) ? raw : Array.isArray(hits) ? hits.map((h) => h._source) : [];
  return items.map((it) => {
    const o = it as { yaml?: unknown; id?: unknown };
    return typeof o?.yaml === 'string' ? parseDataset(o.yaml) : (it as Dataset);
  });
}
