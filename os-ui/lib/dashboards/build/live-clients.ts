/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { config } from '@/lib/core/config';
import { importDashboardBundle, deleteDashboardByName } from '@/lib/superset/client';
import { csrf, serviceHeaders } from '@/lib/superset/auth';
import { type DashboardLiveDeps, type EmbedClient, type SupersetClient } from './live.ts';
import { type GuestTokenRequest } from '../embed.ts';

/**
 * The REAL fetch-backed Superset + embed clients (server-only). Exact request shapes are
 * the documented Superset REST endpoints (dashboard import/list, report/alert create,
 * guest-token mint); validated end-to-end on the real deploy. On a laptop Superset is
 * unreachable, so the server boundary falls back to the offline-mock. A network/HTTP
 * failure throws or returns falsy ⇒ the adapter reports ✗.
 *
 * R3: the guest token is minted by a SERVICE account but CARRIES THE VIEWER'S RLS
 * (`req.rls`) — the security travels in the token's payload, scoped to the viewer.
 */

async function withTimeout(url: string, init: RequestInit, ms = 5000): Promise<Response | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal, cache: 'no-store' });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function realSuperset(): SupersetClient {
  const base = config.supersetInternalUrl;
  return {
    async importBundle(_name, bundle) {
      // Build the real import_assets ZIP from the manifest and POST it multipart; a
      // non-2xx (incl. auth) throws → ✗ → the honest offline-mock fallback.
      await importDashboardBundle(base, bundle);
    },
    async dashboardExists(name) {
      const q = encodeURIComponent(JSON.stringify({ filters: [{ col: 'dashboard_title', opr: 'ct', value: name }] }));
      const res = await withTimeout(`${base}/api/v1/dashboard/?q=${q}`, { method: 'GET' });
      if (!res || !res.ok) return false;
      const d = (await res.json().catch(() => ({}))) as { count?: number };
      return (d.count ?? 0) > 0;
    },
    async deleteDashboard(name) {
      // Real DELETE /api/v1/dashboard/{id} (id resolved by title); throws → ✗.
      return deleteDashboardByName(base, name);
    },
    async createReport(spec) {
      const res = await withTimeout(`${base}/api/v1/report/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'Report', name: `${spec.dashboard} (${spec.cadence})`, crontab: spec.cadence }),
      });
      if (!res || !res.ok) throw new Error(`Superset report create failed (${res?.status ?? 'unreachable'})`);
      const d = (await res.json().catch(() => ({}))) as { id?: number };
      return String(d.id ?? '');
    },
    async reportExists(id) {
      if (!id) return false;
      const res = await withTimeout(`${base}/api/v1/report/${id}`, { method: 'GET' });
      return Boolean(res && res.ok);
    },
    async createAlert(rule) {
      const res = await withTimeout(`${base}/api/v1/report/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'Alert', name: `${rule.member} ${rule.comparator} ${rule.threshold}` }),
      });
      if (!res || !res.ok) throw new Error(`Superset alert create failed (${res?.status ?? 'unreachable'})`);
      const d = (await res.json().catch(() => ({}))) as { id?: number };
      return String(d.id ?? '');
    },
    async alertExists(id) {
      if (!id) return false;
      const res = await withTimeout(`${base}/api/v1/report/${id}`, { method: 'GET' });
      return Boolean(res && res.ok);
    },
  };
}

export function realEmbed(): EmbedClient {
  const base = config.supersetInternalUrl;
  return {
    async mint(req: GuestTokenRequest) {
      // POST /api/v1/security/guest_token/ with a service account; the token PAYLOAD
      // carries the viewer's RLS (req.rls) so the embed is scoped to the viewer (R3).
      // The mint endpoint is CSRF-protected like every other Superset write, so we run
      // the shared authenticated handshake first (CSRF token + session cookie + the
      // trusted X-Forwarded-User), then POST with those headers. `req.resourceId` is the
      // dashboard's EMBEDDED UUID (resolved upstream via ensureEmbedded), which is what a
      // guest token must target.
      const auth = await csrf(fetch, base);
      const res = await withTimeout(`${base}/api/v1/security/guest_token/`, {
        method: 'POST',
        headers: serviceHeaders(base, auth, { 'content-type': 'application/json', accept: 'application/json' }),
        body: JSON.stringify({
          user: req.user,
          resources: [{ type: req.resourceType, id: req.resourceId }],
          rls: req.rls,
        }),
      });
      if (!res || !res.ok) throw new Error(`guest token mint failed (${res?.status ?? 'unreachable'})`);
      const d = (await res.json().catch(() => ({}))) as { token?: string };
      if (!d.token) throw new Error('guest token mint returned no token');
      return { token: d.token, expiresInSeconds: req.ttlSeconds };
    },
  };
}

export function makeRealDashboardClients(): DashboardLiveDeps {
  return { superset: realSuperset(), embed: realEmbed() };
}

/** Superset reachable? The switch between the LIVE path and the offline-mock. */
export async function liveDashboardsReachable(): Promise<boolean> {
  const res = await withTimeout(`${config.supersetInternalUrl}/health`, { method: 'GET' }, 2500);
  return Boolean(res && res.ok);
}
