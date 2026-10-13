/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * AWS Glue provider — engine-specific tests.
 *
 * The Glue prop generation (iceberg vs hive, IRSA-only, cross-account catalog id) is
 * covered by `catalog-props.test.ts`. These lock the ENGINE-SPECIFIC metadata: the
 * dual Hive/Iceberg format handling surfaced in the type rules + notes, the
 * lower-cased identifier rules, and the partition-projection/MSCK honesty.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { glueProvider } from './glue.ts';

test('glue identifier rules: lower-cased, double-quoted (Athena/Glue convention)', () => {
  assert.deepEqual(glueProvider.identifierRules, { quote: '"', unquotedCase: 'lower' });
  assert.equal(glueProvider.discoveryMode, 'show');
});

test('glue Hive-format STRUCT/ARRAY/MAP cast to json; Iceberg-format keeps them native', () => {
  const rules = glueProvider.importTypeRules!;
  const hit = (t: string) => rules.find((r) => r.match.test(t));
  assert.equal(hit('struct<a:int>')!.castTo, 'json');
  assert.equal(hit('array<int>')!.castTo, 'json');
  assert.equal(hit('map<string,int>')!.castTo, 'json');
  // The notes make clear Iceberg-format tables keep the typed structure.
  assert.ok(hit('struct<a:int>')!.note.includes('Iceberg-format'), 'note explains the format split');
  assert.equal(hit('bigint'), undefined);
});

test('glue notes: dual Hive/Iceberg format, MSCK/partition projection, IRSA-only', () => {
  const joined = (glueProvider.notes ?? []).join(' ');
  assert.ok(/Hive- and Iceberg-format/.test(joined), 'flags a Glue db can hold both formats');
  assert.ok(/MSCK REPAIR TABLE/.test(joined), 'flags Hive partition MSCK/projection');
  assert.ok(/IRSA only/.test(joined), 'reaffirms IRSA-only, no static keys');
});
