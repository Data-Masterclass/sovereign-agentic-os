/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Docling health() — status from docling-serve itself (design 00 §6).
 * USER STORY: As an operator I want to see whether document parsing is up.
 * ARCHITECTURE: GET /health (`{"status":"ok"}`). docling-serve has no version endpoint in the
 *   design's table, so `version` is null and the Platform page shows the pod's image tag.
 */
import { config } from '@core/kernel/config';
import type { ComponentHealth, Fetched } from '../_contract';
import { readJson } from '../health/http';

export async function doclingHealth(base = config.doclingUrl): Promise<Fetched<ComponentHealth>> {
  const r = await readJson<{ status?: string }>(`${base}/health`);
  if (!r.ok) return r;
  return { ok: true, at: r.at, value: { version: null, status: r.value.status === 'ok' ? 'ready' : 'degraded', detail: `status ${r.value.status ?? '?'}` } };
}
