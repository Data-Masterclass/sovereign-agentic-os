/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The pure parts of Monitoring → Software: pod state from a Pod object, runner ↔ pod names, the log query.
 * USER STORY: As a reviewer I want one app's counts never to include a look-alike app's pods or log lines.
 * ARCHITECTURE: pure functions of panels-core.ts. The real Kubernetes API and VictoriaLogs answer the same
 *   inputs in `software-panel.int.test.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appLogQuery, foldAppLogs, podFactsOf, podStateOf, runnerOfPod, runnerPodRegex, worstPodState } from './panels-core';

const pod = (status: Record<string, unknown>) => ({ metadata: { name: 'app-x-aaa-bbb' }, status });

test('pod state is what the Pod object says', () => {
  assert.equal(podStateOf(podFactsOf(pod({ phase: 'Running', containerStatuses: [{ ready: true, restartCount: 0, state: { running: {} } }] }))), 'running');
  assert.equal(podStateOf(podFactsOf(pod({ phase: 'Running', containerStatuses: [{ ready: false, restartCount: 7, state: { waiting: { reason: 'CrashLoopBackOff' } }, lastState: { terminated: { reason: 'Error' } } }] }))), 'crash_looping');
  assert.equal(podStateOf(podFactsOf(pod({ phase: 'Pending', containerStatuses: [{ ready: false, restartCount: 0, state: { waiting: { reason: 'ImagePullBackOff' } } }] }))), 'image_pull_failed');
  assert.equal(podStateOf(podFactsOf(pod({ phase: 'Pending' }))), 'starting');
  assert.equal(podStateOf(podFactsOf(pod({ phase: 'Running', containerStatuses: [{ ready: false, restartCount: 0, state: { running: {} } }] }))), 'not_ready', 'running but not ready is not running');
  assert.equal(podFactsOf(pod({ phase: 'Running', containerStatuses: [{ ready: true, restartCount: 2 }, { ready: true, restartCount: 3 }] })).restarts, 5);
});

test('between two restarts (terminated, not yet backing off) a restarted container still reads as crash-looping; a first failed start does not (twin)', () => {
  assert.equal(podStateOf(podFactsOf(pod({ phase: 'Running', containerStatuses: [{ ready: false, restartCount: 3, state: { terminated: { reason: 'Error', exitCode: 1 } }, lastState: { terminated: { reason: 'Error' } } }] }))), 'crash_looping');
  assert.equal(podStateOf(podFactsOf(pod({ phase: 'Running', containerStatuses: [{ ready: false, restartCount: 0, state: { terminated: { reason: 'Error', exitCode: 1 } } }] }))), 'not_ready');
});

test('the worst pod decides the app', () => {
  assert.equal(worstPodState(['running', 'crash_looping']), 'crash_looping');
  assert.equal(worstPodState(['running', 'running']), 'running');
});

test('a pod belongs to its runner only: app-foo does not claim app-foo-bar\'s pods (twin)', () => {
  const runners = new Set(['app-foo', 'app-foo-bar']);
  assert.equal(runnerOfPod('app-foo-7d9f-abcde', runners), 'app-foo');
  assert.equal(runnerOfPod('app-foo-bar-7d9f-abcde', runners), 'app-foo-bar');
  assert.equal(runnerOfPod('app-foo-bar-7d9f-abcde', new Set(['app-foo'])), null);
  assert.equal(runnerOfPod('other-7d9f-abcde', runners), null);
});

test('the log query names the asked runners and counts lines and "error" lines per pod', () => {
  const q = appLogQuery('agentic-apps', ['app-foo', 'app-bar']);
  assert.match(q, /k8s\.namespace\.name:"agentic-apps"/);
  assert.match(q, /k8s\.pod\.name:~"\^\(app-foo\|app-bar\)-\[a-z0-9\]\+-\[a-z0-9\]\+\$"/);
  assert.match(q, /count\(\) if \(i\(error\)\) as errors/);
  assert.equal(new RegExp(runnerPodRegex(['app-foo'])).test('app-foo-bar-aaa-bbb'), false);
  assert.equal(new RegExp(runnerPodRegex(['app-foo'])).test('app-foo-aaa-bbb'), true);
});

test('log rows fold per runner; foreign rows are dropped; no lines gives no rate', () => {
  const m = foldAppLogs([
    { 'k8s.pod.name': 'app-foo-aa-bb', lines: '10', errors: '1' },
    { 'k8s.pod.name': 'app-foo-aa-cc', lines: '30', errors: '2' },
    { 'k8s.pod.name': 'app-secret-aa-bb', lines: '5', errors: '5' },
    { 'k8s.pod.name': 'app-zero-aa-bb', lines: '0', errors: '0' },
  ], ['app-foo', 'app-zero']);
  assert.deepEqual(m.get('app-foo'), { lines: 40, errors: 3, errorRate: 0.075 });
  assert.equal(m.get('app-zero')!.errorRate, null);
  assert.equal(m.has('app-secret'), false);
});
