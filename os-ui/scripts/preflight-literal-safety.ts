/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * READ-ONLY preflight: which stored datasets would the dbt generator refuse under the
 * literal-safety rules (tabs/data/lib/dbt/literal.ts), and the rename plan for each value.
 *
 *   node --import ./scripts/test-setup.mjs scripts/preflight-literal-safety.ts <export.json>…
 *
 * An export is any of: an array of dataset objects (MCP `get_dataset` output), an array of store
 * records (`{ yaml }`), or a search response over the datasets index exported read-only by an
 * operator (`hits.hits[]._source.yaml`). This script opens no connection itself. Exit 0 = nothing
 * refused; exit 1 = findings (printed as JSON lines); exit 2 = usage / unreadable input.
 */
import { readFileSync } from 'node:fs';
import { datasetsFromJson, preflightDatasets } from '@tabs/data/lib/dbt/literal-preflight';

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: preflight-literal-safety.ts <export.json>…');
  process.exit(2);
}
let datasets;
try {
  datasets = files.flatMap((f) => datasetsFromJson(readFileSync(f, 'utf8')));
} catch (e) {
  console.error(`preflight: cannot read input: ${(e as Error).message}`);
  process.exit(2);
}
const findings = preflightDatasets(datasets);
for (const f of findings) console.log(JSON.stringify(f));
console.error(`preflight: ${datasets.length} dataset(s) checked, ${findings.length} refused value(s) in ${new Set(findings.map((f) => f.dataset)).size} dataset(s)`);
process.exit(findings.length ? 1 : 0);
