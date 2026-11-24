/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       acceptance harness (tests/e2e/kind)
 * FEATURE:    Read Dagster's own run ledger and asset-check results over its GraphQL API
 * USER STORY: As AT-b I want "the schedule launched a run as the owner and the quality check
 *             passed" to be Dagster's record, not an OS status row.
 * ARCHITECTURE:
 *   - POST <webserver>/graphql. Queries use only documented schema types: runsOrError(filter:
 *     RunsFilter), Run{runId,status,tags,startTime,endTime}, assetCheckExecutions(assetKey,
 *     checkName, limit) -> AssetCheckExecution{runId,status,evaluation{success}}.
 *   - Docs: https://docs.dagster.io/api/graphql ; schema in dagster-graphql (Apache-2.0).
 */
import { baseUrl } from '../endpoints.mjs';
import { request } from '../http.mjs';
import { HopError } from '../hop.mjs';

// The chart runs the webserver under dagster.dagsterWebserver.pathPrefix (the OS console prefix).
const PREFIX = process.env.E2E_DAGSTER_PATH_PREFIX ?? '/tools/dagster';

export async function gql(query, variables = {}, hop = 'graphql') {
  const url = `${await baseUrl('dagster')}${PREFIX}/graphql`;
  const { data } = await request('dagster', hop, url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: { query, variables } });
  if (data.errors?.length) throw new HopError({ component: 'dagster', hop, reason: data.errors.map((e) => e.message).join('; ') });
  return data.data;
}

const RUNS = `query Runs($filter: RunsFilter, $limit: Int) {
  runsOrError(filter: $filter, limit: $limit) {
    __typename
    ... on Runs { results { runId status jobName startTime endTime tags { key value } } }
    ... on PythonError { message }
    ... on InvalidPipelineRunsFilterError { message }
  }
}`;

/** Runs matching tag filters, newest first. tags: {key: value}. */
export async function runs({ tags = {}, statuses, limit = 20 } = {}) {
  const filter = { tags: Object.entries(tags).map(([key, value]) => ({ key, value })) };
  if (statuses) filter.statuses = statuses;
  const d = await gql(RUNS, { filter, limit }, 'runsOrError');
  if (d.runsOrError.__typename !== 'Runs') throw new HopError({ component: 'dagster', hop: 'runsOrError', reason: d.runsOrError.message ?? d.runsOrError.__typename });
  return d.runsOrError.results.map((r) => ({ ...r, tagMap: Object.fromEntries(r.tags.map((t) => [t.key, t.value])) }));
}

/** Runs the daemon launched from a schedule (Dagster sets the `dagster/schedule_name` tag). */
export async function scheduleRuns(scheduleName, opts = {}) {
  return runs({ ...opts, tags: { 'dagster/schedule_name': scheduleName, ...(opts.tags ?? {}) } });
}

const CHECKS = `query Checks($assetKey: AssetKeyInput!, $checkName: String!, $limit: Int!) {
  assetCheckExecutions(assetKey: $assetKey, checkName: $checkName, limit: $limit) {
    id runId status timestamp evaluation { success severity }
  }
}`;

export async function assetCheckExecutions(assetPath, checkName, limit = 10) {
  const d = await gql(CHECKS, { assetKey: { path: assetPath }, checkName, limit }, 'assetCheckExecutions');
  return d.assetCheckExecutions;
}

const SCHEDULES = `query { repositoriesOrError { __typename ... on RepositoryConnection { nodes { name location { name } schedules { name cronSchedule scheduleState { status } } } } ... on PythonError { message } } }`;

export async function schedules() {
  const d = await gql(SCHEDULES, {}, 'repositoriesOrError');
  if (d.repositoriesOrError.__typename !== 'RepositoryConnection') throw new HopError({ component: 'dagster', hop: 'repositoriesOrError', reason: d.repositoriesOrError.message ?? d.repositoriesOrError.__typename });
  return d.repositoriesOrError.nodes.flatMap((n) => n.schedules.map((s) => ({ ...s, repository: n.name, location: n.location.name })));
}

/** Wait until a run reaches a terminal status; returns the run. */
export async function waitForRun(runId, { timeoutMs = 600000 } = {}) {
  const until = Date.now() + timeoutMs;
  const q = `query R($id: ID!) { runOrError(runId: $id) { __typename ... on Run { runId status tags { key value } } ... on RunNotFoundError { message } } }`;
  for (;;) {
    const d = await gql(q, { id: runId }, 'runOrError');
    const r = d.runOrError;
    if (r.__typename !== 'Run') throw new HopError({ component: 'dagster', hop: 'runOrError', reason: r.message ?? r.__typename });
    if (['SUCCESS', 'FAILURE', 'CANCELED'].includes(r.status)) return r;
    if (Date.now() > until) throw new HopError({ component: 'dagster', hop: 'runOrError', reason: `run ${runId} still ${r.status} after ${timeoutMs} ms` });
    await new Promise((res) => setTimeout(res, 5000));
  }
}
