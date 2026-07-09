/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import 'server-only';
import { config } from '@/lib/core/config';

/**
 * Platform-service connectivity probes — the internal control-plane backends the
 * stack is wired to (gateway, policy, retrieval, observability, …). This is
 * INFRASTRUCTURE, so it lives in Platform Admin → Components and the Home stack
 * strip — NOT in the Connections tab (which is for external systems agents can
 * use as tools). Server-side only: each probe hits a health endpoint in
 * parallel; no backend address or key ever reaches the browser.
 */

export type ServiceProbe = { key: string; label: string; up: boolean; detail: string };
export type ServicesStatus = { services: ServiceProbe[]; up: number; total: number };

type Probe = {
  key: string;
  label: string;
  url: string;
  // Some backends 401/403 when reachable-but-unauthed; treat those as "up".
  okStatuses?: number[];
};

const PROBES: Probe[] = [
  { key: 'sample-agent', label: 'Agent core', url: `${config.sampleAgentUrl}/health` },
  { key: 'query-tool', label: 'Lakehouse', url: `${config.queryToolUrl}/health` },
  { key: 'opensearch', label: 'Retrieval', url: `${config.opensearchUrl}/_cluster/health` },
  { key: 'litellm', label: 'Gateway', url: `${config.litellmUrl}/health/liveliness` },
  { key: 'opa', label: 'Policy', url: `${config.opaUrl}/health` },
  { key: 'forgejo', label: 'Software', url: `${config.forgejoUrl}/api/healthz` },
  { key: 'dagster', label: 'Orchestration', url: `${config.dagsterUrl}/server_info` },
  { key: 'langfuse', label: 'Observability', url: `${config.langfuseUrl}/api/public/health` },
];

async function ping(p: Probe): Promise<ServiceProbe> {
  const okStatuses = p.okStatuses ?? [200, 204];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);
  try {
    const res = await fetch(p.url, { cache: 'no-store', signal: ctrl.signal });
    const up = okStatuses.includes(res.status) || (res.status >= 200 && res.status < 300);
    return { key: p.key, label: p.label, up, detail: `HTTP ${res.status}` };
  } catch (e) {
    return { key: p.key, label: p.label, up: false, detail: (e as Error).name === 'AbortError' ? 'timeout' : 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

/** Probe every platform service in parallel and roll up an up/total summary. */
export async function probeServices(): Promise<ServicesStatus> {
  const services = await Promise.all(PROBES.map(ping));
  const up = services.filter((r) => r.up).length;
  return { services, up, total: services.length };
}
