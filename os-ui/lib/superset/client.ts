/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { buildImportZip } from './import-bundle.ts';
import { csrf, serviceHeaders, serviceUser, withTimeout } from './auth.ts';

/**
 * The server-only wire call that actually LANDS a dashboard in Superset: build the
 * import_assets ZIP from the manifest and POST it as multipart form-data to
 * `/api/v1/dashboard/import/` (the `formData` file field + `overwrite=true` +
 * `passwords={}`), preceded by a best-effort CSRF-token fetch.
 *
 * Auth: Superset here runs behind trusted-proxy SSO (AUTH_REMOTE_USER); the shared
 * handshake in ./auth.ts presents the service account via `X-Forwarded-User`
 * (SUPERSET_SERVICE_USER, default `admin`), carries the session cookie from the CSRF call,
 * and sends `X-CSRFToken`. If CSRF can't be fetched (endpoint disabled), we still attempt
 * the import — a non-2xx throws so the adapter reports ✗ and the caller falls back to the
 * honest offline-mock.
 *
 * `fetchImpl` is injectable (default global `fetch`) so the multipart/CSRF flow is
 * unit-testable against a fake, mirroring lib/agents/build/live-clients.ts.
 */

/** Build the ZIP for the manifest and import it into Superset. Throws on any failure. */
export async function importDashboardBundle(
  base: string,
  bundle: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const zip = buildImportZip(bundle); // throws on a malformed manifest ⇒ ✗
  const auth = await csrf(fetchImpl, base);

  const form = new FormData();
  form.append('formData', new Blob([zip], { type: 'application/zip' }), 'dashboard_export.zip');
  form.append('overwrite', 'true');
  form.append('passwords', '{}');

  const headers = serviceHeaders(base, auth);

  const res = await withTimeout(fetchImpl, `${base}/api/v1/dashboard/import/`, {
    method: 'POST',
    headers,
    body: form,
  });
  if (!res || !res.ok) throw new Error(`Superset import failed (${res?.status ?? 'unreachable'})`);
}

/**
 * PHYSICALLY delete a Superset dashboard by TITLE (the delete side of the Dashboards
 * lifecycle). Resolves the numeric id via the list endpoint (we key our records by name,
 * not the Superset id), then `DELETE /api/v1/dashboard/{id}` with the CSRF token. Returns
 * `false` when no dashboard by that title exists (already gone — an honest, non-fatal
 * outcome); throws on a hard failure so the caller reports ✗. `fetchImpl` is injectable.
 */
export async function deleteDashboardByName(
  base: string,
  name: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const auth = await csrf(fetchImpl, base);
  const id = await resolveDashboardIdByTitle(base, name, fetchImpl);
  if (id == null) return false; // no such dashboard — already gone

  const headers = serviceHeaders(base, auth, { accept: 'application/json' });
  const delRes = await withTimeout(fetchImpl, `${base}/api/v1/dashboard/${id}`, { method: 'DELETE', headers });
  if (!delRes || !delRes.ok) throw new Error(`Superset dashboard delete failed (${delRes?.status ?? 'unreachable'})`);
  return true;
}

/**
 * Resolve a Superset dashboard's numeric id from its TITLE (we key our records by name,
 * not the Superset id). Returns null when no dashboard by that title exists; throws on a
 * hard lookup failure.
 */
export async function resolveDashboardIdByTitle(
  base: string,
  name: string,
  fetchImpl: typeof fetch = fetch,
): Promise<number | null> {
  const q = encodeURIComponent(JSON.stringify({ filters: [{ col: 'dashboard_title', opr: 'ct', value: name }] }));
  const listRes = await withTimeout(fetchImpl, `${base}/api/v1/dashboard/?q=${q}`, {
    method: 'GET',
    headers: { 'X-Forwarded-User': serviceUser(), accept: 'application/json' },
  });
  if (!listRes || !listRes.ok) throw new Error(`Superset dashboard lookup failed (${listRes?.status ?? 'unreachable'})`);
  const data = (await listRes.json().catch(() => ({}))) as { result?: { id: number; dashboard_title?: string }[] };
  // EXACT title only. The query is a `contains` filter (Superset has no exact-match opr for
  // this column), so it can return near-matches; binding to `result[0]` would silently embed
  // the WRONG dashboard on a rename/typo (e.g. "Contribution" vs "Contrib. by region"). We
  // resolve only on an exact title match and return null otherwise — an honest "not found"
  // the caller surfaces, rather than a plausible-but-wrong embed.
  const match = (data.result ?? []).find((d) => d.dashboard_title === name);
  return match ? match.id : null;
}

/**
 * Ensure a Superset dashboard is REGISTERED FOR EMBEDDING and return its embedded UUID —
 * the id a guest token must target (NOT the numeric/OS dashboard id). GETs
 * `/api/v1/dashboard/{id}/embedded`; if none exists yet, POSTs to create the registration
 * (`allowed_domains: []` = allow any host — the embed always runs through the os-ui proxy).
 * Uses the SAME authenticated handshake as import/delete. Throws on a hard failure so the
 * caller falls back to the honest offline-mock.
 */
export async function ensureEmbedded(
  base: string,
  dashboardId: number,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const auth = await csrf(fetchImpl, base);

  const getRes = await withTimeout(fetchImpl, `${base}/api/v1/dashboard/${dashboardId}/embedded`, {
    method: 'GET',
    headers: serviceHeaders(base, auth, { accept: 'application/json' }),
  });
  if (getRes && getRes.ok) {
    const data = (await getRes.json().catch(() => ({}))) as { result?: { uuid?: string } };
    const uuid = data.result?.uuid;
    if (uuid) return uuid;
  }

  // Not registered yet (404 / empty result) → create the embedded configuration.
  const postRes = await withTimeout(fetchImpl, `${base}/api/v1/dashboard/${dashboardId}/embedded`, {
    method: 'POST',
    headers: serviceHeaders(base, auth, { 'content-type': 'application/json', accept: 'application/json' }),
    body: JSON.stringify({ allowed_domains: [] }),
  });
  if (!postRes || !postRes.ok) throw new Error(`Superset embedded-registration failed (${postRes?.status ?? 'unreachable'})`);
  const data = (await postRes.json().catch(() => ({}))) as { result?: { uuid?: string } };
  const uuid = data.result?.uuid;
  if (!uuid) throw new Error('Superset embedded-registration returned no uuid');
  return uuid;
}
