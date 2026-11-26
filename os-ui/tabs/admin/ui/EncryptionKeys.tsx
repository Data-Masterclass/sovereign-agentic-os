/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * EncryptionKeys — Platform → Encryption keys, and the building blocks of the install wizard's key step.
 *
 * FEATURE:
 *   • Where the master key of the connection credentials lives (provider) and whether it works
 *     (a real wrap/unwrap round trip), the data keys, and the last key operations.
 *   • Recovery: an explicit choice — "No recovery key" (one acknowledgement, audited) or "Recovery key"
 *     (generate once, download (.txt) or print / save as PDF, tick "I saved it"). Until an admin picks one,
 *     the choice reads "not made" (Monitoring warns; the prod release check fails).
 *   • Rotate (re-wrap, or a new data key with background re-seal), switch provider (test first;
 *     verified before commit), test restore (recovery key and/or provider, writes nothing), and —
 *     when the store is LOCKED after a restore — unlock with the recovery key or a new provider credential,
 *     or (master key lost, nothing to unlock with) start over with new keys and reconnect the connections.
 *
 * USER STORY:
 *   • As the admin who installed the OS I set this up in one step and know exactly what I must keep
 *     offline; as an admin after a disaster I unlock every credential with the recovery key.
 *
 * ARCHITECTURE:
 *   A thin client over `/api/platform-admin/encryption-keys`. The server decides and verifies
 *   everything (core/infra/key-manager.ts); every POST carries the admin's password (re-auth) and is
 *   audited server-side. The recovery key exists in this component's state only until the admin
 *   leaves the step — it is never stored in the browser.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';

type Field = { name: string; label: string; placeholder?: string; required: boolean };
type ProviderInfo = { id: string; label: string; available: boolean; summary: string; config: Field[]; credential: Field | null; licence?: string };
type Health = { ok: boolean; state: string; detail: string; at?: string };
type View = {
  status: 'unconfigured' | 'ready' | 'locked' | 'failed';
  reason: string;
  provider: { id: string | null; label: string; config: Record<string, string>; hasCredential: boolean };
  recovery: { state: 'missing' | 'unconfirmed' | 'confirmed'; createdAt?: string; createdBy?: string; confirmedAt?: string; confirmedBy?: string };
  recoveryChoice: { choice: 'unset' | 'none' | 'recovery-key'; at?: string; by?: string };
  dataKeys: { id: string; createdAt: string; current: boolean; recoverable: boolean }[];
  lastHealth: Health | null;
  history: { at: string; actor: string; action: string; detail: string }[];
};
export type KeysState = { managed: boolean; note: string; view: View | null; providers: ProviderInfo[]; store?: { status: string; count: number; sealedUnderPreviousKey: number; unreadable: number } };

const API = '/api/platform-admin/encryption-keys';

export function useKeys() {
  const [state, setState] = useState<KeysState | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async (health = false) => {
    try {
      const r = await fetch(`${API}${health ? '?health=1' : ''}`, { cache: 'no-store' });
      const b = await r.json();
      if (!r.ok) setError(b.error ?? 'Could not load the key status');
      else { setState(b); setError(''); }
    } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { load(true); }, [load]);
  return { state, error, load };
}

/** POST one operation with the admin's password. Returns the body, or throws the server's message. */
export async function keyOp(password: string, op: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const r = await fetch(API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op, password, ...extra }) });
  const b = (await r.json().catch(() => ({}))) as { error?: string; code?: string; policy?: string };
  if (r.status === 403 && b.code === 'opa-denied') {
    // A brand-new admin (right after first-run setup) can be ahead of the policy engine: the route already
    // re-published the grants once. Say what is going on instead of a bare "forbidden".
    throw new Error(b.policy === 'opa-unreachable'
      ? 'The policy engine (OPA) is not answering, so key changes are refused for now. Try again in a minute; Monitoring → Platform shows OPA\'s state.'
      : 'The policy engine (OPA) has not confirmed your admin rights yet — common in the first minutes after setup. Wait a few seconds and try again; if it keeps happening, check Governance → Policy (the admin grant) and OPA in Monitoring.');
  }
  if (!r.ok) throw new Error(b.error ?? `HTTP ${r.status}`);
  return b as Record<string, unknown>;
}

export function PasswordField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label style={{ display: 'block', marginBottom: 12 }}>
      <span className="muted" style={{ fontSize: 12.5 }}>Your password — every change to the keys asks for it again</span>
      <input type="password" autoComplete="current-password" value={value} onChange={(e) => onChange(e.target.value)} style={{ display: 'block', width: '100%', maxWidth: 360, marginTop: 4 }} />
    </label>
  );
}

function downloadText(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function recoverySheet(key: string, host: string) {
  return [
    'SOVEREIGN AGENTIC OS — RECOVERY KEY FOR CONNECTION CREDENTIALS',
    '',
    `Installation: ${host}`,
    `Generated:    ${new Date().toISOString()}`,
    '',
    `    ${key}`,
    '',
    'Keep this offline (a password manager, a safe). It is shown once and is NOT stored by the OS.',
    'After a restore or rebuild: Platform → Encryption keys → Unlock → enter this key.',
    'Anyone holding it AND a backup of the cluster can read the stored connection credentials.',
  ].join('\n');
}

function printSheet(text: string) {
  const w = window.open('', '_blank', 'width=720,height=600');
  if (!w) return;
  const pre = w.document.createElement('pre');
  pre.style.cssText = 'font: 14px/1.6 ui-monospace, monospace; white-space: pre-wrap; padding: 32px';
  pre.textContent = text;
  w.document.title = 'Recovery key';
  w.document.body.appendChild(pre);
  w.focus();
  w.print();
}

/** Generate → show once → download / print → "I saved it". Used by the console and the wizard. */
export function RecoveryKeyStep({ password, state, onChanged }: { password: string; state: View['recovery']['state']; onChanged: () => void }) {
  const [key, setKey] = useState('');
  const [saved, setSaved] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const run = async (op: string, extra: Record<string, unknown> = {}) => {
    setBusy(op); setErr('');
    try {
      const b = await keyOp(password, op, extra);
      if (op === 'recovery-generate') { setKey(String(b.recoveryKey ?? '')); setSaved(false); setTyped(''); }
      if (op === 'recovery-confirm') { setKey(''); setTyped(''); }
      onChanged();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(''); }
  };
  const sheet = key ? recoverySheet(key, typeof window !== 'undefined' ? window.location.host : '') : '';
  return (
    <div>
      {err ? <div className="error">{err}</div> : null}
      {!key ? (
        <>
          <p className="muted" style={{ fontSize: 13 }}>
            {state === 'confirmed' ? 'A recovery key is saved. A new one replaces it only once you confirm the new one.'
              : state === 'unconfirmed' ? 'A recovery key was generated but nobody confirmed saving it. Generate a new one and keep it this time.'
                : 'No recovery key yet. Without one, losing the master key loses every stored connection credential.'}
          </p>
          <button className="btn" disabled={!password || !!busy} onClick={() => run('recovery-generate')}>
            {busy ? <span className="spin" /> : state === 'missing' ? 'Generate recovery key' : 'Generate a new recovery key'}
          </button>
        </>
      ) : (
        <>
          <div className="hint" style={{ marginBottom: 8 }}>Shown once. The OS stores only a verifier — it cannot show this again.</div>
          <div className="mono" style={{ fontSize: 18, letterSpacing: 1, padding: '12px 14px', background: 'var(--panel)', borderRadius: 8, wordBreak: 'break-all' }}>{key}</div>
          <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            <button className="btn ghost" onClick={() => downloadText('sovereign-os-recovery-key.txt', sheet)}>Download .txt</button>
            <button className="btn ghost" onClick={() => printSheet(sheet)}>Print / save as PDF</button>
          </div>
          <label className="row" style={{ gap: 8, marginTop: 14, alignItems: 'center' }}>
            <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
            <span>I saved the recovery key somewhere safe, outside this system.</span>
          </label>
          <label style={{ display: 'block', marginTop: 10 }}>
            <span className="muted" style={{ fontSize: 12.5 }}>Type the recovery key from your saved copy to confirm</span>
            <input className="mono" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" placeholder="XXXXX-XXXXX-…" style={{ display: 'block', width: '100%', maxWidth: 520, marginTop: 4 }} />
          </label>
          <button className="btn" style={{ marginTop: 10 }} disabled={!saved || !typed || !password || !!busy} onClick={() => run('recovery-confirm', { saved: true, recoveryKey: typed })}>
            {busy ? <span className="spin" /> : 'Confirm'}
          </button>
        </>
      )}
    </div>
  );
}

/**
 * The RECOVERY CHOICE: "No recovery key" (acknowledge once) or "Recovery key" (the existing flow).
 * Used by the console and the install wizard. The server records who chose what and when.
 */
export function RecoveryChoiceStep({ password, view, onChanged }: { password: string; view: View; onChanged: () => void }) {
  const current = view.recoveryChoice?.choice ?? 'unset';
  const [pick, setPick] = useState<'none' | 'recovery-key'>(current === 'none' ? 'none' : 'recovery-key');
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const chooseNone = async () => {
    setBusy(true); setErr(''); setNote('');
    try {
      const b = await keyOp(password, 'recovery-none', { acknowledged: true });
      setAck(false);
      if (b.hadRecoveryKey) setNote('Done. A copy of the old recovery key that was exported earlier still opens backups taken before now, until the data key is replaced: use Rotate → New data key below to retire it.');
      onChanged();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div>
      <p className="muted" style={{ fontSize: 12.5, marginTop: 0 }}>
        {current === 'unset' ? 'No choice made yet. Pick one: until you do, Monitoring warns and a production release stops here.'
          : current === 'none' ? `No recovery key: chosen by ${view.recoveryChoice.by ?? 'an admin'}${view.recoveryChoice.at ? ` on ${new Date(view.recoveryChoice.at).toLocaleString()}` : ''}.`
            : `Recovery key: saved${view.recoveryChoice.by ? ` (confirmed by ${view.recoveryChoice.by}${view.recoveryChoice.at ? ` on ${new Date(view.recoveryChoice.at).toLocaleString()}` : ''})` : ''}.`}
      </p>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <button className={`btn ${pick === 'none' ? '' : 'ghost'}`} onClick={() => { setPick('none'); setErr(''); }}>No recovery key</button>
        <button className={`btn ${pick === 'recovery-key' ? '' : 'ghost'}`} onClick={() => { setPick('recovery-key'); setErr(''); }}>Recovery key</button>
      </div>
      {err ? <div className="error">{err}</div> : null}
      {note ? <div className="hint">{note}</div> : null}
      {pick === 'none' ? (
        current === 'none' ? <p className="muted" style={{ fontSize: 12.5 }}>Nothing else to do. You can save a recovery key at any time by choosing "Recovery key".</p> : (
          <>
            <p className="muted" style={{ fontSize: 12.5 }}>
              No copy of the key leaves the cluster. If the cluster&apos;s key is lost, stored connection credentials cannot be decrypted:
              people re-enter their API keys and sign in again to OAuth connections (Microsoft 365, Google).
            </p>
            {current === 'recovery-key' ? (
              <p className="hint" style={{ fontSize: 12.5 }}>
                A recovery key is saved now. Choosing this removes it from the OS, but a copy that was already exported still opens
                backups taken before now, until the data key is replaced (Rotate → New data key).
              </p>
            ) : null}
            <label className="row" style={{ gap: 8, alignItems: 'center', fontSize: 13 }}>
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              <span>I understand: if the key is lost, stored connection credentials can&apos;t be decrypted and connections must be reconnected.</span>
            </label>
            <button className="btn" style={{ marginTop: 10 }} disabled={!password || !ack || busy} onClick={chooseNone}>{busy ? <span className="spin" /> : 'Confirm: no recovery key'}</button>
          </>
        )
      ) : (
        <RecoveryKeyStep password={password} state={view.recovery.state} onChanged={onChanged} />
      )}
    </div>
  );
}

/** Provider choice with config + credential + Test connection; `onUse` switches (verified server-side). */
export function ProviderForm({ providers, current, password, onChanged }: { providers: ProviderInfo[]; current: string | null; password: string; onChanged: () => void }) {
  const [id, setId] = useState(current && current !== 'builtin' ? current : 'stackit');
  const [cfg, setCfg] = useState<Record<string, string>>({});
  const [cred, setCred] = useState('');
  const [health, setHealth] = useState<Health | null>(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const info = providers.find((p) => p.id === id);
  const run = async (op: 'test-provider' | 'switch') => {
    setBusy(op); setErr(''); setHealth(null);
    try {
      const b = await keyOp(password, op, { provider: id, config: cfg, credential: cred || undefined });
      setHealth((b.health as Health) ?? null);
      if (op === 'switch') { setCred(''); onChanged(); }
    } catch (e) { setErr((e as Error).message); } finally { setBusy(''); }
  };
  return (
    <div>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        {providers.filter((p) => p.id !== current).map((p) => (
          <button key={p.id} className={`btn ${id === p.id ? '' : 'ghost'}`} onClick={() => { setId(p.id); setHealth(null); setErr(''); }} title={p.summary}>
            {p.label}{p.available ? '' : ' — not yet available'}
          </button>
        ))}
      </div>
      {info ? <p className="muted" style={{ fontSize: 12.5 }}>{info.summary}{info.licence ? ` (${info.licence})` : ''}</p> : null}
      {info?.available ? (
        <>
          {info.config.map((f) => (
            <label key={f.name} style={{ display: 'block', marginBottom: 8 }}>
              <span className="muted" style={{ fontSize: 12 }}>{f.label}{f.required ? '' : ' (optional)'}</span>
              <input value={cfg[f.name] ?? ''} placeholder={f.placeholder} onChange={(e) => setCfg((c) => ({ ...c, [f.name]: e.target.value }))} autoComplete="off" style={{ display: 'block', width: '100%', maxWidth: 420 }} />
            </label>
          ))}
          {info.credential ? (
            <label style={{ display: 'block', marginBottom: 8 }}>
              <span className="muted" style={{ fontSize: 12 }}>{info.credential.label} — stored sealed under the built-in key (a provider cannot protect its own credential)</span>
              <input type="password" value={cred} onChange={(e) => setCred(e.target.value)} autoComplete="off" style={{ display: 'block', width: '100%', maxWidth: 420 }} />
            </label>
          ) : null}
          {err ? <div className="error">{err}</div> : null}
          {health ? <div className={health.ok ? 'hint' : 'error'} style={health.ok ? { color: 'var(--teal)' } : undefined}>{health.ok ? 'Connection works: ' : 'Not usable: '}{health.detail}</div> : null}
          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            <button className="btn ghost" disabled={!password || !!busy} onClick={() => run('test-provider')}>{busy === 'test-provider' ? <span className="spin" /> : 'Test connection'}</button>
            <button className="btn" disabled={!password || !!busy} onClick={() => run('switch')}>{busy === 'switch' ? <span className="spin" /> : `Use ${info.label}`}</button>
          </div>
          <div className="hint" style={{ fontSize: 11.5, marginTop: 6 }}>Switching re-wraps every data key under the new provider and opens each again before anything is saved. If any step fails, nothing changes.</div>
        </>
      ) : null}
    </div>
  );
}

function Badge({ ok, children }: { ok: boolean | null; children: React.ReactNode }) {
  return <span className={`badge ${ok === null ? 'muted' : ok ? 'ok' : 'warn'}`}>{children}</span>;
}

/** The Platform section. */
export default function EncryptionKeys() {
  const { state, error, load } = useKeys();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [rk, setRk] = useState('');
  const [cred, setCred] = useState('');
  const [toBuiltin, setToBuiltin] = useState(false);
  const [resetAck, setResetAck] = useState(false);

  const run = async (op: string, extra: Record<string, unknown>, done: (b: Record<string, unknown>) => string) => {
    setBusy(op); setErr(''); setMsg('');
    try { setMsg(done(await keyOp(password, op, extra))); await load(); } catch (e) { setErr((e as Error).message); } finally { setBusy(''); }
  };

  if (error) return <div className="error">{error}</div>;
  if (!state) return <div className="stub-page">Loading encryption keys…</div>;
  if (!state.managed || !state.view) return <div className="card"><h3>Encryption keys</h3><p className="muted">{state.note}</p></div>;
  const v = state.view;
  const locked = v.status === 'locked';
  const providerInfo = state.providers.find((p) => p.id === v.provider.id);

  return (
    <div className="grid" style={{ gridTemplateColumns: '1fr' }}>
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ margin: 0 }}>Where the master key lives</h3>
          <Badge ok={v.status === 'ready' ? (v.lastHealth ? v.lastHealth.ok : null) : false}>{v.status === 'ready' ? (v.lastHealth ? (v.lastHealth.ok ? 'healthy' : 'unhealthy') : 'ready') : v.status}</Badge>
        </div>
        <p style={{ margin: '8px 0 4px' }}><strong>{v.provider.label || v.provider.id}</strong></p>
        <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>{providerInfo?.summary}</p>
        {v.lastHealth ? <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>Last check {new Date(v.lastHealth.at ?? '').toLocaleString()}: {v.lastHealth.detail}</p> : null}
        {state.store ? <p className="muted" style={{ fontSize: 12 }}>{state.store.count} credential(s) stored{state.store.sealedUnderPreviousKey ? ` · ${state.store.sealedUnderPreviousKey} still being re-sealed under the current data key` : ''}{state.store.unreadable ? ` · ${state.store.unreadable} unreadable` : ''}</p> : null}
        {locked ? <div className="error" style={{ marginTop: 8 }}>The stored credentials are LOCKED: {v.reason}. Unlock them below.</div> : null}
      </div>

      <div className="card">
        <PasswordField value={password} onChange={setPassword} />
        {msg ? <div className="hint" style={{ color: 'var(--teal)' }}>{msg}</div> : null}
        {err ? <div className="error">{err}</div> : null}
      </div>

      {locked ? (
        <div className="card">
          <h3>Unlock after a restore</h3>
          <p className="muted" style={{ fontSize: 12.5 }}>Enter the recovery key: every data key is opened with it and wrapped again under a provider that works now — the current one if it passes a test, otherwise the built-in key (e.g. when the KMS key was deleted or the cluster was rebuilt).</p>
          <input className="mono" value={rk} onChange={(e) => setRk(e.target.value)} placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX" autoComplete="off" style={{ width: '100%', maxWidth: 520 }} />
          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            <button className="btn" disabled={!password || !rk || !!busy} onClick={() => run('restore', { recoveryKey: rk, ...(toBuiltin ? { provider: 'builtin' } : {}) }, (b) => {
              setRk('');
              const r = b.result as { provider: string; fellBackFrom?: string } | undefined;
              return `Unlocked — the stored credentials are readable again${r?.fellBackFrom ? `. ${r.fellBackFrom} could not be used, so the data keys now live under the built-in key — switch back once it works` : r ? ` (data keys under ${r.provider})` : ''}.`;
            })}>Unlock with recovery key</button>
          </div>
          <label className="row" style={{ gap: 8, marginTop: 8, alignItems: 'center', fontSize: 12.5 }}>
            <input type="checkbox" checked={toBuiltin} onChange={(e) => setToBuiltin(e.target.checked)} />
            <span>Move the data keys to the built-in key (use when the KMS key or its access is gone). Without this the OS keeps the current provider if it works, and falls back to built-in if it does not.</span>
          </label>
          {providerInfo?.credential ? (
            <>
              <p className="muted" style={{ fontSize: 12.5, marginTop: 14 }}>Or re-enter the {providerInfo.label} credential (e.g. the old one was sealed under a master key this cluster no longer has):</p>
              <input type="password" value={cred} onChange={(e) => setCred(e.target.value)} placeholder={providerInfo.credential.label} autoComplete="off" style={{ width: '100%', maxWidth: 420 }} />
              <button className="btn ghost" style={{ marginTop: 8 }} disabled={!password || !cred || !!busy} onClick={() => run('provider-credential', { credential: cred }, () => { setCred(''); return 'Credential accepted — the data keys open again.'; })}>Use this credential</button>
            </>
          ) : null}
          <h4 style={{ marginTop: 18 }}>No recovery key? Start over with new keys</h4>
          <p className="muted" style={{ fontSize: 12.5 }}>
            If the key is lost and there is no recovery key, the stored connection credentials cannot be opened again. Starting over
            creates new keys so connections can be saved again; every affected connection shows &quot;Needs reconnect&quot; — people
            re-enter API keys and sign in again to OAuth connections.
          </p>
          <label className="row" style={{ gap: 8, alignItems: 'center', fontSize: 12.5 }}>
            <input type="checkbox" checked={resetAck} onChange={(e) => setResetAck(e.target.checked)} />
            <span>I understand the stored connection credentials are lost and connections must be reconnected.</span>
          </label>
          <button className="btn ghost" style={{ marginTop: 8 }} disabled={!password || !resetAck || !!busy} onClick={() => run('reset-keys', { acknowledged: true }, () => { setResetAck(false); return 'New keys are active. Affected connections now show "Needs reconnect". Next: make the recovery choice below.'; })}>Start over with new keys</button>
        </div>
      ) : null}

      {!locked ? (
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ margin: 0 }}>Recovery</h3>
            <Badge ok={v.recoveryChoice?.choice !== 'unset'}>{v.recoveryChoice?.choice === 'none' ? 'no recovery key' : v.recoveryChoice?.choice === 'recovery-key' ? 'recovery key saved' : 'choice not made'}</Badge>
          </div>
          <RecoveryChoiceStep password={password} view={v} onChanged={() => load()} />
        </div>
      ) : null}

      <div className="card">
        <h3>Test restore</h3>
        <p className="muted" style={{ fontSize: 12.5 }}>Proves the recovery key (if you enter it) and the provider can open every data key. Nothing is changed.</p>
        <input className="mono" value={rk} onChange={(e) => setRk(e.target.value)} placeholder="Recovery key (optional)" autoComplete="off" style={{ width: '100%', maxWidth: 520 }} />
        <button className="btn ghost" style={{ marginTop: 8 }} disabled={!password || !!busy} onClick={() => run('test-restore', { recoveryKey: rk || undefined }, (b) => {
          const r = b.result as { recovery: string; provider: string; detail: string };
          return `Recovery key: ${r.recovery} · provider: ${r.provider}${r.detail ? ` — ${r.detail}` : ''}`;
        })}>Run test restore</button>
      </div>

      {!locked ? (
        <div className="card">
          <h3>Rotate</h3>
          <p className="muted" style={{ fontSize: 12.5 }}>Re-wrap: the provider wraps the same data key again (e.g. after a new KMS key version). New data key: credentials are re-sealed under it in the background; the old key stays until they are.</p>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn ghost" disabled={!password || !!busy} onClick={() => run('rotate', { newDataKey: false }, () => 'Data keys re-wrapped and verified.')}>Re-wrap data key</button>
            <button className="btn ghost" disabled={!password || !!busy} onClick={() => run('rotate', { newDataKey: true }, () => 'New data key active — re-sealing in the background.')}>New data key</button>
          </div>
        </div>
      ) : null}

      {!locked ? (
        <div className="card">
          <h3>Switch provider</h3>
          <ProviderForm providers={state.providers} current={v.provider.id} password={password} onChanged={() => load(true)} />
        </div>
      ) : null}

      <div className="card">
        <h3>Data keys &amp; history</h3>
        <table className="table" style={{ fontSize: 12.5 }}>
          <thead><tr><th>Data key</th><th>Created</th><th>State</th><th>Recoverable</th></tr></thead>
          <tbody>{v.dataKeys.map((k) => <tr key={k.id}><td className="mono">{k.id}</td><td>{new Date(k.createdAt).toLocaleString()}</td><td>{k.current ? 'current' : 'decrypt-only'}</td><td>{k.recoverable ? 'yes' : 'no'}</td></tr>)}</tbody>
        </table>
        <ul className="muted" style={{ fontSize: 12, marginTop: 10 }}>
          {v.history.map((h, i) => <li key={i}>{new Date(h.at).toLocaleString()} · {h.actor} · {h.action} — {h.detail}</li>)}
        </ul>
      </div>
    </div>
  );
}
