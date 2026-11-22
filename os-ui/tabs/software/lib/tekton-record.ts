/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    Software Factory CI - a Tekton PipelineRun becomes the per-commit check record
 * USER STORY: As a builder I want the app to show, per commit, one status per check with its log, exactly as
 *             Tekton recorded it, and I never want an unfinished, cancelled, unresolved or inconsistent
 *             run to read as green.
 * ARCHITECTURE:
 *   - PURE: no I/O. Input is what the Kubernetes API returned (the PipelineRun, its TaskRuns) plus the step logs
 *     the reader fetched; output is the engine-neutral `CheckRecord` of check-record.ts, so no reader of
 *     `App.checks` changes when the producer changes.
 *   - The pipeline (templates/nextjs-web/.tekton/pipeline.yaml) has three tasks: `fetch` (Catalog git-clone),
 *     `gates` (one step per gate, each printing a framed `os-gates/v1` report) and `scan` (Catalog trivy-scanner).
 *     A gate's status comes from its step: the exit code and the framed report must agree, and when they do not
 *     the worse one wins. A step that never ran is `unavailable`, which blocks like a failure.
 *   - The sha of the record is the run's `soa.dev/sha` label (set by the listener from the OS's request), never
 *     anything a log claims. Cancelled runs are `superseded`; unfinished runs are `running`.
 */
import type { CheckEntry, CheckRecord, CheckRunStatus, CheckStatus, CheckTrigger } from '@tabs/software/lib/check-record';
import { REQUIRED_GATES, EXIT_UNAVAILABLE } from '@tabs/software/lib/gates';

type Obj = Record<string, unknown>;
export type RunObjects = {
  run: Obj;
  taskRuns: Obj[];
  /** Step logs, keyed `<taskRunName>/<container>` (the container is `step-<name>`). */
  logs: Record<string, string>;
};

const CAP = 4000;
const TRIGGERS: CheckTrigger[] = ['push', 'button', 'mcp', 'deploy'];

const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? (v as Obj[]) : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const tail = (s: string, n = CAP): string => (s.length > n ? s.slice(s.length - n) : s).trim();

/** `chk-<slug>-<hash of the slug>-<sha:10>-<attempt>`: deterministic, a DNS label, within the listener's 50 characters. */
export function checksRunName(slug: string, sha: string, attempt: number): string {
  const s = slug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20).replace(/-+$/g, '');
  let h = 5381;
  for (const ch of slug) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0;
  return `chk-${s || 'app'}-${h.toString(16).padStart(8, '0').slice(0, 4)}-${sha.slice(0, 10)}-${Math.max(1, Math.floor(attempt))}`;
}

function succeeded(o: Obj): { status: string; reason: string; message: string } {
  const c = arr(obj(o.status).conditions).find((x) => x.type === 'Succeeded');
  return { status: str(c?.status) || 'Unknown', reason: str(c?.reason), message: str(c?.message) };
}

type StepView = { name: string; container: string; exit: number | null };
function stepsOf(tr: Obj): StepView[] {
  return arr(obj(tr.status).steps).map((s) => {
    const term = s.terminated as Obj | undefined;
    return { name: str(s.name), container: str(s.container) || `step-${str(s.name)}`, exit: term && typeof term.exitCode === 'number' ? (term.exitCode as number) : null };
  });
}

const taskOf = (tr: Obj): string => str(obj(obj(tr.metadata).labels)['tekton.dev/pipelineTask']);
const nameOf = (tr: Obj): string => str(obj(tr.metadata).name);

function gateEntry(id: string, step: StepView | undefined, log: string, runDone: boolean): CheckEntry | null {
  if (!step || step.exit === null) {
    return runDone ? { id, status: 'unavailable', detail: `the '${id}' step did not run (an earlier step failed or the run ended first)` } : null;
  }
  // THE VERDICT IS THE STEP'S EXIT CODE (0 pass, 3 unavailable, else fail), recorded by Tekton. Log text is
  // display only: it is app-influenced output and never decides a gate.
  if (step.exit === 0) return { id, status: 'pass', detail: `${id} step exited 0` };
  const violations = log.split('\n').filter((l) => l.startsWith('  - ')).map((l) => l.slice(4)).slice(0, 50);
  if (step.exit === EXIT_UNAVAILABLE) return { id, status: 'unavailable', detail: tail(log) || `${id} could not run`, ...(violations.length ? { violations } : {}) };
  return { id, status: 'fail', detail: tail(log) || `the step exited ${step.exit} and wrote no log`, ...(violations.length ? { violations } : {}) };
}

function scanEntry(tr: Obj | undefined, logs: Record<string, string>, runSucceeded: boolean): CheckEntry | null {
  const step = tr ? stepsOf(tr).find((s) => s.name === 'trivy-scan') ?? stepsOf(tr)[0] : undefined;
  if (!tr || !step || step.exit === null) {
    return runSucceeded ? { id: 'scan', status: 'unavailable', detail: 'the source scan did not run' } : null;
  }
  const log = logs[`${nameOf(tr)}/${step.container}`] ?? '';
  if (step.exit === 0) return { id: 'scan', status: 'pass', detail: tail(log) || 'no high or critical finding' };
  // Trivy exits 1 both for findings (--exit-code 1) and for failing to run; a run that never produced a result table is not a verdict.
  const couldNotRun = /FATAL|failed to download|unable to initialize|DB error|failed to scan/i.test(log) && !/Total:/.test(log);
  return { id: 'scan', status: couldNotRun ? 'unavailable' : 'fail', detail: tail(log) || `the scan exited ${step.exit}` };
}

export function recordFromRun(o: RunObjects): CheckRecord {
  const meta = obj(o.run.metadata);
  const labels = obj(meta.labels);
  const spec = obj(o.run.spec);
  const st = obj(o.run.status);
  const cond = succeeded(o.run);
  const cancelled = str(spec.status).startsWith('Cancelled') || /cancel/i.test(cond.reason);
  const status: CheckRunStatus = cond.status === 'Unknown' ? 'running' : cancelled ? 'superseded' : 'finished';
  const done = status !== 'running';
  const runSucceeded = cond.status === 'True';
  const startedAt = str(st.startTime) || str(meta.creationTimestamp);
  const finishedAt = done ? str(st.completionTime) || startedAt : null;
  const trigger = (TRIGGERS as string[]).includes(str(labels['soa.dev/trigger'])) ? (str(labels['soa.dev/trigger']) as CheckTrigger) : 'push';

  const byTask = (t: string) => o.taskRuns.find((tr) => taskOf(tr) === t);
  const fetchRun = byTask('fetch');
  const gates = byTask('gates');
  const scan = byTask('scan');
  const checks: CheckEntry[] = [];

  if (fetchRun && succeeded(fetchRun).status === 'False') {
    const bad = stepsOf(fetchRun).find((s) => s.exit !== null && s.exit !== 0) ?? stepsOf(fetchRun)[0];
    checks.push({ id: 'fetch', status: 'fail', detail: tail(o.logs[`${nameOf(fetchRun)}/${bad?.container ?? 'step-clone'}`] ?? '') || succeeded(fetchRun).message || 'the clone of the commit failed' });
  }
  if (gates) {
    const steps = stepsOf(gates);
    // `toolchain` installs the platform's pinned tools (npm ci from the platform lockfile), `install` the app's own dependencies.
    // Either failing stops the gates behind it, and says so: the gates that did not run are `unavailable`, never a pass.
    for (const id of ['toolchain', 'install'] as const) {
      const prep = steps.find((s) => s.name === id);
      if (prep && prep.exit !== null && prep.exit !== 0) {
        checks.push({ id, status: 'fail', detail: tail(o.logs[`${nameOf(gates)}/${prep.container}`] ?? '') || `${id === 'toolchain' ? 'the platform toolchain' : 'npm ci'} failed to install` });
      }
    }
    for (const id of REQUIRED_GATES) {
      const step = steps.find((s) => s.name === id);
      const e = gateEntry(id, step, o.logs[`${nameOf(gates)}/${step?.container ?? `step-${id}`}`] ?? '', done);
      if (e) checks.push(e);
    }
  }
  const sc = scanEntry(scan, o.logs, runSucceeded);
  if (sc) checks.push(sc);

  let error: string | null = null;
  if (done && !cancelled && cond.status === 'False' && o.taskRuns.length === 0) {
    error = `the pipeline could not run (${cond.reason || 'failed'}): ${cond.message}`.slice(0, 600);
  }
  return { sha: str(labels['soa.dev/sha']), status, trigger, engine: 'tekton', runRef: str(meta.name) || null, startedAt, finishedAt, checks, error };
}
