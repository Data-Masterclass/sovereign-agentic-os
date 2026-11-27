/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    i18n wave 4 — the KPIs and Dashboards tabs' coded server messages
 * USER STORY: As a user in any of the seven languages I read KPI and dashboard refusals in my language, while API and
 *             MCP clients keep the exact English.
 * ARCHITECTURE: The English is byte-for-byte what the catalog's `en` renders, and every language has the code. A real
 *   model call where cheap, a table for the rest.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorBody, errorBodyOf, type ServerParams } from '@core/kernel/server-message';
import { assertServerEnglish } from '@core/testing/server-message';
import { measureFromForm, measureFromYaml } from '@tabs/metrics/lib/model';

function caught(fn: () => unknown): { error: string; code?: string; params?: ServerParams } {
  try {
    fn();
  } catch (e) {
    return errorBodyOf(e);
  }
  assert.fail('expected a throw');
}

test('metric model refusals carry a code whose English is unchanged', () => {
  const unnamed = caught(() => measureFromForm({ name: ' ', aggregation: 'sum', column: 'x' } as never));
  assert.equal(unnamed.error, 'a metric needs a name');
  assertServerEnglish(unnamed);
  const badCol = caught(() => measureFromForm({ name: 'Revenue', aggregation: 'sum', column: 'a b' } as never));
  assert.equal(badCol.code, 'metrics.invalidMetricColumn');
  assertServerEnglish(badCol);
  const noCol = caught(() => measureFromForm({ name: 'Revenue', aggregation: 'sum', column: '' } as never));
  assert.equal(noCol.error, 'sum needs a column to aggregate');
  assertServerEnglish(noCol);
  const empty = caught(() => measureFromYaml('cubes: []'));
  assert.equal(empty.code, 'metrics.yamlNoMeasures');
  assertServerEnglish(empty);
});

const TRIPLES: [string, string, ServerParams?][] = [
  ["metric 'ds_1.revenue' not found", 'metrics.notFound', { id: 'ds_1.revenue' }],
  ["invalid metric id 'x'", 'metrics.invalidId', { id: 'x' }],
  ['version 3 not found', 'metrics.versionNotFound', { version: '3' }],
  ['version 3 has no restorable measure', 'metrics.versionNotRestorable', { version: '3' }],
  ["invalid filter column 'a;b' — use a plain column name (letters, digits and underscores, starting with a letter or underscore)", 'metrics.invalidFilterColumn', { column: 'a;b' }],
  ["unknown aggregation 'median'", 'metrics.unknownAggregation', { aggregation: 'median' }],
  ["a formula metric must use aggregation 'number'", 'metrics.formulaNeedsNumber'],
  ['a ratio needs a numerator and a denominator measure', 'metrics.ratioNeedsTerms'],
  ["measure 'revenue' not found in the YAML", 'metrics.yamlMeasureNotFound', { measure: 'revenue' }],
  ['A valid stage is required (define|refine|preview|publish|monitor|suggest).', 'metrics.stageRequired'],
  ['datasetId is required', 'metrics.datasetIdRequired'],
  ['a metric form is required', 'metrics.formRequired'],
  ['a goal is required', 'metrics.goalRequired'],
  ['metricId is required', 'metrics.metricIdRequired'],
  ['not permitted to trigger alerts', 'metrics.alertsNotPermitted'],
  ['rule is required', 'metrics.ruleRequired'],
  ['not permitted to run alert evaluation', 'metrics.alertRunNotPermitted'],
  ["metricId and transition ('promote'|'certify') are required", 'metrics.governFieldsRequired'],
  ['Unknown action', 'metrics.unknownAction'],
  ['a folder path is required', 'metrics.folderRequired'],
  ['A version number is required.', 'metrics.versionRequired'],
  ['This metric is already personal — nothing to revoke', 'metrics.alreadyPersonal'],
  ['This metric is already certified', 'metrics.alreadyCertified'],
  ['Promote the underlying dataset to a governed asset in the Data tab first (request_promotion runs the physical publish) — a metric transition cannot materialise an un-published dataset tier here.', 'metrics.promoteDatasetFirst'],
  ["A metric's audience is its dataset's audience — promote the dataset “Orders” to Domain in the Data tab and this metric follows.", 'metrics.promoteViaDataset', { name: 'Orders' }],
  ["dashboard 'd1' not found", 'dashboards.notFound', { id: 'd1' }],
  ['not authorized to view this dashboard', 'dashboards.notAuthorizedView'],
  ["a dashboard cannot belong to 'platform' — choose one of your domains: sales, finance", 'dashboards.platformDomain', { platform: 'platform', domains: 'sales, finance' }],
  ["you are not a member of domain 'hr' — choose one of your domains: (none)", 'dashboards.notDomainMember', { domain: 'hr', domains: '(none)' }],
  ["you belong to no domain a dashboard can live in (only 'platform') — ask an admin to add you to a domain", 'dashboards.noDomain', { platform: 'platform' }],
  ['only the owner, an in-domain domain admin, or an admin can edit this dashboard', 'dashboards.editNotAllowed'],
  ["dashboard 'd1' belongs to domain 'sales'; a save does not move it to 'hr' (use the governed domain move)", 'dashboards.saveNoMove', { id: 'd1', domain: 'sales', target: 'hr' }],
  ['a dashboard needs a name', 'dashboards.nameRequired'],
  ['you can only revoke sharing on dashboards in a domain you belong to', 'dashboards.revokeNotMember'],
  ['revoking a dashboard from the Marketplace requires an Admin', 'dashboards.revokeMarketplaceAdmin'],
  ['unsharing requires the owner, an in-domain Domain admin, or an Admin', 'dashboards.unshareNotAllowed'],
  ['this dashboard is already personal — nothing to revoke', 'dashboards.alreadyPersonal'],
  ['only the owner, an in-domain domain admin, or an admin can modify this dashboard', 'dashboards.modifyNotAllowed'],
  ['version 12 not found', 'dashboards.versionNotFound', { version: '12' }],
  ['A valid stage is required (define|design|build|view|govern).', 'dashboards.stageRequired'],
  ['id, name and view are required', 'dashboards.buildFieldsRequired'],
  ['a dashboard needs at least one panel on a governed metric', 'dashboards.buildNeedsPanel'],
  ['view is required', 'dashboards.viewRequired'],
  ['panel is required', 'dashboards.panelRequired'],
  ['Unknown action', 'dashboards.unknownAction'],
  ['not permitted to send reports', 'dashboards.reportsNotPermitted'],
  ['a report is required', 'dashboards.reportRequired'],
  ['a folder path is required', 'dashboards.folderRequired'],
  ['A version number is required.', 'dashboards.versionRequired'],
];

test('every KPI/Dashboard triple renders its exact English and exists in every language', () => {
  for (const [english, code, params] of TRIPLES) assertServerEnglish(errorBody(english, code, params));
});
