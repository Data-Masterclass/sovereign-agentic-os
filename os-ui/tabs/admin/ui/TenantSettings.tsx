/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
/**
 * TAB:        admin
 * FEATURE:    Tenant Settings — SSO, branding, localization and tenant defaults, as a Platform tab
 * USER STORY: As a platform admin I want the tenant's identity, branding, currency, locale and
 *             default model roles in the same place as the rest of Platform.
 * ARCHITECTURE:
 *   - Markup carried over unchanged from app/(govern)/platform/settings/page.tsx (2026-10-30 move
 *     to one route with tabs on top, not a redesign). That route is now a redirect to
 *     /platform?section=settings.
 *   - The page's `.content` wrapper moved up to platform/page.tsx; the leftover plain <div> is it.
 *   - FAIL-CLOSED gate: Platform is minRole 'builder' (only Overview & Health is builder-readable),
 *     and every section now lives at /platform, so the old pathname gate in platform/layout.tsx no
 *     longer protects this surface. The gate is therefore HERE as well as in the strip: the inner
 *     component — which holds every hook and every fetch — is not mounted until useUser() resolves a
 *     role that clears sectionMinRole('settings'). A builder who hand-crafts ?section=settings gets nothing,
 *     and nothing is requested on their behalf. Hiding is not the boundary: /api/platform-admin/* is
 *     adminCtx()-gated server-side, which is the real enforcement.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useUser } from '@core/ui/useUser';
import { roleAtLeast } from '@core/kernel/session';
import { sectionMinRole } from '@tabs/admin/lib/sections';

type Settings = {
  sso: { enabled: boolean; provider: string; issuerUrl: string; scim: boolean };
  branding: { displayName: string; accent: string; whiteLabel: boolean };
  defaults: { domainTemplate: string; newUserRole: string };
  currency: string;
  localization: { locale: 'en' | 'de'; available: string[] };
  notifications: { email: string; backupFailure: boolean; costThreshold: boolean };
  /** os-ui 0.6.133 — allow coded (custom) apps. OFF by default: only Declarative
   *  (no-code) apps can be created. The coded path is experimental. */
  codedAppsEnabled: boolean;
  /** os-ui 0.6.152 — allow autonomous (unattended) agent execution. OFF by default:
   *  agents run only when a human clicks Run; cron/event triggers are refused. */
  autonomousAgentsEnabled: boolean;
  /** Langfuse masking: what the OS may send to Langfuse. OFF by default. */
  langfuseMasking: { enabled: boolean; level: 'pii' | 'content' };
  /** Personal data before Company certification: block (default) / confirm / off. */
  personalDataBeforeCompany: 'block' | 'confirm' | 'off';
};


// Prominent currencies as quick-pick chips; the dropdown covers the rest.
const PROMINENT_CURRENCIES = ['EUR', 'CHF', 'USD'] as const;
// A pragmatic slice of common ISO-4217 codes for the "other" dropdown.
const OTHER_CURRENCIES = ['GBP', 'JPY', 'CAD', 'AUD', 'CNY', 'INR', 'SEK', 'NOK', 'DKK', 'PLN', 'SGD', 'HKD', 'NZD', 'ZAR', 'BRL', 'AED'] as const;

function Switch({ on, onClick, disabled }: { on: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button className={'switch' + (on ? ' on' : '')} onClick={onClick} disabled={disabled}>
      <span className="switch-track"><span className="switch-thumb" /></span>
      <span className="switch-text">{on ? 'ON' : 'OFF'}</span>
    </button>
  );
}

export default function TenantSettings() {
  const { user, loading } = useUser();
  const role = user?.role ?? null;
  // Fail closed: TenantSettingsInner holds every hook and every fetch, so until the role
  // resolves AND clears the floor nothing renders and nothing is requested.
  if (loading || role === null || !roleAtLeast(role, sectionMinRole('settings'))) return null;
  return <TenantSettingsInner />;
}

function TenantSettingsInner() {
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
        <div>
          {error ? <div className="error">{error}</div> : <div className="stub-page">Loading…</div>}
        </div>
      </>
    );
  }

  return (
    <>
      <div>
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
          <div className="hint">
            The OS calls three model roles (strong, worker, embedding). Which model each one means is set in{' '}
            <Link href="/platform?section=models">Platform → Models</Link>, not here.
          </div>
        </div>

        <div className="section-title">Software</div>
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="row" style={{ gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
            <label className="hint" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              Allow coded (custom) apps
              <Switch
                on={s.codedAppsEnabled}
                disabled={busy === 'codedAppsEnabled'}
                onClick={() => {
                  const next = !s.codedAppsEnabled;
                  set('codedAppsEnabled', next);
                  void save('codedAppsEnabled', { codedAppsEnabled: next });
                }}
              />
            </label>
          </div>
          <div className="hint" style={{ marginTop: 8 }}>
            Off = only Declarative no-code apps can be created. The coded path is experimental.
          </div>
        </div>

        <div className="section-title">Agents</div>
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="row" style={{ gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
            <label className="hint" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              Allow autonomous agent execution
              <Switch
                on={s.autonomousAgentsEnabled}
                disabled={busy === 'autonomousAgentsEnabled'}
                onClick={() => {
                  const next = !s.autonomousAgentsEnabled;
                  set('autonomousAgentsEnabled', next);
                  void save('autonomousAgentsEnabled', { autonomousAgentsEnabled: next });
                }}
              />
            </label>
          </div>
          <div className="hint" style={{ marginTop: 8 }}>
            Off (default) = agents run only when a person clicks Run. Scheduled (cron) and
            event/API triggers are refused until this is on — nothing runs unattended.
          </div>
        </div>

        <div className="section-title">Governance — personal data before Company</div>
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="row" style={{ gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
            <label className="hint" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              Personal data before Company certification
              <select
                value={s.personalDataBeforeCompany ?? 'block'}
                disabled={busy === 'personalDataBeforeCompany'}
                onChange={(e) => {
                  const next = e.target.value as Settings['personalDataBeforeCompany'];
                  set('personalDataBeforeCompany', next);
                  void save('personalDataBeforeCompany', { personalDataBeforeCompany: next });
                }}
              >
                <option value="block">Block (default) — refuse until personal data is masked or hidden</option>
                <option value="confirm">Confirm — the certifier confirms with a reason</option>
                <option value="off">Off — do not check</option>
              </select>
            </label>
          </div>
          <div className="hint" style={{ marginTop: 8 }}>
            A dataset certified to Company can be read by <strong>every domain</strong>; only the masks and hides in its
            grants protect a column. Columns are marked as personal data in the dataset&apos;s Documentation
            (&ldquo;Personal data: yes / no&rdquo;).
          </div>
          <div className="hint" style={{ marginTop: 6 }}>
            <strong>Block</strong>: certification is refused while a personal-data column is neither masked nor hidden;
            a dataset whose columns are not classified needs a classification or the certifier&apos;s confirmation that it
            holds no personal data. <strong>Confirm</strong>: the certifier may go ahead after ticking a confirmation and
            giving a reason. <strong>Off</strong>: no check. Every certification records what the rule decided (and any
            reason) on the dataset and in the audit log; every change to this setting is audited.
          </div>
        </div>

        <div className="section-title">Traces (Langfuse)</div>
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="row" style={{ gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
            <label className="hint" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              Mask what is sent to Langfuse
              <Switch
                on={s.langfuseMasking.enabled}
                disabled={busy === 'langfuseMasking'}
                onClick={() => {
                  const next = { ...s.langfuseMasking, enabled: !s.langfuseMasking.enabled };
                  set('langfuseMasking', next);
                  void save('langfuseMasking', { langfuseMasking: next });
                }}
              />
            </label>
            <label className="hint" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              Level
              <select
                value={s.langfuseMasking.level}
                disabled={busy === 'langfuseMasking'}
                onChange={(e) => {
                  const next = { ...s.langfuseMasking, level: e.target.value as 'pii' | 'content' };
                  set('langfuseMasking', next);
                  void save('langfuseMasking', { langfuseMasking: next });
                }}
              >
                <option value="pii">Personal data only (e-mail, phone, IBAN, card)</option>
                <option value="content">All content (keep model, tokens, latency, cost, tool names, status)</option>
              </select>
            </label>
          </div>
          <div className="hint" style={{ marginTop: 8 }}>
            Off (default) = traces are recorded as before. On = the masking happens inside os-ui, before anything
            is sent, and the gateway is told to leave prompts and answers out of its own record of each call.
            Monitoring keeps working: tokens, cost, latency, model, tool names and errors are never masked.
          </div>
          <div className="hint" style={{ marginTop: 6 }}>
            <strong>Applies without a restart or a redeploy</strong>: os-ui and the run worker read this switch
            on their next write (the worker within a few seconds). A run that is already in progress keeps the
            level it started with for its message text; personal data is masked on every export either way.
            Traces already stored in Langfuse are not changed. The gateway&apos;s tool definitions and ids
            are not message content and are not masked. Langfuse&apos;s own server-side masking is an
            Enterprise feature and is not used.
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
