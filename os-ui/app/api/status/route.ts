import { NextResponse } from 'next/server';
import { config } from '@/lib/config';

export const dynamic = 'force-dynamic';

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
  {
    key: 'langfuse',
    label: 'Observability',
    url: `${config.langfuseUrl}/api/public/health`,
  },
];

async function ping(p: Probe): Promise<{ key: string; label: string; up: boolean; detail: string }> {
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

/**
 * Home stack-status strip. Server-side pings each backend's health endpoint in
 * parallel and reports up/down. No backend address or key reaches the browser.
 */
export async function GET() {
  const results = await Promise.all(PROBES.map(ping));
  const up = results.filter((r) => r.up).length;
  return NextResponse.json({ services: results, up, total: results.length });
}
