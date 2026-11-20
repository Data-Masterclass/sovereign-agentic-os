/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    LiteLLM health() — status and version from the gateway itself (design 00 §6).
 * USER STORY: As an operator I want the Platform page to show the LiteLLM version that is running.
 * ARCHITECTURE:
 *   - Status: GET /health/readiness (unauthenticated, https://docs.litellm.ai/docs/proxy/health).
 *   - Version: `litellm_version` in that body where the gateway still returns it (≤ 1.90). From
 *     1.109 the public body is only `{status, db}` (the detail moved behind auth to
 *     /health/readiness/details), so the version is the gateway's own OpenAPI `info.version`
 *     (GET /openapi.json, unauthenticated). Neither → null (the page shows the image tag, labelled).
 *   - No key is used: the master key never enters this path.
 */
import { config } from '@core/kernel/config';
import type { ComponentHealth, Fetched } from '../_contract';
import { readJson } from '../health/http';

type Readiness = { status?: string; litellm_version?: string; db?: string };

export async function litellmHealth(base = config.litellmUrl): Promise<Fetched<ComponentHealth>> {
  const r = await readJson<Readiness>(`${base}/health/readiness`);
  if (!r.ok) return r;
  let version = r.value.litellm_version ?? null;
  let note = '';
  if (!version) {
    const api = await readJson<{ info?: { version?: string } }>(`${base}/openapi.json`);
    version = api.ok ? (api.value.info?.version ?? null) : null;
    note = api.ok ? '' : `; version unreadable (${api.reason})`;
  }
  const ok = r.value.status === 'healthy' && (r.value.db === undefined || r.value.db === 'connected' || r.value.db === 'Not connected');
  return { ok: true, at: r.at, value: { version, status: ok ? 'ready' : 'degraded', detail: `status ${r.value.status ?? '?'}, db ${r.value.db ?? '?'}${note}` } };
}
