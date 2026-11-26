/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
/**
 * TAB:        admin
 * FEATURE:    Models & Providers — LiteLLM's models and connections (live), routing defaults and adding providers, as a Platform tab
 * USER STORY: As a platform admin I want to see every model LiteLLM serves right now — and which the
 *             deployment's config sets and which live in LiteLLM — set the per-role defaults, and add a
 *             provider, without leaving Platform. The list is LiteLLM's: the OS keeps no copy and no switch.
 * ARCHITECTURE:
 *   - Markup carried over unchanged from app/(govern)/platform/models/page.tsx (2026-10-30 move
 *     to one route with tabs on top, not a redesign). That route is now a redirect to
 *     /platform?section=models.
 *   - The page's `.content` wrapper moved up to platform/page.tsx; the leftover plain <div> is it.
 *   - FAIL-CLOSED gate: Platform is minRole 'builder' (only Overview & Health is builder-readable),
 *     and every section now lives at /platform, so the old pathname gate in platform/layout.tsx no
 *     longer protects this surface. The gate is therefore HERE as well as in the strip: the inner
 *     component — which holds every hook and every fetch — is not mounted until useUser() resolves a
 *     role that clears sectionMinRole('models'). A builder who hand-crafts ?section=models gets nothing,
 *     and nothing is requested on their behalf. Hiding is not the boundary: /api/platform-admin/* is
 *     adminCtx()-gated server-side, which is the real enforcement.
 * I18N:       converted (wave 2) — texts from `admin.models.*`. Model ids, provider product names and
 *             error text from the server are shown as they are.
 */
'use client';

import { LEAD_SWITCH_LABEL_KEY, leadSwitchTextKey } from '@tabs/admin/lib/lead-model-label';
import { useTranslations, useFormat } from '@core/i18n/client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ConfirmProvider, useConfirm } from '@core/ui/lifecycle/ConfirmDialog';
import { splitCatalog } from '@tabs/admin/lib/catalog-groups';
import { useUser } from '@core/ui/useUser';
import { roleAtLeast } from '@core/kernel/session';
import { sectionMinRole } from '@tabs/admin/lib/sections';
import ProviderWizard from '@tabs/admin/ui/ProviderWizard';
import { DEPRECATED_ALIASES } from '@core/models/role-names';

type ModelReference = { kind: 'role' | 'assistant' | 'agent'; label: string };

// The three roles (sovereign-strong / -worker / -embedding) are mapped in the section below; the mapping is the
// file os/models.yml, enforced at the gateway. The old per-role dropdowns (settings `modelRoles`) are gone.
type ProviderType = 'stackit' | 'openai-compatible' | 'azure' | 'bedrock' | 'self-hosted';
// `management` = who owns the model (from LiteLLM's `db_model`): `config` = set by the deployment's
// `model_list` (changed with a deploy), `database` = registered in LiteLLM (removable), `mixed` = both.
type Management = 'config' | 'database' | 'mixed';
type CatalogModel = { model_name: string; display: string; provenance: 'internal' | 'external'; providerType?: ProviderType; tier?: string; management?: Management; mode?: 'chat' | 'embedding'; credentials?: string[]; images?: boolean };
type RoleView = { role: string; model: string; inCatalog: boolean; cost: { inputPerM: number; outputPerM: number } | null };
type RolesPayload = {
  mapping: Record<string, string> | null; roles: RoleView[]; warnings: string[]; litellmUi: string; source: 'litellm' | 'unavailable'; error?: string;
  catalog: { name: string; cost: { inputPerM: number; outputPerM: number } | null }[]; report: { state: string; ok: boolean } | null;
};
const ROLE_NAMES = ['sovereign-strong', 'sovereign-worker', 'sovereign-embedding'];
const ROLE_HELP: Record<string, 'models.roles.helpStrong' | 'models.roles.helpWorker' | 'models.roles.helpEmbedding'> = {
  'sovereign-strong': 'models.roles.helpStrong',
  'sovereign-worker': 'models.roles.helpWorker',
  'sovereign-embedding': 'models.roles.helpEmbedding',
};
type Connection = { name: string; info: Record<string, unknown>; models: string[] };
const MANAGEMENT_LABEL: Record<Management, `management.${Management}`> = { config: 'management.config', database: 'management.database', mixed: 'management.mixed' };
// The exact `toLocaleString()` shape the page showed before i18n (en: "11/27/2026, 2:05:07 PM"), now in the user's language.
const SAVED_AT: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' };
// Which models may be sent an image — the server's answer (core/models/capabilities.ts), shown
// read-only. `models` is the list in force; `source` says whether it is the built-in list or the
// deployment's own. This page never works the answer out for itself.
type ImageInput = { models: string[]; source: 'default' | 'override'; warnings: string[] };

// Product names stay as they are; the two descriptive labels are catalog keys.
const PROVIDER_LABELS: Record<ProviderType, { name: string } | { key: 'providers.openaiCompatible' | 'providers.selfHosted' }> = {
  stackit: { name: 'STACKIT AI Model Serving' },
  'openai-compatible': { key: 'providers.openaiCompatible' },
  'self-hosted': { key: 'providers.selfHosted' },
  azure: { name: 'Azure OpenAI' },
  bedrock: { name: 'AWS Bedrock' },
};

// Token prices (EUR per 1M tokens) — stored beats the deployment-config seed.
type PriceRow = { inputPerM: number; outputPerM: number; source: 'stored' | 'env' };
type PriceEdit = { input: string; output: string };

export default function ModelsProviders() {
  const { user, loading } = useUser();
  const role = user?.role ?? null;
  // Fail closed: ModelsPageInner holds every hook and every fetch, so until the role
  // resolves AND clears the floor nothing renders and nothing is requested.
  if (loading || role === null || !roleAtLeast(role, sectionMinRole('models'))) return null;
  // The remove flow uses the OS-standard confirm dialog — provider wraps the body once.
  return (
    <ConfirmProvider>
      <ModelsPageInner />
    </ConfirmProvider>
  );
}

function ModelsPageInner() {
  const t = useTranslations('admin');
  const f = useFormat();
  const confirm = useConfirm();
  // A price exactly as typed (en: 0.15 / 1000), with the locale's decimal sign.
  const price = (n: number) => f.number(n, { maximumFractionDigits: 20, useGrouping: false });
  const money = (c: { inputPerM: number; outputPerM: number } | null | undefined) => (c ? t('models.roles.priced', { input: price(c.inputPerM), output: price(c.outputPerM) }) : t('models.roles.unpriced'));
  const strong = (chunks: React.ReactNode) => <strong>{chunks}</strong>;
  const code = (chunks: React.ReactNode) => <code>{chunks}</code>;
  const [assistant, setAssistant] = useState('');
  const [assistantExplicit, setAssistantExplicit] = useState(false);
  const [assistantRole, setAssistantRole] = useState<'strong' | 'worker' | 'pinned'>('strong');
  // Live gateway catalog (source of truth for the role selectors) + the current
  // modelRoles store (the ONE per-role default store).
  const [catalog, setCatalog] = useState<CatalogModel[]>([]);
  const [catalogSource, setCatalogSource] = useState<'litellm' | 'unavailable' | null>(null);
  const [catalogError, setCatalogError] = useState('');
  const [rolesData, setRolesData] = useState<RolesPayload | null>(null);
  const [roleEdit, setRoleEdit] = useState<Record<string, string>>({});
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [imageInput, setImageInput] = useState<ImageInput | null>(null);
  // Cost routing: standard-first escalation (default ON). Strictly-validated surfaces
  // try Standard first and escalate to Reasoning only on a validation miss.
  const [standardFirst, setStandardFirst] = useState(false);
  // Token prices: the effective book (stored/env per row) + unsaved field edits.
  const [prices, setPrices] = useState<Record<string, PriceRow>>({});
  const [pricesMeta, setPricesMeta] = useState<{ updatedAt?: string; updatedBy?: string }>({});
  const [priceEdits, setPriceEdits] = useState<Record<string, PriceEdit>>({});
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [toast, setToast] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      fetch('/api/platform-admin/models/roles', { cache: 'no-store' }).then(async (r) => { if (r.ok) { const d = (await r.json()) as RolesPayload; setRolesData(d); setRoleEdit(d.mapping ?? {}); } }).catch(() => undefined);
      const [mRes, cRes, sRes, pRes] = await Promise.all([
        fetch('/api/platform-admin/models', { cache: 'no-store' }),
        fetch('/api/agents/models', { cache: 'no-store' }),
        fetch('/api/platform-admin/settings', { cache: 'no-store' }),
        fetch('/api/platform-admin/models/prices', { cache: 'no-store' }),
      ]);
      const mBody = await mRes.json();
      if (!mRes.ok) { setError(mBody.error ?? t('models.errors.loadFailed')); return; }
      setAssistant(mBody.assistant ?? ''); setAssistantExplicit(Boolean(mBody.assistantExplicit)); setAssistantRole(mBody.assistantRole === 'pinned' || mBody.assistantRole === 'worker' ? mBody.assistantRole : 'strong');
      if (cRes.ok) { const c = await cRes.json(); setCatalog(c.models ?? []); setCatalogSource(c.source ?? null); setCatalogError(c.error ?? ''); setConnections(c.credentials ?? null); setImageInput(c.imageInput ?? null); }
      if (sRes.ok) { const s = await sRes.json(); setStandardFirst(s.settings?.standardFirstEscalation === true); }
      if (pRes.ok) { const p = await pRes.json(); setPrices(p.prices ?? {}); setPricesMeta({ updatedAt: p.updatedAt, updatedBy: p.updatedBy }); setPriceEdits({}); }
    } catch (e) { setError((e as Error).message); } finally { setLoading(false); }
  }, [t]);
  useEffect(() => { load(); }, [load]);

  // Map the three roles (OS-owned; committed as os/models.yml and applied to LiteLLM). Refusals are typed and shown.
  const saveRoleMapping = useCallback(async () => {
    setBusy('rolemap'); setError('');
    try {
      const res = await fetch('/api/platform-admin/models/roles', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ roles: roleEdit }) });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? t('models.errors.roleMapSaveFailed'));
      else { setToast(t('models.toasts.roleMapSaved')); await load(); }
    } finally { setBusy(''); }
  }, [roleEdit, load, t]);

  // Cost routing switch (settings `standardFirstEscalation`) — the only per-role setting that is not the mapping.
  const saveRoles = useCallback(async () => {
    setBusy('roles'); setError('');
    try {
      const res = await fetch('/api/platform-admin/settings', {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ standardFirstEscalation: standardFirst }),
      });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? t('models.errors.saveFailed'));
      else { setToast(t('models.toasts.leadSaved')); await load(); }
    } finally { setBusy(''); }
  }, [standardFirst, load, t]);

  // Save the edited token prices. Both fields set → an override; both cleared on
  // a stored row → remove the override (back to the deployment seed / unpriced).
  const savePrices = useCallback(async () => {
    const patch: Record<string, { inputPerM: number; outputPerM: number } | null> = {};
    for (const [name, e] of Object.entries(priceEdits)) {
      const inp = e.input.trim();
      const out = e.output.trim();
      if (inp === '' && out === '') {
        if (prices[name]?.source === 'stored') patch[name] = null;
        continue;
      }
      const inputPerM = Number(inp);
      const outputPerM = Number(out);
      if (inp === '' || out === '' || !Number.isFinite(inputPerM) || inputPerM < 0 || !Number.isFinite(outputPerM) || outputPerM < 0) {
        setError(t('models.errors.priceInvalid', { name }));
        return;
      }
      patch[name] = { inputPerM, outputPerM };
    }
    if (Object.keys(patch).length === 0) return;
    setBusy('prices'); setError('');
    try {
      const res = await fetch('/api/platform-admin/models/prices', {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prices: patch }),
      });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? t('models.errors.pricesSaveFailed'));
      else { setToast(t('models.toasts.pricesSaved')); await load(); }
    } finally { setBusy(''); }
  }, [priceEdits, prices, load, t]);

  const patch = useCallback(async (id: string, payload: Record<string, unknown>) => {
    setBusy(id); setError('');
    try {
      const res = await fetch(`/api/platform-admin/models/${id}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
      });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? t('models.errors.updateFailed'));
      else await load();
    } finally { setBusy(''); }
  }, [load, t]);

  // Remove an administrator-added model — reference-aware two-step confirm.
  // Usages (role pins, assistant pin, agent per-node pins) are listed in the FIRST
  // dialog; a model that is in use additionally requires typing its alias (the
  // explicit second confirmation) before the force-remove is sent. The server
  // re-checks both (409 without force; seeded models always refused).
  const removeCatalogModel = useCallback(async (name: string) => {
    setError('');
    let refs: ModelReference[] = [];
    try {
      const rRes = await fetch(`/api/platform-admin/models/${encodeURIComponent(name)}/references`, { cache: 'no-store' });
      if (rRes.ok) refs = (await rRes.json()).references ?? [];
    } catch { /* sweep unavailable — the server still blocks a referenced delete */ }
    const used = refs.length > 0;
    const ok = await confirm({
      title: t('models.remove.title', { name }),
      body: used
        ? t('models.remove.bodyUsed', { usages: refs.map((r) => r.label).join(' · ') })
        : t('models.remove.bodyUnused'),
      confirmLabel: used ? t('models.remove.continue') : t('models.remove.remove'),
      danger: true,
    });
    if (!ok) return;
    if (used) {
      const ok2 = await confirm({
        title: t('models.remove.inUseTitle'),
        body: t('models.remove.inUseBody'),
        confirmLabel: t('models.remove.removeAnyway'),
        danger: true,
        confirmPhrase: name,
      });
      if (!ok2) return;
    }
    setBusy(`rm-${name}`);
    try {
      const res = await fetch(`/api/platform-admin/models/${encodeURIComponent(name)}${used ? '?force=1' : ''}`, { method: 'DELETE' });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? t('models.errors.removeFailed'));
      else { setToast(t('models.toasts.removed', { name })); await load(); }
    } finally { setBusy(''); }
  }, [confirm, load, t]);

  return (
    <>
      <div>
        {toast ? <div className="hint" style={{ color: 'var(--teal)' }}>{toast}</div> : null}
        {error ? <div className="error">{error}</div> : null}

        <div className="section-title">{t('models.roles.title')}</div>
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="hint" style={{ marginBottom: 10 }}>
            {t.rich('models.roles.intro', {
              strong, code,
              link: (chunks) => <a href={rolesData?.litellmUi ?? '/tools/litellm/ui'} target="_blank" rel="noreferrer">{chunks}</a>,
            })}
          </div>
          {rolesData?.source === 'unavailable' ? <div className="error">{rolesData.error}</div> : null}
          {(rolesData?.warnings ?? []).map((w) => <div key={w} className="error" role="alert" style={{ marginBottom: 8 }}>{w}</div>)}
          {ROLE_NAMES.map((role) => {
            const cur = rolesData?.roles.find((r) => r.role === role);
            const val = roleEdit[role] ?? '';
            const cost = rolesData?.catalog.find((m) => m.name === val)?.cost ?? null;
            return (
              <div key={role} className="row" style={{ gap: 12, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                <label className="hint" style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 340px' }}>
                  <span><code>{role}</code> {cur && !cur.inCatalog ? <span className="pa-tag" style={{ color: 'var(--danger)' }}>{t('models.roles.missing')}</span> : null}</span>
                  <select value={val} disabled={busy !== '' || rolesData?.source === 'unavailable'} onChange={(e) => setRoleEdit({ ...roleEdit, [role]: e.target.value })}>
                    <option value="">{t('models.roles.choose')}</option>
                    {(rolesData?.catalog ?? []).map((m) => <option key={m.name} value={m.name}>{m.name}</option>)}
                    {val && !(rolesData?.catalog ?? []).some((m) => m.name === val) ? <option value={val}>{t('models.roles.notInCatalog', { model: val })}</option> : null}
                  </select>
                  <span className="hint" style={{ fontSize: 12 }}>{ROLE_HELP[role] ? t(ROLE_HELP[role]) : null} {val ? t('models.roles.cost', { cost: money(cost) }) : ''}</span>
                </label>
              </div>
            );
          })}
          <div className="hint" style={{ fontSize: 12, marginBottom: 10 }}>
            {t('models.roles.aliases', {
              list: ROLE_NAMES.map((r) => `${Object.entries(DEPRECATED_ALIASES).filter(([, to]) => to === r).map(([a]) => a).join(', ')} → ${r.replace('sovereign-', '')}`).join('; '),
            })}
          </div>
          <button className="btn" disabled={busy === 'rolemap' || ROLE_NAMES.some((r) => !roleEdit[r])} onClick={saveRoleMapping}>
            {busy === 'rolemap' ? <span className="spin" /> : t('models.roles.save')}
          </button>
        </div>

        <div className="section-title">{t('models.lead.title')}</div>
        <div className="card" style={{ marginBottom: 18 }}>
          <label
            className="row"
            style={{ gap: 10, alignItems: 'flex-start', marginTop: 6, marginBottom: 14, cursor: 'pointer' }}
          >
            <input
              type="checkbox"
              checked={standardFirst}
              disabled={busy !== ''}
              onChange={(e) => setStandardFirst(e.target.checked)}
              style={{ marginTop: 3 }}
            />
            <span className="hint" style={{ flex: 1 }}>
              <strong>{t(LEAD_SWITCH_LABEL_KEY)}</strong>
              <span style={{ display: 'block', fontSize: 12, marginTop: 2 }}>
                {t(leadSwitchTextKey(standardFirst), { model: assistant || t('models.lead.unset') })}{' '}
                {t('models.lead.trace')}
              </span>
            </span>
          </label>
          <button className="btn" disabled={busy === 'roles'} onClick={saveRoles}>
            {busy === 'roles' ? <span className="spin" /> : t('models.lead.save')}
          </button>
        </div>

        <div className="section-title" style={{ marginTop: 22 }}>{t('models.assistant.title')}</div>
        <p className="hint">{t.rich('models.assistant.intro', { strong })}</p>
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="comp-label" style={{ margin: 0 }}>{t('models.assistant.active')}</span>
            <span className="pa-tag" title={t('models.assistant.tagTitle')}>
              {assistant || t('models.lead.unset')} · {assistantRole === 'pinned' ? t('models.assistant.pinned') : t('models.assistant.roleLead', { role: assistantRole })}
            </span>
            <select
              value={assistantExplicit ? assistant : ''}
              disabled={busy !== ''}
              onChange={(e) => e.target.value === ''
                ? patch(assistant || 'assistant', { op: 'assistant-clear' })
                : patch(e.target.value, { op: 'assistant' })}
              style={{ minWidth: 260 }}
            >
              <option value="">{t('models.assistant.follow', { model: assistant || t('models.lead.unset') })}</option>
              {catalog.filter((m) => m.mode !== 'embedding').map((m) => (
                <option key={m.model_name} value={m.model_name}>{m.display} ({m.model_name})</option>
              ))}
              {assistantExplicit && assistant && !catalog.some((m) => m.model_name === assistant) ? <option value={assistant}>{t('models.assistant.notInLiteLLM', { model: assistant })}</option> : null}
            </select>
          </div>
          <div className="hint" style={{ marginTop: 10, fontSize: 12 }}>
            {t.rich('models.assistant.addHint', { strong })}
          </div>
        </div>

        <div className="section-title" style={{ marginTop: 22 }}>{t('models.provider.title')}</div>
        <p className="hint">{t('models.provider.intro')}</p>
        <ProviderWizard onRegistered={(msg) => { setToast(msg); load(); }} />

        {(() => {
          // The two catalog groups — the split rule lives in lib/platform-admin/
          // catalog-groups.ts (live db_model flag, else the governed endpoint mark).
          const liveByName = new Map(catalog.map((c) => [c.model_name, c]));
          const { managed, adminAdded } = splitCatalog(catalog);
          // The catalog models the three roles are mapped to now (os/models.yml).
          const roleDefaults = new Set((rolesData?.roles ?? []).map((r) => r.model));
          const familyOf = (name: string): string => {
            const type = liveByName.get(name)?.providerType;
            if (!type) return '';
            const label = PROVIDER_LABELS[type];
            if (!label) return type;
            return 'key' in label ? t(`models.${label.key}`) : label.name;
          };
          const row = (name: string, removable: boolean) => {
            const live = liveByName.get(name);
            const isDefault = roleDefaults.has(name);
            const isAssistant = assistant === name;
            const family = familyOf(name);
            // Exact name on the server's list, or "no". A model the server did not list is "no".
            const images = live?.images ?? imageInput?.models.includes(name) ?? false;
            return (
              <tr key={name}>
                <td>
                  <strong>{live?.display ?? name}</strong>
                  {isDefault ? <span className="pa-tag" style={{ marginLeft: 8 }}>{t('models.catalog.tagDefault')}</span> : null}
                  {isAssistant ? <span className="pa-tag" style={{ marginLeft: 8 }}>{t('models.catalog.tagAssistant')}</span> : null}
                  <span
                    className="pa-tag" style={{ marginLeft: 8 }}
                    title={images ? t('models.catalog.imagesYesTitle') : t('models.catalog.imagesNoTitle')}
                  >
                    {t('models.catalog.imagesTag', { images: images ? 'yes' : 'no' })}
                  </span>
                  <div className="muted" style={{ fontSize: 11 }}>{name}{live?.mode === 'embedding' ? ` · ${t('models.catalog.embedding')}` : ''}{family ? ` · ${family}` : ''}{live?.tier ? ` · ${t('models.catalog.tierSuffix', { tier: live.tier })}` : ''}</div>
                </td>
                <td>{live?.tier ? <span className="pa-tag">{live.tier}</span> : <span className="muted">—</span>}</td>
                <td>{family || '—'}</td>
                <td title={t('models.catalog.managedByTitle')}>
                  {live?.management ? t(`models.${MANAGEMENT_LABEL[live.management]}`) : '—'}
                  {live?.credentials?.length ? <div className="muted" style={{ fontSize: 11 }}>{t('models.catalog.connectionLine', { names: live.credentials.join(', ') })}</div> : null}
                </td>
                {removable ? (
                  <td>
                    <button
                      className="btn ghost" disabled={busy === `rm-${name}`}
                      onClick={() => removeCatalogModel(name)}
                      style={{ color: 'var(--danger)' }}
                    >
                      {busy === `rm-${name}` ? <span className="spin" /> : t('models.catalog.remove')}
                    </button>
                  </td>
                ) : null}
              </tr>
            );
          };
          const head = (
            <tr><th>{t('models.catalog.colModel')}</th><th>{t('models.catalog.colTier')}</th><th>{t('models.catalog.colProvider')}</th><th>{t('models.catalog.colManagedBy')}</th></tr>
          );
          return (
            <>
              <div className="section-title" style={{ marginTop: 22 }}>{t('models.catalog.managedTitle')}<span className="count-pill">{managed.length}</span></div>
              <div className="hint" style={{ marginBottom: 10 }}>
                {t.rich('models.catalog.managedHint', { code })}
                {catalogSource === 'unavailable' ? ` ${t('models.catalog.unavailable')}` : ''}
              </div>
              {imageInput ? (
                <div className="hint" style={{ marginBottom: 10 }}>
                  <strong>{t('models.catalog.imagesLabel')}</strong>{' '}
                  {imageInput.models.length === 0
                    ? t('models.catalog.imagesNone')
                    : t.rich('models.catalog.imagesOnly', {
                      models: () => <>{imageInput.models.map((n, i) => <span key={n}>{i > 0 ? ', ' : ''}<code>{n}</code></span>)}</>,
                    })}
                  {' '}
                  {imageInput.source === 'override'
                    ? t('models.catalog.imagesOverride')
                    : t('models.catalog.imagesDefault')}
                  {' '}{t.rich('models.catalog.imagesChange', { code })}
                  {imageInput.warnings.map((w) => <div key={w} style={{ color: 'var(--danger)', marginTop: 4 }}>{w}</div>)}
                </div>
              ) : null}
              <div className="table-wrap">
                <table>
                  <thead>{head}</thead>
                  <tbody>{managed.map((name) => row(name, false))}</tbody>
                </table>
              </div>

              <div className="section-title" style={{ marginTop: 22 }}>{t('models.catalog.adminTitle')}<span className="count-pill">{adminAdded.length}</span></div>
              <div className="hint" style={{ marginBottom: 10 }}>
                {t.rich('models.catalog.adminHint', { strong })}
              </div>
              {adminAdded.length === 0 ? (
                <div className="hint" style={{ marginBottom: 10 }}>
                  {t.rich('models.catalog.adminEmpty', { strong })}
                </div>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>{t('models.catalog.colModel')}</th><th>{t('models.catalog.colTier')}</th><th>{t('models.catalog.colProvider')}</th><th>{t('models.catalog.colManagedBy')}</th><th /></tr></thead>
                    <tbody>{adminAdded.map((name) => row(name, true))}</tbody>
                  </table>
                </div>
              )}
            </>
          );
        })()}


        {connections !== null ? (
          <>
            <div className="section-title" style={{ marginTop: 22 }}>{t('models.connections.title')}<span className="count-pill">{connections.length}</span></div>
            <div className="hint" style={{ marginBottom: 10 }}>{t('models.connections.hint')}</div>
            {connections.length === 0 ? <div className="hint" style={{ marginBottom: 10 }}>{t('models.connections.empty')}</div> : (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>{t('models.connections.colConnection')}</th><th>{t('models.connections.colModels')}</th></tr></thead>
                  <tbody>{connections.map((c) => (
                    <tr key={c.name}><td><strong>{c.name}</strong></td><td>{c.models.length ? c.models.join(', ') : <span className="muted">{t('models.connections.none')}</span>}</td></tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </>
        ) : catalogSource === 'litellm' ? <div className="hint" style={{ marginTop: 14 }}>{t('models.connections.unreadable')}</div> : null}

        <div className="section-title" style={{ marginTop: 22 }}>{t('models.prices.title')}</div>
        <div className="hint" style={{ marginBottom: 10 }}>
          {t.rich('models.prices.hint', { code, strong, em: (chunks) => <em>{chunks}</em> })}
          {pricesMeta.updatedAt ? ` ${t('models.prices.lastSaved', { user: pricesMeta.updatedBy ?? '', date: f.dateTime(pricesMeta.updatedAt, SAVED_AT) })}` : ''}
        </div>
        <div className="table-wrap" style={{ marginBottom: 10 }}>
          <table>
            <thead><tr><th>{t('models.prices.colModel')}</th><th>{t('models.prices.colInput')}</th><th>{t('models.prices.colOutput')}</th><th>{t('models.prices.colStatus')}</th></tr></thead>
            <tbody>
              {(() => {
                // Every live LiteLLM model_name + any priced key (stored or env) that is no longer in LiteLLM.
                const names = [...new Set([
                  ...catalog.map((c) => c.model_name),
                  ...Object.keys(prices),
                ])].sort();
                const edit = (name: string, field: keyof PriceEdit, value: string) => {
                  const cur = prices[name];
                  const base: PriceEdit = priceEdits[name]
                    ?? { input: cur ? String(cur.inputPerM) : '', output: cur ? String(cur.outputPerM) : '' };
                  setPriceEdits({ ...priceEdits, [name]: { ...base, [field]: value } });
                };
                return names.map((name) => {
                  const cur = prices[name];
                  const e = priceEdits[name];
                  const inputVal = e ? e.input : cur ? String(cur.inputPerM) : '';
                  const outputVal = e ? e.output : cur ? String(cur.outputPerM) : '';
                  return (
                    <tr key={name}>
                      <td><span className="mono" style={{ fontSize: 12 }}>{name}</span></td>
                      <td>
                        <input type="number" min={0} step="any" value={inputVal} placeholder="—"
                          style={{ width: 110 }} disabled={busy === 'prices'}
                          onChange={(ev) => edit(name, 'input', ev.target.value)} />
                      </td>
                      <td>
                        <input type="number" min={0} step="any" value={outputVal} placeholder="—"
                          style={{ width: 110 }} disabled={busy === 'prices'}
                          onChange={(ev) => edit(name, 'output', ev.target.value)} />
                      </td>
                      <td>
                        {e ? <span className="pa-tag">{t('models.prices.unsaved')}</span>
                          : cur?.source === 'stored' ? <span className="pa-tag">{t('models.prices.adminSet')}</span>
                          : cur?.source === 'env' ? <span className="muted" style={{ fontSize: 11 }}>{t('models.prices.seeded')}</span>
                          : <span className="muted" style={{ fontSize: 11 }}>{t('models.prices.unpriced')}</span>}
                      </td>
                    </tr>
                  );
                });
              })()}
            </tbody>
          </table>
        </div>
        {catalog.length === 0 && Object.keys(prices).length === 0
          ? <div className="hint">{t('models.prices.empty')}</div> : null}
        <button className="btn" disabled={busy === 'prices' || Object.keys(priceEdits).length === 0} onClick={savePrices} style={{ marginBottom: 6 }}>
          {busy === 'prices' ? <span className="spin" /> : t('models.prices.save')}
        </button>

        <div className="hint" style={{ marginTop: 14 }}>
          {t.rich('models.footer', { link: (chunks) => <Link href="/monitoring#spend">{chunks}</Link> })}
        </div>
      </div>
    </>
  );
}
