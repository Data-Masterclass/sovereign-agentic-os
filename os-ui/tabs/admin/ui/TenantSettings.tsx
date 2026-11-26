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
 * I18N:       converted (wave 2) — texts from `admin.tenant.*`. Role names, currency and locale codes stay as is;
 *             server error texts render as sent.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useUser } from '@core/ui/useUser';
import { roleAtLeast } from '@core/kernel/session';
import { sectionMinRole } from '@tabs/admin/lib/sections';
import { useTranslations } from '@core/i18n/client';

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

// Option values shown verbatim: role names stay English lowercase (glossary), locale codes are codes.
const NEW_USER_ROLES = ['creator', 'builder'] as const;
const TENANT_LOCALES = ['en', 'de'] as const;

function Switch({ on, onClick, disabled }: { on: boolean; onClick: () => void; disabled?: boolean }) {
  const t = useTranslations('admin');
  return (
    <button className={'switch' + (on ? ' on' : '')} onClick={onClick} disabled={disabled}>
      <span className="switch-track"><span className="switch-thumb" /></span>
      <span className="switch-text">{on ? t('tenant.switch.on') : t('tenant.switch.off')}</span>
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
  const t = useTranslations('admin');

  const load = useCallback(async () => {
    setError('');
    try {
      const res = await fetch('/api/platform-admin/settings', { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? t('tenant.errors.load'));
      else setS(body.settings ?? null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [t]);

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
      if (!res.ok) setError(body.error ?? t('tenant.errors.save'));
      else await load();
    } finally {
      setBusy('');
    }
  }, [load, t]);

  // local edit helper
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setS((prev) => (prev ? { ...prev, [key]: value } : prev));

  if (!s) {
    return (
      <>
        <div>
          {error ? <div className="error">{error}</div> : <div className="stub-page">{t('tenant.loading')}</div>}
        </div>
      </>
    );
  }

  return (
    <>
      <div>
        {error ? <div className="error">{error}</div> : null}

        <div className="section-title">{t('tenant.sso.title')}</div>
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="row" style={{ gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
            <label className="hint" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {t('tenant.sso.enabled')}
              <Switch on={s.sso.enabled} onClick={() => set('sso', { ...s.sso, enabled: !s.sso.enabled })} />
            </label>
            <label className="hint" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {t('tenant.sso.scim')}
              <Switch on={s.sso.scim} onClick={() => set('sso', { ...s.sso, scim: !s.sso.scim })} />
            </label>
            <span className="hint">{t.rich('tenant.sso.provider', { provider: s.sso.provider, mono: (c) => <span className="mono">{c}</span> })}</span>
          </div>
          <div className="row" style={{ gap: 10, marginTop: 10, alignItems: 'center' }}>
            <input style={{ flex: '1 1 280px' }} value={s.sso.issuerUrl} onChange={(e) => set('sso', { ...s.sso, issuerUrl: e.target.value })} placeholder={t('tenant.sso.issuerPlaceholder')} />
            <button className="btn" disabled={busy === 'sso'} onClick={() => save('sso', { sso: s.sso })}>
              {busy === 'sso' ? <span className="spin" /> : t('tenant.save')}
            </button>
          </div>
          <div className="hint" style={{ marginTop: 8 }}>{t('tenant.sso.hint')}</div>
        </div>

        <div className="section-title">{t('tenant.branding.title')}</div>
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="row" style={{ gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
            <input style={{ flex: '1 1 220px' }} value={s.branding.displayName} onChange={(e) => set('branding', { ...s.branding, displayName: e.target.value })} placeholder={t('tenant.branding.displayNamePlaceholder')} />
            <label className="hint" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {t('tenant.branding.whiteLabel')}
              <Switch on={s.branding.whiteLabel} onClick={() => set('branding', { ...s.branding, whiteLabel: !s.branding.whiteLabel })} />
            </label>
            <button className="btn" disabled={busy === 'branding'} onClick={() => save('branding', { branding: s.branding })}>
              {busy === 'branding' ? <span className="spin" /> : t('tenant.save')}
            </button>
          </div>
        </div>

        <div className="section-title">{t('tenant.defaults.title')}</div>
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="row" style={{ gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
            <label className="hint" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {t('tenant.defaults.domainTemplate')}
              <select value={s.defaults.domainTemplate} onChange={(e) => set('defaults', { ...s.defaults, domainTemplate: e.target.value })}>
                <option value="">{t('tenant.defaults.templates.blank')}</option>
                <option value="analytics">{t('tenant.defaults.templates.analytics')}</option>
                <option value="science">{t('tenant.defaults.templates.science')}</option>
                <option value="big-data">{t('tenant.defaults.templates.bigData')}</option>
              </select>
            </label>
            <label className="hint" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {t('tenant.defaults.newUserRole')}
              <select value={s.defaults.newUserRole} onChange={(e) => set('defaults', { ...s.defaults, newUserRole: e.target.value })}>
                {NEW_USER_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </label>
            <button className="btn" disabled={busy === 'defaults'} onClick={() => save('defaults', { defaults: s.defaults })}>
              {busy === 'defaults' ? <span className="spin" /> : t('tenant.save')}
            </button>
          </div>
        </div>

        <div className="section-title">{t('tenant.currency.title')}</div>
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="hint" style={{ marginBottom: 12 }}>
            {t('tenant.currency.hint')}
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
              {t('tenant.currency.other')}
              <select
                value={(PROMINENT_CURRENCIES as readonly string[]).includes(s.currency) ? '' : s.currency}
                onChange={(e) => e.target.value && set('currency', e.target.value)}
              >
                <option value="">{t('tenant.currency.select')}</option>
                {OTHER_CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <span className="hint">{t.rich('tenant.currency.current', { currency: s.currency, mono: (c) => <span className="mono">{c}</span> })}</span>
            <button className="btn" disabled={busy === 'currency'} onClick={() => save('currency', { currency: s.currency })}>
              {busy === 'currency' ? <span className="spin" /> : t('tenant.save')}
            </button>
          </div>
        </div>

        <div className="section-title">{t('tenant.localization.title')}</div>
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="row" style={{ gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
            <label className="hint" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {t('tenant.localization.locale')}
              <select value={s.localization.locale} onChange={(e) => set('localization', { ...s.localization, locale: e.target.value as 'en' | 'de' })}>
                {TENANT_LOCALES.map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
            </label>
            <span className="hint">{t('tenant.localization.hint')}</span>
            <button className="btn" disabled={busy === 'localization'} onClick={() => save('localization', { localization: s.localization })}>
              {busy === 'localization' ? <span className="spin" /> : t('tenant.save')}
            </button>
          </div>
        </div>

        <div className="section-title">{t('tenant.modelRoles.title')}</div>
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="hint">
            {t.rich('tenant.modelRoles.hint', { link: (c) => <Link href="/platform?section=models">{c}</Link> })}
          </div>
        </div>

        <div className="section-title">{t('tenant.software.title')}</div>
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="row" style={{ gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
            <label className="hint" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {t('tenant.software.coded')}
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
            {t('tenant.software.hint')}
          </div>
        </div>

        <div className="section-title">{t('tenant.agents.title')}</div>
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="row" style={{ gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
            <label className="hint" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {t('tenant.agents.autonomous')}
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
            {t('tenant.agents.hint')}
          </div>
        </div>

        <div className="section-title">{t('tenant.personalData.title')}</div>
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="row" style={{ gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
            <label className="hint" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {t('tenant.personalData.label')}
              <select
                value={s.personalDataBeforeCompany ?? 'block'}
                disabled={busy === 'personalDataBeforeCompany'}
                onChange={(e) => {
                  const next = e.target.value as Settings['personalDataBeforeCompany'];
                  set('personalDataBeforeCompany', next);
                  void save('personalDataBeforeCompany', { personalDataBeforeCompany: next });
                }}
              >
                <option value="block">{t('tenant.personalData.block')}</option>
                <option value="confirm">{t('tenant.personalData.confirm')}</option>
                <option value="off">{t('tenant.personalData.off')}</option>
              </select>
            </label>
          </div>
          <div className="hint" style={{ marginTop: 8 }}>
            {t.rich('tenant.personalData.hint', { strong: (c) => <strong>{c}</strong> })}
          </div>
          <div className="hint" style={{ marginTop: 6 }}>
            {t.rich('tenant.personalData.detail', { strong: (c) => <strong>{c}</strong> })}
          </div>
        </div>

        <div className="section-title">{t('tenant.traces.title')}</div>
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="row" style={{ gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
            <label className="hint" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {t('tenant.traces.mask')}
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
              {t('tenant.traces.level')}
              <select
                value={s.langfuseMasking.level}
                disabled={busy === 'langfuseMasking'}
                onChange={(e) => {
                  const next = { ...s.langfuseMasking, level: e.target.value as 'pii' | 'content' };
                  set('langfuseMasking', next);
                  void save('langfuseMasking', { langfuseMasking: next });
                }}
              >
                <option value="pii">{t('tenant.traces.pii')}</option>
                <option value="content">{t('tenant.traces.content')}</option>
              </select>
            </label>
          </div>
          <div className="hint" style={{ marginTop: 8 }}>
            {t('tenant.traces.hint')}
          </div>
          <div className="hint" style={{ marginTop: 6 }}>
            {t.rich('tenant.traces.detail', { strong: (c) => <strong>{c}</strong> })}
          </div>
        </div>

        <div className="section-title">{t('tenant.notifications.title')}</div>
        <div className="card">
          <div className="row" style={{ gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
            <input style={{ flex: '1 1 220px' }} type="email" value={s.notifications.email} onChange={(e) => set('notifications', { ...s.notifications, email: e.target.value })} placeholder={t('tenant.notifications.emailPlaceholder')} />
            <label className="hint" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {t('tenant.notifications.backupFailure')}
              <Switch on={s.notifications.backupFailure} onClick={() => set('notifications', { ...s.notifications, backupFailure: !s.notifications.backupFailure })} />
            </label>
            <label className="hint" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {t('tenant.notifications.costThreshold')}
              <Switch on={s.notifications.costThreshold} onClick={() => set('notifications', { ...s.notifications, costThreshold: !s.notifications.costThreshold })} />
            </label>
            <button className="btn" disabled={busy === 'notifications'} onClick={() => save('notifications', { notifications: s.notifications })}>
              {busy === 'notifications' ? <span className="spin" /> : t('tenant.save')}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
