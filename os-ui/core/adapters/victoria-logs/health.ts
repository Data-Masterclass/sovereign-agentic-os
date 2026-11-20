/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    VictoriaLogs health() — status and version from VictoriaLogs itself (design 00 §6).
 * USER STORY: As an operator I want the Platform page to show the VictoriaLogs version that is running.
 * ARCHITECTURE: GET /health ("OK"); GET /metrics → `vm_app_version{short_version="v…"}`, the build
 *   version every VictoriaMetrics binary exports about itself.
 */
import { config } from '@core/kernel/config';
import type { ComponentHealth, Fetched } from '../_contract';
import { failed, promLabel, readHttp } from '../health/http';

export async function victoriaLogsHealth(base = config.victoriaLogsUrl): Promise<Fetched<ComponentHealth>> {
  const m = await readHttp(`${base}/metrics`);
  if (!m.ok) return m;
  const version = promLabel(m.value.text, 'vm_app_version', 'short_version');
  if (!version) return failed('invalid', '/metrics has no vm_app_version short_version');
  const h = await readHttp(`${base}/health`);
  return { ok: true, at: m.at, value: { version, status: h.ok && h.value.text.trim() === 'OK' ? 'ready' : 'degraded', detail: h.ok ? h.value.text.trim() : h.detail } };
}
