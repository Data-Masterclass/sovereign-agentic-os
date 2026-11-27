/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    i18n wave 4 — the Data tab's coded server messages
 * USER STORY: As a user in any of the seven languages I read the Data tab's refusals in my language, while API and
 *             MCP clients keep the exact English.
 * ARCHITECTURE: Every refusal a person reads keeps its English byte-for-byte (the catalog's `en` renders exactly it)
 *   and every language has the code. Real store / compiler calls where cheap, a table for the rest (the triples the
 *   routes and the store emit).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { errorBody, errorBodyOf, type ServerParams } from '@core/kernel/server-message';
import { assertServerEnglish } from '@core/testing/server-message';
import { __resetStore, createDataset, getDataset, renameDataset, requestPromotion, type Principal } from '@tabs/data/lib/store';
import { compileSilver, compileGoldJoin } from '@tabs/data/lib/transform';
import { publishPersonalDataRule } from '@core/policy/personal-data-rule';

publishPersonalDataRule('off', true);

const amir: Principal = { id: 'amir', domains: ['sales'], role: 'creator' };
const kenji: Principal = { id: 'kenji', domains: ['finance'], role: 'creator' };

beforeEach(() => __resetStore());

function caught(fn: () => unknown): { error: string; code?: string; params?: ServerParams } {
  try {
    fn();
  } catch (e) {
    return errorBodyOf(e);
  }
  assert.fail('expected a throw');
}

test('store refusals carry a code whose English is unchanged', () => {
  const d = createDataset(amir, { name: 'Orders' });
  const notFound = caught(() => getDataset('ds_nope', amir));
  assert.equal(notFound.error, 'Dataset not found');
  assertServerEnglish(notFound);

  const view = caught(() => getDataset(d.id, kenji));
  assert.equal(view.code, 'data.notPermittedView');
  assertServerEnglish(view);

  const dup = caught(() => createDataset(amir, { name: 'Orders' }));
  assert.equal(dup.error, 'A dataset named “Orders” already exists in sales — pick a unique name.');
  assertServerEnglish(dup);

  const unnamed = caught(() => renameDataset(d.id, amir, '  '));
  assert.equal(unnamed.code, 'data.nameRequired');
  assertServerEnglish(unnamed);

  const bronze = caught(() => requestPromotion(d.id, amir));
  assert.equal(bronze.code, 'data.promoteBronze');
  assertServerEnglish(bronze);
});

test('transform compile refusals carry a code whose English is unchanged', () => {
  const noCols = caught(() => compileSilver({ source: 'iceberg.personal_amir.orders', target: 'iceberg.personal_amir.s', columns: [], ops: [] } as never));
  assert.equal(noCols.code, 'data.transform.noColumns');
  assertServerEnglish(noCols);

  const unknown = caught(() =>
    compileSilver({ source: 'iceberg.personal_amir.orders', target: 'iceberg.personal_amir.s', columns: ['a'], ops: [{ kind: 'drop', column: 'zz' }] } as never),
  );
  assert.equal(unknown.error, "op references unknown column 'zz'");
  assertServerEnglish(unknown);

  const gold = caught(() => compileGoldJoin({ base: 'iceberg.personal_amir.a', target: 'iceberg.personal_amir.g', joins: [], columns: [], measures: [] } as never));
  if (gold.code) assertServerEnglish(gold);
});

// The (english, code, params) triples the store, the routes and the transform compiler emit beyond the calls above.
const TRIPLES: [string, string, ServerParams?][] = [
  ['Not permitted to edit this dataset', 'data.notPermittedEdit'],
  ['Not permitted to change this dataset', 'data.notPermittedChange'],
  ['Defining a metric requires a Builder or Admin', 'data.metricNeedsBuilder'],
  ['A short description is required to adopt a connected table.', 'data.adoptNeedsDescription'],
  ["check column 'x y' is not a plain identifier (letters, digits, underscore)", 'data.checkColumnInvalid', { column: 'x y' }],
  ["check value 'a'b' is not allowed: a value must be 1–200 characters and carry no quote, backslash, control character or Jinja delimiter (it is interpolated into generated dbt test SQL)", 'data.checkValueInvalid', { value: "a'b", max: 200 }],
  ['reference needs a `toDataset` (the dataset id the column must exist in)', 'data.referenceNeedsDataset'],
  ["reference column 'a-b' is not a plain identifier (letters, digits, underscore)", 'data.referenceColumnInvalid', { column: 'a-b' }],
  ['a reference rule must point at a DIFFERENT dataset', 'data.referenceSameDataset'],
  ['sync: connectionId required', 'data.sync.connectionRequired'],
  ['sync: source schema + table required', 'data.sync.sourceRequired'],
  ["sync: invalid mode 'x'", 'data.sync.invalidMode', { mode: 'x' }],
  ['sync: incremental mode requires a cursor column', 'data.sync.cursorRequired', { mode: 'incremental' }],
  ["sync: cursor kind 'uuid' is not implemented yet (timestamp|number|kafka-offsets)", 'data.sync.cursorKindUnsupported', { kind: 'uuid' }],
  ['sync: kafka-offsets cursors support append mode only', 'data.sync.kafkaAppendOnly'],
  ['sync: merge mode requires at least one merge key', 'data.sync.mergeKeyRequired'],
  ["Measure 'revenue' not found", 'data.measureNotFound', { measure: 'revenue' }],
  ['Cannot decertify — 2 domain(s) import this product. Remove subscribers first.', 'data.decertifyHasImports', { count: 2 }],
  ['Cannot unshare — named individuals are granted access. Revoke their grants first.', 'data.unshareHasGrants'],
  ['Only the dataset owner can request its promotion', 'data.promoteOwnerOnly'],
  ['This dataset is already promoted', 'data.alreadyPromoted'],
  ['Cannot promote — transparency gate: missing owner, domain. Complete the documentation first.', 'data.promoteGateMissing', { missing: 'owner, domain' }],
  ['Dataset is no longer pending promotion', 'data.notPendingPromotion'],
  ['A promotion is approved by a Builder in the dataset’s domain', 'data.promoteApproverDomain'],
  ['Promotion blocked — transparency gate: missing owner', 'data.promotionBlocked', { missing: 'owner' }],
  ['Another shared dataset (“Orders”) already publishes to the domain table “iceberg.sales.gold_orders”. Rename this dataset before promoting so it gets its own shared table.', 'data.domainTableClash', { name: 'Orders', target: 'iceberg.sales.gold_orders' }],
  ["Cannot approve — a promotion grants access to its own domain ('sales'), not to 'finance'. Share across domains via the marketplace.", 'data.grantOwnDomainOnly', { datasetDomain: 'sales', domain: 'finance' }],
  ["Cannot grant access to domain 'sales' — you do not govern it.", 'data.grantDomainNotGoverned', { domain: 'sales' }],
  ['Promotion refused (tier unchanged) — the governed CTAS did not land iceberg.sales.x in the domain schema. Re-materialize before flipping.', 'data.promotionNotLanded', { target: 'iceberg.sales.x' }],
  ['This dataset is not promoted — nothing to re-materialize', 'data.notPromotedRematerialize'],
  ['Clearing the stale marker requires the owner or a Builder in the dataset’s domain', 'data.clearStaleNotAllowed'],
  ['Only a data asset can be certified', 'data.certifyAssetOnly'],
  ['Certification is by an Admin in the asset’s domain', 'data.certifyApproverDomain'],
  ['Certification blocked — transparency gate: missing owner', 'data.certificationBlocked', { missing: 'owner' }],
  ['Already certified', 'data.alreadyCertified'],
  ['Promote to a data asset before certifying', 'data.certifyNeedsAsset'],
  ['Cannot certify — transparency gate: missing domain', 'data.certifyGateMissing', { missing: 'domain' }],
  ['Importing a data product requires a Builder or Admin — ask a domain Builder to import it', 'data.importNeedsBuilder'],
  ['Only a certified data product can be imported', 'data.importProductOnly'],
  ['This product already belongs to your domain', 'data.importOwnDomain'],
  ['Cannot delete — 1 domain(s) import this data product. Remove subscribers first.', 'data.deleteHasImports', { count: 1 }],
  ["Path 'x.sql' is not part of this dataset", 'data.pathNotInDataset', { path: 'x.sql' }],
  ["Path 'silver/x.sql' is materialised by Build, not hand-edited here", 'data.pathMaterialised', { path: 'silver/x.sql' }],
  ['The file changed since you opened it (stale sha) — reload', 'data.staleSha'],
  ['dataset.yaml: tier, owner cannot be edited here — use Promote / Share / Unshare / Certify (governed, approved and audited).', 'data.yamlLockedFields', { fields: 'tier, owner' }],
  ['the extract has no columns — pull it again before confirming', 'data.extractNoColumns'],
  ['Missing question', 'data.questionRequired'],
  ['pull-extract needs sql', 'data.sandbox.extractNeedsSql'],
  ['land-bronze needs a datasetId', 'data.sandbox.landNeedsDataset'],
  ['unknown dataset', 'data.sandbox.unknownDataset'],
  ['upload a file via POST /api/data/sandbox/upload (multipart) — it now lands a real Iceberg table', 'data.sandbox.uploadViaMultipart'],
  ['unknown extract — pull it again before confirming (extracts are per-session)', 'data.sandbox.unknownExtract'],
  ['Unknown action', 'data.unknownAction'],
  ['unknown action: undefined', 'data.unknownActionNamed', { action: 'undefined' }],
  ['a file is required (multipart field "file")', 'data.fileRequired'],
  ['file exceeds the 1024 MB upload limit', 'data.uploadTooLarge', { mb: '1024' }],
  ['A valid stage is required (define|clean|ingest|harmonize|validate|publish|describe-checks).', 'data.stageRequired'],
  ['checkId is required', 'data.checkIdRequired'],
  ['a folder path is required', 'data.folderRequired'],
  ["action must be 'restore', 'tag', 'branch' or 'diff'", 'data.versionActionInvalid'],
  ['action must be decertify or unshare', 'data.lifecycleActionInvalid'],
  ['unknown monitor', 'data.unknownMonitor'],
  ['path and content are required', 'data.pathContentRequired'],
  ['stage must be one of bronze|silver|gold', 'data.stageInvalid', { stages: 'bronze|silver|gold' }],
  ['unknown check', 'data.unknownCheck'],
  ['nothing is built yet — there is no table to fix', 'data.nothingBuilt'],
  ['batch mode needs a sqlExpr', 'data.batchNeedsSqlExpr'],
  ['rows mode needs at least one accepted fix', 'data.rowsNeedFix'],
  ["mode must be 'batch' or 'rows'", 'data.modeInvalid'],
  ["duplicate source column 'a'", 'data.transform.duplicateColumn', { column: 'a' }],
  ["unsupported type 'blob'", 'data.transform.unsupportedType', { type: 'blob' }],
  ["unsupported filter 'like'", 'data.transform.unsupportedFilter', { op: 'like' }],
  ['every column was dropped — nothing to select', 'data.transform.allDropped'],
  ["two columns both output as 'id'", 'data.transform.duplicateAlias', { alias: 'id' }],
  ['a measure needs a name', 'data.transform.measureNameRequired'],
  ["measure 'm': unsupported aggregation 'median'", 'data.transform.measureBadAggregation', { measure: 'm', agg: 'median' }],
  ["measure 'm': unsupported operator '^'", 'data.transform.measureBadOperator', { measure: 'm', op: '^' }],
  ['measure is malformed', 'data.transform.measureMalformed'],
  ['a derived field needs a name', 'data.transform.derivedNameRequired'],
  ["derived field 'd': unsupported operator '%'", 'data.transform.derivedBadOperator', { field: 'd', op: '%' }],
  ['iceberg.sales.x is joined more than once', 'data.transform.joinedTwice', { table: 'iceberg.sales.x' }],
  ['join #2 type must be inner or left', 'data.transform.joinType', { n: '2' }],
  ['choose a join key for iceberg.sales.x', 'data.transform.joinKeyRequired', { table: 'iceberg.sales.x' }],
  ['the join key for iceberg.sales.x must match an earlier table', 'data.transform.joinKeyEarlier', { table: 'iceberg.sales.x' }],
  ['pick at least one column or measure for the Gold table', 'data.transform.goldNeedsOutput'],
  ["two outputs both named 'total'", 'data.transform.duplicateOutput', { name: 'total' }],
  ['nothing to publish — build a Silver or Gold version first', 'data.transform.nothingToPublish'],
  ['Missing SQL', 'query.missingSql'],
];

test('every Data/query triple renders its exact English and exists in every language', () => {
  for (const [english, code, params] of TRIPLES) assertServerEnglish(errorBody(english, code, params));
});
