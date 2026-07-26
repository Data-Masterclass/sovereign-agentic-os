/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import PageHeader from '@/components/PageHeader';

/**
 * Platform Admin → Drive OAuth apps. Register the ONE Google Cloud OAuth client and
 * the ONE Azure app the connected-drive flow federates to. Same discipline as the
 * model provider keys: the raw client SECRET is written once to Secrets Manager
 * server-side; the catalog keeps only a reference + fingerprint, and this page never
 * shows or logs the raw value. Users then connect their OWN drive with their OWN
 * account from the Connections tab.
 */

type OAuthProvider = 'google' | 'microsoft';
type CatalogEntry = { provider: OAuthProvider; label: string; scopes: string[]; configured: boolean };
type App = { provider: OAuthProvider; clientId: string; fingerprint: string; addedBy: string; addedAt: string };

const APP_BASE = 'https://agentic.datamasterclass.com';
const REDIRECT_URI: Record<OAuthProvider, string> = {
  google: `${APP_BASE}/api/connections/oauth/google/callback`,
  microsoft: `${APP_BASE}/api/connections/oauth/microsoft/callback`,
};
const CONSOLE: Record<OAuthProvider, { name: string; url: string }> = {
  google: { name: 'Google Cloud Console → APIs & Services → Credentials', url: 'https://console.cloud.google.com/apis/credentials' },
  microsoft: { name: 'Azure Portal → App registrations', url: 'https://portal.azure.com' },
};

export default function OAuthAppsPage() {
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [apps, setApps] = useState<App[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [toast, setToast] = useState('');
  const [form, setForm] = useState<Record<OAuthProvider, { clientId: string; clientSecret: string; tenant: string }>>({
    google: { clientId: '', clientSecret: '', tenant: '' },
    microsoft: { clientId: '', clientSecret: '', tenant: '' },
  });

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const res = await fetch('/api/platform-admin/oauth-apps', { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? 'Failed to load OAuth apps');
      else { setCatalog(body.catalog ?? []); setApps(body.apps ?? []); }
    } catch (e) { setError((e as Error).message); } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const register = useCallback(async (provider: OAuthProvider) => {
    const f = form[provider];
    if (!f.clientId.trim() || !f.clientSecret.trim()) return;
    setBusy(provider); setError(''); setToast('');
    try {
      const res = await fetch('/api/platform-admin/oauth-apps', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider, clientId: f.clientId.trim(), clientSecret: f.clientSecret, tenant: f.tenant.trim() || undefined }),
      });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? 'Failed to register the OAuth app');
      else {
        setToast(`Registered the ${provider} OAuth app — client secret stored in the secrets manager (${body.app.fingerprint}). The raw secret was never returned.`);
        setForm((s) => ({ ...s, [provider]: { clientId: '', clientSecret: '', tenant: '' } }));
        await load();
      }
    } catch (e) { setError((e as Error).message); } finally { setBusy(''); }
  }, [form, load]);

  return (
    <>
      <PageHeader title="Drive OAuth apps" crumb="platform · Google & Microsoft apps for connected drives" />
      <div className="content">
        <p className="lead">
          Register the tenant&rsquo;s <strong>Google Cloud OAuth client</strong> and <strong>Azure app</strong> once. Each
          user then connects their <strong>own</strong> Google Drive or OneDrive with their <strong>own</strong> account from
          the <Link href="/connections">Connections</Link> tab — through the provider consent screen. The client
          secret is written <strong>via the secrets manager</strong>; the catalog keeps only a reference + fingerprint and
          <strong> never shows or logs the raw secret</strong>.
        </p>

        {toast ? <div className="hint" style={{ color: 'var(--teal)' }}>{toast}</div> : null}
        {error ? <div className="error">{error}</div> : null}
        {loading && catalog.length === 0 ? <div className="stub-page" style={{ marginTop: 20 }}>Loading OAuth apps…</div> : null}

        <div className="grid">
          {catalog.map((entry) => {
            const app = apps.find((a) => a.provider === entry.provider);
            const f = form[entry.provider];
            const console_ = CONSOLE[entry.provider];
            return (
              <div className="card" key={entry.provider}>
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                  <h3 style={{ margin: 0 }}>{entry.label}</h3>
                  <span className={`badge ${entry.configured ? 'ok' : 'muted'}`}>{entry.configured ? 'configured' : 'not configured'}</span>
                </div>

                {app ? (
                  <div className="muted" style={{ marginTop: 8, fontSize: 12.5 }}>
                    Client id <span className="mono">{app.clientId}</span><br />
                    Secret <span className="mono" style={{ fontSize: 11 }}>{app.fingerprint}</span> · added by {app.addedBy} · {new Date(app.addedAt).toLocaleString()}
                  </div>
                ) : null}

                <div className="hint" style={{ marginTop: 12, marginBottom: 4 }}>Register this exact redirect URI on the OAuth app:</div>
                <div className="mono" style={{ fontSize: 11.5, wordBreak: 'break-all', background: 'var(--panel)', padding: '6px 8px', borderRadius: 6 }}>
                  {REDIRECT_URI[entry.provider]}
                </div>
                <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
                  Scopes (least-privilege read): <span className="mono">{entry.scopes.join(' ')}</span>
                </div>
                <div className="muted" style={{ marginTop: 4, fontSize: 12 }}>
                  Create the app in <a href={console_.url} target="_blank" rel="noreferrer">{console_.name}</a>.
                </div>

                <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 12 }}>
                  <input
                    style={{ flex: '1 1 200px' }}
                    value={f.clientId}
                    onChange={(e) => setForm((s) => ({ ...s, [entry.provider]: { ...f, clientId: e.target.value } }))}
                    placeholder={entry.provider === 'google' ? 'Client id (…apps.googleusercontent.com)' : 'Application (client) id'}
                    autoComplete="off"
                  />
                  <input
                    style={{ flex: '1 1 200px' }}
                    type="password"
                    value={f.clientSecret}
                    onChange={(e) => setForm((s) => ({ ...s, [entry.provider]: { ...f, clientSecret: e.target.value } }))}
                    placeholder="Client secret value"
                    autoComplete="off"
                  />
                  {entry.provider === 'microsoft' ? (
                    <input
                      style={{ flex: '1 1 160px' }}
                      value={f.tenant}
                      onChange={(e) => setForm((s) => ({ ...s, [entry.provider]: { ...f, tenant: e.target.value } }))}
                      placeholder="Tenant (optional)"
                      autoComplete="off"
                    />
                  ) : null}
                  <button
                    className="btn"
                    onClick={() => register(entry.provider)}
                    disabled={busy === entry.provider || !f.clientId.trim() || !f.clientSecret.trim()}
                  >
                    {busy === entry.provider ? <span className="spin" /> : app ? 'Replace' : 'Register'}
                  </button>
                </div>
                {entry.provider === 'microsoft' ? (
                  <div className="hint" style={{ marginTop: 6, fontSize: 11.5 }}>
                    Tenant is optional — the connector uses the multi-tenant <span className="mono">common</span> endpoint so any
                    work or personal Microsoft account your app allows can connect.
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        <div className="hint" style={{ marginTop: 18 }}>
          Secrets are written once server-side; only a <code>sha256</code> fingerprint is ever stored in the catalog or shown here.
          See <Link href="/connections">Connections</Link> for how a user connects their own drive.
        </div>
      </div>
    </>
  );
}
