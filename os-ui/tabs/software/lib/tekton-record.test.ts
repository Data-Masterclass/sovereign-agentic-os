/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    Software Factory CI - a Tekton PipelineRun becomes the per-commit check record
 * USER STORY: As a builder I want the app to show, per commit, one status per check with its log,
 *             exactly as Tekton recorded it, and I never want a run that is unfinished, cancelled,
 *             unresolved or inconsistent to read as green.
 * ARCHITECTURE: PURE mapping (tekton-record.ts) from the PipelineRun, its TaskRuns and the step logs
 *             to the engine-neutral `CheckRecord` (check-record.ts). Fixtures have the shape of the
 *             objects a real Tekton Pipelines v1 controller writes (the real-cluster proof is
 *             tests/software-factory/tekton-e2e.sh). Readers of App.checks are unchanged.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checksRunName, recordFromRun, type RunObjects } from './tekton-record.ts';
import { recordVerdict } from './check-record.ts';
import { GATES_REPORT_DELIM, REQUIRED_GATES } from './gates.ts';

const SHA = 'a'.repeat(40);
const frame = (id: string, status: string, detail = 'ok', violations?: string[]) =>
  `${GATES_REPORT_DELIM}\n${JSON.stringify({ schema: 'os-gates/v1', template: 'nextjs-web', ok: status === 'pass', gates: [{ id, status, detail, ...(violations ? { violations } : {}) }] })}\n`;

type Step = { name: string; exit?: number; ran?: boolean };
const taskRun = (name: string, task: string, steps: Step[], cond: 'True' | 'False' | 'Unknown' = 'True') => ({
  metadata: { name: `run-${name}`, labels: { 'tekton.dev/pipelineTask': task } },
  status: {
    podName: `run-${name}-pod`,
    conditions: [{ type: 'Succeeded', status: cond, reason: cond === 'True' ? 'Succeeded' : 'Failed', message: cond === 'False' ? 'step failed' : '' }],
    steps: steps.map((s) => ({
      name: s.name,
      container: `step-${s.name}`,
      ...(s.ran === false ? { waiting: { reason: 'PodInitializing' } } : { terminated: { exitCode: s.exit ?? 0, reason: (s.exit ?? 0) === 0 ? 'Completed' : 'Error' } }),
    })),
  },
});
const GATE_STEPS = ['install', 'typecheck', 'lint', 'tests', 'build', 'policy', 'verdict'];
const run = (over: Record<string, unknown> = {}, cond: 'True' | 'False' | 'Unknown' = 'True', reason = 'Succeeded') => ({
  metadata: { name: 'chk-x-aaaaaaaaaa-1', labels: { 'soa.dev/app': 'x', 'soa.dev/sha': SHA, 'soa.dev/trigger': 'push' }, creationTimestamp: '2026-11-22T10:00:00Z' },
  spec: {},
  status: { startTime: '2026-11-22T10:00:01Z', ...(cond === 'Unknown' ? {} : { completionTime: '2026-11-22T10:03:00Z' }), conditions: [{ type: 'Succeeded', status: cond, reason, message: 'm' }] },
  ...over,
});
function green(over: { fail?: string; exit?: Record<string, number>; logs?: Record<string, string>; skipScan?: boolean } = {}): RunObjects {
  const logs: Record<string, string> = {};
  const steps: Step[] = GATE_STEPS.map((s) => ({ name: s, exit: over.exit?.[s] ?? (over.fail === s ? 1 : 0) }));
  for (const id of REQUIRED_GATES) logs[`run-gates/step-${id}`] = frame(id, over.fail === id ? 'fail' : 'pass', over.fail === id ? 'npm run test failed: 1 failing' : `npm run ${id} passed`);
  return {
    run: run({}, over.fail ? 'False' : 'True', over.fail ? 'Failed' : 'Succeeded') as never,
    taskRuns: [
      taskRun('fetch', 'fetch', [{ name: 'clone' }]),
      { ...taskRun('gates', 'gates', steps, over.fail ? 'False' : 'True'), metadata: { name: 'run-gates', labels: { 'tekton.dev/pipelineTask': 'gates' } } },
      ...(over.skipScan ? [] : [{ ...taskRun('scan', 'scan', [{ name: 'trivy-scan' }]), metadata: { name: 'run-scan', labels: { 'tekton.dev/pipelineTask': 'scan' } } }]),
    ] as never,
    logs: { ...logs, 'run-scan/step-trivy-scan': 'Total: 0 (HIGH: 0, CRITICAL: 0)', ...(over.logs ?? {}) },
  };
}

test('run names are deterministic DNS labels that fit Tekton label limits, per app, per sha, per attempt', () => {
  const n = checksRunName('order-desk', SHA, 1);
  assert.equal(n, checksRunName('order-desk', SHA, 1));
  assert.notEqual(n, checksRunName('order-desk', SHA, 2));
  assert.notEqual(n, checksRunName('order-desk', 'b'.repeat(40), 1));
  assert.notEqual(n, checksRunName('other-desk', SHA, 1));
  assert.match(n, /^chk-[a-z0-9-]+$/);
  const long = checksRunName('a'.repeat(63), SHA, 12);
  assert.ok(long.length <= 50, `${long.length}: the listener accepts at most 50 characters after chk-, and the TaskRun names add a task suffix`);
  assert.match(long, /^chk-[a-z0-9]+(-[a-z0-9]+)*$/);
});

test('a green run is a finished record: one pass per required gate plus the scan, with the run reference and times', () => {
  const rec = recordFromRun(green());
  assert.equal(rec.status, 'finished');
  assert.equal(rec.sha, SHA);
  assert.equal(rec.engine, 'tekton');
  assert.equal(rec.runRef, 'chk-x-aaaaaaaaaa-1');
  assert.equal(rec.trigger, 'push');
  assert.equal(rec.startedAt, '2026-11-22T10:00:01Z');
  assert.equal(rec.finishedAt, '2026-11-22T10:03:00Z');
  assert.deepEqual(rec.checks.map((c) => c.id), [...REQUIRED_GATES, 'scan']);
  assert.ok(rec.checks.every((c) => c.status === 'pass'));
  assert.equal(rec.error, null);
  assert.equal(recordVerdict(rec, SHA).green, true);
});

test('NEGATIVE a failing test blocks: the gate is fail with the step log detail, the record is not green', () => {
  const rec = recordFromRun(green({ fail: 'tests' }));
  assert.equal(rec.status, 'finished');
  const t = rec.checks.find((c) => c.id === 'tests')!;
  assert.equal(t.status, 'fail');
  assert.match(t.detail, /1 failing/);
  const v = recordVerdict(rec, SHA);
  assert.equal(v.green, false);
  assert.match(v.reason, /tests/);
});

test('NEGATIVE a step that exits non-zero is a fail even when its own report says pass (the report is never trusted over the exit code)', () => {
  const rec = recordFromRun(green({ exit: { lint: 3 } }));
  assert.equal(rec.checks.find((c) => c.id === 'lint')!.status, 'fail');
  assert.equal(recordVerdict(rec, SHA).green, false);
});

test('NEGATIVE a gate with no framed report and a non-zero exit is a fail carrying the log tail, never a pass', () => {
  const rec = recordFromRun(green({ fail: 'build', logs: { 'run-gates/step-build': 'Error: Command failed: next build\n./src/x.ts:1:1 Type error' } }));
  const b = rec.checks.find((c) => c.id === 'build')!;
  assert.equal(b.status, 'fail');
  assert.match(b.detail, /Type error/);
});

test('NEGATIVE npm ci failing: install is a fail and every later gate is unavailable (it did not run), so nothing reads as green', () => {
  const o = green();
  const gates = o.taskRuns.find((t) => (t as { metadata: { name: string } }).metadata.name === 'run-gates') as { status: { steps: Step[] & { terminated?: unknown; waiting?: unknown }[]; conditions: unknown[] } };
  gates.status.steps = [
    { name: 'install', container: 'step-install', terminated: { exitCode: 1, reason: 'Error' } },
    ...['typecheck', 'lint', 'tests', 'build', 'policy', 'verdict'].map((n) => ({ name: n, container: `step-${n}`, waiting: { reason: 'PodInitializing' } })),
  ] as never;
  (o.run as { status: { conditions: { status: string }[] } }).status.conditions[0].status = 'False';
  o.logs = { 'run-gates/step-install': 'npm ERR! 404 Not Found - GET https://registry.npmjs.org/nope' };
  const rec = recordFromRun(o);
  assert.equal(rec.checks.find((c) => c.id === 'install')!.status, 'fail');
  assert.match(rec.checks.find((c) => c.id === 'install')!.detail, /404/);
  for (const id of REQUIRED_GATES) assert.equal(rec.checks.find((c) => c.id === id)!.status, 'unavailable', id);
  assert.equal(recordVerdict(rec, SHA).green, false);
});

test('NEGATIVE a failing scan blocks; a scan that could not run (no database) is unavailable, not a pass', () => {
  const failed = recordFromRun(green({ logs: { 'run-scan/step-trivy-scan': 'Total: 2 (HIGH: 1, CRITICAL: 1)\nlodash 4.17.20 CVE-2021-23337' } }));
  const scanTask = failed.checks.find((c) => c.id === 'scan');
  // exit code of the scan step decides: patch it to the failure Trivy returns with --exit-code 1
  assert.ok(scanTask);
  const o = green({ logs: { 'run-scan/step-trivy-scan': 'Total: 2 (HIGH: 1, CRITICAL: 1)\nlodash 4.17.20 CVE-2021-23337' } });
  const scan = o.taskRuns.find((t) => (t as { metadata: { name: string } }).metadata.name === 'run-scan') as { status: { steps: { terminated: { exitCode: number } }[]; conditions: { status: string }[] } };
  scan.status.steps[0].terminated.exitCode = 1;
  scan.status.conditions[0].status = 'False';
  (o.run as { status: { conditions: { status: string }[] } }).status.conditions[0].status = 'False';
  const rec = recordFromRun(o);
  assert.equal(rec.checks.find((c) => c.id === 'scan')!.status, 'fail');
  assert.match(rec.checks.find((c) => c.id === 'scan')!.detail, /CVE-2021-23337/);
  assert.equal(recordVerdict(rec, SHA).green, false);

  const o2 = green({ logs: { 'run-scan/step-trivy-scan': 'FATAL init error: DB error: failed to download vulnerability DB' } });
  const s2 = o2.taskRuns.find((t) => (t as { metadata: { name: string } }).metadata.name === 'run-scan') as typeof scan;
  s2.status.steps[0].terminated.exitCode = 1;
  s2.status.conditions[0].status = 'False';
  const rec2 = recordFromRun(o2);
  assert.equal(rec2.checks.find((c) => c.id === 'scan')!.status, 'unavailable');
});

test('NEGATIVE a run still running is `running` (never finished, never green)', () => {
  const o = green();
  o.run = run({}, 'Unknown', 'Running') as never;
  const rec = recordFromRun(o);
  assert.equal(rec.status, 'running');
  assert.equal(rec.finishedAt, null);
  assert.match(recordVerdict(rec, SHA).reason, /running, not finished/);
});

test('NEGATIVE a cancelled run (a newer push superseded it) is `superseded`, so its result can never be read as the head\'s', () => {
  const o = green();
  o.run = run({ spec: { status: 'Cancelled' } }, 'False', 'Cancelled') as never;
  const rec = recordFromRun(o);
  assert.equal(rec.status, 'superseded');
  assert.equal(recordVerdict(rec, SHA).green, false);
});

test('NEGATIVE a pipeline that could not be resolved from git is a finished record with the error (no checks ran)', () => {
  const rec = recordFromRun({ run: run({}, 'False', 'CouldntGetPipeline') as never, taskRuns: [], logs: {} });
  assert.equal(rec.status, 'finished');
  assert.deepEqual(rec.checks, []);
  assert.match(rec.error ?? '', /pipeline/i);
  assert.equal(recordVerdict(rec, SHA).green, false);
});

test('NEGATIVE a clone failure is reported as a failed fetch, with the clone log, and no gate reads as passing', () => {
  const o: RunObjects = {
    run: run({}, 'False', 'Failed') as never,
    taskRuns: [taskRun('fetch', 'fetch', [{ name: 'clone', exit: 128 }], 'False')] as never,
    logs: { 'run-fetch/step-clone': 'fatal: unable to access http://os-git-http:9419/git/domain-sales.git/: Connection refused' },
  };
  const rec = recordFromRun(o);
  const f = rec.checks.find((c) => c.id === 'fetch')!;
  assert.equal(f.status, 'fail');
  assert.match(f.detail, /Connection refused/);
  assert.equal(recordVerdict(rec, SHA).green, false);
});

test('the sha of a record is the sha label of the run, not anything a log claims', () => {
  const o = green();
  o.logs['run-gates/step-tests'] = `${GATES_REPORT_DELIM}\n${JSON.stringify({ schema: 'os-gates/v1', template: 't', ok: true, gates: [{ id: 'tests', status: 'pass', detail: 'x', sha: 'f'.repeat(40) }] })}\n`;
  assert.equal(recordFromRun(o).sha, SHA);
});

test('logs are capped per check so one chatty step cannot bloat the app record', () => {
  const rec = recordFromRun(green({ fail: 'tests', logs: { 'run-gates/step-tests': 'x'.repeat(100_000) } }));
  assert.ok(rec.checks.every((c) => c.detail.length <= 4000));
});
