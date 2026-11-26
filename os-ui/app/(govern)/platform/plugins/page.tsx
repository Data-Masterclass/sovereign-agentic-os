/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 *
 * I18N:       converted (wave 2) — texts from `admin.plugins.*`. Plugin names, publishers, summaries and
 *             error texts from the API are shown as they come.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import PageHeader from '@core/ui/PageHeader';
import { useTranslations } from '@core/i18n/client';
import { REGISTRATION_NOTE_KEY } from '@tabs/admin/lib/marketplace-copy';

type Plugin = {
  id: string;
  name: string;
  kind: 'mcp' | 'skill' | 'tool';
  publisher: string;
  signed: boolean;
  scanned: boolean;
  status: 'available' | 'installed' | 'approved';
  allowedDomains: string[];
  summary: string;
};
type Registration = {
  registered: boolean;
  listingName: string;
  partnerId: string;
  status: 'unregistered' | 'pending' | 'listed';
};

export default function PluginsPage() {
  const t = useTranslations('admin');
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [registration, setRegistration] = useState<Registration | null>(null);
  const [domains, setDomains] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  // per-plugin approve picker
  const [approveText, setApproveText] = useState<Record<string, string>>({});
  // marketplace registration form
  const [partnerId, setPartnerId] = useState('');
  const [listingName, setListingName] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const res = await fetch('/api/platform-admin/plugins', { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? t('plugins.errLoad'));
      else {
        setPlugins(body.plugins ?? []);
        setRegistration(body.registration ?? null);
        setDomains(body.domains ?? []);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, [t]);

  useEffect(() => { load(); }, [load]);

  const post = useCallback(async (key: string, body: Record<string, unknown>) => {
    setBusy(key);
    setError('');
    try {
      const res = await fetch('/api/platform-admin/plugins', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) setError(b.error ?? t('plugins.errAction'));
      else await load();
    } finally {
      setBusy('');
    }
  }, [load, t]);

  return (
    <>
      <PageHeader title={t('plugins.title')} crumb={t('plugins.crumb')} />
      <div className="content">
        {error ? <div className="error">{error}</div> : null}

        <div className="section-title" style={{ marginTop: 0 }}>{t('plugins.sectionTitle')}<span className="count-pill">{plugins.length}</span></div>
        <div className="grid">
          {plugins.map((p) => {
            const installable = p.signed && p.scanned && p.status === 'available';
            return (
              <div key={p.id} className="card">
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                  <strong>{p.name}</strong>
                  <span className="pa-tag">{t(`plugins.kind.${p.kind}`)}</span>
                </div>
                <div className="muted" style={{ fontSize: 11.5 }}>{t('plugins.by', { publisher: p.publisher })}</div>
                <p className="muted" style={{ margin: '8px 0', fontSize: 12.5 }}>{p.summary}</p>
                <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                  <span className={`badge ${p.signed ? 'ok' : 'err'}`}>{p.signed ? t('plugins.signed') : t('plugins.unsigned')}</span>
                  <span className={`badge ${p.scanned ? 'ok' : 'err'}`}>{p.scanned ? t('plugins.scanned') : t('plugins.unscanned')}</span>
                  <span className="badge muted">{t(`plugins.status.${p.status}`)}</span>
                </div>
                {p.allowedDomains.length ? (
                  <div style={{ marginTop: 8 }}>{p.allowedDomains.map((d) => <span className="chip" key={d}>{d}</span>)}</div>
                ) : null}
                <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                  <button className="btn" disabled={busy === p.id || !installable}
                    onClick={() => post(p.id, { op: 'install', id: p.id })}>
                    {busy === p.id ? <span className="spin" /> : t('plugins.install')}
                  </button>
                  <input
                    style={{ flex: '1 1 140px' }}
                    value={approveText[p.id] ?? ''}
                    onChange={(e) => setApproveText((s) => ({ ...s, [p.id]: e.target.value }))}
                    placeholder={domains.length ? t('plugins.domainsPlaceholder', { list: domains.join(', ') }) : t('plugins.domainsPlaceholderEmpty')}
                  />
                  <button className="btn ghost" disabled={busy === p.id}
                    onClick={() => post(p.id, {
                      op: 'approve',
                      id: p.id,
                      domains: (approveText[p.id] ?? '').split(',').map((d) => d.trim()).filter(Boolean),
                    })}>
                    {t('plugins.approve')}
                  </button>
                </div>
                {!installable ? (
                  <div className="hint" style={{ marginTop: 6 }}>
                    {p.status !== 'available' ? t(`plugins.already.${p.status}`) : t('plugins.needsSignedScanned')}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        <div className="section-title" style={{ marginTop: 22 }}>{t('plugins.marketplaceTitle')}</div>
        <div className="card">
          {registration ? (
            <>
              <div className="row" style={{ alignItems: 'center', gap: 8 }}>
                {t('plugins.listingStatus')}{' '}
                <span className={`badge ${registration.status === 'listed' ? 'ok' : registration.status === 'pending' ? 'muted' : 'err'}`}>
                  {t(`plugins.regStatus.${registration.status}`)}
                </span>
                {registration.registered ? <span className="muted" style={{ fontSize: 12 }}>{registration.listingName} · {registration.partnerId}</span> : null}
              </div>
              {!registration.registered ? (
                <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center', marginTop: 10 }}>
                  <input style={{ flex: '1 1 140px' }} value={partnerId} onChange={(e) => setPartnerId(e.target.value)} placeholder={t('plugins.partnerPlaceholder')} />
                  <input style={{ flex: '1 1 160px' }} value={listingName} onChange={(e) => setListingName(e.target.value)} placeholder={t('plugins.listingPlaceholder')} />
                  <button className="btn" disabled={busy === 'register' || !partnerId.trim()}
                    onClick={() => post('register', { op: 'register', partnerId, listingName: listingName || undefined })}>
                    {busy === 'register' ? <span className="spin" /> : t('plugins.register')}
                  </button>
                </div>
              ) : (
                <div className="hint" style={{ marginTop: 8 }}>{t(REGISTRATION_NOTE_KEY)}</div>
              )}
            </>
          ) : <div className="hint">{t('plugins.loading')}</div>}

        </div>
      </div>
    </>
  );
}
