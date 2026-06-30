/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import PageHeader from '@/components/PageHeader';

type Settings = {
  sso: { enabled: boolean; provider: string; issuerUrl: string; scim: boolean };
  branding: { displayName: string; accent: string; whiteLabel: boolean };
  defaults: { domainTemplate: string; newUserRole: string };
  localization: { locale: 'en' | 'de'; available: string[] };
  notifications: { email: string; backupFailure: boolean; costThreshold: boolean };
};

function Switch({ on, onClick, disabled }: { on: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button className={'switch' + (on ? ' on' : '')} onClick={onClick} disabled={disabled}>
      <span className="switch-track"><span className="switch-thumb" /></span>
      <span className="switch-text">{on ? 'ON' : 'OFF'}</span>
    </button>
  );
}

export default function SettingsPage() {
  const [s, setS] = useState<Settings | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const res = await fetch('/api/platform-admin/settings', { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? 'Failed to load');
      else setS(body.settings ?? null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const save = useCallback(async (group: string, patch: Partial<Settings>) => {
    setBusy(group);
    setError('');
    try {
      const res = await fetch('/api/platform-admin/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? 'Save failed');
      else await load();
    } finally {
      setBusy('');
    }
  }, [load]);

  // local edit helper
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setS((prev) => (prev ? { ...prev, [key]: value } : prev));

  if (!s) {
    return (
      <>
        <PageHeader title="Settings" crumb="platform · tenant identity, branding, localization" />
        <div className="content">
          {error ? <div className="error">{error}</div> : <div className="stub-page">Loading…</div>}
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Settings" crumb="platform · tenant identity, branding, localization" />
      <div className="content">
        <p className="lead">
          Tenant identity, branding, defaults and localization. Each group saves on its own.
        </p>

        {error ? <div className="error">{error}</div> : null}

        <div className="section-title">Identity / SSO</div>
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="row" style={{ gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
            <label className="hint" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              SSO enabled
              <Switch on={s.sso.enabled} onClick={() => set('sso', { ...s.sso, enabled: !s.sso.enabled })} />
            </label>
            <label className="hint" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              SCIM
              <Switch on={s.sso.scim} onClick={() => set('sso', { ...s.sso, scim: !s.sso.scim })} />
            </label>
            <span className="hint">provider: <span className="mono">{s.sso.provider}</span></span>
          </div>
          <div className="row" style={{ gap: 10, marginTop: 10, alignItems: 'center' }}>
            <input style={{ flex: '1 1 280px' }} value={s.sso.issuerUrl} onChange={(e) => set('sso', { ...s.sso, issuerUrl: e.target.value })} placeholder="issuer URL" />
            <button className="btn" disabled={busy === 'sso'} onClick={() => save('sso', { sso: s.sso })}>
              {busy === 'sso' ? <span className="spin" /> : 'Save'}
            </button>
          </div>
          <div className="hint" style={{ marginTop: 8 }}>SSO client secrets go through Ory + the secrets manager — never this form.</div>
        </div>

        <div className="section-title">Branding</div>
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="row" style={{ gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
            <input style={{ flex: '1 1 220px' }} value={s.branding.displayName} onChange={(e) => set('branding', { ...s.branding, displayName: e.target.value })} placeholder="display name" />
            <label className="hint" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              White-label
              <Switch on={s.branding.whiteLabel} onClick={() => set('branding', { ...s.branding, whiteLabel: !s.branding.whiteLabel })} />
            </label>
            <button className="btn" disabled={busy === 'branding'} onClick={() => save('branding', { branding: s.branding })}>
              {busy === 'branding' ? <span className="spin" /> : 'Save'}
            </button>
          </div>
        </div>

        <div className="section-title">Defaults</div>
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="row" style={{ gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
            <label className="hint" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              Domain template
              <select value={s.defaults.domainTemplate} onChange={(e) => set('defaults', { ...s.defaults, domainTemplate: e.target.value })}>
                <option value="">blank</option>
                <option value="analytics">analytics</option>
                <option value="science">science</option>
                <option value="big-data">big-data</option>
              </select>
            </label>
            <label className="hint" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              New-user role
              <select value={s.defaults.newUserRole} onChange={(e) => set('defaults', { ...s.defaults, newUserRole: e.target.value })}>
                <option value="participant">participant</option>
                <option value="builder">builder</option>
              </select>
            </label>
            <button className="btn" disabled={busy === 'defaults'} onClick={() => save('defaults', { defaults: s.defaults })}>
              {busy === 'defaults' ? <span className="spin" /> : 'Save'}
            </button>
          </div>
        </div>

        <div className="section-title">Localization</div>
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="row" style={{ gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
            <label className="hint" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              Locale
              <select value={s.localization.locale} onChange={(e) => set('localization', { ...s.localization, locale: e.target.value as 'en' | 'de' })}>
                <option value="en">en</option>
                <option value="de">de</option>
              </select>
            </label>
            <span className="hint">DE for the Data Masterclass audience.</span>
            <button className="btn" disabled={busy === 'localization'} onClick={() => save('localization', { localization: s.localization })}>
              {busy === 'localization' ? <span className="spin" /> : 'Save'}
            </button>
          </div>
        </div>

        <div className="section-title">Notifications</div>
        <div className="card">
          <div className="row" style={{ gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
            <input style={{ flex: '1 1 220px' }} type="email" value={s.notifications.email} onChange={(e) => set('notifications', { ...s.notifications, email: e.target.value })} placeholder="notification email" />
            <label className="hint" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              Backup failure
              <Switch on={s.notifications.backupFailure} onClick={() => set('notifications', { ...s.notifications, backupFailure: !s.notifications.backupFailure })} />
            </label>
            <label className="hint" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              Cost threshold
              <Switch on={s.notifications.costThreshold} onClick={() => set('notifications', { ...s.notifications, costThreshold: !s.notifications.costThreshold })} />
            </label>
            <button className="btn" disabled={busy === 'notifications'} onClick={() => save('notifications', { notifications: s.notifications })}>
              {busy === 'notifications' ? <span className="spin" /> : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
