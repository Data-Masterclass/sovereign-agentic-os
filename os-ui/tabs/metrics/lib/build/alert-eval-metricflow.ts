/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    WP-50 (alerts) — evaluate a COMMITTED alert with MetricFlow, as its owner, via Dagster
 * USER STORY: As a creator I want my alert to test the number MetricFlow returns for the saved query
 *             committed in my domain repo, run as me, and never a number the OS compiled itself.
 * ARCHITECTURE:
 *   - Server-only; used by `app/api/metrics/alerts/run/route.ts` when `OS_ALERTS_NATIVE` is on.
 *   - The rule is read from git (`metrics/alerts/*.yml` at the domain's HEAD), not from the store:
 *     an alert that is not committed is `pending`, never evaluated from the store's copy.
 *   - The Dagster image wires one job per committed alert (`<domain>__alert_<saved query>`,
 *     `images/extensions/dagster/repo.py`); os-ui launches it with the owner as `OS_PRINCIPAL` (the
 *     same run-pod env as a data launch), waits for the run, and reads the op's `os_alert_result`
 *     output metadata: `mf query --saved-query` value + the committed threshold's decision.
 *   - The committed `os_alert.owner` token must be the store owner's, or the rule is `refused`
 *     (the image refuses too, against the run's OS_PRINCIPAL). `metrics/alerts/**` is OS-owned on push.
 *   - No fallback: Dagster unreachable, a failed run or a missing result is `unavailable`.
 */
import 'server-only';
import { config } from '@core/kernel/config';
import { listTree, readBlob, log } from '@core/infra/git-store';
import * as dagster from '@core/infra/dagster';
import { ALERTS_PREFIX, alertOwnerToken, readAlertFiles, type CommittedAlert } from '@tabs/metrics/lib/git/alerts-native';
import { ownerPrincipal, type AlertValue } from '@tabs/metrics/lib/build/alert-eval';
import type { AlertRuleRecord } from '@tabs/metrics/lib/alert-store';

/** The op output metadata of a run (Dagster GraphQL `ExecutionStepOutputEvent.metadataEntries`). */
export const ALERT_RESULT_QUERY = `query AlertResult($id: ID!) { runOrError(runId: $id) { __typename ... on Run { status eventConnection { events { __typename ... on ExecutionStepOutputEvent { stepKey metadataEntries { label ... on JsonMetadataEntry { jsonString } } } } } } ... on RunNotFoundError { message } ... on PythonError { message } } }`;

export type MetricFlowResult = { status: string; value?: number; breached?: boolean; reason?: string; comparator?: string; threshold?: number; saved_query?: string };
export type CommittedEvaluation = Exclude<AlertValue, { status: 'ok' }> | { status: 'refused'; reason: string } | { status: 'ok'; value: number; breached: boolean; committed: CommittedAlert; runId: string };

type Deps = {
  dagster?: Pick<typeof dagster, 'launchRun' | 'run' | 'gql'>;
  owner?: typeof ownerPrincipal;
  reposDir?: string;
  sleep?: (ms: number) => Promise<void>;
  waitMs?: number;
};

/** The domain's committed alerts at HEAD, with that commit (empty when nothing is committed). */
export async function committedAlerts(domain: string, reposDir = config.reposDir): Promise<{ sha: string | null; alerts: CommittedAlert[] }> {
  const sha = (await log(domain, { reposDir, limit: 1 }))[0]?.sha;
  if (!sha) return { sha: null, alerts: [] };
  const files = new Map<string, string>();
  for (const e of await listTree(domain, sha, { reposDir })) if (e.path.startsWith(ALERTS_PREFIX)) files.set(e.path, await readBlob(domain, sha, e.path, { reposDir }));
  return { sha, alerts: readAlertFiles(files) };
}

const TERMINAL = new Set(['SUCCESS', 'FAILURE', 'CANCELED']);

/** Evaluate one rule from its committed file, through the image's MetricFlow job, as its owner. */
export async function evaluateCommittedAlert(rule: AlertRuleRecord, deps: Deps = {}): Promise<CommittedEvaluation> {
  const dg = deps.dagster ?? dagster;
  const owner = await (deps.owner ?? ownerPrincipal)(rule);
  if (!owner) return { status: 'orphaned', reason: `the owner of this alert (${rule.owner}) was deleted or deactivated, so it is not evaluated` };
  const head = await committedAlerts(rule.domain, deps.reposDir);
  const committed = head.alerts.find((a) => a.id === rule.id);
  if (!committed) return { status: 'pending', reason: `alert ${rule.id} is not committed in the ${rule.domain} repository (metrics/alerts/)` };
  // The job runs AS the owner: the committed file must name that owner, or an edited query would
  // run under someone else's identity.
  if (committed.ownerToken !== alertOwnerToken(rule.owner)) {
    return { status: 'refused', reason: `the committed owner of ${committed.path} is not this alert's owner: refused, never run as ${rule.owner}` };
  }
  const jobName = `${dagster.sanitizeName(rule.domain)}__alert_${dagster.sanitizeName(committed.savedQuery)}`;
  const launched = await dg.launchRun({
    jobName,
    tags: { 'os/principal': owner.id, 'os/alert': rule.id, 'os/action': 'alert evaluation', 'os/domain': rule.domain, 'os/commit': head.sha! },
    // The same run-pod env a data launch sets: MetricFlow's dbt profile impersonates OS_PRINCIPAL,
    // and the pod checks out the commit the alert was read at.
    env: { OS_PRINCIPAL: owner.id, OS_PINNED_COMMITS: `${rule.domain}=${head.sha}` },
  });
  if (!launched.ok) return { status: 'unavailable', reason: `Dagster did not launch ${jobName}: ${launched.error}` };
  const runId = launched.data.runId;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const end = Date.now() + (deps.waitMs ?? 180_000);
  let status = launched.data.status as string;
  while (!TERMINAL.has(status) && Date.now() < end) {
    await sleep(2000);
    const r = await dg.run(runId);
    if (r.ok) status = r.data.status;
  }
  if (status !== 'SUCCESS') return { status: 'unavailable', reason: `MetricFlow run ${runId} ended ${status}` };
  const ev = await dg.gql<{ runOrError: { events?: unknown; eventConnection?: { events?: { __typename?: string; metadataEntries?: { label?: string; jsonString?: string }[] }[] } } }>(ALERT_RESULT_QUERY, { id: runId });
  if (!ev.ok) return { status: 'unavailable', reason: `run ${runId}: ${ev.error}` };
  const entry = (ev.data.runOrError.eventConnection?.events ?? [])
    .filter((e) => e.__typename === 'ExecutionStepOutputEvent')
    .flatMap((e) => e.metadataEntries ?? [])
    .find((m) => m.label === 'os_alert_result' && m.jsonString);
  let res: MetricFlowResult;
  try {
    res = JSON.parse(entry?.jsonString ?? '') as MetricFlowResult;
  } catch {
    return { status: 'unavailable', reason: `run ${runId} has no os_alert_result output` };
  }
  if (res.status !== 'ok' || typeof res.value !== 'number' || typeof res.breached !== 'boolean') {
    return { status: 'unavailable', reason: res.reason ?? `run ${runId}: MetricFlow gave no number` };
  }
  return { status: 'ok', value: res.value, breached: res.breached, committed, runId };
}
