/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    Software Factory CI - start one Tekton run per commit, cancel the superseded one, read the result
 * USER STORY: As a builder I want every push, every "Run checks" press and every verify_app_gates call to start
 *             the same checks for the commit, once, and a newer push to stop the older run, so the app shows
 *             what is true of its head.
 * ARCHITECTURE:
 *   - GLUE ONLY. Tekton is the engine; the OS adds no queue, runner or status store. This module
 *       1. POSTs a small JSON event to the Triggers EventListener (its CEL interceptor validates it; its
 *          TriggerTemplate creates the PipelineRun from the app's own `.tekton/pipeline.yaml` at that sha);
 *       2. lists PipelineRuns by label and PATCHes `spec.status: Cancelled` on the in-progress run of the same
 *          app when a newer sha arrives (https://tekton.dev/docs/pipelines/pipelineruns/#cancelling-a-pipelinerun);
 *       3. reads the PipelineRun, its TaskRuns and the step logs through the Kubernetes API and maps them to the
 *          engine-neutral record (tekton-record.ts).
 *   - ONE RUN PER SHA: the run name is deterministic and a run found for the sha is returned, not duplicated.
 *     "Run checks" (`force`) starts a new attempt only when the sha's run has finished.
 *   - FAIL CLOSED: no engine configured, no cluster, a refused event or an event that never became a run each
 *     come back as a distinct, named failure, which `ensureChecksRecord` turns into a FINISHED record carrying
 *     the reason (never green, never silently skipped).
 *   - os-ui's ServiceAccount may read runs, patch (cancel) and read pod logs in the build namespace; it may not
 *     create a PipelineRun: only the listener can (templates/base/os-ui/software-tekton.yaml).
 */
import 'server-only';
import {
  tektonNamespace, tektonListenerUrl, tektonWaitMs, liveTektonK8s, liveTektonK8sText, postEvent,
  listRuns, getRun, cancelRun, listTaskRuns, stepLog,
  type TektonObj, type TektonK8s, type TektonK8sText, type TektonPost,
} from '@core/adapters/tekton/client';
import { domainRepoName, legacyDomainRepoName, repoDirName } from '@core/infra/repo-layout';
import type { CheckRecord, CheckResult, CheckTrigger } from '@tabs/software/lib/check-record';
import { recordFromRun, checksRunName, type RunObjects } from '@tabs/software/lib/tekton-record';

type Obj = TektonObj;
export type ChecksK8s = TektonK8s;
export type ChecksK8sText = TektonK8sText;
export type ChecksPost = TektonPost;
export type ChecksDeps = {
  k8s?: ChecksK8s;
  k8sText?: ChecksK8sText;
  post?: ChecksPost;
  namespace?: string;
  listenerUrl?: string;
  /** How long `ensureChecksRecord` waits for the run to finish before returning it as `running`. */
  waitMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export type StartInput = { slug: string; domain: string; sha: string; trigger: CheckTrigger; force?: boolean };
export type StartResult =
  | { ok: true; runRef: string; created: boolean; superseded: string[] }
  | { ok: false; kind: 'not-configured' | 'no-cluster' | 'refused'; reason: string };
export type ReadResult = { kind: 'record'; record: CheckRecord } | { kind: 'none' } | { kind: 'no-cluster' };

const POLL_MS = 2_000;
const APPEAR_TRIES = 8;
const LOG_LIMIT = 256 * 1024;
const L_APP = 'soa.dev/app';
const L_SHA = 'soa.dev/sha';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? (v as Obj[]) : []);

/** The adapter's `Fetched` answer as the status/text pair this module reasons about (`status: 0` = never reached). */
const postViaAdapter: ChecksPost = async (url, json) => {
  const r = await postEvent(url, json);
  return r.ok ? r.value : { status: 0, text: r.detail };
};

type Cfg = { k8s: ChecksK8s; k8sText: ChecksK8sText; post: ChecksPost; ns: string; url: string; now: () => number; sleep: (ms: number) => Promise<void> };
function cfg(d: ChecksDeps): Cfg {
  return {
    k8s: d.k8s ?? liveTektonK8s,
    k8sText: d.k8sText ?? liveTektonK8sText,
    post: d.post ?? postViaAdapter,
    ns: d.namespace ?? tektonNamespace(),
    url: d.listenerUrl ?? tektonListenerUrl(),
    now: d.now ?? (() => Date.now()),
    sleep: d.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))),
  };
}

const nameOf = (r: Obj): string => str(obj(r.metadata).name);
const labelOf = (r: Obj, k: string): string => str(obj(obj(r.metadata).labels)[k]);
const created = (r: Obj): string => str(obj(r.metadata).creationTimestamp);

/** A run is done when Tekton says so (a Succeeded condition that is not Unknown), or when it was cancelled. */
function isDone(r: Obj): boolean {
  if (str(obj(r.spec).status).startsWith('Cancelled')) return true;
  const c = arr(obj(r.status).conditions).find((x) => x.type === 'Succeeded');
  return !!c && str(c.status) !== 'Unknown' && str(c.status) !== '';
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SHA_RE = /^[0-9a-f]{40}$/;

export async function startChecksRun(input: StartInput, deps: ChecksDeps = {}): Promise<StartResult> {
  const c = cfg(deps);
  if (!c.ns || !c.url) {
    return { ok: false, kind: 'not-configured', reason: 'no Tekton engine is configured for this OS (osUI.software.tekton is off), so no check can run' };
  }
  let repo: string;
  try {
    // `<domain>.git` is the engineer's own clone URL and is served in both repository layouts (a real directory, or the
    // alias beside `domain-<domain>.git`); a domain whose name reads as another repo kind has only the canonical name.
    repo = repoDirName(legacyDomainRepoName(input.domain) ?? domainRepoName(input.domain));
  } catch (e) {
    return { ok: false, kind: 'refused', reason: e instanceof Error ? e.message : 'invalid domain' };
  }
  if (!SLUG_RE.test(input.slug)) return { ok: false, kind: 'refused', reason: `'${input.slug}' is not a valid app slug` };
  if (!SHA_RE.test(input.sha)) return { ok: false, kind: 'refused', reason: `'${input.sha}' is not a full commit sha` };

  const listed = await listRuns(c.k8s, c.ns, { [L_APP]: input.slug });
  if (listed.status === 0) return { ok: false, kind: 'no-cluster', reason: 'the Kubernetes API server is unreachable from the OS, so no Tekton run could be started' };
  if (listed.status !== 200) return { ok: false, kind: 'refused', reason: `Kubernetes refused to list the app's PipelineRuns (HTTP ${listed.status}); os-ui needs get/list on pipelineruns in ${c.ns}` };
  const runs = arr(listed.body.items);

  // A newer sha supersedes the app's run still in progress: Tekton's own cancellation, never a delete.
  const superseded: string[] = [];
  for (const r of runs) {
    const sha = labelOf(r, L_SHA);
    if (isDone(r) || sha === input.sha) continue;
    const res = await cancelRun(c.k8s, c.ns, nameOf(r));
    if (res.status === 200) {
      if (!superseded.includes(sha)) superseded.push(sha);
    } else if (res.status === 0) {
      return { ok: false, kind: 'no-cluster', reason: 'the Kubernetes API server became unreachable while cancelling the superseded run' };
    } else {
      return { ok: false, kind: 'refused', reason: `Kubernetes refused to cancel the superseded run ${nameOf(r)} (HTTP ${res.status}); os-ui needs patch on pipelineruns` };
    }
  }

  const same = runs.filter((r) => labelOf(r, L_SHA) === input.sha).sort((a, b) => created(b).localeCompare(created(a)));
  const newest = same[0];
  if (newest && (!input.force || !isDone(newest))) return { ok: true, runRef: nameOf(newest), created: false, superseded };

  const runName = checksRunName(input.slug, input.sha, same.length + 1);
  const sent = await c.post(c.url, { slug: input.slug, domain: input.domain, repo, sha: input.sha, runName, trigger: input.trigger });
  if (sent.status === 0) return { ok: false, kind: 'refused', reason: `the Tekton EventListener is unreachable: ${sent.text}`.slice(0, 300) };
  if (sent.status < 200 || sent.status >= 300) return { ok: false, kind: 'refused', reason: `the Tekton EventListener refused the event (HTTP ${sent.status}): ${sent.text}`.slice(0, 300) };
  for (let i = 0; i < APPEAR_TRIES; i++) {
    const got = await getRun(c.k8s, c.ns, runName);
    if (got.status === 200) return { ok: true, runRef: runName, created: true, superseded };
    if (got.status === 0) return { ok: false, kind: 'no-cluster', reason: 'the Kubernetes API server became unreachable after the event was accepted' };
    await c.sleep(500);
  }
  return { ok: false, kind: 'refused', reason: `the EventListener accepted the event but no PipelineRun ${runName} appeared (check the listener and the pipeline resolution in ${c.ns})` };
}

/** Read the newest run of exactly this sha as a check record (running, finished or superseded). */
export async function readChecksRecord(slug: string, sha: string, deps: ChecksDeps = {}): Promise<ReadResult> {
  const c = cfg(deps);
  if (!c.ns) return { kind: 'none' };
  const listed = await listRuns(c.k8s, c.ns, { [L_APP]: slug, [L_SHA]: sha });
  if (listed.status === 0) return { kind: 'no-cluster' };
  if (listed.status !== 200) return { kind: 'none' };
  const run = arr(listed.body.items).sort((a, b) => created(b).localeCompare(created(a)))[0];
  if (!run) return { kind: 'none' };

  const trs = await listTaskRuns(c.k8s, c.ns, nameOf(run));
  if (trs.status === 0) return { kind: 'no-cluster' };
  const taskRuns = trs.status === 200 ? arr(trs.body.items) : [];
  const logs: Record<string, string> = {};
  for (const tr of taskRuns) {
    const pod = str(obj(tr.status).podName);
    if (!pod) continue;
    for (const s of arr(obj(tr.status).steps)) {
      const terminated = obj(s.terminated);
      const step = str(s.name);
      const container = str(s.container) || `step-${step}`;
      // The verdict step prints nothing we read; every other terminated step may carry a gate report or the failure.
      if (!Object.keys(terminated).length || step === 'verdict') continue;
      const log = await stepLog(c.k8sText, c.ns, pod, container, LOG_LIMIT);
      if (log.status === 200) logs[`${nameOf(tr)}/${container}`] = log.text;
    }
  }
  const objects: RunObjects = { run, taskRuns, logs };
  const record = recordFromRun(objects);
  // The sha is whatever the caller asked for: the lookup was by that label, so they cannot differ.
  return { kind: 'record', record: { ...record, sha } };
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Start (idempotently) and wait up to `waitMs` for the run; always returns a record, never throws. */
export async function ensureChecksRecord(input: StartInput & { waitMs?: number }, deps: ChecksDeps = {}): Promise<CheckResult> {
  const c = cfg(deps);
  const wait = input.waitMs ?? deps.waitMs ?? tektonWaitMs();
  const t0 = c.now();
  const started = await startChecksRun(input, deps);
  if (!started.ok) {
    const reason = started.reason;
    return {
      superseded: [],
      record: { sha: input.sha, status: 'finished', trigger: input.trigger, engine: 'tekton', runRef: null, startedAt: iso(t0), finishedAt: iso(c.now()), checks: [], error: reason },
    };
  }
  for (;;) {
    const got = await readChecksRecord(input.slug, input.sha, deps);
    if (got.kind === 'record' && got.record.status !== 'running') return { record: got.record, superseded: started.superseded };
    if (c.now() - t0 >= wait) {
      const record: CheckRecord = got.kind === 'record'
        ? got.record
        : { sha: input.sha, status: 'running', trigger: input.trigger, engine: 'tekton', runRef: started.runRef, startedAt: iso(t0), finishedAt: null, checks: [], error: null };
      return { record, superseded: started.superseded };
    }
    await c.sleep(POLL_MS);
  }
}

export type ChecksRunner = (input: StartInput & { waitMs?: number }) => Promise<CheckResult>;

let override: ChecksRunner | null = null;
/** Tests only: stand in for the engine (the real one is proven against kind + Tekton). */
export function __setChecksRunner(fn: ChecksRunner | null): void {
  override = fn;
}
/** The engine the OS uses: Tekton, unless a test installed a stand-in. */
export const defaultChecksRunner: ChecksRunner = (input) => (override ?? ((i) => ensureChecksRecord(i)))(input);
