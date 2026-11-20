/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    LiteLLM health() — status and version from the gateway itself (design 00 §6).
 * USER STORY: As an operator I want the Platform page to show the LiteLLM version that is running.
 * ARCHITECTURE: GET /health/readiness (unauthenticated,
 *   https://docs.litellm.ai/docs/proxy/health#readiness): `status` and `litellm_version`.
 */
import { config } from '@core/kernel/config';
import type { ComponentHealth, Fetched } from '../_contract';
import { failed, readJson } from '../health/http';

type Readiness = { status?: string; litellm_version?: string; db?: string };

export async function litellmHealth(base = config.litellmUrl): Promise<Fetched<ComponentHealth>> {
  const r = await readJson<Readiness>(`${base}/health/readiness`);
  if (!r.ok) return r;
  const version = r.value.litellm_version;
  if (!version) return failed('invalid', '/health/readiness has no litellm_version');
  const ok = r.value.status === 'healthy' || r.value.status === 'connected';
  return { ok: true, at: r.at, value: { version, status: ok ? 'ready' : 'degraded', detail: `status ${r.value.status ?? '?'}, db ${r.value.db ?? '?'}` } };
}
