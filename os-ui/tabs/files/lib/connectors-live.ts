/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import {
  type ConnectorClient,
  type ConnectorSource,
  type Provider,
  type Pull,
  type RemoteFile,
  mockClient,
} from '@tabs/files/lib/connectors';
import { offlineMockAllowed, refuseOfflineMock } from '@core/kernel/offline-mock';
import { config } from '@core/kernel/config';

/**
 * LIVE connector clients — real pulls against Google Drive / Microsoft Graph
 * (OneDrive) using the connection's OAuth **Read** token, behind the SAME
 * `ConnectorClient` interface as the mock. No token (the connection isn't wired) or
 * the API is unreachable → fall back to the deterministic mock client, honestly
 * labelled `mode: 'mock'`. This is the dual pattern: a deploy with a real Drive
 * connection syncs for real; kind uses the fake drive.
 *
 * THE HONESTY GATE (2026-11-18, review H2). Six branches here fell back to the fake drive — a
 * missing token, a non-OK HTTP response and a JSON parse failure, for each of the two providers —
 * and the fabrication was labelled `mode: 'mock'`, a DIFFERENT string from `offline-mock`, so
 * the original tripwire never saw this file at all. Every one of those files was then INDEXED:
 * the Files tab, the Knowledge retrieval and any agent reading them got documents that do not
 * exist in the customer's Drive. All six now go through `fakeDrive()`, which refuses unless this
 * deployment explicitly asked for the teaching flow. A broken Drive connection is an outage, and
 * an outage is the honest answer.
 *
 * Importable in tests (no server-only); only invoked from the server sync route,
 * which resolves the token from the governed Connection.
 */

async function get(url: string, token: string, ms = 8000): Promise<Response | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: ctrl.signal, cache: 'no-store' });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The fake-drive fallback, gated. `why` names the real cause (no token / HTTP status / unparseable
 * body) so a refusal tells the operator which of the three to fix — the old code collapsed all
 * three into the same silent substitution.
 */
function fakeDrive(provider: Provider, why: string): ConnectorClient {
  if (!offlineMockAllowed()) {
    refuseOfflineMock(
      `Cannot sync ${provider}: ${why} No files were read, and this deployment will not index ` +
        'placeholder documents in their place.',
    );
  }
  return mockClient(provider);
}

/** Google Drive: list a folder's files (incremental via the changes feed cursor). */
function googleDrive(token: string | null): ConnectorClient {
  return {
    provider: 'google-drive',
    mode: token ? 'live' : 'mock',
    async pull(source: ConnectorSource, sinceCursor: string | null): Promise<Pull> {
      if (!token) return fakeDrive('google-drive', 'the connection has no Read token.').pull(source, sinceCursor);
      const q = source.scope === 'folder' ? `'${source.target}' in parents and trashed=false` : 'trashed=false';
      const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,modifiedTime,md5Checksum,webViewLink)&pageSize=100`;
      const res = await get(url, token);
      if (!res || !res.ok) return fakeDrive('google-drive', `the Drive API answered ${res ? res.status : 'nothing (unreachable/timeout)'}.`).pull(source, sinceCursor);
      try {
        const json = (await res.json()) as { files?: Record<string, unknown>[] };
        const items: RemoteFile[] = (json.files ?? []).map((f) => ({
          remoteId: String(f.id),
          name: String(f.name ?? 'untitled'),
          path: source.scope === 'folder' ? `/${source.label}` : '/',
          mimeType: String(f.mimeType ?? 'application/octet-stream'),
          modifiedAt: String(f.modifiedTime ?? new Date().toISOString()),
          contentHash: String(f.md5Checksum ?? f.modifiedTime ?? f.id),
          url: String(f.webViewLink ?? ''),
        }));
        return { items, cursor: new Date().toISOString() };
      } catch {
        return fakeDrive('google-drive', 'the Drive API response could not be parsed.').pull(source, sinceCursor);
      }
    },
  };
}

/** OneDrive (Microsoft Graph): delta over the drive root / a folder. */
function oneDrive(token: string | null): ConnectorClient {
  const client: ConnectorClient = {
    provider: 'onedrive',
    mode: token ? 'live' : 'mock',
    async pull(source: ConnectorSource, sinceCursor: string | null): Promise<Pull> {
      if (!token) return fakeDrive('onedrive', 'the connection has no Read token.').pull(source, sinceCursor);
      // Use the saved deltaLink when present (incremental); otherwise a fresh delta.
      const base = sinceCursor && sinceCursor.startsWith('http')
        ? sinceCursor
        : source.scope === 'folder'
          ? `https://graph.microsoft.com/v1.0/me/drive/items/${source.target}/delta`
          : 'https://graph.microsoft.com/v1.0/me/drive/root/delta';
      const res = await get(base, token);
      if (!res || !res.ok) return fakeDrive('onedrive', `Microsoft Graph answered ${res ? res.status : 'nothing (unreachable/timeout)'}.`).pull(source, sinceCursor);
      try {
        const json = (await res.json()) as { value?: Record<string, unknown>[]; ['@odata.deltaLink']?: string };
        const items: RemoteFile[] = (json.value ?? [])
          .filter((it) => it.file)
          .map((it) => {
            const file = (it.file ?? {}) as Record<string, unknown>;
            const hashes = (file.hashes ?? {}) as Record<string, unknown>;
            return {
              remoteId: String(it.id),
              name: String(it.name ?? 'untitled'),
              path: `/${source.label}`,
              mimeType: String(file.mimeType ?? 'application/octet-stream'),
              modifiedAt: String(it.lastModifiedDateTime ?? new Date().toISOString()),
              contentHash: String(hashes.quickXorHash ?? hashes.sha256Hash ?? it.eTag ?? it.id),
              url: String(it.webUrl ?? ''),
            };
          });
        return { items, cursor: String(json['@odata.deltaLink'] ?? new Date().toISOString()) };
      } catch {
        return fakeDrive('onedrive', 'the Microsoft Graph response could not be parsed.').pull(source, sinceCursor);
      }
    },
  };
  // Content is read only with a token: the tokenless (teaching-flow) pull is the fake drive, whose
  // items carry their own text — there is no remote content to read.
  if (!token) return client;
  return {
    ...client,
    // Graph `GET /me/drive/items/{id}/content` (https://learn.microsoft.com/graph/api/driveitem-get-content):
    // a 302 to a pre-authenticated download URL, which fetch follows (dropping the bearer on the
    // cross-origin hop, as the spec requires — the download URL carries its own short-lived grant).
    async content(file: RemoteFile) {
      const fail = (why: string): never => {
        const e = new Error(`Cannot read "${file.name}" from OneDrive: ${why} Nothing was indexed for it.`) as Error & { status?: number };
        e.status = 502;
        throw e;
      };
      const res = await get(`https://graph.microsoft.com/v1.0/me/drive/items/${encodeURIComponent(file.remoteId)}/content`, token, 30_000);
      if (!res || !res.ok) return fail(`Microsoft Graph answered ${res ? res.status : 'nothing (unreachable/timeout)'}.`);
      const declared = Number(res.headers.get('content-length') ?? '0');
      if (declared > config.uploadMaxBytes) return fail(`it is larger than the ${Math.round(config.uploadMaxBytes / 1048576)} MB limit.`);
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > config.uploadMaxBytes) return fail(`it is larger than the ${Math.round(config.uploadMaxBytes / 1048576)} MB limit.`);
      return { bytes, contentType: res.headers.get('content-type') || file.mimeType || 'application/octet-stream' };
    },
  };
}

/** Resolve the client for a provider with the connection's access token (or null). */
export function liveClientFor(provider: Provider, token: string | null): ConnectorClient {
  return provider === 'google-drive' ? googleDrive(token) : oneDrive(token);
}
