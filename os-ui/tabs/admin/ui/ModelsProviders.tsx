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
 */
'use client';

import { LEAD_SWITCH_LABEL, leadSwitchText } from '@tabs/admin/lib/lead-model-label';
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
const ROLE_HELP: Record<string, string> = {
  'sovereign-strong': 'Planning, deep reasoning and image understanding.',
  'sovereign-worker': 'Assistants, agent execution and light work.',
  'sovereign-embedding': 'Knowledge and Files embeddings.',
};
const money = (c: { inputPerM: number; outputPerM: number } | null | undefined) => (c ? `${c.inputPerM} in / ${c.outputPerM} out per 1M tokens` : 'no price in LiteLLM (cost shows as unpriced)');
type Connection = { name: string; info: Record<string, unknown>; models: string[] };
const MANAGEMENT_LABEL: Record<Management, string> = { config: 'deployment config', database: 'LiteLLM database', mixed: 'config + LiteLLM database' };
// Which models may be sent an image — the server's answer (core/models/capabilities.ts), shown
// read-only. `models` is the list in force; `source` says whether it is the built-in list or the
// deployment's own. This page never works the answer out for itself.
type ImageInput = { models: string[]; source: 'default' | 'override'; warnings: string[] };

const PROVIDER_LABELS: Record<ProviderType, string> = {
  stackit: 'STACKIT AI Model Serving',
  'openai-compatible': 'OpenAI-compatible',
  'self-hosted': 'self-hosted',
  azure: 'Azure OpenAI',
  bedrock: 'AWS Bedrock',
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
  const confirm = useConfirm();
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
      if (!mRes.ok) { setError(mBody.error ?? 'Failed to load'); return; }
      setAssistant(mBody.assistant ?? ''); setAssistantExplicit(Boolean(mBody.assistantExplicit)); setAssistantRole(mBody.assistantRole === 'pinned' || mBody.assistantRole === 'worker' ? mBody.assistantRole : 'strong');
      if (cRes.ok) { const c = await cRes.json(); setCatalog(c.models ?? []); setCatalogSource(c.source ?? null); setCatalogError(c.error ?? ''); setConnections(c.credentials ?? null); setImageInput(c.imageInput ?? null); }
      if (sRes.ok) { const s = await sRes.json(); setStandardFirst(s.settings?.standardFirstEscalation === true); }
      if (pRes.ok) { const p = await pRes.json(); setPrices(p.prices ?? {}); setPricesMeta({ updatedAt: p.updatedAt, updatedBy: p.updatedBy }); setPriceEdits({}); }
    } catch (e) { setError((e as Error).message); } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  // Map the three roles (OS-owned; committed as os/models.yml and applied to LiteLLM). Refusals are typed and shown.
  const saveRoleMapping = useCallback(async () => {
    setBusy('rolemap'); setError('');
    try {
      const res = await fetch('/api/platform-admin/models/roles', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ roles: roleEdit }) });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? 'Could not save the role mapping');
      else { setToast('Saved the role mapping — it is applied at the gateway now; every caller resolves it there.'); await load(); }
    } finally { setBusy(''); }
  }, [roleEdit, load]);

  // Cost routing switch (settings `standardFirstEscalation`) — the only per-role setting that is not the mapping.
  const saveRoles = useCallback(async () => {
    setBusy('roles'); setError('');
    try {
      const res = await fetch('/api/platform-admin/settings', {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ standardFirstEscalation: standardFirst }),
      });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? 'Save failed');
      else { setToast('Saved the lead-model setting.'); await load(); }
    } finally { setBusy(''); }
  }, [standardFirst, load]);

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
        setError(`${name}: both € prices are required and must be ≥ 0 (leave both empty to clear).`);
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
      if (!res.ok) setError(body.error ?? 'Failed to save prices');
      else { setToast('Saved token prices — Monitoring cost attribution uses these immediately, no redeploy.'); await load(); }
    } finally { setBusy(''); }
  }, [priceEdits, prices, load]);

  const patch = useCallback(async (id: string, payload: Record<string, unknown>) => {
    setBusy(id); setError('');
    try {
      const res = await fetch(`/api/platform-admin/models/${id}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
      });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? 'Update failed');
      else await load();
    } finally { setBusy(''); }
  }, [load]);

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
      title: `Remove “${name}”?`,
      body: used
        ? `Used as: ${refs.map((r) => r.label).join(' · ')}. Removing this model breaks those until an admin re-points them.`
        : 'The model is removed from the gateway and disappears from every picker. Your provider account is untouched — you can add it again anytime with Add provider.',
      confirmLabel: used ? 'Continue' : 'Remove',
      danger: true,
    });
    if (!ok) return;
    if (used) {
      const ok2 = await confirm({
        title: 'Remove a model that is in use?',
        body: 'The usages listed before will fail until an admin re-points them. Type the model alias to confirm.',
        confirmLabel: 'Remove anyway',
        danger: true,
        confirmPhrase: name,
      });
      if (!ok2) return;
    }
    setBusy(`rm-${name}`);
    try {
      const res = await fetch(`/api/platform-admin/models/${encodeURIComponent(name)}${used ? '?force=1' : ''}`, { method: 'DELETE' });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? 'Remove failed');
      else { setToast(`Removed ${name} — it is gone from the gateway and every picker.`); await load(); }
    } finally { setBusy(''); }
  }, [confirm, load]);

  return (
    <>
      <div>
        {toast ? <div className="hint" style={{ color: 'var(--teal)' }}>{toast}</div> : null}
        {error ? <div className="error">{error}</div> : null}

        <div className="section-title">Model roles · the three names every caller uses</div>
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="hint" style={{ marginBottom: 10 }}>
            <strong>Owned by the OS.</strong> Each role below points at a model in the LiteLLM catalog. The mapping is saved as
            the file <code>os/models.yml</code> in the platform repository (versioned) and applied to LiteLLM, so os-ui, agents
            and apps all resolve a role the same way, at the gateway. If someone edits the alias in LiteLLM, the OS puts it back
            and shows it here. The <strong>catalog</strong> — the real models and their keys — is <strong>owned by LiteLLM</strong>:
            add or remove models there (<a href={rolesData?.litellmUi ?? '/tools/litellm/ui'} target="_blank" rel="noreferrer">open LiteLLM ↗</a>).
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
                  <span><code>{role}</code> {cur && !cur.inCatalog ? <span className="pa-tag" style={{ color: 'var(--danger)' }}>model missing in LiteLLM</span> : null}</span>
                  <select value={val} disabled={busy !== '' || rolesData?.source === 'unavailable'} onChange={(e) => setRoleEdit({ ...roleEdit, [role]: e.target.value })}>
                    <option value="">— choose a catalog model —</option>
                    {(rolesData?.catalog ?? []).map((m) => <option key={m.name} value={m.name}>{m.name}</option>)}
                    {val && !(rolesData?.catalog ?? []).some((m) => m.name === val) ? <option value={val}>{val} (not in the catalog)</option> : null}
                  </select>
                  <span className="hint" style={{ fontSize: 12 }}>{ROLE_HELP[role]} {val ? `Cost: ${money(cost)}.` : ''}</span>
                </label>
              </div>
            );
          })}
          <div className="hint" style={{ fontSize: 12, marginBottom: 10 }}>
            Old names keep working for one release, as aliases of these roles:{' '}
            {ROLE_NAMES.map((r) => `${Object.entries(DEPRECATED_ALIASES).filter(([, to]) => to === r).map(([a]) => a).join(', ')} → ${r.replace('sovereign-', '')}`).join('; ')}.
          </div>
          <button className="btn" disabled={busy === 'rolemap' || ROLE_NAMES.some((r) => !roleEdit[r])} onClick={saveRoleMapping}>
            {busy === 'rolemap' ? <span className="spin" /> : 'Save role mapping'}
          </button>
        </div>

        <div className="section-title">Lead model</div>
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
              <strong>{LEAD_SWITCH_LABEL}</strong>
              <span style={{ display: 'block', fontSize: 12, marginTop: 2 }}>
                {leadSwitchText(standardFirst, assistant || 'unset')}{' '}
                Every escalation is shown in the turn's model trace.
              </span>
            </span>
          </label>
          <button className="btn" disabled={busy === 'roles'} onClick={saveRoles}>
            {busy === 'roles' ? <span className="spin" /> : 'Save'}
          </button>
        </div>

        <div className="section-title" style={{ marginTop: 22 }}>Assistant model · the ONE LLM behind every built-in assistant</div>
        <p className="hint">
          Agents &amp; Software build chat, the Big Bets planner, the Knowledge assistant and the Metric
          agent all run on <strong>this one model</strong>, through the governed LiteLLM gateway. By default
          it <strong>follows the lead role</strong> (the strong model, unless the cost saver below is on): it plans, chooses tools and writes every
          answer on the lead model; the strong lead hands only clearly defined, schema-checked sub-tasks to the worker. Override it below to pin a
          model you added with Add a provider.
        </p>
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="comp-label" style={{ margin: 0 }}>Active assistant</span>
            <span className="pa-tag" title="The model the assistant runs on right now, and the role it stands for">
              {assistant || 'unset'} · {assistantRole === 'pinned' ? 'pinned by an admin' : `${assistantRole} role (lead)`}
            </span>
            <select
              value={assistantExplicit ? assistant : ''}
              disabled={busy !== ''}
              onChange={(e) => e.target.value === ''
                ? patch(assistant || 'assistant', { op: 'assistant-clear' })
                : patch(e.target.value, { op: 'assistant' })}
              style={{ minWidth: 260 }}
            >
              <option value="">Follow the lead role ({assistant || 'unset'})</option>
              {catalog.filter((m) => m.mode !== 'embedding').map((m) => (
                <option key={m.model_name} value={m.model_name}>{m.display} ({m.model_name})</option>
              ))}
              {assistantExplicit && assistant && !catalog.some((m) => m.model_name === assistant) ? <option value={assistant}>{assistant} (not in LiteLLM now)</option> : null}
            </select>
          </div>
          <div className="hint" style={{ marginTop: 10, fontSize: 12 }}>
            To use a model that is not listed, add it with <strong>Add a provider</strong> below; it then appears here.
          </div>
        </div>

        <div className="section-title" style={{ marginTop: 22 }}>Add a provider · connect your own LLM backend</div>
        <p className="hint">
          Azure OpenAI, an OpenAI-compatible server (vLLM, LM Studio, EU Router), Ollama, Mistral, STACKIT or any
          other provider the LiteLLM gateway supports. The connection and the model are stored in the gateway&rsquo;s
          own database (durable across restarts); the key is kept by the gateway, encrypted, and never shown again.
          The provider&rsquo;s host must be on the egress allowlist — if it is not, this flow says exactly what to add.
        </p>
        <ProviderWizard onRegistered={(msg) => { setToast(msg); load(); }} />

        {(() => {
          // The two catalog groups — the split rule lives in lib/platform-admin/
          // catalog-groups.ts (live db_model flag, else the governed endpoint mark).
          const liveByName = new Map(catalog.map((c) => [c.model_name, c]));
          const { managed, adminAdded } = splitCatalog(catalog);
          // The catalog models the three roles are mapped to now (os/models.yml).
          const roleDefaults = new Set((rolesData?.roles ?? []).map((r) => r.model));
          const familyOf = (name: string): string => {
            const t = liveByName.get(name)?.providerType;
            return t ? (PROVIDER_LABELS[t] ?? t) : '';
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
                  {isDefault ? <span className="pa-tag" style={{ marginLeft: 8 }}>default</span> : null}
                  {isAssistant ? <span className="pa-tag" style={{ marginLeft: 8 }}>assistant</span> : null}
                  <span
                    className="pa-tag" style={{ marginLeft: 8 }}
                    title={images ? 'This model is on the list of models that may be sent images.' : 'This model is not on the list of models that may be sent images.'}
                  >
                    Images: {images ? 'yes' : 'no'}
                  </span>
                  <div className="muted" style={{ fontSize: 11 }}>{name}{live?.mode === 'embedding' ? ' · embedding' : ''}{family ? ` · ${family}` : ''}{live?.tier ? ` · ${live.tier} tier` : ''}</div>
                </td>
                <td>{live?.tier ? <span className="pa-tag">{live.tier}</span> : <span className="muted">—</span>}</td>
                <td>{familyOf(name) || '—'}</td>
                <td title="Who manages this model. Access and budgets are set in LiteLLM.">
                  {live?.management ? MANAGEMENT_LABEL[live.management] : '—'}
                  {live?.credentials?.length ? <div className="muted" style={{ fontSize: 11 }}>connection: {live.credentials.join(', ')}</div> : null}
                </td>
                {removable ? (
                  <td>
                    <button
                      className="btn ghost" disabled={busy === `rm-${name}`}
                      onClick={() => removeCatalogModel(name)}
                      style={{ color: 'var(--danger)' }}
                    >
                      {busy === `rm-${name}` ? <span className="spin" /> : 'Remove'}
                    </button>
                  </td>
                ) : null}
              </tr>
            );
          };
          return (
            <>
              <div className="section-title" style={{ marginTop: 22 }}>Set by the deployment<span className="count-pill">{managed.length}</span></div>
              <div className="hint" style={{ marginBottom: 10 }}>
                The models the deployment&rsquo;s gateway config sets (<code>litellm.proxy_config.model_list</code>). The chart values are authoritative: change them with a deploy — LiteLLM cannot edit or delete them. This list is read live from LiteLLM.
                {catalogSource === 'unavailable' ? ' LiteLLM could not be read, so no models are listed — the OS does not guess.' : ''}
              </div>
              {imageInput ? (
                <div className="hint" style={{ marginBottom: 10 }}>
                  <strong>Images.</strong>{' '}
                  {imageInput.models.length === 0
                    ? 'No model may be sent images.'
                    : <>Only these models may be sent images: {imageInput.models.map((n, i) => <span key={n}>{i > 0 ? ', ' : ''}<code>{n}</code></span>)}.</>}
                  {' '}
                  {imageInput.source === 'override'
                    ? 'This list is set by your deployment.'
                    : 'This is the built-in list.'}
                  {' '}To change it, set <code>osUI.imageAllowlist</code> in the deployment values. Any model not on the list is never sent an image.
                  {imageInput.warnings.map((w) => <div key={w} style={{ color: 'var(--danger)', marginTop: 4 }}>{w}</div>)}
                </div>
              ) : null}
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Model</th><th>Tier</th><th>Provider</th><th>Managed by</th></tr></thead>
                  <tbody>{managed.map((name) => row(name, false))}</tbody>
                </table>
              </div>

              <div className="section-title" style={{ marginTop: 22 }}>Added by administrators<span className="count-pill">{adminAdded.length}</span></div>
              <div className="hint" style={{ marginBottom: 10 }}>
                Models registered in LiteLLM&rsquo;s own database — with <strong>Add provider</strong> here, or directly in LiteLLM. LiteLLM is authoritative: a model added or removed there shows up here. Each can be removed; the OS first
                shows where it is used (role pins, the assistant, agents) so nothing breaks silently.
              </div>
              {adminAdded.length === 0 ? (
                <div className="hint" style={{ marginBottom: 10 }}>
                  No models in LiteLLM&rsquo;s database — add your cloud provider&rsquo;s LLM with <strong>Add provider</strong> above, or in LiteLLM.
                </div>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>Model</th><th>Tier</th><th>Provider</th><th>Managed by</th><th /></tr></thead>
                    <tbody>{adminAdded.map((name) => row(name, true))}</tbody>
                  </table>
                </div>
              )}
            </>
          );
        })()}


        {connections !== null ? (
          <>
            <div className="section-title" style={{ marginTop: 22 }}>Connections in LiteLLM<span className="count-pill">{connections.length}</span></div>
            <div className="hint" style={{ marginBottom: 10 }}>
              The provider connections LiteLLM holds (its credential store). Keys are kept by LiteLLM, encrypted, and never shown here.
            </div>
            {connections.length === 0 ? <div className="hint" style={{ marginBottom: 10 }}>No connections yet.</div> : (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Connection</th><th>Models using it</th></tr></thead>
                  <tbody>{connections.map((c) => (
                    <tr key={c.name}><td><strong>{c.name}</strong></td><td>{c.models.length ? c.models.join(', ') : <span className="muted">none</span>}</td></tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </>
        ) : catalogSource === 'litellm' ? <div className="hint" style={{ marginTop: 14 }}>LiteLLM&rsquo;s connection list could not be read.</div> : null}

        <div className="section-title" style={{ marginTop: 22 }}>Token prices · € per 1M tokens</div>
        <div className="hint" style={{ marginBottom: 10 }}>
          What Monitoring charges a run against, per LiteLLM <code>model_name</code> (in the currency of your price book).
          Saved prices are durable and apply immediately — no redeploy. Values marked
          <em> seeded from deployment config</em> come from <code>MODEL_PRICES_JSON</code> until you save
          an override; clear both fields to drop an override again. An unpriced model is honest:
          its runs show <strong>—</strong>, never a fabricated €0.
          {pricesMeta.updatedAt ? ` Last saved by ${pricesMeta.updatedBy} · ${new Date(pricesMeta.updatedAt).toLocaleString()}.` : ''}
        </div>
        <div className="table-wrap" style={{ marginBottom: 10 }}>
          <table>
            <thead><tr><th>Model</th><th>€ input / 1M</th><th>€ output / 1M</th><th>Status</th></tr></thead>
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
                        {e ? <span className="pa-tag">unsaved</span>
                          : cur?.source === 'stored' ? <span className="pa-tag">admin-set</span>
                          : cur?.source === 'env' ? <span className="muted" style={{ fontSize: 11 }}>seeded from deployment config</span>
                          : <span className="muted" style={{ fontSize: 11 }}>Unpriced — cost shows —</span>}
                      </td>
                    </tr>
                  );
                });
              })()}
            </tbody>
          </table>
        </div>
        {catalog.length === 0 && Object.keys(prices).length === 0
          ? <div className="hint">No models configured yet — register a model above to price it.</div> : null}
        <button className="btn" disabled={busy === 'prices' || Object.keys(priceEdits).length === 0} onClick={savePrices} style={{ marginBottom: 6 }}>
          {busy === 'prices' ? <span className="spin" /> : 'Save prices'}
        </button>

        <div className="hint" style={{ marginTop: 14 }}>
          Model access and budgets are set in LiteLLM; live spend and the tenant envelope are in <Link href="/monitoring#spend">Monitoring</Link>.
        </div>
      </div>
    </>
  );
}
