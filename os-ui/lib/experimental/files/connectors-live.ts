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
} from './connectors.ts';

/**
 * LIVE connector clients — real pulls against Google Drive / Microsoft Graph
 * (OneDrive) using the connection's OAuth **Read** token, behind the SAME
 * `ConnectorClient` interface as the mock. No token (the connection isn't wired) or
 * the API is unreachable → fall back to the deterministic mock client, honestly
 * labelled `mode: 'mock'`. This is the dual pattern: a deploy with a real Drive
 * connection syncs for real; kind uses the fake drive.
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

/** Google Drive: list a folder's files (incremental via the changes feed cursor). */
function googleDrive(token: string | null): ConnectorClient {
  return {
    provider: 'google-drive',
    mode: token ? 'live' : 'mock',
    async pull(source: ConnectorSource, sinceCursor: string | null): Promise<Pull> {
      if (!token) return mockClient('google-drive').pull(source, sinceCursor);
      const q = source.scope === 'folder' ? `'${source.target}' in parents and trashed=false` : 'trashed=false';
      const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,modifiedTime,md5Checksum,webViewLink)&pageSize=100`;
      const res = await get(url, token);
      if (!res || !res.ok) return mockClient('google-drive').pull(source, sinceCursor);
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
        return mockClient('google-drive').pull(source, sinceCursor);
      }
    },
  };
}

/** OneDrive (Microsoft Graph): delta over the drive root / a folder. */
function oneDrive(token: string | null): ConnectorClient {
  return {
    provider: 'onedrive',
    mode: token ? 'live' : 'mock',
    async pull(source: ConnectorSource, sinceCursor: string | null): Promise<Pull> {
      if (!token) return mockClient('onedrive').pull(source, sinceCursor);
      // Use the saved deltaLink when present (incremental); otherwise a fresh delta.
      const base = sinceCursor && sinceCursor.startsWith('http')
        ? sinceCursor
        : source.scope === 'folder'
          ? `https://graph.microsoft.com/v1.0/me/drive/items/${source.target}/delta`
          : 'https://graph.microsoft.com/v1.0/me/drive/root/delta';
      const res = await get(base, token);
      if (!res || !res.ok) return mockClient('onedrive').pull(source, sinceCursor);
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
        return mockClient('onedrive').pull(source, sinceCursor);
      }
    },
  };
}

/** Resolve the client for a provider with the connection's access token (or null). */
export function liveClientFor(provider: Provider, token: string | null): ConnectorClient {
  return provider === 'google-drive' ? googleDrive(token) : oneDrive(token);
}
