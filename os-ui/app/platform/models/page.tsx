/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import PageHeader from '@/components/PageHeader';

type Task = 'chat' | 'reasoning' | 'embedding';
type Model = { id: string; label: string; provider: string; task: Task; tier: 'sovereign' | 'premium'; route: string; enabled: boolean; capEUR: number | null };
type Key = { provider: string; fingerprint: string; addedBy: string; addedAt: string };

// The three per-ROLE defaults are ONE store: the platform-admin settings
// `modelRoles`, resolved at runtime by lib/models/roles.ts. This page shows the
// SAME values (and writes the SAME store) as Settings → Model roles.
type RoleKey = 'standard' | 'reasoning' | 'embeddings';
type ProviderType = 'stackit' | 'openai-compatible' | 'azure' | 'bedrock' | 'self-hosted';
type CatalogModel = { model_name: string; display: string; provenance: 'internal' | 'external'; providerType?: ProviderType; tier?: string };

// Provider-family group headings for the live Catalog. Order = display order.
const PROVIDER_GROUPS: { type: ProviderType; label: string }[] = [
  { type: 'stackit', label: 'STACKIT managed inference' },
  { type: 'openai-compatible', label: 'OpenAI-compatible' },
  { type: 'self-hosted', label: 'Self-hosted (in-cluster / WireGuard)' },
  { type: 'azure', label: 'Azure OpenAI' },
  { type: 'bedrock', label: 'AWS Bedrock' },
];

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

export default function ModelsPage() {
  const [models, setModels] = useState<Model[]>([]);
  const [assistant, setAssistant] = useState('');
  const [assistantExplicit, setAssistantExplicit] = useState(false);
  const [keys, setKeys] = useState<Key[]>([]);
  // Live gateway catalog (source of truth for the role selectors) + the current
  // modelRoles store (the ONE per-role default store).
  const [catalog, setCatalog] = useState<CatalogModel[]>([]);
  const [catalogSource, setCatalogSource] = useState<'litellm' | 'offline' | null>(null);
  const [modelRoles, setModelRoles] = useState<Record<RoleKey, string>>({ standard: '', reasoning: '', embeddings: '' });
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
      const [mRes, cRes, sRes] = await Promise.all([
        fetch('/api/platform-admin/models', { cache: 'no-store' }),
        fetch('/api/agents/models', { cache: 'no-store' }),
        fetch('/api/platform-admin/settings', { cache: 'no-store' }),
      ]);
      const mBody = await mRes.json();
      if (!mRes.ok) { setError(mBody.error ?? 'Failed to load'); return; }
      setModels(mBody.models ?? []); setAssistant(mBody.assistant ?? ''); setAssistantExplicit(Boolean(mBody.assistantExplicit)); setKeys(mBody.keys ?? []);
      if (cRes.ok) { const c = await cRes.json(); setCatalog(c.models ?? []); setCatalogSource(c.source ?? null); }
      if (sRes.ok) { const s = await sRes.json(); if (s.settings?.modelRoles) setModelRoles(s.settings.modelRoles); }
    } catch (e) { setError((e as Error).message); } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  // Save the three per-role defaults to the ONE store (settings modelRoles).
  const saveRoles = useCallback(async () => {
    setBusy('roles'); setError('');
    try {
      const res = await fetch('/api/platform-admin/settings', {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modelRoles }),
      });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? 'Save failed');
      else { setToast('Saved the default model per role — every assistant, agent and embedding call resolves through these.'); await load(); }
    } finally { setBusy(''); }
  }, [modelRoles, load]);

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

        <div className="section-title" style={{ marginTop: 22 }}>Catalog<span className="count-pill">{models.length}</span></div>
        <div className="hint" style={{ marginBottom: 10 }}>
          Grouped by provider family from the LIVE gateway (<code>/model/info</code>), each row showing its
          OS tier mapping. Enable/disable + per-model caps are governed here.
          {catalogSource === 'offline' ? ' LiteLLM is unreachable — showing the install catalog.' : ''}
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Model</th><th>Tier</th><th>Route</th><th>Cap €/mo</th><th>Enabled</th></tr></thead>
            <tbody>
              {(() => {
                // The effective per-role default ids: the override else the platform baseline.
                const roleDefaults = new Set([
                  modelRoles.standard || 'sovereign-default',
                  modelRoles.reasoning || 'sovereign-reasoning',
                  modelRoles.embeddings || 'sovereign-embed',
                ]);
                // Group the LIVE catalog (from /model/info) by provider family. Any
                // governance-only model not seen live still shows under its own family
                // (or STACKIT for the seed). Join to `models` for enable/cap controls.
                const govById = new Map(models.map((m) => [m.id, m]));
                const liveByName = new Map(catalog.map((c) => [c.model_name, c]));
                const allNames = new Set<string>([...liveByName.keys(), ...govById.keys()]);
                const groupOf = (name: string): ProviderType =>
                  liveByName.get(name)?.providerType
                  ?? (govById.get(name)?.provider as ProviderType | undefined)
                  ?? 'stackit';
                return PROVIDER_GROUPS.flatMap((g) => {
                  const names = [...allNames].filter((n) => groupOf(n) === g.type).sort();
                  if (names.length === 0) return [];
                  return [
                    <tr key={`grp-${g.type}`}><td colSpan={5} style={{ background: 'var(--panel-2, rgba(0,0,0,0.03))', fontWeight: 600, fontSize: 12 }}>{g.label}<span className="count-pill">{names.length}</span></td></tr>,
                    ...names.map((name) => {
                      const live = liveByName.get(name);
                      const m = govById.get(name);
                      const isDefault = roleDefaults.has(name);
                      const isAssistant = assistant === name;
                      return (
                        <tr key={name}>
                          <td>
                            <strong>{live?.display ?? m?.label ?? name}</strong>
                            {isDefault ? <span className="pa-tag" style={{ marginLeft: 8 }}>default</span> : null}
                            {isAssistant ? <span className="pa-tag" style={{ marginLeft: 8 }}>assistant</span> : null}
                            <div className="muted" style={{ fontSize: 11 }}>{name}{m ? ` · ${m.task}` : ''}{live?.tier ? ` · ${live.tier} tier` : ''}</div>
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
                        </tr>
                      );
                    }),
                  ];
                });
              })()}
            </tbody>
          </table>
        </div>

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
