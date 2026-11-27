/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    App Builder (E) - My Settings → App permissions: the apps that act as me, and revoking one
 * USER STORY: As a user I see each app I allowed to sign me in (per Dev / Prod), what it may do, since when, and I can
 *             revoke it; its next call as me is refused and the next sign-in asks me again.
 * ARCHITECTURE:
 *   - Reads `GET /api/auth/app-consent` (own records only) and revokes with `DELETE /api/auth/app-consent { key }`
 *     (OPA-checked, audited). Rendered by the settings page ONLY while the App Builder is on.
 *   - A failed read says so (never an empty "no apps" list); a failed revoke keeps the row and says so.
 * I18N:       texts from `settings.appPermissions.*`.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { useFormat, useTranslations } from '@core/i18n/client';

type Consent = { key: string; appName: string; slug: string; domain: string; env: 'dev' | 'prod'; scopes: string[]; reads: string[]; agents: string[]; grantedAt: string };

export default function AppPermissions() {
  const t = useTranslations('settings');
  const f = useFormat();
  const [items, setItems] = useState<Consent[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [revokeFailed, setRevokeFailed] = useState<string | null>(null);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const res = await fetch('/api/auth/app-consent', { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const j = (await res.json()) as { consents?: Consent[] };
      setItems(j.consents ?? []);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function revoke(key: string) {
    setBusy(key);
    setRevokeFailed(null);
    try {
      const res = await fetch('/api/auth/app-consent', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key }) });
      if (!res.ok) throw new Error(String(res.status));
      setItems((cur) => (cur ?? []).filter((c) => c.key !== key));
    } catch {
      setRevokeFailed(key);
    } finally {
      setBusy(null);
    }
  }

  if (failed) return <div className="muted" role="status">{t('appPermissions.failed')}</div>;
  if (items === null) return <div className="muted" role="status">{t('appPermissions.loading')}</div>;
  if (items.length === 0) return <div className="muted">{t('appPermissions.empty')}</div>;
  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {items.map((c) => {
        const actions = c.scopes.filter((s) => s.startsWith('action:')).length;
        const facts = [
          c.reads.length > 0 ? t('appPermissions.reads', { count: c.reads.length }) : t('appPermissions.identityOnly'),
          ...(c.agents.length > 0 ? [t('appPermissions.agents', { count: c.agents.length })] : []),
          ...(actions > 0 ? [t('appPermissions.actions', { count: actions })] : []),
        ];
        return (
          <li key={c.key} className="row" style={{ alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '10px 0', borderTop: '1px solid var(--border, #e6e1d6)' }}>
            <div style={{ flex: 1, minWidth: 220 }}>
              <div style={{ fontWeight: 600 }}>
                {c.appName || c.slug} <span className="muted">· {c.domain} · {c.env === 'prod' ? t('appPermissions.envProd') : t('appPermissions.envDev')}</span>
              </div>
              <div className="muted">
                {facts.join(' · ')}
                {c.grantedAt ? ` · ${t('appPermissions.granted', { date: f.date(c.grantedAt) })}` : ''}
              </div>
              {revokeFailed === c.key ? <div className="muted" role="status">{t('appPermissions.revokeFailed')}</div> : null}
            </div>
            <button type="button" className="btn" disabled={busy === c.key} onClick={() => revoke(c.key)}>
              {busy === c.key ? t('appPermissions.revoking') : t('appPermissions.revoke')}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
