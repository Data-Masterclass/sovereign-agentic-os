/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * I18N:       converted (wave 2) — texts from `admin.oauthApps.*` (the title `oauthApps.title` is the
 *             translated SIGN_IN_APPS_NAME). Provider labels, scopes and API error texts are shown as they come.
 */
'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import PageHeader from '@core/ui/PageHeader';
import { useTranslations, useFormat } from '@core/i18n/client';

/**
 * Sign-in apps (Google & Microsoft), formerly "Drive OAuth apps"; linked from Connections, URL unchanged.
 * They now serve mail (Microsoft 365) as well as drives. Register the ONE Google Cloud OAuth client and
 * the ONE Azure app the connected-drive flow federates to. Same discipline as the
 * model provider keys: the raw client SECRET is written once to Secrets Manager
 * server-side; the catalog keeps only a reference + fingerprint, and this page never
 * shows or logs the raw value. Users then connect their OWN drive with their OWN
 * account from the Connections tab.
 */

type OAuthProvider = 'google' | 'microsoft';
type CatalogEntry = { provider: OAuthProvider; label: string; scopes: string[]; optionalScopes?: string[]; configured: boolean };
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

const mono = (c: ReactNode) => <span className="mono">{c}</span>;

export default function OAuthAppsPage() {
  const t = useTranslations('admin');
  const fmt = useFormat();
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
      if (!res.ok) setError(body.error ?? t('oauthApps.errLoad'));
      else { setCatalog(body.catalog ?? []); setApps(body.apps ?? []); }
    } catch (e) { setError((e as Error).message); } finally { setLoading(false); }
  }, [t]);
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
      if (!res.ok) setError(body.error ?? t('oauthApps.errRegister'));
      else {
        setToast(t('oauthApps.registered', { provider: provider === 'google' ? 'Google' : 'Microsoft', fingerprint: body.app.fingerprint }));
        setForm((s) => ({ ...s, [provider]: { clientId: '', clientSecret: '', tenant: '' } }));
        await load();
      }
    } catch (e) { setError((e as Error).message); } finally { setBusy(''); }
  }, [form, load, t]);

  return (
    <>
      <PageHeader title={t('oauthApps.title')} crumb={t('oauthApps.crumb')} />
      <div className="content">
        {toast ? <div className="hint" style={{ color: 'var(--teal)' }}>{toast}</div> : null}
        {error ? <div className="error">{error}</div> : null}
        {loading && catalog.length === 0 ? <div className="stub-page" style={{ marginTop: 20 }}>{t('oauthApps.loading')}</div> : null}

        <div className="grid">
          {catalog.map((entry) => {
            const app = apps.find((a) => a.provider === entry.provider);
            const f = form[entry.provider];
            const console_ = CONSOLE[entry.provider];
            return (
              <div className="card" key={entry.provider}>
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                  <h3 style={{ margin: 0 }}>{entry.label}</h3>
                  <span className={`badge ${entry.configured ? 'ok' : 'muted'}`}>{entry.configured ? t('oauthApps.configured') : t('oauthApps.notConfigured')}</span>
                </div>

                {app ? (
                  <div className="muted" style={{ marginTop: 8, fontSize: 12.5 }}>
                    {t.rich('oauthApps.clientIdLine', { id: app.clientId, mono })}<br />
                    {t.rich('oauthApps.secretLine', {
                      fingerprint: app.fingerprint,
                      by: app.addedBy,
                      // en unchanged: the old toLocaleString() form, "11/27/2026, 2:05:00 PM".
                      when: fmt.dateTime(app.addedAt, { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' }),
                      fp: (c: ReactNode) => <span className="mono" style={{ fontSize: 11 }}>{c}</span>,
                    })}
                  </div>
                ) : null}

                <div className="hint" style={{ marginTop: 12, marginBottom: 4 }}>{t('oauthApps.redirectHint')}</div>
                <div className="mono" style={{ fontSize: 11.5, wordBreak: 'break-all', background: 'var(--panel)', padding: '6px 8px', borderRadius: 6 }}>
                  {REDIRECT_URI[entry.provider]}
                </div>
                <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
                  {t.rich('oauthApps.scopesAlways', { scopes: entry.scopes.join(' '), mono })}
                </div>
                {entry.optionalScopes && entry.optionalScopes.length > 0 ? (
                  <div className="muted" style={{ marginTop: 4, fontSize: 12 }}>
                    {t.rich('oauthApps.scopesOptional', { scopes: entry.optionalScopes.join(' '), mono })}
                  </div>
                ) : null}
                <div className="muted" style={{ marginTop: 4, fontSize: 12 }}>
                  {t.rich('oauthApps.createIn', {
                    name: console_.name,
                    link: (c: ReactNode) => <a href={console_.url} target="_blank" rel="noreferrer">{c}</a>,
                  })}
                </div>

                <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 12 }}>
                  <input
                    style={{ flex: '1 1 200px' }}
                    value={f.clientId}
                    onChange={(e) => setForm((s) => ({ ...s, [entry.provider]: { ...f, clientId: e.target.value } }))}
                    placeholder={entry.provider === 'google' ? t('oauthApps.clientIdGoogle') : t('oauthApps.clientIdMicrosoft')}
                    autoComplete="off"
                  />
                  <input
                    style={{ flex: '1 1 200px' }}
                    type="password"
                    value={f.clientSecret}
                    onChange={(e) => setForm((s) => ({ ...s, [entry.provider]: { ...f, clientSecret: e.target.value } }))}
                    placeholder={t('oauthApps.secretPlaceholder')}
                    autoComplete="off"
                  />
                  {entry.provider === 'microsoft' ? (
                    <input
                      style={{ flex: '1 1 160px' }}
                      value={f.tenant}
                      onChange={(e) => setForm((s) => ({ ...s, [entry.provider]: { ...f, tenant: e.target.value } }))}
                      placeholder={t('oauthApps.tenantPlaceholder')}
                      autoComplete="off"
                    />
                  ) : null}
                  <button
                    className="btn"
                    onClick={() => register(entry.provider)}
                    disabled={busy === entry.provider || !f.clientId.trim() || !f.clientSecret.trim()}
                  >
                    {busy === entry.provider ? <span className="spin" /> : app ? t('oauthApps.replace') : t('oauthApps.register')}
                  </button>
                </div>
                {entry.provider === 'microsoft' ? (
                  <div className="hint" style={{ marginTop: 6, fontSize: 11.5 }}>
                    {t.rich('oauthApps.tenantHint', { mono })}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        <div className="hint" style={{ marginTop: 18 }}>
          {t.rich('oauthApps.footer', {
            code: (c: ReactNode) => <code>{c}</code>,
            link: (c: ReactNode) => <Link href="/connections">{c}</Link>,
          })}

        </div>
      </div>
    </>
  );
}
