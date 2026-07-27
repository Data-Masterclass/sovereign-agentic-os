/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import PageHeader from '@/components/PageHeader';
import { ConfirmProvider, useConfirm } from '@/components/lifecycle/ConfirmDialog';
import { splitCatalog } from '@/lib/platform-admin/catalog-groups';

type Task = 'chat' | 'reasoning' | 'embedding';
// `endpoint` is present ONLY on administrator-registered models (a secrets-manager
// ref + fingerprint, never a raw key) — its presence marks a model as removable
// when the live gateway can't say (offline). Mirrors lib/platform-admin/catalog-groups.
type Model = { id: string; label: string; provider: string; task: Task; tier: 'sovereign' | 'premium'; route: string; enabled: boolean; capEUR: number | null; endpoint?: unknown };
type Key = { provider: string; fingerprint: string; addedBy: string; addedAt: string };
type ModelReference = { kind: 'role' | 'assistant' | 'agent'; label: string };

// The three per-ROLE defaults are ONE store: the platform-admin settings
// `modelRoles`, resolved at runtime by lib/models/roles.ts. This page shows the
// SAME values (and writes the SAME store) as Settings → Model roles.
type RoleKey = 'standard' | 'reasoning' | 'embeddings';
type ProviderType = 'stackit' | 'openai-compatible' | 'azure' | 'bedrock' | 'self-hosted';
// `dbModel` = LiteLLM's seeded-vs-admin-added flag (true ⇒ registered via the
// add-provider wizard, removable; false ⇒ seeded from the deployment config).
type CatalogModel = { model_name: string; display: string; provenance: 'internal' | 'external'; providerType?: ProviderType; tier?: string; dbModel?: boolean };

const PROVIDER_LABELS: Record<ProviderType, string> = {
  stackit: 'STACKIT managed inference',
  'openai-compatible': 'OpenAI-compatible',
  'self-hosted': 'self-hosted',
  azure: 'Azure OpenAI',
  bedrock: 'AWS Bedrock',
};

// "Add provider" wizard — MVP ships OpenAI-compatible + STACKIT; Azure/Bedrock are
// scaffolded (disabled) so the stepper already has their slot for a later phase.
type WizardType = { type: ProviderType; label: string; blurb: string; enabled: boolean };
const WIZARD_TYPES: WizardType[] = [
  { type: 'openai-compatible', label: 'OpenAI-compatible', blurb: 'Any server that speaks the OpenAI API (vLLM, Ollama, LM Studio, a hosted endpoint).', enabled: true },
  { type: 'stackit', label: 'STACKIT managed inference', blurb: 'STACKIT-hosted models. Keep the org prefix in the model id (e.g. Qwen/Qwen3-VL-235B…).', enabled: true },
  { type: 'azure', label: 'Azure OpenAI', blurb: 'Coming soon.', enabled: false },
  { type: 'bedrock', label: 'AWS Bedrock', blurb: 'Coming soon.', enabled: false },
];
const EMPTY_WIZARD = { alias: '', baseUrl: '', modelName: '', apiKey: '', task: 'chat' as Task };
const ROLE_META: { key: RoleKey; label: string; help: string }[] = [
  { key: 'standard', label: 'Standard', help: 'Assistants, agent execution and light work. Default: sovereign-default.' },
  { key: 'reasoning', label: 'Reasoning', help: 'Planning and deep reasoning across the OS. Default: sovereign-reasoning.' },
  { key: 'embeddings', label: 'Embeddings', help: 'Knowledge + Files vector embeddings. Default: sovereign-embed.' },
];

const EMPTY_ASSISTANT = { label: 'STACKIT managed LLM', baseUrl: '', modelName: '', apiKey: '' };

// Token prices (EUR per 1M tokens) — stored beats the deployment-config seed.
type PriceRow = { inputPerM: number; outputPerM: number; source: 'stored' | 'env' };
type PriceEdit = { input: string; output: string };

export default function ModelsPage() {
  // The remove flow uses the OS-standard confirm dialog — provider wraps the page once.
  return (
    <ConfirmProvider>
      <ModelsPageInner />
    </ConfirmProvider>
  );
}

function ModelsPageInner() {
  const confirm = useConfirm();
  const [models, setModels] = useState<Model[]>([]);
  const [assistant, setAssistant] = useState('');
  const [assistantExplicit, setAssistantExplicit] = useState(false);
  const [keys, setKeys] = useState<Key[]>([]);
  // Live gateway catalog (source of truth for the role selectors) + the current
  // modelRoles store (the ONE per-role default store).
  const [catalog, setCatalog] = useState<CatalogModel[]>([]);
  const [catalogSource, setCatalogSource] = useState<'litellm' | 'offline' | null>(null);
  const [modelRoles, setModelRoles] = useState<Record<RoleKey, string>>({ standard: '', reasoning: '', embeddings: '' });
  // Cost routing: standard-first escalation (default ON). Strictly-validated surfaces
  // try Standard first and escalate to Reasoning only on a validation miss.
  const [standardFirst, setStandardFirst] = useState(true);
  // Token prices: the effective book (stored/env per row) + unsaved field edits.
  const [prices, setPrices] = useState<Record<string, PriceRow>>({});
  const [pricesMeta, setPricesMeta] = useState<{ updatedAt?: string; updatedBy?: string }>({});
  const [priceEdits, setPriceEdits] = useState<Record<string, PriceEdit>>({});
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [provider, setProvider] = useState('');
  const [value, setValue] = useState('');
  const [reg, setReg] = useState(EMPTY_ASSISTANT);
  const [toast, setToast] = useState('');
  // "Add provider" wizard: step 1 = pick type, step 2 = fields.
  const [wizType, setWizType] = useState<ProviderType | null>(null);
  const [wiz, setWiz] = useState(EMPTY_WIZARD);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [mRes, cRes, sRes, pRes] = await Promise.all([
        fetch('/api/platform-admin/models', { cache: 'no-store' }),
        fetch('/api/agents/models', { cache: 'no-store' }),
        fetch('/api/platform-admin/settings', { cache: 'no-store' }),
        fetch('/api/platform-admin/models/prices', { cache: 'no-store' }),
      ]);
      const mBody = await mRes.json();
      if (!mRes.ok) { setError(mBody.error ?? 'Failed to load'); return; }
      setModels(mBody.models ?? []); setAssistant(mBody.assistant ?? ''); setAssistantExplicit(Boolean(mBody.assistantExplicit)); setKeys(mBody.keys ?? []);
      if (cRes.ok) { const c = await cRes.json(); setCatalog(c.models ?? []); setCatalogSource(c.source ?? null); }
      if (sRes.ok) { const s = await sRes.json(); if (s.settings?.modelRoles) setModelRoles(s.settings.modelRoles); setStandardFirst(s.settings?.standardFirstEscalation !== false); }
      if (pRes.ok) { const p = await pRes.json(); setPrices(p.prices ?? {}); setPricesMeta({ updatedAt: p.updatedAt, updatedBy: p.updatedBy }); setPriceEdits({}); }
    } catch (e) { setError((e as Error).message); } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  // Save the three per-role defaults to the ONE store (settings modelRoles).
  const saveRoles = useCallback(async () => {
    setBusy('roles'); setError('');
    try {
      const res = await fetch('/api/platform-admin/settings', {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modelRoles, standardFirstEscalation: standardFirst }),
      });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? 'Save failed');
      else { setToast('Saved the default model per role — every assistant, agent and embedding call resolves through these.'); await load(); }
    } finally { setBusy(''); }
  }, [modelRoles, standardFirst, load]);

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

  const registerAssistant = useCallback(async () => {
    if (!reg.label.trim() || !reg.baseUrl.trim() || !reg.modelName.trim() || !reg.apiKey.trim()) return;
    setBusy('assistant-reg'); setError('');
    try {
      const res = await fetch('/api/platform-admin/models/assistant', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(reg),
      });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? 'Failed to register the assistant model');
      else {
        setToast(`Registered ${body.model.label} as the assistant model — key stored in the secrets manager, gateway ${body.gateway}. The raw key was never returned.`);
        setReg(EMPTY_ASSISTANT); await load();
      }
    } finally { setBusy(''); }
  }, [reg, load]);

  const addProvider = useCallback(async () => {
    if (!wizType || !wiz.alias.trim() || !wiz.baseUrl.trim() || !wiz.modelName.trim() || !wiz.apiKey.trim()) return;
    setBusy('provider'); setError('');
    try {
      const res = await fetch('/api/platform-admin/providers', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providerType: wizType, ...wiz }),
      });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? 'Failed to add the provider');
      else {
        setToast(`Registered ${body.model.label} under ${body.providerType} — key stored in the secrets manager (${body.fingerprint}), gateway ${body.gateway}. The raw key was never returned.`);
        setWiz(EMPTY_WIZARD); setWizType(null); await load();
      }
    } finally { setBusy(''); }
  }, [wizType, wiz, load]);

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

  const addKey = useCallback(async () => {
    if (!provider.trim() || !value.trim()) return;
    setBusy('key'); setError('');
    try {
      const res = await fetch('/api/platform-admin/models', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider, value }),
      });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? 'Failed to store key');
      else { setToast(`Stored ${provider} key in the secrets manager — fingerprint ${body.key.fingerprint}. The raw value was never returned.`); setProvider(''); setValue(''); await load(); }
    } finally { setBusy(''); }
  }, [provider, value, load]);

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
      <PageHeader title="Models & Providers" crumb="platform · the LiteLLM catalog (sovereign + STACKIT)" />
      <div className="content">
        <p className="lead">
          Govern which models run. The live models behind the gateway aliases are set at deploy time
          (this deployment runs STACKIT-managed inference: gpt-oss-20b for standard work, Qwen3-VL-235B for
          reasoning/vision, Qwen3-VL-Embedding-8B for embeddings). Set the <strong>default model per
          role</strong>, enable/disable, and cap per-model spend. Provider keys are added
          <strong> via the secrets manager</strong> — the OS stores a reference + fingerprint and
          <strong> never shows or logs the raw key</strong>.
        </p>

        {toast ? <div className="hint" style={{ color: 'var(--teal)' }}>{toast}</div> : null}
        {error ? <div className="error">{error}</div> : null}

        <div className="section-title">Default model per role</div>
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="hint" style={{ marginBottom: 12 }}>
            The three defaults the whole OS resolves at runtime, picked from the LIVE gateway catalog.
            Leave a role on <strong>Default</strong> to use the platform baseline. This is the SAME setting
            as <Link href="/platform/settings">Settings → Model roles</Link> — one store, no duplicates.
            {catalogSource === 'offline' ? ' LiteLLM is unreachable — showing the install catalog.' : ''}
          </div>
          {ROLE_META.map((r) => {
            const val = modelRoles[r.key] ?? '';
            const selected = catalog.find((m) => m.model_name === val);
            return (
              <div key={r.key} className="row" style={{ gap: 12, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                <label className="hint" style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 340px' }}>
                  {r.label}
                  <select
                    value={val}
                    disabled={busy !== ''}
                    onChange={(e) => setModelRoles({ ...modelRoles, [r.key]: e.target.value })}
                  >
                    <option value="">Default (platform baseline)</option>
                    {catalog.map((m) => (
                      <option key={m.model_name} value={m.model_name}>
                        {m.display} — {m.provenance === 'internal' ? 'in-box' : 'hosted'} ({m.model_name})
                      </option>
                    ))}
                    {val && !selected ? <option value={val}>{val} (current)</option> : null}
                  </select>
                  <span className="hint" style={{ fontSize: 12 }}>{r.help}</span>
                </label>
              </div>
            );
          })}
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
              <strong>Standard-first escalation</strong> (cost routing)
              <span style={{ display: 'block', fontSize: 12, marginTop: 2 }}>
                For surfaces whose output is strictly validated before use — suggest metrics, DQ
                fix proposals, structured stage assistants, NL→SQL generation — run <strong>Standard</strong>{' '}
                first and escalate to <strong>Reasoning</strong> only when validation fails. The validators
                are the quality gate, so this is safe by construction. Every escalation is traced to the
                model that actually answered. Turn off to send those surfaces straight to Reasoning.
                The agent plan phase and free-form surfaces always use Reasoning regardless.
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
          it <strong>follows the Standard role</strong> above, so it just works; override it below to pin a
          bespoke model (e.g. a registered STACKIT managed LLM).
        </p>
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="comp-label" style={{ margin: 0 }}>Active assistant</span>
            <select
              value={assistantExplicit ? assistant : ''}
              disabled={busy !== ''}
              onChange={(e) => e.target.value === ''
                ? patch(assistant || 'assistant', { op: 'assistant-clear' })
                : patch(e.target.value, { op: 'assistant' })}
              style={{ minWidth: 260 }}
            >
              <option value="">Follow Standard default ({assistant || 'unset'})</option>
              {models.filter((m) => m.task === 'chat' && m.enabled).map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
          </div>
          <div className="hint" style={{ marginTop: 12, marginBottom: 6 }}>
            Register the STACKIT managed LLM as an OpenAI-compatible model (base URL + model name + API key).
            The key is written once to the secrets manager; the catalog keeps only a fingerprint.
          </div>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <input style={{ flex: '1 1 160px' }} value={reg.label} onChange={(e) => setReg({ ...reg, label: e.target.value })} placeholder="label (e.g. STACKIT managed LLM)" />
            <input style={{ flex: '1 1 220px' }} value={reg.baseUrl} onChange={(e) => setReg({ ...reg, baseUrl: e.target.value })} placeholder="base URL (https://…/v1)" autoComplete="off" />
            <input style={{ flex: '1 1 160px' }} value={reg.modelName} onChange={(e) => setReg({ ...reg, modelName: e.target.value })} placeholder="model name (upstream)" autoComplete="off" />
            <input style={{ flex: '1 1 220px' }} type="password" value={reg.apiKey} onChange={(e) => setReg({ ...reg, apiKey: e.target.value })} placeholder="API key value" autoComplete="off" />
            <button className="btn" onClick={registerAssistant} disabled={busy === 'assistant-reg' || !reg.label.trim() || !reg.baseUrl.trim() || !reg.modelName.trim() || !reg.apiKey.trim()}>
              {busy === 'assistant-reg' ? <span className="spin" /> : 'Register + set as assistant'}
            </button>
          </div>
        </div>

        <div className="section-title" style={{ marginTop: 22 }}>Add a provider · connect your own LLM backend</div>
        <p className="hint">
          Register your own model behind the governed LiteLLM gateway. Pick a provider type,
          give the minimal details, and the OS stores the key <strong>write-only in the secrets
          manager</strong> and registers the model with the gateway (durable across restarts).
        </p>
        <div className="card" style={{ marginBottom: 16 }}>
          {!wizType ? (
            <>
              <div className="hint" style={{ marginBottom: 10 }}>Step 1 — choose a provider type</div>
              <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
                {WIZARD_TYPES.map((t) => (
                  <button
                    key={t.type} className="btn ghost" disabled={!t.enabled}
                    onClick={() => { setWizType(t.type); setWiz({ ...EMPTY_WIZARD, baseUrl: t.type === 'stackit' ? 'https://api.openai-compat.model-serving.eu01.onstackit.cloud/v1' : '' }); }}
                    style={{ flex: '1 1 220px', textAlign: 'left', opacity: t.enabled ? 1 : 0.5, cursor: t.enabled ? 'pointer' : 'not-allowed' }}
                    title={t.enabled ? '' : 'Coming in a later phase'}
                  >
                    <strong>{t.label}</strong>
                    <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>{t.blurb}</div>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <div className="hint">Step 2 — <strong>{WIZARD_TYPES.find((t) => t.type === wizType)?.label}</strong> details</div>
                <button className="btn ghost" onClick={() => { setWizType(null); setWiz(EMPTY_WIZARD); }}>← Back</button>
              </div>
              <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                <input style={{ flex: '1 1 150px' }} value={wiz.alias} onChange={(e) => setWiz({ ...wiz, alias: e.target.value })} placeholder="alias (gateway model_name)" autoComplete="off" />
                <input style={{ flex: '1 1 230px' }} value={wiz.baseUrl} onChange={(e) => setWiz({ ...wiz, baseUrl: e.target.value })} placeholder="api_base (https://…/v1)" autoComplete="off" />
                <input style={{ flex: '1 1 180px' }} value={wiz.modelName} onChange={(e) => setWiz({ ...wiz, modelName: e.target.value })} placeholder={wizType === 'stackit' ? 'model id (Qwen/Qwen3-VL-235B…)' : 'model id (upstream)'} autoComplete="off" />
                <select value={wiz.task} onChange={(e) => setWiz({ ...wiz, task: e.target.value as Task })} style={{ flex: '0 1 140px' }}>
                  <option value="chat">chat</option>
                  <option value="reasoning">reasoning</option>
                  <option value="embedding">embedding</option>
                </select>
                <input style={{ flex: '1 1 200px' }} type="password" value={wiz.apiKey} onChange={(e) => setWiz({ ...wiz, apiKey: e.target.value })} placeholder="API key value" autoComplete="off" />
                <button className="btn" onClick={addProvider} disabled={busy === 'provider' || !wiz.alias.trim() || !wiz.baseUrl.trim() || !wiz.modelName.trim() || !wiz.apiKey.trim()}>
                  {busy === 'provider' ? <span className="spin" /> : 'Register model'}
                </button>
              </div>
              {wizType === 'stackit' ? (
                <div className="hint" style={{ marginTop: 8, fontSize: 12 }}>
                  STACKIT keeps its org prefix — the gateway needs the double prefix <code>openai/Qwen/…</code>;
                  a single prefix 404s. Enter the model id <strong>with</strong> its org (e.g. <code>Qwen/Qwen3-VL-235B-A22B-Instruct-FP8</code>); the OS adds the <code>openai/</code> protocol prefix.
                </div>
              ) : null}
              <div className="hint" style={{ marginTop: 8, fontSize: 12 }}>
                The API key is written once to the secrets manager and handed to the gateway once. The catalog keeps only a <code>sha256</code> fingerprint — the raw key is never shown, logged or returned.
              </div>
            </>
          )}
        </div>

        {(() => {
          // The two catalog groups — the split rule lives in lib/platform-admin/
          // catalog-groups.ts (live db_model flag, else the governed endpoint mark).
          const liveByName = new Map(catalog.map((c) => [c.model_name, c]));
          const govById = new Map(models.map((m) => [m.id, m]));
          const { managed, adminAdded } = splitCatalog(catalog, models);
          // The effective per-role default ids: the override else the platform baseline.
          const roleDefaults = new Set([
            modelRoles.standard || 'sovereign-default',
            modelRoles.reasoning || 'sovereign-reasoning',
            modelRoles.embeddings || 'sovereign-embed',
          ]);
          const familyOf = (name: string): string => {
            const t = liveByName.get(name)?.providerType ?? (govById.get(name)?.provider as ProviderType | undefined);
            return t ? (PROVIDER_LABELS[t] ?? t) : '';
          };
          const row = (name: string, removable: boolean) => {
            const live = liveByName.get(name);
            const m = govById.get(name);
            const isDefault = roleDefaults.has(name);
            const isAssistant = assistant === name;
            const family = familyOf(name);
            return (
              <tr key={name}>
                <td>
                  <strong>{live?.display ?? m?.label ?? name}</strong>
                  {isDefault ? <span className="pa-tag" style={{ marginLeft: 8 }}>default</span> : null}
                  {isAssistant ? <span className="pa-tag" style={{ marginLeft: 8 }}>assistant</span> : null}
                  <div className="muted" style={{ fontSize: 11 }}>{name}{m ? ` · ${m.task}` : ''}{family ? ` · ${family}` : ''}{live?.tier ? ` · ${live.tier} tier` : ''}</div>
                </td>
                <td>{live?.tier ? <span className="pa-tag">{live.tier}</span> : (m ? <span className="pa-tag">{m.tier}</span> : <span className="muted">—</span>)}</td>
                <td>{m?.route ?? (live?.provenance === 'internal' ? 'self-hosted' : 'stackit')}</td>
                <td>
                  {m ? (
                    <input
                      type="number" min={0} defaultValue={m.capEUR ?? ''} placeholder="none"
                      style={{ width: 90 }} disabled={busy === name}
                      onBlur={(e) => { const v = e.target.value.trim(); patch(name, { op: 'cap', capEUR: v === '' ? null : Number(v) }); }}
                    />
                  ) : <span className="muted">—</span>}
                </td>
                <td>
                  {m ? (
                    <button
                      className={`switch${m.enabled ? ' on' : ''}`} disabled={busy === name}
                      onClick={() => patch(name, { op: 'enable', enabled: !m.enabled })}
                      title={isDefault && m.enabled ? 'A default model cannot be disabled' : ''}
                    >
                      <span className="switch-track"><span className="switch-thumb" /></span>
                      <span className="switch-text">{m.enabled ? 'On' : 'Off'}</span>
                    </button>
                  ) : <span className="muted" style={{ fontSize: 11 }}>live-only</span>}
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
              <div className="section-title" style={{ marginTop: 22 }}>Managed AI (STACKIT)<span className="count-pill">{managed.length}</span></div>
              <div className="hint" style={{ marginBottom: 10 }}>
                The platform&rsquo;s built-in models, managed by the deployment — always available, not removable here.
                {catalogSource === 'offline' ? ' LiteLLM is unreachable — showing the install catalog.' : ''}
              </div>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Model</th><th>Tier</th><th>Route</th><th>Cap €/mo</th><th>Enabled</th></tr></thead>
                  <tbody>{managed.map((name) => row(name, false))}</tbody>
                </table>
              </div>

              <div className="section-title" style={{ marginTop: 22 }}>Added by administrators<span className="count-pill">{adminAdded.length}</span></div>
              <div className="hint" style={{ marginBottom: 10 }}>
                Models an admin connected with <strong>Add provider</strong> — each can be removed; the OS first
                shows where it is used (role pins, the assistant, agents) so nothing breaks silently.
              </div>
              {adminAdded.length === 0 ? (
                <div className="hint" style={{ marginBottom: 10 }}>
                  No custom models — add your cloud provider&rsquo;s LLM with <strong>Add provider</strong> above.
                </div>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>Model</th><th>Tier</th><th>Route</th><th>Cap €/mo</th><th>Enabled</th><th /></tr></thead>
                    <tbody>{adminAdded.map((name) => row(name, true))}</tbody>
                  </table>
                </div>
              )}
            </>
          );
        })()}

        <div className="section-title" style={{ marginTop: 22 }}>Token prices · € per 1M tokens</div>
        <div className="hint" style={{ marginBottom: 10 }}>
          What Monitoring charges a run against, per LiteLLM <code>model_name</code> (STACKIT bills EUR).
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
                // Every configured model_name: live catalog + governed catalog + any
                // priced key (stored or env) that is no longer in either list.
                const names = [...new Set([
                  ...catalog.map((c) => c.model_name),
                  ...models.map((m) => m.id),
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
        {catalog.length === 0 && models.length === 0 && Object.keys(prices).length === 0
          ? <div className="hint">No models configured yet — register a model above to price it.</div> : null}
        <button className="btn" disabled={busy === 'prices' || Object.keys(priceEdits).length === 0} onClick={savePrices} style={{ marginBottom: 6 }}>
          {busy === 'prices' ? <span className="spin" /> : 'Save prices'}
        </button>

        <div className="section-title" style={{ marginTop: 22 }}>Provider keys</div>
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <input style={{ flex: '1 1 160px' }} value={provider} onChange={(e) => setProvider(e.target.value)} placeholder="provider (e.g. openai)" />
            <input style={{ flex: '1 1 220px' }} type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder="API key value" autoComplete="off" />
            <button className="btn" onClick={addKey} disabled={busy === 'key' || !provider.trim() || !value.trim()}>
              {busy === 'key' ? <span className="spin" /> : 'Store via secrets manager'}
            </button>
          </div>
          <div className="hint" style={{ marginTop: 8 }}>
            The value is written once to the secrets manager server-side. Only a <code>sha256</code> fingerprint
            is ever stored in the catalog or shown here.
          </div>
        </div>
        {keys.length === 0 ? <div className="hint">No provider keys stored.</div> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Provider</th><th>Fingerprint</th><th>Added by</th><th>When</th></tr></thead>
              <tbody>
                {keys.map((k) => (
                  <tr key={k.provider}>
                    <td><strong>{k.provider}</strong></td>
                    <td className="mono" style={{ fontSize: 12 }}>{k.fingerprint}</td>
                    <td>{k.addedBy}</td>
                    <td className="muted" style={{ fontSize: 11.5 }}>{new Date(k.addedAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="hint" style={{ marginTop: 14 }}>
          Per-model caps tune the envelope set in <Link href="/platform/billing">Cost & Billing</Link>; live spend is in <Link href="/monitoring">Monitoring</Link>.
        </div>
      </div>
    </>
  );
}
