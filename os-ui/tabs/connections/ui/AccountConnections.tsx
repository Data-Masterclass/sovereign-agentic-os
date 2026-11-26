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
 *     /platform/oauth-apps), everyone else is told to ask their admin. The add form warns before adding and
 *     says "Added. Next step: …" after. Wording lives in tabs/connections/lib/sign-in-apps.ts (tested); the
 *     list API sends only per-provider booleans (`signInApps`), never a client id or secret.
 *   - Microsoft 365 has one more switch, "Allow drafting and sending mail" (default off; domain admin or
 *     admin, per-user sign-in only). It is in the add form and on the row; the server checks the role again.
 *     A person whose sign-in predates the switch sees "Reconnect to allow sending".
 */
'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useUser } from '@core/ui/useUser';
import { roleAtLeast } from '@core/kernel/session';
import {
  SIGN_IN_APPS_NAME, SIGN_IN_APPS_HREF, signInProvider, missingSignInAppNotice, addedNotice,
  type SignInAppsStatus, type SignInNotice,
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

const KINDS: { kind: string; label: string; what: string }[] = [
  { kind: 'notion', label: 'Notion', what: 'pages and databases, via Notion\'s official MCP server' },
  { kind: 'microsoft-365', label: 'Microsoft 365', what: 'Outlook mail and calendar, Teams, SharePoint and OneDrive (read); optionally drafting and sending mail, confirmed per message' },
  { kind: 'onedrive', label: 'OneDrive', what: 'your OneDrive files (read)' },
  { kind: 'gdrive', label: 'Google Drive', what: 'your Google Drive files, Docs and Sheets (read)' },
];
const SCOPE_WORD: Record<string, string> = { Personal: 'My', Shared: 'Domain', Certified: 'Company' };

/** Under the switch, once it is on: the Entra prerequisite, with the page that lists the scopes. */
function EntraNote() {
  return (
    <p className="hint" style={{ margin: '2px 0 0 22px' }}>
      Requires Mail.ReadWrite and Mail.Send in your Entra app registration (<Link href={SIGN_IN_APPS_HREF}>{SIGN_IN_APPS_NAME}</Link>)
    </p>
  );
}

/** A visible warning (the warn badge, as a block) with the admin's link when there is one. */
function SignInNoticeBox({ notice }: { notice: SignInNotice }) {
  return (
    <div className="badge warn" role="status" style={{ display: 'block', marginTop: 6, whiteSpace: 'normal', fontSize: 12.5 }}>
      {notice.text}
      {notice.action ? <> <Link className="btn sm" href={notice.action.href} style={{ marginLeft: 6 }}>{notice.action.label}</Link></> : null}
    </div>
  );
}

export function connectHref(connectionId: string, returnTo = '/connections'): string {
  return `/api/connections/connect?connectionId=${encodeURIComponent(connectionId)}&returnTo=${encodeURIComponent(returnTo)}`;
}

export default function AccountConnections() {
  const { user } = useUser();
  const role = user?.role ?? 'creator';
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
  const [added, setAdded] = useState<SignInNotice | null>(null);

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
    setAdded(null);
    try {
      const r = await fetch('/api/connections/accounts', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind, name: name.trim() || undefined, scope, credentialMode: shared ? 'shared' : 'per_user', sharedAcknowledged: shared && ack, allowMailSend: offerMailSend && mailSend }),
      });
      const j = (await r.json()) as { error?: string };
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setAdded(addedNotice(kind, signInApps, role));
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
    <section className="card" aria-label="Accounts for the chat" style={{ marginBottom: 22 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div className="section-title" style={{ marginTop: 0 }}>Accounts for the chat</div>
          <p className="hint">Notion, Microsoft 365, OneDrive and Google Drive in the Home chat. Each person connects their own account; the chat reads only what that account may read.</p>
        </div>
        <button type="button" className="btn" onClick={() => setAdding((v) => !v)}>{adding ? 'Cancel' : '＋ Add connection'}</button>
      </div>

      {adding ? (
        <div className="card" style={{ marginTop: 12 }}>
          <div className="seg" role="radiogroup" aria-label="Service">
            {KINDS.map((k) => (
              <button key={k.kind} type="button" role="radio" aria-checked={kind === k.kind} className={`btn ghost sm${kind === k.kind ? ' is-active' : ''}`} onClick={() => setKind(k.kind)}>{k.label}</button>
            ))}
          </div>
          <p className="hint">{KINDS.find((k) => k.kind === kind)?.what}</p>
          {(() => {
            const p = signInProvider(kind);
            return p && signInApps && !signInApps[p] ? <SignInNoticeBox notice={missingSignInAppNotice(kind, role)} /> : null;
          })()}
          <label className="row" style={{ gap: 8 }}>Name <input value={name} onChange={(e) => setName(e.target.value)} placeholder={KINDS.find((k) => k.kind === kind)?.label} /></label>
          <div className="row" role="radiogroup" aria-label="Who can use it" style={{ gap: 12, marginTop: 8 }}>
            <label><input type="radio" checked={scope === 'my'} onChange={() => setScope('my')} /> Only me (My)</label>
            {canDomain ? <label><input type="radio" checked={scope === 'domain'} onChange={() => setScope('domain')} /> My domain</label> : null}
            {canCompany ? <span className="muted" title="Company-wide visibility ships with the company scope (#333); until then a Company connection is visible in its home domain only.">The whole company: after company scope ships</span> : null}
          </div>
          <p className="hint">Sign-in: <strong>each person connects their own account</strong> (recommended).</p>
          {scope === 'domain' ? (
            <div style={{ marginTop: 6 }}>
              <label><input type="checkbox" checked={shared} onChange={(e) => { setShared(e.target.checked); setAck(false); }} /> Use ONE shared account for everyone instead</label>
              {shared ? (
                <div className="badge warn" role="alert" style={{ display: 'block', marginTop: 6, whiteSpace: 'normal' }}>
                  Everyone in the domain will read and act with the account you connect, including data they could not open themselves. Promoting the connection later turns this off again until you re-confirm.
                  <label style={{ display: 'block', marginTop: 4 }}><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I understand and want a shared credential</label>
                </div>
              ) : null}
            </div>
          ) : null}
          {offerMailSend ? (
            <div style={{ marginTop: 6 }}>
              <label><input type="checkbox" checked={mailSend} onChange={(e) => setMailSend(e.target.checked)} /> Allow drafting and sending mail</label>
              <p className="hint" style={{ margin: '2px 0 0 22px' }}>Off by default. On: each person&apos;s sign-in also asks for Mail.ReadWrite and Mail.Send, and the chat can draft or send a plain-text mail as them, only after they confirmed the full message.</p>
              {mailSend ? <EntraNote /> : null}
            </div>
          ) : null}
          <div className="row" style={{ marginTop: 10 }}>
            <button type="button" className="btn" disabled={busy || (shared && !ack)} onClick={() => void add()}>{busy ? 'Adding…' : 'Add connection'}</button>
          </div>
        </div>
      ) : null}

      {added ? <SignInNoticeBox notice={added} /> : null}
      {error ? <div className="error" role="alert">{error}</div> : null}
      {accounts === null ? <p className="muted"><span className="spin" /> Loading…</p> : accounts.length === 0 ? (
        <p className="muted">No account connections yet.{canDomain ? ' Add one above for your domain.' : ' Ask your domain admin to add one, or add one for yourself.'}</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: '12px 0 0' }}>
          {accounts.map((a) => (
            <li key={a.id} className="row" style={{ justifyContent: 'space-between', padding: '8px 0', borderTop: '1px solid var(--border)' }}>
              <div>
                <strong>{a.name}</strong> <span className="badge muted">{a.label}</span> <span className="badge muted">{SCOPE_WORD[a.visibility] ?? a.visibility}</span>{' '}
                <span className="badge muted">{a.credentialMode === 'per_user' ? 'each person signs in' : a.credentialMode === 'shared' ? 'shared account' : 'owner only'}</span>
                {a.mailSend?.allowed ? <> <span className="badge warn">can draft and send mail (confirmed per message)</span></> : null}
                <div className="muted" style={{ fontSize: 12 }}>
                  {a.status.connected ? <>Connected{a.status.subject ? <> as <span className="mono">{a.status.subject}</span></> : null}</> : 'Not connected'}
                  {a.status.mailSendGranted === false ? ' · your sign-in does not allow sending yet: Reconnect to allow sending' : ''}
                </div>
                {!a.oauthAppConfigured ? <SignInNoticeBox notice={missingSignInAppNotice(a.template, role)} /> : null}
                {a.mailSend?.canChange ? (
                  <label className="muted" style={{ fontSize: 12, display: 'block', marginTop: 2 }}>
                    <input type="checkbox" checked={a.mailSend.allowed} onChange={(e) => void toggleMailSend(a.id, e.target.checked)} /> Allow drafting and sending mail
                  </label>
                ) : null}
                {a.mailSend?.canChange && a.mailSend.allowed ? <EntraNote /> : null}
                {a.mailSend?.allowed && (a.mailSend.ungranted ?? 0) > 0 ? (
                  <div className="muted" style={{ fontSize: 12 }}>{a.mailSend.ungranted} {a.mailSend.ungranted === 1 ? 'person' : 'people'} connected without send permission (they are asked to reconnect before drafting or sending)</div>
                ) : null}
              </div>
              <div className="row" style={{ gap: 6 }}>
                {a.status.connected && (a.credentialMode === 'per_user' || a.status.canConnect) ? (
                  <button type="button" className="btn ghost sm" onClick={() => void disconnect(a.id)}>Disconnect</button>
                ) : null}
                {a.status.canConnect && a.oauthAppConfigured ? (
                  <a className="btn sm" href={connectHref(a.id)}>{a.status.mailSendGranted === false ? 'Reconnect to allow sending' : a.status.connected ? 'Reconnect' : `Connect your ${a.label} account`}</a>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
