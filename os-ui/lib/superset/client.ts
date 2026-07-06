/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { buildImportZip } from './import-bundle.ts';

/**
 * The server-only wire call that actually LANDS a dashboard in Superset: build the
 * import_assets ZIP from the manifest and POST it as multipart form-data to
 * `/api/v1/dashboard/import/` (the `formData` file field + `overwrite=true` +
 * `passwords={}`), preceded by a best-effort CSRF-token fetch.
 *
 * Auth: Superset here runs behind trusted-proxy SSO (AUTH_REMOTE_USER); we present the
 * service account via `X-Forwarded-User` (SUPERSET_SERVICE_USER, default `admin`), carry
 * the session cookie from the CSRF call, and send `X-CSRFToken`. If CSRF can't be
 * fetched (endpoint disabled), we still attempt the import — a non-2xx throws so the
 * adapter reports ✗ and the caller falls back to the honest offline-mock.
 *
 * `fetchImpl` is injectable (default global `fetch`) so the multipart/CSRF flow is
 * unit-testable against a fake, mirroring lib/agents/build/live-clients.ts.
 */

function serviceUser(): string {
  return process.env.SUPERSET_SERVICE_USER || 'admin';
}

async function withTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  ms = 8000,
): Promise<Response | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetchImpl(url, { ...init, signal: ctrl.signal, cache: 'no-store' });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Best-effort: fetch a CSRF token + session cookie. Returns {} when unavailable. */
async function csrf(fetchImpl: typeof fetch, base: string): Promise<{ token?: string; cookie?: string }> {
  const res = await withTimeout(fetchImpl, `${base}/api/v1/security/csrf_token/`, {
    method: 'GET',
    headers: { 'X-Forwarded-User': serviceUser(), accept: 'application/json' },
  });
  if (!res || !res.ok) return {};
  const raw = res.headers.get('set-cookie');
  const cookie = raw ? raw.split(/,(?=[^;]+=)/).map((c) => c.split(';')[0].trim()).join('; ') : undefined;
  const data = (await res.json().catch(() => ({}))) as { result?: string };
  return { token: data.result, cookie };
}

/** Build the ZIP for the manifest and import it into Superset. Throws on any failure. */
export async function importDashboardBundle(
  base: string,
  bundle: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const zip = buildImportZip(bundle); // throws on a malformed manifest ⇒ ✗
  const { token, cookie } = await csrf(fetchImpl, base);

  const form = new FormData();
  form.append('formData', new Blob([zip], { type: 'application/zip' }), 'dashboard_export.zip');
  form.append('overwrite', 'true');
  form.append('passwords', '{}');

  const headers: Record<string, string> = { 'X-Forwarded-User': serviceUser(), Referer: base };
  if (token) headers['X-CSRFToken'] = token;
  if (cookie) headers['Cookie'] = cookie;

  const res = await withTimeout(fetchImpl, `${base}/api/v1/dashboard/import/`, {
    method: 'POST',
    headers,
    body: form,
  });
  if (!res || !res.ok) throw new Error(`Superset import failed (${res?.status ?? 'unreachable'})`);
}
