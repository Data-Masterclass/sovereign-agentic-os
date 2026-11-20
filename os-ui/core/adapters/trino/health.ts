/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Trino health() — status and version from Trino itself (design 00 §6).
 * USER STORY: As an operator I want the Platform page to show the Trino version that is running.
 * ARCHITECTURE: GET /v1/info (unauthenticated, https://trino.io/docs/current/develop/client-protocol.html):
 *   `nodeVersion.version`; `starting: true` is degraded.
 */
import { config } from '@core/kernel/config';
import type { ComponentHealth, Fetched } from '../_contract';
import { failed, readJson } from '../health/http';

type Info = { nodeVersion?: { version?: string }; starting?: boolean; environment?: string };

export async function trinoHealth(base = `http://${config.trinoHost}:${config.trinoPort}`): Promise<Fetched<ComponentHealth>> {
  const r = await readJson<Info>(`${base}/v1/info`);
  if (!r.ok) return r;
  const version = r.value.nodeVersion?.version;
  if (!version) return failed('invalid', '/v1/info has no nodeVersion.version');
  return { ok: true, at: r.at, value: { version, status: r.value.starting ? 'degraded' : 'ready', detail: r.value.starting ? 'starting' : `environment ${r.value.environment ?? '?'}` } };
}
