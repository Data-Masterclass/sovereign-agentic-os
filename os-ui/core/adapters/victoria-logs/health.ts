/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    VictoriaLogs health() — status and version from VictoriaLogs itself (design 00 §6).
 * USER STORY: As an operator I want the Platform page to show the VictoriaLogs version that is running.
 * ARCHITECTURE: GET /health ("OK"); GET /metrics → the `app_version` label every VictoriaMetrics
 *   binary puts on its own series: the release tag for a release build, the whole string otherwise;
 *   no label at all → version null (the page then shows the pod's image tag, labelled).
 */
import { config } from '@core/kernel/config';
import type { ComponentHealth, Fetched } from '../_contract';
import { readHttp, vmVersion } from '../health/http';

export async function victoriaLogsHealth(base = config.victoriaLogsUrl): Promise<Fetched<ComponentHealth>> {
  const m = await readHttp(`${base}/metrics`);
  if (!m.ok) return m;
  const version = vmVersion(m.value.text);
  const h = await readHttp(`${base}/health`);
  return { ok: true, at: m.at, value: { version, status: h.ok && h.value.text.trim() === 'OK' ? 'ready' : 'degraded', detail: h.ok ? h.value.text.trim() : h.detail } };
}
