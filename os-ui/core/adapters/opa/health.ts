/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    OPA health() — status and version from OPA itself (design 00 §6).
 * USER STORY: As an operator I want the Platform page to show the OPA version that is running.
 * ARCHITECTURE: GET /health (https://www.openpolicyagent.org/docs/rest-api#health-api): 200 ready,
 *   anything else degraded. Version: GET /v1/config → `result.labels.version`, which OPA sets
 *   itself (https://www.openpolicyagent.org/docs/rest-api#config-api).
 */
import { config } from '@core/kernel/config';
import type { ComponentHealth, Fetched } from '../_contract';
import { failed, readHttp, readJson } from '../health/http';

export async function opaHealth(base = config.opaUrl): Promise<Fetched<ComponentHealth>> {
  const cfg = await readJson<{ result?: { labels?: { version?: string } } }>(`${base}/v1/config`);
  if (!cfg.ok) return cfg;
  const version = cfg.value.result?.labels?.version;
  if (!version) return failed('invalid', '/v1/config has no result.labels.version');
  const h = await readHttp(`${base}/health`);
  return { ok: true, at: cfg.at, value: { version, status: h.ok ? 'ready' : 'degraded', detail: h.ok ? 'healthy' : h.detail } };
}
