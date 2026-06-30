/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STAGE_COPY,
  priorLayer,
  nextLayer,
  stageArtifact,
  canBuildStage,
  canPassThrough,
  passThroughWarning,
  stepperStages,
} from './panels.ts';
import { emptyVersions, type Dataset } from './dataset-schema.ts';

function ds(over: Partial<Dataset> = {}): Dataset {
  return {
    version: '1', id: 'ds_x', name: 'Orders', owner: 'amir', domain: 'sales',
    tier: 'dataset', visibility: 'private', description: '', versions: emptyVersions(),
    grants: [], measures: [], columns: [], ...over,
  };
}

test('plain-language copy hides the native tool behind a verb', () => {
  assert.equal(STAGE_COPY.bronze.title, 'Bring it in');
  assert.equal(STAGE_COPY.silver.title, 'Clean it up + set the key');
  assert.equal(STAGE_COPY.gold.title, 'Make it ready + monitoring');
  assert.match(STAGE_COPY.silver.tool, /dbt/);
});

test('layer ordering helpers', () => {
  assert.equal(priorLayer('bronze'), null);
  assert.equal(priorLayer('silver'), 'bronze');
  assert.equal(nextLayer('silver'), 'gold');
  assert.equal(nextLayer('gold'), null);
});

test('one canonical artifact name per stage (FQN handover discipline)', () => {
  assert.equal(stageArtifact('Web Traffic', 'bronze'), 'bronze/web_traffic.dlt.yml');
  assert.equal(stageArtifact('Web Traffic', 'silver'), 'silver/stg_web_traffic.sql');
  assert.equal(stageArtifact('Web Traffic', 'gold'), 'gold/mart_web_traffic.sql');
});

test('a stage is buildable only once the prior layer exists', () => {
  const empty = emptyVersions();
  assert.equal(canBuildStage(empty, 'bronze'), true); // entry point, always
  assert.equal(canBuildStage(empty, 'silver'), false); // nothing brought in yet
  empty.bronze.built = true;
  assert.equal(canBuildStage(empty, 'silver'), true);
  assert.equal(canBuildStage(empty, 'gold'), false);
});

test('pass-through is offered for silver/gold only, with a clear warning', () => {
  assert.equal(canPassThrough('bronze'), false);
  assert.equal(canPassThrough('silver'), true);
  assert.match(passThroughWarning('silver'), /carries the bronze version forward/i);
});

test('stepperStages projects the three steps with built/buildable flags', () => {
  const v = emptyVersions();
  v.bronze = { built: true, passThrough: false, quality: 'passing', updatedAt: '2026-06-29', artifact: 'bronze/orders.dlt.yml' };
  const stages = stepperStages(ds({ versions: v }));
  assert.equal(stages.length, 3);
  assert.equal(stages[0].built, true);
  assert.equal(stages[1].buildable, true); // silver now buildable
  assert.equal(stages[2].buildable, false); // gold not yet
});
