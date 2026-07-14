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

test('trigger_dag defaults to Write-approval; the two reads are Read', () => {
  const t = templateByKey('airflow')!;
  const byName = Object.fromEntries(t.tools.map((x) => [x.name, x]));
  assert.equal(byName.list_dags.mode, 'Read');
  assert.equal(byName.list_dags.write, false);
  assert.equal(byName.get_dag_run.mode, 'Read');
  assert.equal(byName.get_dag_run.write, false);
  assert.equal(byName.trigger_dag.mode, 'Write-approval', 'triggering a DAG is a real side effect — held for approval');
  assert.equal(byName.trigger_dag.write, true);
});

test('the airflow preset carries exactly the three promised tools', () => {
  const t = templateByKey('airflow')!;
  assert.deepEqual(t.tools.map((x) => x.name).sort(), ['get_dag_run', 'list_dags', 'trigger_dag']);
});
