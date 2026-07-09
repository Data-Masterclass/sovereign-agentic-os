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
  currency: string;
  localization: { locale: 'en' | 'de'; available: string[] };
  notifications: { email: string; backupFailure: boolean; costThreshold: boolean };
  modelRoles: { reasoning: string; standard: string; embeddings: string };
};

type CatalogModel = { model_name: string; display: string; provenance: 'internal' | 'external' };
type ModelsResponse = { models: CatalogModel[]; source: 'litellm' | 'offline'; roles: { reasoning: string; standard: string; embeddings: string } };

// Prominent currencies as quick-pick chips; the dropdown covers the rest.
const PROMINENT_CURRENCIES = ['EUR', 'CHF', 'USD'] as const;
// A pragmatic slice of common ISO-4217 codes for the "other" dropdown.
const OTHER_CURRENCIES = ['GBP', 'JPY', 'CAD', 'AUD', 'CNY', 'INR', 'SEK', 'NOK', 'DKK', 'PLN', 'SGD', 'HKD', 'NZD', 'ZAR', 'BRL', 'AED'] as const;

const ROLE_META: { key: keyof Settings['modelRoles']; label: string; help: string }[] = [
  { key: 'reasoning', label: 'Reasoning', help: 'Planning and deep reasoning across the OS. Default: sovereign-reasoning.' },
  { key: 'standard', label: 'Standard', help: 'Assistants, agent execution and light work. Default: sovereign-default.' },
  { key: 'embeddings', label: 'Embeddings', help: 'Knowledge + Files vector embeddings. Default: sovereign-embed.' },
];

function Switch({ on, onClick, disabled }: { on: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button className={'switch' + (on ? ' on' : '')} onClick={onClick} disabled={disabled}>
      <span className="switch-track"><span className="switch-thumb" /></span>
      <span className="switch-text">{on ? 'ON' : 'OFF'}</span>
    </button>
  );
}

/** In-box (sovereign) vs hosted (external) badge — same language as the agent builder. */
function ProvBadge({ provenance }: { provenance: 'internal' | 'external' }) {
  return provenance === 'internal' ? (
    <span className="badge ok" title="Runs in-box on the sovereign cluster — no data leaves.">in-box · sovereign</span>
  ) : (
    <span className="badge warn" title="Runs on a hosted API — the call leaves the box.">hosted · external</span>
  );
}

export default function SettingsPage() {
  const [s, setS] = useState<Settings | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [catalog, setCatalog] = useState<CatalogModel[]>([]);
  const [catalogSource, setCatalogSource] = useState<'litellm' | 'offline' | null>(null);

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

  // The live LiteLLM catalog that populates the three model-role selectors (same
  // source the agent builder uses). Falls back to the install catalog offline.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch('/api/agents/models', { cache: 'no-store' });
        const body = (await res.json()) as ModelsResponse;
        if (alive && res.ok) { setCatalog(body.models ?? []); setCatalogSource(body.source ?? null); }
      } catch { /* keep the selectors on their current values */ }
    })();
    return () => { alive = false; };
  }, []);

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
                <option value="creator">creator</option>
                <option value="builder">builder</option>
              </select>
            </label>
            <button className="btn" disabled={busy === 'defaults'} onClick={() => save('defaults', { defaults: s.defaults })}>
              {busy === 'defaults' ? <span className="spin" /> : 'Save'}
            </button>
          </div>
        </div>

        <div className="section-title">Currency</div>
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="hint" style={{ marginBottom: 12 }}>
            The tenant-wide currency. The Strategy tab reads this to format monetary targets
            (EBIT, Revenue and custom-monetary metrics); non-monetary metrics ignore it.
          </div>
          <div className="row" style={{ gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
            <div className="rt-seg">
              {PROMINENT_CURRENCIES.map((c) => (
                <button
                  key={c}
                  className={`rt-seg-opt${s.currency === c ? ' active' : ''}`}
                  onClick={() => set('currency', c)}
                >
                  {c}
                </button>
              ))}
            </div>
            <label className="hint" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              Other
              <select
                value={(PROMINENT_CURRENCIES as readonly string[]).includes(s.currency) ? '' : s.currency}
                onChange={(e) => e.target.value && set('currency', e.target.value)}
              >
                <option value="">select…</option>
                {OTHER_CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <span className="hint">current: <span className="mono">{s.currency}</span></span>
            <button className="btn" disabled={busy === 'currency'} onClick={() => save('currency', { currency: s.currency })}>
              {busy === 'currency' ? <span className="spin" /> : 'Save'}
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

        <div className="section-title">Model roles</div>
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="hint" style={{ marginBottom: 12 }}>
            The three default models the OS resolves at runtime. Each is chosen from the live LiteLLM
            catalog; leave a role on <strong>Default</strong> to use the platform env baseline. This
            re-points the app ROLE → gateway alias — it never changes the fixed LiteLLM aliases.
            {catalogSource === 'offline' ? ' LiteLLM is unreachable — showing the install catalog.' : ''}
          </div>
          {ROLE_META.map((r) => {
            const value = s.modelRoles[r.key];
            const selected = catalog.find((m) => m.model_name === value);
            return (
              <div key={r.key} className="row" style={{ gap: 12, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                <label className="hint" style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 320px' }}>
                  {r.label}
                  <select
                    value={value}
                    onChange={(e) => set('modelRoles', { ...s.modelRoles, [r.key]: e.target.value })}
                  >
                    <option value="">Default (platform baseline)</option>
                    {catalog.map((m) => (
                      <option key={m.model_name} value={m.model_name}>
                        {m.display} — {m.provenance === 'internal' ? 'in-box' : 'hosted'} ({m.model_name})
                      </option>
                    ))}
                    {value && !selected ? <option value={value}>{value} (current)</option> : null}
                  </select>
                  <span className="hint" style={{ fontSize: 12 }}>{r.help}</span>
                </label>
                {selected ? <ProvBadge provenance={selected.provenance} /> : null}
              </div>
            );
          })}
          <button className="btn" disabled={busy === 'modelRoles'} onClick={() => save('modelRoles', { modelRoles: s.modelRoles })}>
            {busy === 'modelRoles' ? <span className="spin" /> : 'Save'}
          </button>
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
