import { NextResponse } from 'next/server';
import { secretStoreStatus } from '@core/infra/secrets';
import { keyHealthSummary } from '@core/infra/key-manager';

export const dynamic = 'force-dynamic';

// Liveness/readiness probe target — cheap, no backend calls.
//
// `connectionSecrets` EXPOSES the credential store's state (in-memory read, counts only): `ready`,
// `unavailable` (the cluster did not answer — the store retries with backoff), or `failed`
// (misconfigured). It deliberately does NOT turn the probe red: liveness shares this endpoint, and
// restarting os-ui would not fix an RBAC or API problem — it would only take every other tab down too.
//
// `connectionKeys` is COARSE on purpose — 'ok' (the data key is loaded) or 'degraded' (locked,
// unavailable, failed). This endpoint is unauthenticated: which key provider runs and whether a
// recovery key was saved are not for the internet. The details are behind
// /api/platform-admin/encryption-keys (admin session, or `?summary=1` with the service bearer — which the
// release smoke test uses in-cluster).
export function GET() {
  const s = secretStoreStatus();
  return NextResponse.json({
    status: 'ok',
    connectionSecrets: { backend: s.backend, status: s.status, failedWrites: s.failedWrites, unreadable: s.unreadable },
    connectionKeys: keyHealthSummary().status === 'ready' ? 'ok' : keyHealthSummary().status === 'unconfigured' ? 'n/a' : 'degraded',
  });
}
