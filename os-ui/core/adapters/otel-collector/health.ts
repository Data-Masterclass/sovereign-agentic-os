/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    OpenTelemetry Collector health() — status and version from the Collector itself.
 * USER STORY: As an operator I want the Platform page to show the Collector version that is running.
 * ARCHITECTURE: the health_check extension (GET :13133/, https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/extension/healthcheckextension)
 *   for status; the Collector's own metrics (:8888) carry `service_version` on every series.
 */
import { config } from '@core/kernel/config';
import type { ComponentHealth, Fetched } from '../_contract';
import { failed, promLabel, readHttp, readJson } from '../health/http';

export async function otelCollectorHealth(healthBase = config.otelCollectorHealthUrl, metricsBase = config.otelCollectorMetricsUrl): Promise<Fetched<ComponentHealth>> {
  const m = await readHttp(`${metricsBase}/metrics`);
  if (!m.ok) return m;
  const version = promLabel(m.value.text, 'otelcol_process_uptime_seconds_total', 'service_version') ?? promLabel(m.value.text, 'target_info', 'service_version');
  if (!version) return failed('invalid', 'the Collector metrics carry no service_version');
  const h = await readJson<{ status?: string }>(`${healthBase}/`);
  return { ok: true, at: m.at, value: { version, status: h.ok ? 'ready' : 'degraded', detail: h.ok ? (h.value.status ?? 'available') : h.detail } };
}
