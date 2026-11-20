/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Langfuse health() — status and version from Langfuse itself (design 00 §6).
 * USER STORY: As an operator I want the Platform page to show the Langfuse version that is running.
 * ARCHITECTURE: GET /api/public/health (unauthenticated,
 *   https://api.reference.langfuse.com/#tag/health): `{ status: "OK", version }`.
 */
import { config } from '@core/kernel/config';
import type { ComponentHealth, Fetched } from '../_contract';
import { failed, readJson } from '../health/http';

export async function langfuseHealth(base = config.langfuseUrl): Promise<Fetched<ComponentHealth>> {
  const r = await readJson<{ status?: string; version?: string }>(`${base}/api/public/health`);
  if (!r.ok) return r;
  if (!r.value.version) return failed('invalid', '/api/public/health has no version');
  return { ok: true, at: r.at, value: { version: r.value.version, status: r.value.status === 'OK' ? 'ready' : 'degraded', detail: `status ${r.value.status ?? '?'}` } };
}
