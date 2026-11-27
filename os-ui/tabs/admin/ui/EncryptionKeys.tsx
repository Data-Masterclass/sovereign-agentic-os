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
 *   - I18N:       converted (wave 2) — texts from `admin.encryption.*`. Server error messages, provider labels,
 *                 summaries and field labels, the lock reason, history actions and details come from the API and
 *                 render as is (wave 4). The OPA explanations thrown by `keyOp` keep their English in
 *                 `Error.message` (logs) and carry a `messageKey` the components translate.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations, useFormat } from '@core/i18n/client';

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
  history: { at: string; actor: string; action: string; detail: string; unverified?: boolean }[];
  startOver?: { eligible: boolean; reason: string; recoveryPresent: boolean };
  archived?: number;
};
export type KeysState = { managed: boolean; note: string; view: View | null; providers: ProviderInfo[]; store?: { status: string; count: number; sealedUnderPreviousKey: number; unreadable: number } };

type T = ReturnType<typeof useTranslations<'admin'>>;

const API = '/api/platform-admin/encryption-keys';
/** The date-time form the console showed before i18n (en-US `toLocaleString()`), now in the user's locale. */
const LEGACY_DT: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' };

/** A refusal the UI explains itself: `message` stays English (logs), `messageKey` is what the user reads. */
export class KeyOpError extends Error {
  constructor(message: string, readonly messageKey: 'encryption.opa.unreachable' | 'encryption.opa.notConfirmed') {
    super(message);
  }
}

/** The text to show for a failed operation: our own explanation translated, a server message as is. */
function errorText(t: T, e: unknown): string {
  return e instanceof KeyOpError ? t(e.messageKey) : (e as Error).message;
}

export function useKeys() {
  const t = useTranslations('admin');
  const [state, setState] = useState<KeysState | null>(null);
  const [error, setError] = useState('');
  const loadError = t('encryption.loadError');
  const load = useCallback(async (health = false) => {
    try {
      const r = await fetch(`${API}${health ? '?health=1' : ''}`, { cache: 'no-store' });
      const b = await r.json();
      if (!r.ok) setError(b.error ?? loadError);
      else { setState(b); setError(''); }
    } catch (e) { setError((e as Error).message); }
  }, [loadError]);
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
    throw b.policy === 'opa-unreachable'
      ? new KeyOpError('The policy engine (OPA) is not answering, so key changes are refused for now. Try again in a minute; Monitoring → Platform shows OPA\'s state.', 'encryption.opa.unreachable')
      : new KeyOpError('The policy engine (OPA) has not confirmed your admin rights yet — common in the first minutes after setup. Wait a few seconds and try again; if it keeps happening, check Governance → Policy (the admin grant) and OPA in Monitoring.', 'encryption.opa.notConfirmed');
  }
  if (!r.ok) throw new Error(b.error ?? `HTTP ${r.status}`);
  return b as Record<string, unknown>;
}

export function PasswordField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const t = useTranslations('admin');
  return (
    <label style={{ display: 'block', marginBottom: 12 }}>
      <span className="muted" style={{ fontSize: 12.5 }}>{t('encryption.passwordLabel')}</span>
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

function recoverySheet(t: T, key: string, host: string) {
  return [
    t('encryption.sheet.title'),
    '',
    t('encryption.sheet.installation', { host }),
    t('encryption.sheet.generated', { at: new Date().toISOString() }),
    '',
    `    ${key}`,
    '',
    t('encryption.sheet.keepOffline'),
    t('encryption.sheet.afterRestore'),
    t('encryption.sheet.warning'),
  ].join('\n');
}

function printSheet(text: string, title: string) {
  const w = window.open('', '_blank', 'width=720,height=600');
  if (!w) return;
  const pre = w.document.createElement('pre');
  pre.style.cssText = 'font: 14px/1.6 ui-monospace, monospace; white-space: pre-wrap; padding: 32px';
  pre.textContent = text;
  w.document.title = title;
  w.document.body.appendChild(pre);
  w.focus();
  w.print();
}

/** Generate → show once → download / print → "I saved it". Used by the console and the wizard. */
export function RecoveryKeyStep({ password, state, onChanged }: { password: string; state: View['recovery']['state']; onChanged: () => void }) {
  const t = useTranslations('admin');
  const tc = useTranslations('common');
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
    } catch (e) { setErr(errorText(t, e)); } finally { setBusy(''); }
  };
  const sheet = key ? recoverySheet(t, key, typeof window !== 'undefined' ? window.location.host : '') : '';
  return (
    <div>
      {err ? <div className="error">{err}</div> : null}
      {!key ? (
        <>
          <p className="muted" style={{ fontSize: 13 }}>
            {state === 'confirmed' ? t('encryption.recoveryKey.stateConfirmed')
              : state === 'unconfirmed' ? t('encryption.recoveryKey.stateUnconfirmed')
                : t('encryption.recoveryKey.stateMissing')}
          </p>
          <button className="btn" disabled={!password || !!busy} onClick={() => run('recovery-generate')}>
            {busy ? <span className="spin" /> : state === 'missing' ? t('encryption.recoveryKey.generate') : t('encryption.recoveryKey.generateNew')}
          </button>
        </>
      ) : (
        <>
          <div className="hint" style={{ marginBottom: 8 }}>{t('encryption.recoveryKey.shownOnce')}</div>
          <div className="mono" style={{ fontSize: 18, letterSpacing: 1, padding: '12px 14px', background: 'var(--panel)', borderRadius: 8, wordBreak: 'break-all' }}>{key}</div>
          <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            <button className="btn ghost" onClick={() => downloadText('sovereign-os-recovery-key.txt', sheet)}>{t('encryption.recoveryKey.download')}</button>
            <button className="btn ghost" onClick={() => printSheet(sheet, t('encryption.sheet.windowTitle'))}>{t('encryption.recoveryKey.print')}</button>
          </div>
          <label className="row" style={{ gap: 8, marginTop: 14, alignItems: 'center' }}>
            <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
            <span>{t('encryption.recoveryKey.savedAck')}</span>
          </label>
          <label style={{ display: 'block', marginTop: 10 }}>
            <span className="muted" style={{ fontSize: 12.5 }}>{t('encryption.recoveryKey.typeToConfirm')}</span>
            {/* i18n-ignore: the recovery-key format mask, not words */}
            <input className="mono" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" placeholder="XXXXX-XXXXX-…" style={{ display: 'block', width: '100%', maxWidth: 520, marginTop: 4 }} />
          </label>
          <button className="btn" style={{ marginTop: 10 }} disabled={!saved || !typed || !password || !!busy} onClick={() => run('recovery-confirm', { saved: true, recoveryKey: typed })}>
            {busy ? <span className="spin" /> : tc('actions.confirm')}
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
  const t = useTranslations('admin');
  const f = useFormat();
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
      if (b.hadRecoveryKey) setNote(t('encryption.choice.doneNote'));
      onChanged();
    } catch (e) { setErr(errorText(t, e)); } finally { setBusy(false); }
  };
  const by = view.recoveryChoice.by;
  const at = view.recoveryChoice.at ? f.dateTime(view.recoveryChoice.at, LEGACY_DT) : '';
  const status = current === 'unset' ? t('encryption.choice.unset')
    : current === 'none'
      ? (at ? t('encryption.choice.noneByAt', { by: by ?? t('encryption.choice.anAdmin'), at }) : t('encryption.choice.noneBy', { by: by ?? t('encryption.choice.anAdmin') }))
      : !by ? t('encryption.choice.keySaved') : at ? t('encryption.choice.keySavedByAt', { by, at }) : t('encryption.choice.keySavedBy', { by });
  return (
    <div>
      <p className="muted" style={{ fontSize: 12.5, marginTop: 0 }}>{status}</p>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <button className={`btn ${pick === 'none' ? '' : 'ghost'}`} onClick={() => { setPick('none'); setErr(''); }}>{t('encryption.choice.optionNone')}</button>
        <button className={`btn ${pick === 'recovery-key' ? '' : 'ghost'}`} onClick={() => { setPick('recovery-key'); setErr(''); }}>{t('encryption.choice.optionKey')}</button>
      </div>
      {err ? <div className="error">{err}</div> : null}
      {note ? <div className="hint">{note}</div> : null}
      {pick === 'none' ? (
        current === 'none' ? <p className="muted" style={{ fontSize: 12.5 }}>{t('encryption.choice.nothingElse')}</p> : (
          <>
            <p className="muted" style={{ fontSize: 12.5 }}>{t('encryption.choice.noneExplain')}</p>
            {current === 'recovery-key' ? (
              <p className="hint" style={{ fontSize: 12.5 }}>{t('encryption.choice.removesSaved')}</p>
            ) : null}
            <label className="row" style={{ gap: 8, alignItems: 'center', fontSize: 13 }}>
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              <span>{t('encryption.choice.ack')}</span>
            </label>
            <button className="btn" style={{ marginTop: 10 }} disabled={!password || !ack || busy} onClick={chooseNone}>{busy ? <span className="spin" /> : t('encryption.choice.confirmNone')}</button>
            <p className="hint" style={{ fontSize: 11.5, marginTop: 6 }}>{t('encryption.oneWay')}</p>
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
  const t = useTranslations('admin');
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
    } catch (e) { setErr(errorText(t, e)); } finally { setBusy(''); }
  };
  return (
    <div>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        {providers.filter((p) => p.id !== current).map((p) => (
          <button key={p.id} className={`btn ${id === p.id ? '' : 'ghost'}`} onClick={() => { setId(p.id); setHealth(null); setErr(''); }} title={p.summary}>
            {p.available ? p.label : t('encryption.provider.notAvailable', { label: p.label })}
          </button>
        ))}
      </div>
      {info ? <p className="muted" style={{ fontSize: 12.5 }}>{info.summary}{info.licence ? ` (${info.licence})` : ''}</p> : null}
      {info?.available ? (
        <>
          {info.config.map((fl) => (
            <label key={fl.name} style={{ display: 'block', marginBottom: 8 }}>
              <span className="muted" style={{ fontSize: 12 }}>{fl.required ? fl.label : t('encryption.provider.optional', { label: fl.label })}</span>
              <input value={cfg[fl.name] ?? ''} placeholder={fl.placeholder} onChange={(e) => setCfg((c) => ({ ...c, [fl.name]: e.target.value }))} autoComplete="off" style={{ display: 'block', width: '100%', maxWidth: 420 }} />
            </label>
          ))}
          {info.credential ? (
            <label style={{ display: 'block', marginBottom: 8 }}>
              <span className="muted" style={{ fontSize: 12 }}>{t('encryption.provider.credentialLabel', { label: info.credential.label })}</span>
              <input type="password" value={cred} onChange={(e) => setCred(e.target.value)} autoComplete="off" style={{ display: 'block', width: '100%', maxWidth: 420 }} />
            </label>
          ) : null}
          {err ? <div className="error">{err}</div> : null}
          {health ? <div className={health.ok ? 'hint' : 'error'} style={health.ok ? { color: 'var(--teal)' } : undefined}>{health.ok ? t('encryption.provider.healthOk', { detail: health.detail }) : t('encryption.provider.healthBad', { detail: health.detail })}</div> : null}
          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            <button className="btn ghost" disabled={!password || !!busy} onClick={() => run('test-provider')}>{busy === 'test-provider' ? <span className="spin" /> : t('encryption.provider.test')}</button>
            <button className="btn" disabled={!password || !!busy} onClick={() => run('switch')}>{busy === 'switch' ? <span className="spin" /> : t('encryption.provider.use', { label: info.label })}</button>
          </div>
          <div className="hint" style={{ fontSize: 11.5, marginTop: 6 }}>{t('encryption.provider.switchHint')}</div>
        </>
      ) : null}
    </div>
  );
}

function Badge({ ok, children }: { ok: boolean | null; children: React.ReactNode }) {
  return <span className={`badge ${ok === null ? 'muted' : ok ? 'ok' : 'warn'}`}>{children}</span>;
}

const STATUS_KEYS = { unconfigured: 'unconfigured', ready: 'ready', locked: 'locked', failed: 'failed' } as const;
const RESTORE_RECOVERY_KEYS: Record<string, 'ok' | 'wrongKey' | 'noRecovery' | 'skipped'> = { ok: 'ok', 'wrong-key': 'wrongKey', 'no-recovery': 'noRecovery', skipped: 'skipped' };
const RESTORE_PROVIDER_KEYS: Record<string, 'ok' | 'failed'> = { ok: 'ok', failed: 'failed' };

/** The Platform section. */
export default function EncryptionKeys() {
  const t = useTranslations('admin');
  const f = useFormat();
  const { state, error, load } = useKeys();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [rk, setRk] = useState('');
  const [cred, setCred] = useState('');
  const [toBuiltin, setToBuiltin] = useState(false);
  const [resetAck, setResetAck] = useState(false);
  const [resetOverride, setResetOverride] = useState(false);

  const run = async (op: string, extra: Record<string, unknown>, done: (b: Record<string, unknown>) => string) => {
    setBusy(op); setErr(''); setMsg('');
    try { setMsg(done(await keyOp(password, op, extra))); await load(); } catch (e) { setErr(errorText(t, e)); } finally { setBusy(''); }
  };

  if (error) return <div className="error">{error}</div>;
  if (!state) return <div className="stub-page">{t('encryption.console.loading')}</div>;
  if (!state.managed || !state.view) return <div className="card"><h3>{t('encryption.console.title')}</h3><p className="muted">{state.note}</p></div>;
  const v = state.view;
  const locked = v.status === 'locked';
  const providerInfo = state.providers.find((p) => p.id === v.provider.id);
  const statusKey = STATUS_KEYS[v.status];
  const statusLabel = v.status === 'ready'
    ? (v.lastHealth ? (v.lastHealth.ok ? t('encryption.console.status.healthy') : t('encryption.console.status.unhealthy')) : t('encryption.console.status.ready'))
    : statusKey ? t(`encryption.console.status.${statusKey}`) : v.status;
  const storeParts = state.store ? [
    t('encryption.console.stored', { count: state.store.count }),
    ...(state.store.sealedUnderPreviousKey ? [t('encryption.console.storeResealing', { count: state.store.sealedUnderPreviousKey })] : []),
    ...(state.store.unreadable ? [t('encryption.console.storeUnreadable', { count: state.store.unreadable })] : []),
  ] : [];

  return (
    <div className="grid" style={{ gridTemplateColumns: '1fr' }}>
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ margin: 0 }}>{t('encryption.console.masterKeyTitle')}</h3>
          <Badge ok={v.status === 'ready' ? (v.lastHealth ? v.lastHealth.ok : null) : false}>{statusLabel}</Badge>
        </div>
        <p style={{ margin: '8px 0 4px' }}><strong>{v.provider.label || v.provider.id}</strong></p>
        <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>{providerInfo?.summary}</p>
        {v.lastHealth ? <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>{t('encryption.console.lastCheck', { at: f.dateTime(v.lastHealth.at ?? '', LEGACY_DT), detail: v.lastHealth.detail })}</p> : null}
        {state.store ? <p className="muted" style={{ fontSize: 12 }}>{storeParts.join(' · ')}</p> : null}
        {locked ? <div className="error" style={{ marginTop: 8 }}>{t('encryption.console.locked', { reason: v.reason })}</div> : null}
      </div>

      <div className="card">
        <PasswordField value={password} onChange={setPassword} />
        {msg ? <div className="hint" style={{ color: 'var(--teal)' }}>{msg}</div> : null}
        {err ? <div className="error">{err}</div> : null}
      </div>

      {locked ? (
        <div className="card">
          <h3>{t('encryption.unlock.title')}</h3>
          <p className="muted" style={{ fontSize: 12.5 }}>{t('encryption.unlock.body')}</p>
          {/* i18n-ignore: the recovery-key format mask, not words */}
          <input className="mono" value={rk} onChange={(e) => setRk(e.target.value)} placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX" autoComplete="off" style={{ width: '100%', maxWidth: 520 }} />
          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            <button className="btn" disabled={!password || !rk || !!busy} onClick={() => run('restore', { recoveryKey: rk, ...(toBuiltin ? { provider: 'builtin' } : {}) }, (b) => {
              setRk('');
              const r = b.result as { provider: string; fellBackFrom?: string } | undefined;
              return r?.fellBackFrom ? t('encryption.unlock.doneFellBack', { from: r.fellBackFrom })
                : r ? t('encryption.unlock.doneProvider', { provider: r.provider }) : t('encryption.unlock.done');
            })}>{t('encryption.unlock.button')}</button>
          </div>
          <label className="row" style={{ gap: 8, marginTop: 8, alignItems: 'center', fontSize: 12.5 }}>
            <input type="checkbox" checked={toBuiltin} onChange={(e) => setToBuiltin(e.target.checked)} />
            <span>{t('encryption.unlock.toBuiltin')}</span>
          </label>
          {providerInfo?.credential ? (
            <>
              <p className="muted" style={{ fontSize: 12.5, marginTop: 14 }}>{t('encryption.unlock.credentialIntro', { label: providerInfo.label })}</p>
              <input type="password" value={cred} onChange={(e) => setCred(e.target.value)} placeholder={providerInfo.credential.label} autoComplete="off" style={{ width: '100%', maxWidth: 420 }} />
              <button className="btn ghost" style={{ marginTop: 8 }} disabled={!password || !cred || !!busy} onClick={() => run('provider-credential', { credential: cred }, () => { setCred(''); return t('encryption.unlock.credentialAccepted'); })}>{t('encryption.unlock.useCredential')}</button>
            </>
          ) : null}
          {v.startOver?.eligible ? (
            <>
              <h4 style={{ marginTop: 18 }}>{t('encryption.startOver.title')}</h4>
              <p className="muted" style={{ fontSize: 12.5 }}>{t('encryption.startOver.body')}</p>
              {v.startOver.recoveryPresent ? (
                <label className="row" style={{ gap: 8, alignItems: 'center', fontSize: 12.5 }}>
                  <input type="checkbox" checked={resetOverride} onChange={(e) => setResetOverride(e.target.checked)} />
                  <span>{t('encryption.startOver.recoveryPresent')}</span>
                </label>
              ) : null}
              <label className="row" style={{ gap: 8, alignItems: 'center', fontSize: 12.5 }}>
                <input type="checkbox" checked={resetAck} onChange={(e) => setResetAck(e.target.checked)} />
                <span>{t('encryption.startOver.ack')}</span>
              </label>
              <button className="btn ghost" style={{ marginTop: 8 }} disabled={!password || !resetAck || (v.startOver.recoveryPresent && !resetOverride) || !!busy} onClick={() => run('reset-keys', { acknowledged: true, overrideRecovery: v.startOver?.recoveryPresent ? resetOverride : undefined }, () => { setResetAck(false); setResetOverride(false); return t('encryption.startOver.done'); })}>{t('encryption.startOver.button')}</button>
              <p className="hint" style={{ fontSize: 11.5, marginTop: 6 }}>{t('encryption.oneWay')}</p>
            </>
          ) : null}
        </div>
      ) : null}

      {!locked ? (
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ margin: 0 }}>{t('encryption.recoveryCard.title')}</h3>
            <Badge ok={v.recoveryChoice?.choice !== 'unset'}>{v.recoveryChoice?.choice === 'none' ? t('encryption.recoveryCard.badgeNone') : v.recoveryChoice?.choice === 'recovery-key' ? t('encryption.recoveryCard.badgeSaved') : t('encryption.recoveryCard.badgeUnset')}</Badge>
          </div>
          <RecoveryChoiceStep password={password} view={v} onChanged={() => load()} />
        </div>
      ) : null}

      <div className="card">
        <h3>{t('encryption.testRestore.title')}</h3>
        <p className="muted" style={{ fontSize: 12.5 }}>{t('encryption.testRestore.body')}</p>
        <input className="mono" value={rk} onChange={(e) => setRk(e.target.value)} placeholder={t('encryption.testRestore.placeholder')} autoComplete="off" style={{ width: '100%', maxWidth: 520 }} />
        <button className="btn ghost" style={{ marginTop: 8 }} disabled={!password || !!busy} onClick={() => run('test-restore', { recoveryKey: rk || undefined }, (b) => {
          const r = b.result as { recovery: string; provider: string; detail: string };
          const rec = RESTORE_RECOVERY_KEYS[r.recovery];
          const prov = RESTORE_PROVIDER_KEYS[r.provider];
          const recovery = rec ? t(`encryption.testRestore.recovery.${rec}`) : r.recovery;
          const provider = prov ? t(`encryption.testRestore.provider.${prov}`) : r.provider;
          return r.detail ? t('encryption.testRestore.resultDetail', { recovery, provider, detail: r.detail }) : t('encryption.testRestore.result', { recovery, provider });
        })}>{t('encryption.testRestore.button')}</button>
      </div>

      {!locked ? (
        <div className="card">
          <h3>{t('encryption.rotate.title')}</h3>
          <p className="muted" style={{ fontSize: 12.5 }}>{t('encryption.rotate.body')}</p>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn ghost" disabled={!password || !!busy} onClick={() => run('rotate', { newDataKey: false }, () => t('encryption.rotate.rewrapDone'))}>{t('encryption.rotate.rewrap')}</button>
            <button className="btn ghost" disabled={!password || !!busy} onClick={() => run('rotate', { newDataKey: true }, () => t('encryption.rotate.newKeyDone'))}>{t('encryption.rotate.newKey')}</button>
          </div>
        </div>
      ) : null}

      {!locked ? (
        <div className="card">
          <h3>{t('encryption.switchTitle')}</h3>
          <ProviderForm providers={state.providers} current={v.provider.id} password={password} onChanged={() => load(true)} />
        </div>
      ) : null}

      <div className="card">
        <h3>{t('encryption.history.title')}</h3>
        <table className="table" style={{ fontSize: 12.5 }}>
          <thead><tr><th>{t('encryption.history.colDataKey')}</th><th>{t('encryption.history.colCreated')}</th><th>{t('encryption.history.colState')}</th><th>{t('encryption.history.colRecoverable')}</th></tr></thead>
          <tbody>{v.dataKeys.map((k) => <tr key={k.id}><td className="mono">{k.id}</td><td>{f.dateTime(k.createdAt, LEGACY_DT)}</td><td>{k.current ? t('encryption.history.current') : t('encryption.history.decryptOnly')}</td><td>{k.recoverable ? t('encryption.history.yes') : t('encryption.history.no')}</td></tr>)}</tbody>
        </table>
        <ul className="muted" style={{ fontSize: 12, marginTop: 10 }}>
          {v.history.map((h, i) => <li key={i}>{f.dateTime(h.at, LEGACY_DT)} · {h.actor} · {h.action} — {h.detail}{h.unverified ? ` ${t('encryption.history.unverified')}` : ''}</li>)}
        </ul>
      </div>
    </div>
  );
}
