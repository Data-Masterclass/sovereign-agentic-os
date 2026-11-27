/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        admin
 * FEATURE:    Platform → Go-live rules (App Builder F) — the global table of who reviews going live in Prod
 * USER STORY: As a platform admin I see, per kind (app, agent) and scope (My, Domain, Company), who must review a
 *             go-live, change a row and save it; I see that nobody ever approves their own go-live (fixed), when and
 *             by whom the table was last changed, and a clear warning when the stored table failed its integrity
 *             check or cannot be read (then every go-live needs an admin).
 * ARCHITECTURE:
 *   - A SHELL over `/api/platform-admin/go-live-rules` (GET, PUT { rules, expectedVersion }); validation, the seal,
 *     the confirmed write and the audit row are in core/policy/go-live-rules-store.ts. The closed sets (kinds,
 *     scopes, reviewers) come from the server's answer, so this file imports no policy module.
 *   - FAIL CLOSED like the other admin sections: the inner component holds every hook and fetch and is mounted only
 *     for a resolved role that clears `sectionMinRole('go-live-rules')`. The Platform strip shows the section only
 *     while the App Builder switch is on; the route refuses with `app_builder_disabled` otherwise.
 *   - Sends the WHOLE table with the version it loaded, so a concurrent change is a 409, never a silent overwrite.
 * I18N:       texts from `admin.goLiveRules.*`. User ids and the server's reason text are shown as they are.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { useFormat, useTranslations } from '@core/i18n/client';
import { useUser } from '@core/ui/useUser';
import { roleAtLeast } from '@core/kernel/session';
import { sectionMinRole } from '@tabs/admin/lib/sections';

type Kind = 'app' | 'agent';
type Scope = 'my' | 'domain' | 'company';
type Reviewer = 'none' | 'builder' | 'domain_admin' | 'admin';
type Rule = { kind: Kind; scope: Scope; reviewer: Reviewer };
type State = {
  rules: Rule[];
  version: number;
  updatedAt: string | null;
  updatedBy: string | null;
  integrity: 'sealed' | 'default' | 'broken' | 'unreachable';
  reason?: string;
  kinds: Kind[];
  scopes: Scope[];
  reviewers: Reviewer[];
};

/** `domain_admin` is a role id; the catalog leaf is camelCase. */
const REVIEWER_KEY: Record<Reviewer, 'none' | 'builder' | 'domainAdmin' | 'admin'> = {
  none: 'none',
  builder: 'builder',
  domain_admin: 'domainAdmin',
  admin: 'admin',
};

export default function GoLiveRules() {
  const { user, loading } = useUser();
  const role = user?.role ?? null;
  if (loading || role === null || !roleAtLeast(role, sectionMinRole('go-live-rules'))) return null;
  return <GoLiveRulesInner />;
}

function GoLiveRulesInner() {
  const t = useTranslations('admin');
  const f = useFormat();
  const [state, setState] = useState<State | null>(null);
  const [draft, setDraft] = useState<Rule[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/platform-admin/go-live-rules', { cache: 'no-store' });
      const body = (await res.json().catch(() => ({}))) as Partial<State> & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setState(body as State);
      setDraft((body.rules ?? []).map((r) => ({ ...r })));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const reviewerOf = (rules: Rule[], kind: Kind, scope: Scope): Reviewer =>
    rules.find((r) => r.kind === kind && r.scope === scope)?.reviewer ?? 'admin';

  function change(kind: Kind, scope: Scope, reviewer: Reviewer) {
    setNotice('');
    setDraft((d) => d.map((r) => (r.kind === kind && r.scope === scope ? { ...r, reviewer } : r)));
  }

  const dirty = state !== null && draft.some((r) => reviewerOf(state.rules, r.kind, r.scope) !== r.reviewer);

  async function save() {
    if (!state) return;
    if (!dirty && state.integrity !== 'broken') { setNotice(t('goLiveRules.noChanges')); return; }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const res = await fetch('/api/platform-admin/go-live-rules', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rules: draft, expectedVersion: state.version }),
      });
      const body = (await res.json().catch(() => ({}))) as Partial<State> & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setState(body as State);
      setDraft((body.rules ?? []).map((r) => ({ ...r })));
      setNotice(t('goLiveRules.saved', { version: body.version ?? 0 }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" style={{ padding: 16 }}>
      <h2 style={{ marginTop: 0 }}>{t('goLiveRules.title')}</h2>
      <p className="hint">{t('goLiveRules.intro')}</p>
      <p><strong>{t('goLiveRules.selfApproval')}</strong></p>

      {state?.integrity === 'broken' && (
        <p className="notice warn" role="alert">{t('goLiveRules.integrityBroken')} {state.reason ?? ''}</p>
      )}
      {state?.integrity === 'unreachable' && (
        <p className="notice warn" role="alert">{t('goLiveRules.integrityUnreachable')} {state.reason ?? ''}</p>
      )}
      {error && <p className="notice error" role="alert">{error}</p>}

      {!state ? (
        !error && <p className="hint">{t('goLiveRules.loading')}</p>
      ) : (
        <>
          <table className="table">
            <thead>
              <tr>
                <th>{t('goLiveRules.colKind')}</th>
                <th>{t('goLiveRules.colScope')}</th>
                <th>{t('goLiveRules.colReviewer')}</th>
              </tr>
            </thead>
            <tbody>
              {state.kinds.flatMap((kind) =>
                state.scopes.map((scope) => (
                  <tr key={`${kind}/${scope}`}>
                    <td>{t(`goLiveRules.kind.${kind}`)}</td>
                    <td>{t(`goLiveRules.scope.${scope}`)}</td>
                    <td>
                      <select
                        value={reviewerOf(draft, kind, scope)}
                        disabled={busy || state.integrity === 'unreachable'}
                        aria-label={t('goLiveRules.reviewerAria', { kind: t(`goLiveRules.kind.${kind}`), scope: t(`goLiveRules.scope.${scope}`) })}
                        onChange={(e) => change(kind, scope, e.target.value as Reviewer)}
                      >
                        {state.reviewers.map((r) => (
                          <option key={r} value={r}>{t(`goLiveRules.reviewer.${REVIEWER_KEY[r]}`)}</option>
                        ))}
                      </select>
                    </td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
          <p className="hint">{t('goLiveRules.agentsNote')}</p>
          <p className="hint">
            {state.version > 0 && state.updatedAt
              ? t('goLiveRules.version', { version: state.version, by: state.updatedBy ?? '', at: f.dateTime(state.updatedAt) })
              : t('goLiveRules.neverSaved')}
          </p>
          <p className="hint">{t('goLiveRules.audit')}</p>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <button type="button" className="btn primary" disabled={busy || state.integrity === 'unreachable'} onClick={() => void save()}>
              {busy ? t('goLiveRules.saving') : t('goLiveRules.save')}
            </button>
            {notice && <span className="hint" role="status">{notice}</span>}
          </div>
        </>
      )}
    </section>
  );
}
