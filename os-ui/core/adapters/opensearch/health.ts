/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    OpenSearch health() — status and version from OpenSearch itself (design 00 §6).
 * USER STORY: As an operator I want the Platform page to show the OpenSearch version that is running.
 * ARCHITECTURE: GET / → `version.number`; GET /_cluster/health → green/yellow ready, red degraded.
 *   URL and credentials come from the one OpenSearch client (./client.ts).
 */
import type { ComponentHealth, Fetched } from '../_contract';
import { failed, readJson } from '../health/http';
import { opensearchAuthHeaders, opensearchRequestUrl } from './client';

export async function opensearchHealth(url: (p: string) => string = opensearchRequestUrl): Promise<Fetched<ComponentHealth>> {
  const headers = opensearchAuthHeaders();
  const root = await readJson<{ version?: { number?: string; distribution?: string } }>(url('/'), { headers });
  if (!root.ok) return root;
  const version = root.value.version?.number;
  if (!version) return failed('invalid', 'GET / has no version.number');
  const h = await readJson<{ status?: string; number_of_nodes?: number }>(url('/_cluster/health'), { headers });
  if (!h.ok) return { ok: true, at: root.at, value: { version, status: 'degraded', detail: `cluster health unreadable: ${h.detail}` } };
  const status = h.value.status === 'red' ? 'degraded' : 'ready';
  return { ok: true, at: h.at, value: { version, status, detail: `cluster ${h.value.status ?? '?'}, ${h.value.number_of_nodes ?? '?'} node(s)` } };
}
