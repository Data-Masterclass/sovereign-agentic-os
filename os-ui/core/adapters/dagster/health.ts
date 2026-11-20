/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Dagster health() — status and version from the webserver itself (design 00 §6).
 * USER STORY: As an operator I want the Platform page to show the Dagster version that is running.
 * ARCHITECTURE: GraphQL `{ version workspaceOrError { ... locationEntries { name loadStatus } } }`
 *   (https://docs.dagster.io/api/graphql). A location not LOADED is degraded.
 */
import { config } from '@core/kernel/config';
import type { ComponentHealth, Fetched } from '../_contract';
import { failed, readJson } from '../health/http';

const QUERY = '{ version workspaceOrError { __typename ... on Workspace { locationEntries { name loadStatus } } } }';
type Gql = { data?: { version?: string; workspaceOrError?: { __typename?: string; locationEntries?: { name: string; loadStatus: string }[] } } };

export async function dagsterHealth(base = config.dagsterUrl): Promise<Fetched<ComponentHealth>> {
  const r = await readJson<Gql>(`${base}/graphql`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: QUERY }) });
  if (!r.ok) return r;
  const version = r.value.data?.version;
  if (!version) return failed('invalid', 'GraphQL { version } returned nothing');
  const entries = r.value.data?.workspaceOrError?.locationEntries ?? [];
  const bad = entries.filter((e) => e.loadStatus !== 'LOADED');
  return { ok: true, at: r.at, value: { version, status: bad.length ? 'degraded' : 'ready', detail: bad.length ? `not loaded: ${bad.map((e) => `${e.name} (${e.loadStatus})`).join(', ')}` : `${entries.length} code location(s) loaded` } };
}
