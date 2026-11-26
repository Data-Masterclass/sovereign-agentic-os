/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        connections
 * FEATURE:    "Accounts for the chat" — add Notion / OneDrive / Microsoft 365 / Google Drive, connect your own account
 * USER STORY: As an admin I want to add a Notion, OneDrive, Microsoft 365 or Google Drive connection for my
 *             domain or company in one form, per-user by default; as a user I want one "Connect your account"
 *             button, to see as whom I am connected, and to disconnect.
 * ARCHITECTURE:
 *   - Talks to `/api/connections/accounts` (list + add), `/api/connections/[id]/account` (status,
 *     disconnect) and `/api/connections/connect` (the OAuth start). No token ever reaches the browser.
 *   - The scope choices follow the role (domain_admin: Domain; admin: Company) and the server checks
 *     again. A shared credential needs the warned tick; the server refuses it without the tick.
 *   - When the Microsoft/Google sign-in app is not configured yet, the row shows a warning instead of a Connect
 *     button that would fail: admins get "Set up the sign-in app" (Sign-in apps (Google & Microsoft), at
 *     /platform/oauth-apps), everyone else is told to ask their admin. The add form warns before adding (an
 *     unknown status counts as missing) and the new row then says "Added. Next step: …" (one warning per row;
 *     a polite live region announces it). Role-specific text waits until the role has loaded. Wording lives in tabs/connections/lib/sign-in-apps.ts (tested); the
 *     list API sends only per-provider booleans (`signInApps`), never a client id or secret.
 *   - Microsoft 365 has one more switch, "Allow drafting and sending mail" (default off; domain admin or
 *     admin, per-user sign-in only). It is in the add form and on the row; the server checks the role again.
 *     A person whose sign-in predates the switch sees "Reconnect to allow sending".
 * I18N:       converted (wave 2) — texts from `connections.accounts.*` and `connections.signInApps.*`.
 */
'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useUser } from '@core/ui/useUser';
import { useTranslations } from '@core/i18n/client';
import { roleAtLeast } from '@core/kernel/session';
import {
  preAddNotice, rowSignInNotice, addedAnnouncementNotice, entraNote,
  type KnownRole, type SignInAppsStatus, type SignInNotice,
} from '@tabs/connections/lib/sign-in-apps';

type Account = {
  id: string; name: string; template: string; label: string; visibility: string; domain: string; owner: string;
  credentialMode: 'per_user' | 'shared' | 'owner';
  status: { connected: boolean; subject: string | null; connectedAt: string | null; canConnect: boolean; mailSendGranted?: boolean };
  oauthAppConfigured: boolean;
  /**
   * Microsoft 365 only: the "Allow drafting and sending mail" switch, whether the caller may change it, and —
   * sent only to those who may — how many sign-ins still lack the mail permissions.
   */
  mailSend?: { allowed: boolean; canChange: boolean; ungranted?: number };
};

type ConnT = ReturnType<typeof useTranslations<'connections'>>;

// `label` is the product name (never translated); `whatKey` is the catalog key of the one-line description.
const KINDS: { kind: string; label: string; whatKey: 'accounts.kinds.notion' | 'accounts.kinds.microsoft365' | 'accounts.kinds.onedrive' | 'accounts.kinds.gdrive' }[] = [
  { kind: 'notion', label: 'Notion', whatKey: 'accounts.kinds.notion' },
  { kind: 'microsoft-365', label: 'Microsoft 365', whatKey: 'accounts.kinds.microsoft365' },
  { kind: 'onedrive', label: 'OneDrive', whatKey: 'accounts.kinds.onedrive' },
  { kind: 'gdrive', label: 'Google Drive', whatKey: 'accounts.kinds.gdrive' },
];
const SCOPE_WORD_KEY = { Personal: 'accounts.scopeWord.my', Shared: 'accounts.scopeWord.domain', Certified: 'accounts.scopeWord.company' } as const;
function scopeWord(t: ConnT, visibility: string): string {
  const k = SCOPE_WORD_KEY[visibility as keyof typeof SCOPE_WORD_KEY];
  return k ? t(k) : visibility;
}

/** A sign-in notice in the active language: its key and arguments, not the English `text`. */
function noticeText(t: ConnT, n: SignInNotice): string {
  return t(n.key, n.values);
}

/** Under the switch, once it is on: the Entra prerequisite; only an admin gets the link to the (admin-only) page. */
function EntraNote({ role }: { role: KnownRole }) {
  const t = useTranslations('connections');
  const n = entraNote(role);
  return (
    <p className="hint" style={{ margin: '2px 0 0 22px' }}>
      {noticeText(t, n)}{n.action && n.actionKey ? <> (<Link href={n.action.href}>{t(n.actionKey)}</Link>)</> : null}
    </p>
  );
}

/** Visually hidden but read by screen readers (the polite live region for "Added…"). */
const SR_ONLY = { position: 'absolute', width: 1, height: 1, margin: -1, padding: 0, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0 } as const;

/** A visible warning (the warn badge, as a block) with the admin's link when there is one. */
function SignInNoticeBox({ notice }: { notice: SignInNotice }) {
  const t = useTranslations('connections');
  return (
    <div className="badge warn" style={{ display: 'block', marginTop: 6, whiteSpace: 'normal', fontSize: 12.5 }}>
      {noticeText(t, notice)}
      {notice.action && notice.actionKey ? <> <Link className="btn sm" href={notice.action.href} style={{ marginLeft: 6 }}>{t(notice.actionKey)}</Link></> : null}
    </div>
  );
}

export function connectHref(connectionId: string, returnTo = '/connections'): string {
  return `/api/connections/connect?connectionId=${encodeURIComponent(connectionId)}&returnTo=${encodeURIComponent(returnTo)}`;
}

export default function AccountConnections() {
  const t = useTranslations('connections');
  const tc = useTranslations('common');
  const { user, loading: userLoading } = useUser();
  const role = user?.role ?? 'creator';
  // For role-specific wording: null while the role is still loading, so an admin never sees the creator text.
  const knownRole: KnownRole = userLoading ? null : role;
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState('microsoft-365');
  const [name, setName] = useState('');
  const [scope, setScope] = useState<'my' | 'domain' | 'company'>('my');
  const [shared, setShared] = useState(false);
  const [ack, setAck] = useState(false);
  const [mailSend, setMailSend] = useState(false);
  const [busy, setBusy] = useState(false);
  const [signInApps, setSignInApps] = useState<SignInAppsStatus | null>(null);
  // The connection just added: its row shows "Added. Next step: …" (computed at render, never stored text).
  const [justAddedId, setJustAddedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/connections/accounts', { cache: 'no-store' });
      const j = (await r.json()) as { accounts?: Account[]; signInApps?: SignInAppsStatus; error?: string };
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setAccounts(j.accounts ?? []);
      setSignInApps(j.signInApps ?? null);
    } catch (e) {
      setError((e as Error).message);
      setAccounts([]);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const add = async () => {
    setBusy(true);
    setError('');
    setJustAddedId(null);
    try {
      const r = await fetch('/api/connections/accounts', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind, name: name.trim() || undefined, scope, credentialMode: shared ? 'shared' : 'per_user', sharedAcknowledged: shared && ack, allowMailSend: offerMailSend && mailSend }),
      });
      const j = (await r.json()) as { id?: string; error?: string };
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setJustAddedId(j.id ?? null);
      setAdding(false); setName(''); setShared(false); setAck(false); setMailSend(false);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async (id: string) => {
    setError('');
    const r = await fetch(`/api/connections/${encodeURIComponent(id)}/account`, { method: 'DELETE' });
    if (!r.ok) setError(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${r.status}`);
    await load();
  };

  const canDomain = roleAtLeast(role, 'domain_admin');
  const canCompany = role === 'admin';
  // The switch is offered where the server will accept it: Microsoft 365, per-user sign-in, a domain admin or admin.
  const offerMailSend = kind === 'microsoft-365' && !shared && canDomain && (scope !== 'company' || canCompany);

  const toggleMailSend = async (id: string, allow: boolean) => {
    setError('');
    const r = await fetch(`/api/connections/${encodeURIComponent(id)}/account`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ allowMailSend: allow }),
    });
    if (!r.ok) setError(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${r.status}`);
    await load();
  };

  return (
    <section className="card" aria-label={t('accounts.title')} style={{ marginBottom: 22 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div className="section-title" style={{ marginTop: 0 }}>{t('accounts.title')}</div>
          <p className="hint">{t('accounts.intro')}</p>
        </div>
        <button type="button" className="btn" onClick={() => setAdding((v) => !v)}>{adding ? tc('actions.cancel') : t('accounts.addToggle')}</button>
      </div>

      {adding ? (
        <div className="card" style={{ marginTop: 12 }}>
          <div className="seg" role="radiogroup" aria-label={t('accounts.serviceAria')}>
            {KINDS.map((k) => (
              <button key={k.kind} type="button" role="radio" aria-checked={kind === k.kind} className={`btn ghost sm${kind === k.kind ? ' is-active' : ''}`} onClick={() => setKind(k.kind)}>{k.label}</button>
            ))}
          </div>
          <p className="hint">{(() => { const k = KINDS.find((x) => x.kind === kind); return k ? t(k.whatKey) : null; })()}</p>
          {(() => {
            const n = preAddNotice(kind, signInApps, knownRole);
            return n ? <SignInNoticeBox notice={n} /> : null;
          })()}
          <label className="row" style={{ gap: 8 }}>{t('accounts.nameLabel')} <input value={name} onChange={(e) => setName(e.target.value)} placeholder={KINDS.find((k) => k.kind === kind)?.label} /></label>
          <div className="row" role="radiogroup" aria-label={t('accounts.whoAria')} style={{ gap: 12, marginTop: 8 }}>
            <label><input type="radio" checked={scope === 'my'} onChange={() => setScope('my')} /> {t('accounts.scopeMe')}</label>
            {canDomain ? <label><input type="radio" checked={scope === 'domain'} onChange={() => setScope('domain')} /> {t('accounts.scopeDomain')}</label> : null}
            {canCompany ? <span className="muted" title={t('accounts.companyTitle')}>{t('accounts.companyLater')}</span> : null}
          </div>
          <p className="hint">{t.rich('accounts.signInHint', { strong: (c) => <strong>{c}</strong> })}</p>
          {scope === 'domain' ? (
            <div style={{ marginTop: 6 }}>
              <label><input type="checkbox" checked={shared} onChange={(e) => { setShared(e.target.checked); setAck(false); }} /> {t('accounts.sharedToggle')}</label>
              {shared ? (
                <div className="badge warn" role="alert" style={{ display: 'block', marginTop: 6, whiteSpace: 'normal' }}>
                  {t('accounts.sharedWarn')}
                  <label style={{ display: 'block', marginTop: 4 }}><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> {t('accounts.sharedAck')}</label>
                </div>
              ) : null}
            </div>
          ) : null}
          {offerMailSend ? (
            <div style={{ marginTop: 6 }}>
              <label><input type="checkbox" checked={mailSend} onChange={(e) => setMailSend(e.target.checked)} /> {t('accounts.mailSend')}</label>
              <p className="hint" style={{ margin: '2px 0 0 22px' }}>{t('accounts.mailSendHint')}</p>
              {mailSend ? <EntraNote role={knownRole} /> : null}
            </div>
          ) : null}
          <div className="row" style={{ marginTop: 10 }}>
            <button type="button" className="btn" disabled={busy || (shared && !ack)} onClick={() => void add()}>{busy ? t('accounts.adding') : t('accounts.add')}</button>
          </div>
        </div>
      ) : null}

      <div aria-live="polite" style={SR_ONLY}>{(() => { const n = addedAnnouncementNotice(accounts, justAddedId, knownRole); return n ? noticeText(t, n) : ''; })()}</div>
      {error ? <div className="error" role="alert">{error}</div> : null}
      {accounts === null ? <p className="muted"><span className="spin" /> {t('accounts.loading')}</p> : accounts.length === 0 ? (
        <p className="muted">{canDomain ? t('accounts.emptyDomain') : t('accounts.emptyOther')}</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: '12px 0 0' }}>
          {accounts.map((a) => (
            <li key={a.id} className="row" style={{ justifyContent: 'space-between', padding: '8px 0', borderTop: '1px solid var(--border)' }}>
              <div>
                <strong>{a.name}</strong> <span className="badge muted">{a.label}</span> <span className="badge muted">{scopeWord(t, a.visibility)}</span>{' '}
                <span className="badge muted">{a.credentialMode === 'per_user' ? t('accounts.modePerUser') : a.credentialMode === 'shared' ? t('accounts.modeShared') : t('accounts.modeOwner')}</span>
                {a.mailSend?.allowed ? <> <span className="badge warn">{t('accounts.canSendMail')}</span></> : null}
                <div className="muted" style={{ fontSize: 12 }}>
                  {a.status.connected
                    ? (a.status.subject ? t.rich('accounts.connectedAs', { subject: a.status.subject, mono: (c) => <span className="mono">{c}</span> }) : t('accounts.connected'))
                    : t('accounts.notConnected')}
                  {a.status.mailSendGranted === false ? ` · ${t('accounts.mailNotGranted')}` : ''}
                </div>
                {(() => {
                  const n = rowSignInNotice(a, justAddedId, knownRole);
                  return n ? <SignInNoticeBox notice={n} /> : null;
                })()}
                {a.mailSend?.canChange ? (
                  <label className="muted" style={{ fontSize: 12, display: 'block', marginTop: 2 }}>
                    <input type="checkbox" checked={a.mailSend.allowed} onChange={(e) => void toggleMailSend(a.id, e.target.checked)} /> {t('accounts.mailSend')}
                  </label>
                ) : null}
                {a.mailSend?.canChange && a.mailSend.allowed ? <EntraNote role={knownRole} /> : null}
                {a.mailSend?.allowed && (a.mailSend.ungranted ?? 0) > 0 ? (
                  <div className="muted" style={{ fontSize: 12 }}>{t('accounts.ungranted', { count: a.mailSend.ungranted ?? 0 })}</div>
                ) : null}
              </div>
              <div className="row" style={{ gap: 6 }}>
                {a.status.connected && (a.credentialMode === 'per_user' || a.status.canConnect) ? (
                  <button type="button" className="btn ghost sm" onClick={() => void disconnect(a.id)}>{t('accounts.disconnect')}</button>
                ) : null}
                {a.status.canConnect && a.oauthAppConfigured ? (
                  <a className="btn sm" href={connectHref(a.id)}>{a.status.mailSendGranted === false ? t('accounts.reconnectSend') : a.status.connected ? t('accounts.reconnect') : t('accounts.connectYour', { label: a.label })}</a>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
