/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    VictoriaMetrics health() — status and version from VictoriaMetrics itself (design 00 §6).
 * USER STORY: As an operator I want the Platform page to show the VictoriaMetrics version that is running.
 * ARCHITECTURE: GET /health ("OK"); GET /metrics → the `app_version` label every VictoriaMetrics
 *   binary puts on its own series (`victoria-…-tags-v1.156.0-0-g…`): the release tag is the version.
 */
import { config } from '@core/kernel/config';
import type { ComponentHealth, Fetched } from '../_contract';
import { failed, readHttp, vmReleaseTag } from '../health/http';

export async function victoriaMetricsHealth(base = config.victoriaMetricsUrl): Promise<Fetched<ComponentHealth>> {
  const m = await readHttp(`${base}/metrics`);
  if (!m.ok) return m;
  const version = vmReleaseTag(m.value.text);
  if (!version) return failed('invalid', '/metrics carries no app_version with a release tag');
  const h = await readHttp(`${base}/health`);
  return { ok: true, at: m.at, value: { version, status: h.ok && h.value.text.trim() === 'OK' ? 'ready' : 'degraded', detail: h.ok ? h.value.text.trim() : h.detail } };
}
