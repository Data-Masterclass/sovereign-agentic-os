import { NextResponse } from 'next/server';
import { secretStoreStatus } from '@core/infra/secrets';
import { keyHealthSummary } from '@core/infra/key-manager';
import { blobStoreMode } from '@tabs/files/lib/object-store';
import '@tabs/files/lib/object-store-server'; // registers the Files blob backend, so its mode is known

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
//
// `filesBlobStore` says where uploaded originals live: 'object-storage', or 'memory' — the explicit
// FILES_BLOB_STORE=memory laptop/demo mode, in which uploads are lost on restart (also a warning on
// /api/status). Never a silent fallback: with object storage, a write it does not confirm fails the upload.
export function GET() {
  const s = secretStoreStatus();
  const keys = keyHealthSummary().status;
  return NextResponse.json({
    status: 'ok',
    connectionSecrets: { backend: s.backend, status: s.status, failedWrites: s.failedWrites, unreadable: s.unreadable },
    connectionKeys: keys === 'ready' ? 'ok' : keys === 'unconfigured' ? 'n/a' : 'degraded',
    filesBlobStore: blobStoreMode(),
  });
}
