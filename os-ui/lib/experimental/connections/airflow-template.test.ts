/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  USER_FACING_TEMPLATE_KEYS,
  userFacingTemplates,
  templateByKey,
  isPersonalConnectable,
} from './schema.ts';

test('the airflow template exists as a user-facing service API connector', () => {
  const t = templateByKey('airflow');
  assert.ok(t, 'airflow template is registered');
  assert.equal(t!.type, 'API');
  assert.equal(t!.connector, 'api');
  assert.equal(t!.auth, 'service');
  assert.equal(t!.secretKey, 'airflow-secret');
  assert.equal(isPersonalConnectable(t!), false, 'shared service-credential connector (Builder/Admin)');
});

test('airflow IS user-facing (shows in the Supported Connectors gallery)', () => {
  assert.ok(USER_FACING_TEMPLATE_KEYS.includes('airflow'));
  assert.ok(userFacingTemplates().some((t) => t.key === 'airflow'));
});

test('every observe/retrieve tool is a side-effect-free Read (auto-allowed)', () => {
  const t = templateByKey('airflow')!;
  const byName = Object.fromEntries(t.tools.map((x) => [x.name, x]));
  for (const name of [
    'list_dags',
    'get_dag_run',
    'list_dag_runs',
    'get_task_instances',
    'get_task_logs',
    'get_xcom',
    'list_datasets',
    'get_dataset_events',
  ]) {
    assert.equal(byName[name].mode, 'Read', `${name} is Read`);
    assert.equal(byName[name].write, false, `${name} is non-write`);
  }
});

test('every control tool is a Write held for approval (real side effects)', () => {
  const t = templateByKey('airflow')!;
  const byName = Object.fromEntries(t.tools.map((x) => [x.name, x]));
  for (const name of ['trigger_dag', 'pause_dag', 'unpause_dag', 'clear_task']) {
    assert.equal(byName[name].mode, 'Write-approval', `${name} is held for approval`);
    assert.equal(byName[name].write, true, `${name} is a write`);
  }
});

test('the airflow preset carries exactly the promised operate+observe+retrieve tools', () => {
  const t = templateByKey('airflow')!;
  assert.deepEqual(
    t.tools.map((x) => x.name).sort(),
    [
      'clear_task',
      'get_dag_run',
      'get_dataset_events',
      'get_task_instances',
      'get_task_logs',
      'get_xcom',
      'list_dag_runs',
      'list_dags',
      'list_datasets',
      'pause_dag',
      'trigger_dag',
      'unpause_dag',
    ],
  );
});
