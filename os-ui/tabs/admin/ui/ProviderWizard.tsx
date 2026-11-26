/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * TAB:        admin
 * FEATURE:    Add a provider — one flow for every LLM backend LiteLLM supports
 * USER STORY: As a platform admin on Azure, on my own servers or on STACKIT, I pick the provider, give
 *             its endpoint and key, pick the model, test the connection and register it; then I assign
 *             it to a role in "Default model per role". A host the egress proxy would block is refused
 *             with the exact deployment change to make.
 * ARCHITECTURE:
 *   - Presets come from the server (tabs/admin/lib/llm-provider-presets.ts); "Another LiteLLM
 *     provider" lists LiteLLM's own provider catalogue. Every step is a route under
 *     /api/platform-admin/providers/*, each a thin call to LiteLLM's admin API (lib/llm-providers.ts).
 *   - The key is sent once, to the connections route, and never shown again: connections are listed
 *     by name, provider and endpoint only.
 *   - Rendered only inside ModelsProviders, which is already admin-gated (fail closed); the routes are
 *     adminCtx()-gated, which is the real boundary.
 * I18N:       converted (wave 2) — texts from `admin.providerWizard.*`. A preset's label, blurb and model hint are
 *             looked up by its id (the server's English stays in llm-provider-presets.ts); refusals and guidance
 *             from the server are shown as they are.
 */
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from '@core/i18n/client';
import type { Preset, PresetId } from '@tabs/admin/lib/llm-provider-presets';

type Connection = { name: string; provider: string; preset: string; apiBase: string; apiVersion: string; hasKey: boolean };
type Catalog = { presets: Preset[]; providers: { id: string; label: string }[]; connections: Connection[]; gateway: string; accessGroup: string };
type Suggestion = { id: string; mode: string; priced: boolean };
type Refusal = { error?: string; message?: string; guidance?: string; host?: string };

const EMPTY = { name: '', apiBase: '', apiVersion: '', apiKey: '', provider: '' };

// The catalog entry of each preset (`providerWizard.presets.<key>.*`).
const PRESET_KEY: Record<PresetId, 'azure' | 'openaiCompatible' | 'ollama' | 'mistral' | 'stackit' | 'litellm'> = {
  azure: 'azure', 'openai-compatible': 'openaiCompatible', ollama: 'ollama', mistral: 'mistral', stackit: 'stackit', litellm: 'litellm',
};

export default function ProviderWizard({ onRegistered }: { onRegistered: (msg: string) => void }) {
  const t = useTranslations('admin');
  // A preset the catalog does not know (a newer server) falls back to the server's English.
  const presetText = (p: Preset, field: 'label' | 'blurb' | 'modelHint'): string => {
    const k = PRESET_KEY[p.id];
    return k ? t(`providerWizard.presets.${k}.${field}`) : p[field];
  };
  const [cat, setCat] = useState<Catalog | null>(null);
  const [preset, setPreset] = useState<Preset | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [connection, setConnection] = useState('');
  const [model, setModel] = useState('');
  const [alias, setAlias] = useState('');
  const [prices, setPrices] = useState({ inputPerM: '', outputPerM: '' });
  const [task, setTask] = useState<'chat' | 'reasoning' | 'embedding'>('chat');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [tested, setTested] = useState<'' | 'ok' | 'failed'>('');
  const [note, setNote] = useState<Refusal | null>(null);
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    const res = await fetch('/api/platform-admin/providers', { cache: 'no-store' });
    if (res.ok) setCat((await res.json()) as Catalog);
  }, []);
  useEffect(() => { load(); }, [load]);

  const provider = preset?.litellmProvider ?? form.provider;
  const conns = useMemo(() => (cat?.connections ?? []).filter((c) => preset && (c.preset === preset.id || (!c.preset && c.provider === provider))), [cat, preset, provider]);

  useEffect(() => {
    if (!preset || (preset.id === 'litellm' && !form.provider)) { setSuggestions([]); return; }
    const q = new URLSearchParams({ preset: preset.id, provider: form.provider });
    fetch(`/api/platform-admin/providers/models?${q}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { models: [] }))
      .then((b) => setSuggestions(b.models ?? []))
      .catch(() => setSuggestions([]));
  }, [preset, form.provider]);

  const pick = (p: Preset) => { setPreset(p); setForm({ ...EMPTY, apiBase: p.defaultApiBase ?? '' }); setConnection(''); setModel(''); setAlias(''); setTested(''); setNote(null); };
  const reset = () => { setPreset(null); setForm(EMPTY); setConnection(''); setModel(''); setAlias(''); setTested(''); setNote(null); };

  const post = async (path: string, body: unknown) => {
    const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { res, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };

  const saveConnection = async () => {
    if (!preset) return;
    setBusy('conn'); setNote(null);
    try {
      const { res, body } = await post('/api/platform-admin/providers/connections', { preset: preset.id, ...form });
      if (!res.ok) { setNote(body as Refusal); return; }
      setConnection(form.name); setForm({ ...form, apiKey: '' }); await load();
    } finally { setBusy(''); }
  };

  const test = async () => {
    if (!preset) return;
    setBusy('test'); setNote(null);
    try {
      const { body } = await post('/api/platform-admin/providers/test', { preset: preset.id, provider: form.provider, connection, model, mode: task === 'embedding' ? 'embedding' : 'chat' });
      if (body.ok === true) setTested('ok'); else { setTested('failed'); setNote(body as Refusal); }
    } finally { setBusy(''); }
  };

  const register = async () => {
    if (!preset) return;
    setBusy('reg'); setNote(null);
    try {
      const { res, body } = await post('/api/platform-admin/providers/models', { preset: preset.id, provider: form.provider, connection, model, alias, task, ...prices });
      if (!res.ok) { setNote(body as Refusal); return; }
      onRegistered(t('providerWizard.registered', { alias, model: String(body.litellmModel) }));
      reset();
    } finally { setBusy(''); }
  };

  if (!cat) return <div className="card"><span className="spin" /></div>;

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      {cat.gateway !== 'reachable' ? <div className="error" style={{ marginBottom: 10 }}>{t('providerWizard.unreachable')}</div> : null}
      {!preset ? (
        <>
          <div className="hint" style={{ marginBottom: 10 }}>{t('providerWizard.step1')}</div>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
            {cat.presets.map((p) => (
              <button key={p.id} className="btn ghost" onClick={() => pick(p)} style={{ flex: '1 1 200px', textAlign: 'left' }}>
                <strong>{presetText(p, 'label')}</strong>
                <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>{presetText(p, 'blurb')}</div>
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div className="hint"><strong>{presetText(preset, 'label')}</strong>{provider ? <> · {t.rich('providerWizard.litellmProvider', { provider, code: (c) => <code>{c}</code> })}</> : null}</div>
            <button className="btn ghost" onClick={reset}>{t('providerWizard.back')}</button>
          </div>

          <div className="hint" style={{ marginBottom: 6 }}>{t('providerWizard.step2')}</div>
          {conns.length > 0 ? (
            <div className="row" style={{ gap: 10, marginBottom: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <select value={connection} onChange={(e) => setConnection(e.target.value)} style={{ minWidth: 260 }}>
                <option value="">{t('providerWizard.newConnection')}</option>
                {conns.map((c) => <option key={c.name} value={c.name}>{c.name} — {c.apiBase || c.provider}</option>)}
              </select>
            </div>
          ) : null}
          {!connection ? (
            <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              {preset.id === 'litellm' ? (
                <select value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })} style={{ flex: '1 1 200px' }}>
                  <option value="">{t('providerWizard.pickProvider')}</option>
                  {cat.providers.map((p) => <option key={p.id} value={p.id}>{p.label} ({p.id})</option>)}
                </select>
              ) : null}
              <input style={{ flex: '1 1 150px' }} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value.toLowerCase() })} placeholder={t('providerWizard.namePlaceholder')} autoComplete="off" />
              <input style={{ flex: '1 1 260px' }} value={form.apiBase} onChange={(e) => setForm({ ...form, apiBase: e.target.value })}
                placeholder={preset.apiBase === 'required' ? t('providerWizard.baseUrl') : t('providerWizard.baseUrlOptional', { host: preset.defaultHost ?? t('providerWizard.litellmDefault') })} autoComplete="off" />
              {preset.apiVersion ? (
                <input style={{ flex: '0 1 150px' }} value={form.apiVersion} onChange={(e) => setForm({ ...form, apiVersion: e.target.value })} placeholder={t('providerWizard.apiVersion')} autoComplete="off" />
              ) : null}
              {preset.apiKey !== 'none' ? (
                <input style={{ flex: '1 1 200px' }} type="password" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                  placeholder={preset.apiKey === 'required' ? t('providerWizard.apiKey') : t('providerWizard.apiKeyOptional')} autoComplete="off" />
              ) : null}
              <button className="btn" onClick={saveConnection} disabled={busy === 'conn' || !form.name.trim()}>
                {busy === 'conn' ? <span className="spin" /> : t('providerWizard.saveConnection')}
              </button>
            </div>
          ) : (
            <div className="hint" style={{ fontSize: 12 }}>{t.rich('providerWizard.usingConnection', { name: connection, strong: (c) => <strong>{c}</strong> })}</div>
          )}

          {connection ? (
            <>
              <div className="hint" style={{ margin: '14px 0 6px' }}>{suggestions.length ? t('providerWizard.step3Suggestions') : t('providerWizard.step3')}</div>
              <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                <input list="llm-model-suggestions" style={{ flex: '1 1 240px' }} value={model} onChange={(e) => { setModel(e.target.value); setTested(''); }} placeholder={presetText(preset, 'modelHint')} autoComplete="off" />
                <datalist id="llm-model-suggestions">{suggestions.map((s) => <option key={s.id} value={s.id}>{s.priced ? t('providerWizard.suggestionPriced', { mode: s.mode }) : s.mode}</option>)}</datalist>
                <select value={task} onChange={(e) => { setTask(e.target.value as typeof task); setTested(''); }} style={{ flex: '0 1 140px' }}>
                  <option value="chat">{t('providerWizard.taskChat')}</option>
                  <option value="reasoning">{t('providerWizard.taskReasoning')}</option>
                  <option value="embedding">{t('providerWizard.taskEmbedding')}</option>
                </select>
                <button className="btn ghost" onClick={test} disabled={busy === 'test' || !model.trim()}>
                  {busy === 'test' ? <span className="spin" /> : t('providerWizard.test')}
                </button>
                {tested === 'ok' ? <span className="pa-tag" style={{ color: 'var(--teal)' }}>{t('providerWizard.connected')}</span> : null}
              </div>
              <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center', marginTop: 10 }}>
                <input style={{ flex: '1 1 200px' }} value={alias} onChange={(e) => setAlias(e.target.value)} placeholder={t('providerWizard.aliasPlaceholder')} autoComplete="off" />
                <input style={{ flex: '0 1 130px' }} type="number" min={0} step="any" value={prices.inputPerM} onChange={(e) => setPrices({ ...prices, inputPerM: e.target.value })} placeholder={t('providerWizard.inPlaceholder')} title={t('providerWizard.inTitle')} />
                <input style={{ flex: '0 1 130px' }} type="number" min={0} step="any" value={prices.outputPerM} onChange={(e) => setPrices({ ...prices, outputPerM: e.target.value })} placeholder={t('providerWizard.outPlaceholder')} title={t('providerWizard.outTitle')} />
                <button className="btn" onClick={register} disabled={busy === 'reg' || tested !== 'ok' || !alias.trim()} title={tested !== 'ok' ? t('providerWizard.testFirst') : ''}>
                  {busy === 'reg' ? <span className="spin" /> : t('providerWizard.register')}
                </button>
              </div>
            </>
          ) : null}

          {note ? (
            <div className="error" style={{ marginTop: 10, whiteSpace: 'pre-wrap' }}>
              {note.message ?? note.error}
              {note.guidance ? <pre className="mono" style={{ marginTop: 6, fontSize: 12, whiteSpace: 'pre-wrap' }}>{note.guidance}</pre> : null}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
