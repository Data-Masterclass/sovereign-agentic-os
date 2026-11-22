/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    A foreign edit of the Trino access rules is repaired and reported, on a real API server
 * USER STORY: As a platform admin I want to know when someone edits the access rules outside the OS.
 *             The OS owns access rights, so it puts them back and tells me.
 * ARCHITECTURE: the harness (tests/access/up.sh) is a kind cluster with the chart's real
 *   `trino-access-rules` ConfigMap. The OS code is the production `k8s()` client and
 *   `reconcileTrinoAccessRules`, pointed at the cluster through OS_K8S_SA_DIR and KUBERNETES_API. The
 *   foreign edit is a real `kubectl patch`, as an engineer's `kubectl edit` would do.
 *   Negative twins: the first write and a membership change are not drift; an untouched file stays
 *   quiet on the next pass.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { reconcileTrinoAccessRules, lastDrift, _resetReconcileOutcome, RULES_KEY, RULES_STAMP } from '@core/infra/trino-rules-server';
import { rulesInputFromDirectory } from '@core/infra/trino-rules';
import { accessDriftAlerts } from '@tabs/monitoring/lib/access-drift-core';

const envFile = process.env.ACCESS_ENV ?? `${process.env.TMPDIR ?? '/tmp'}/own-access-work/env`.replace('//', '/');
let kube: string | null = null;
try {
  const env = Object.fromEntries(readFileSync(envFile, 'utf8').trim().split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2) as [string, string]));
  process.env.OS_K8S_SA_DIR = env.OS_K8S_SA_DIR;
  process.env.KUBERNETES_API = env.KUBERNETES_API;
  kube = env.ACCESS_KUBECONFIG;
} catch { /* no harness: the test below is skipped */ }
const skip = kube ? false : `harness env ${envFile} missing (run tests/access/up.sh)`;

const kubectl = (...a: string[]) => execFileSync('kubectl', ['--kubeconfig', kube!, '-n', 'agentic-os', ...a], { encoding: 'utf8' });
const cm = () => JSON.parse(kubectl('get', 'configmap', 'trino-access-rules', '-o', 'json')) as { data: Record<string, string>; metadata: { annotations?: Record<string, string> } };

const PATTERN = '[A-Za-z0-9][A-Za-z0-9._-]{0,63}';
const input = (users: { id: string; domains: string[] }[]) =>
  rulesInputFromDirectory({ serviceUsers: ['dbt-runner'], principalPattern: PATTERN, domains: ['sales'], users, sanitize: (s) => s.toLowerCase() });

test('real ConfigMap: first write and membership change are quiet; a kubectl edit is repaired, recorded and alerted', { skip }, async () => {
  _resetReconcileOutcome();
  const amir = [{ id: 'amir', domains: ['sales'] }];

  const first = await reconcileTrinoAccessRules(input(amir));
  assert.equal(first.ok && first.code, 'written', JSON.stringify(first));
  const written = cm();
  assert.ok(written.metadata.annotations?.[RULES_STAMP], 'the OS stamped what it wrote');
  assert.equal(lastDrift(), null, 'the first write over the chart bootstrap is not drift');

  await reconcileTrinoAccessRules(input([...amir, { id: 'bea', domains: ['sales'] }]));
  assert.equal(lastDrift(), null, 'a membership change is not drift');
  const good = cm().data[RULES_KEY];

  const quiet = await reconcileTrinoAccessRules(input([...amir, { id: 'bea', domains: ['sales'] }]));
  assert.equal(quiet.ok && quiet.code, 'unchanged');
  assert.equal(lastDrift(), null, 'an untouched file stays quiet');

  // A person opens everything up with kubectl.
  kubectl('patch', 'configmap', 'trino-access-rules', '--type', 'merge', '-p', JSON.stringify({ data: { [RULES_KEY]: '{"tables":[{"privileges":["OWNERSHIP"]}]}' } }));
  assert.match(cm().data[RULES_KEY], /OWNERSHIP/);

  const repaired = await reconcileTrinoAccessRules(input([...amir, { id: 'bea', domains: ['sales'] }]), { now: () => Date.now() });
  assert.equal(repaired.ok && repaired.code, 'written');
  assert.equal(cm().data[RULES_KEY], good, 'the cluster holds the OS rules again');
  const d = lastDrift();
  assert.ok(d, 'the drift is recorded');
  const alerts = accessDriftAlerts(d, Date.now());
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].severity, 'warning');
  assert.match(alerts[0].detail, /outside the OS/);
});
