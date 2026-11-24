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
// `connectionKeys` (envelope encryption, core/infra/key-manager.ts): status, provider id and whether a
// recovery key is CONFIRMED — read from the record this process verified (HMAC), never from a raw
// annotation. Non-secret; the prod release smoke test reads it (scripts/lib/conn-key-check.py).
export function GET() {
  const s = secretStoreStatus();
  return NextResponse.json({
    status: 'ok',
    connectionSecrets: { backend: s.backend, status: s.status, failedWrites: s.failedWrites, unreadable: s.unreadable, unknownKey: s.unknownKey },
    connectionKeys: keyHealthSummary(),
  });
}
