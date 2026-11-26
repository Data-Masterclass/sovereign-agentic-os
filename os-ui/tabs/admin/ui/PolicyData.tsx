/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        admin
 * FEATURE:    Platform → Policy data: is OPA on the current policy data, and if a compile was refused,
 *             what it removes — acknowledged here with a reason, after a confirmation naming it all
 * USER STORY: As an admin I want to see without reading logs that a policy-data update was refused,
 *             exactly which users and tables it would remove and why each user is gone, and to accept
 *             it once — or leave OPA on the last good revision.
 * ARCHITECTURE:
 *   - GET/POST /api/platform-admin/opa-bundle (tabs/admin/lib/opa-bundle-admin.ts). All copy and state
 *     derivation is `tabs/admin/lib/policy-data-view.ts`, under test; this component renders it.
 *   - The POST carries the hash the admin was SHOWN. A 409 means the refused content changed: the card
 *     refreshes and asks for a fresh review; nothing was acknowledged.
 *   - The confirmation is an in-page dialog (role="dialog", aria-modal, labelled, Escape closes, focus
 *     moves into it and back to the button), never the browser's own confirm box.
 *   - FAIL-CLOSED gate like every admin section: nothing is mounted or fetched until the role resolves
 *     and clears sectionMinRole('policy-data'). The real gate is the route (admin + OPA).
 *   - I18N:       converted (wave 2) — texts from `admin.policy.*`, built from the view model's codes and parts
 *     (policy-data-view.ts keeps the English). Refusal reasons, history details and server errors render as sent.
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useUser } from '@core/ui/useUser';
import { useTranslations, useFormat } from '@core/i18n/client';
import { roleAtLeast } from '@core/kernel/session';
import { onEscape, isBackdropClick } from '@core/kernel/overlay-dismiss';
import { sectionMinRole } from '@tabs/admin/lib/sections';
import {
  HISTORY_KEY, LIST_KEY, LIST_LABEL, MIN_REASON_LENGTH, STATE_BADGE, STATE_KEY, ackFailureCode, ackFailureMessage, agoMinutes, confirmParts,
  reasonError, syncState,
  type BundleDiff, type ConfirmPart, type PolicyDataView,
} from '@tabs/admin/lib/policy-data-view';

type T = ReturnType<typeof useTranslations<'admin'>>;

export default function PolicyData() {
  const { user, loading } = useUser();
  const role = user?.role ?? null;
  if (loading || role === null || !roleAtLeast(role, sectionMinRole('policy-data'))) return null;
  return <PolicyDataInner />;
}

/** Dates exactly as `toLocaleString()` wrote them in English, in the active language. */
const LEGACY_DT: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' };

/** "(… min)" behind the refused headline, from the view model's minute count. */
function agoText(iso: string, nowMs: number, t: T): string {
  const min = agoMinutes(iso, nowMs);
  if (min < 1) return t('policy.ago.lessThanMinute');
  if (min < 120) return t('policy.ago.minutes', { min });
  return t('policy.ago.hours', { h: Math.floor(min / 60), m: min % 60 });
}

/** One confirmation line, translated from `confirmParts` (policy-data-view.ts writes the English). */
function partText(p: ConfirmPart, t: T): string {
  switch (p.kind) {
    case 'served': return t('policy.confirm.served', { hash: p.hash });
    case 'noDiff': return t('policy.confirm.noDiff');
    case 'counts': return t('policy.confirm.counts', { g0: p.base.grants, g1: p.now.grants, p0: p.base.principals, p1: p.now.principals, t0: p.base.tables, t1: p.now.tables });
    case 'nothingRemoved': return t('policy.confirm.nothingRemoved');
    case 'list': {
      const items = p.shown.map((x) => (x.state ? t('policy.confirm.itemState', { id: x.id, state: t(`policy.principalState.${STATE_KEY[x.state]}`) }) : x.id)).join(', ');
      const label = t(`policy.list.${LIST_KEY[p.list]}`);
      return p.more > 0
        ? t('policy.confirm.listMore', { label, removed: p.removedTotal, items, more: p.more })
        : t('policy.confirm.list', { label, removed: p.removedTotal, items });
    }
  }
}

function PolicyDataInner() {
  const t = useTranslations('admin');
  const f = useFormat();
  const fmt = (iso: string | null) => (iso ? f.dateTime(iso, LEGACY_DT) : '—');
  const [view, setView] = useState<PolicyDataView | null>(null);
  const [error, setError] = useState('');
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const ackButton = useRef<HTMLButtonElement | null>(null);
  const noticeRef = useRef<HTMLDivElement | null>(null);
  const stateHeading = useRef<HTMLHeadingElement | null>(null);

  // After an acknowledgement attempt the dialog and (on success) the Acknowledge button are gone:
  // focus moves to the outcome message, else to the state heading, never to <body>.
  useEffect(() => {
    if (!notice) return;
    (noticeRef.current ?? stateHeading.current)?.focus();
  }, [notice]);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/platform-admin/opa-bundle', { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) { setError(body.error ?? `HTTP ${res.status}`); return; }
      setError('');
      setView(body as PolicyDataView);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const closeConfirm = useCallback(() => {
    setConfirming(false);
    ackButton.current?.focus();
  }, []);

  async function acknowledge(hash: string) {
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch('/api/platform-admin/opa-bundle', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hash, reason: reason.trim() }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        setNotice({ kind: 'ok', text: body.compiled ? t('policy.ackOk', { detail: String(body.detail) }) : t('policy.ackOkNotCompiled', { detail: String(body.detail) }) });
        setReason('');
        setTouched(false);
      } else {
        // The server's own error text renders as sent; the card's own sentences are the catalog's.
        const m = ackFailureMessage(res.status, body);
        const code = ackFailureCode(res.status, body);
        const text = code === 'not-refused' ? t('policy.ackFail.notRefused')
          : code === 'changed' ? t('policy.ackFail.changed')
            : code === 'forbidden' ? t('policy.ackFail.forbidden')
              : code === 'server' ? m.text
                : t('policy.ackFail.http', { status: res.status });
        setNotice({ kind: 'err', text });
      }
    } catch (e) {
      setNotice({ kind: 'err', text: (e as Error).message });
    } finally {
      setBusy(false);
      setConfirming(false);
      await load();
    }
  }

  if (error && !view) return <div className="error" role="alert">{t('policy.readFailed', { error })}</div>;
  if (!view) return <p className="muted">{t('policy.reading')}</p>;

  // The kind comes from the view model; the words are the catalog's.
  const kind = syncState(view, Date.now()).kind;
  const now = Date.now();
  const state = view.refused
    ? { kind, headline: t('policy.sync.refusedHeadline', { since: fmt(view.refused.since), ago: agoText(view.refused.since, now, t) }), sub: t('policy.sync.refusedSub', { revision: view.revision ?? t('policy.sync.noRevision') }) }
    : !view.revision
      ? { kind, headline: t('policy.sync.noneHeadline'), sub: view.lastError ? t('policy.sync.noneSubFailed', { error: view.lastError }) : t('policy.sync.noneSub') }
      : view.lastError
        ? { kind, headline: t('policy.sync.errorHeadline'), sub: t('policy.sync.errorSub', { revision: view.revision, error: view.lastError }) }
        : { kind, headline: t('policy.sync.inSyncHeadline'), sub: t('policy.sync.inSyncSub', { revision: view.revision }) };
  const r = view.refused;
  const reasonMsg = reasonError(reason) ? t('policy.reasonTooShort', { min: MIN_REASON_LENGTH, n: reason.trim().length }) : null;

  return (
    <div data-testid="policy-data">
      <div className="section-title">{t('policy.title')}</div>
      <p className="hint">
        {t('policy.hint', { pct: view.maxDropPercent, minutes: view.refusalAlertMinutes })}
      </p>

      <section className="card" style={{ marginBottom: 16 }} aria-labelledby="pd-state">
        <h3 id="pd-state" ref={stateHeading} tabIndex={-1} style={{ marginTop: 0 }}>
          <span className={`badge ${state.kind === 'in-sync' ? 'ok' : state.kind === 'refused' ? 'err' : 'warn'}`} style={{ marginRight: 8 }}>
            {state.kind === 'in-sync' ? t('policy.badge.inSync') : state.kind === 'refused' ? t('policy.badge.refused') : state.kind === 'error' ? t('policy.badge.error') : t('policy.badge.none')}
          </span>
          {state.headline}
        </h3>
        <div role={state.kind === 'refused' ? 'alert' : undefined} className={state.kind === 'refused' ? 'danger-note' : 'muted'}>{state.sub}</div>
        <dl className="row" style={{ gap: 24, marginTop: 12, flexWrap: 'wrap', fontSize: 13 }}>
          <div><dt className="muted">{t('policy.currentRevision')}</dt><dd style={{ margin: 0 }}><code>{view.revision ?? '—'}</code></dd></div>
          <div><dt className="muted">{t('policy.lastUpdate')}</dt><dd style={{ margin: 0 }}>{fmt(view.compiledAt)}</dd></div>
          <div><dt className="muted">{t('policy.lastChecked')}</dt><dd style={{ margin: 0 }}>{fmt(view.checkedAt)}</dd></div>
        </dl>
      </section>

      {r ? (
        <section className="card" style={{ marginBottom: 16 }} aria-labelledby="pd-refused" data-testid="policy-data-refused">
          <h3 id="pd-refused" style={{ marginTop: 0 }}>{t('policy.refusedTitle')} <code style={{ fontSize: 12 }}>{r.hash}</code></h3>
          <p className="muted" style={{ fontSize: 12 }}>{t('policy.refusedMeta', { at: fmt(r.at), pct: r.maxDropPercent })}</p>
          <ul>{r.reasons.map((x) => <li key={x}>{x}</li>)}</ul>
          {r.baseStats ? (
            <p style={{ fontSize: 13 }}>
              {t('policy.statsLine', { g0: r.baseStats.grants, g1: r.stats.grants, p0: r.baseStats.principals, p1: r.stats.principals, t0: r.baseStats.tables, t1: r.stats.tables })}
            </p>
          ) : null}
          {r.diff ? <DiffLists diff={r.diff} annotations={view.annotations} /> : <p className="muted">{t('policy.noDiff')}</p>}
          {r.diff && !view.directoryAuthoritative ? <p className="muted" style={{ fontSize: 12 }}>{t('policy.noDirectory')}</p> : null}

          <div style={{ marginTop: 16 }}>
            <label htmlFor="pd-reason" style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>{t('policy.reasonLabel')}</label>
            <textarea
              id="pd-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              onBlur={() => setTouched(true)}
              rows={2}
              style={{ width: '100%' }}
              aria-invalid={touched && !!reasonMsg}
              aria-describedby="pd-reason-help"
              placeholder={t('policy.reasonPlaceholder')}
            />
            <div id="pd-reason-help" className={touched && reasonMsg ? 'error' : 'muted'} style={{ fontSize: 12 }}>
              {reasonMsg ?? t('policy.reasonHelp')}
            </div>
            <button
              ref={ackButton}
              className="btn"
              style={{ marginTop: 10 }}
              disabled={!!reasonMsg || busy}
              onClick={() => setConfirming(true)}
              data-testid="policy-data-ack"
            >
              {t('policy.ackButton', { hash: r.hash })}
            </button>
          </div>
        </section>
      ) : null}

      {notice ? <div ref={noticeRef} tabIndex={-1} className={notice.kind === 'ok' ? 'ok-note' : 'error'} role="status" style={{ marginBottom: 16 }}>{notice.text}</div> : null}

      <section className="card" aria-labelledby="pd-history">
        <h3 id="pd-history" style={{ marginTop: 0 }}>{t('policy.historyTitle')}</h3>
        {view.history.length === 0 ? <p className="muted">{t('policy.historyNone')}</p> : (
          <div className="table-wrap">
            <table data-testid="policy-data-history">
              <thead><tr><th>{t('policy.historyCol.when')}</th><th>{t('policy.historyCol.what')}</th><th>{t('policy.historyCol.who')}</th><th>{t('policy.historyCol.content')}</th><th>{t('policy.historyCol.reason')}</th></tr></thead>
              <tbody>
                {view.history.map((h, i) => (
                  <tr key={`${h.at}-${i}`}>
                    <td>{fmt(h.at)}</td>
                    <td>{HISTORY_KEY[h.kind] ? t(`policy.history.${HISTORY_KEY[h.kind]}`) : h.kind}</td>
                    <td>{h.actor}</td>
                    <td><code style={{ fontSize: 11 }}>{h.hash || '—'}</code>{h.counts ? <div className="muted" style={{ fontSize: 11 }}>{t('policy.historyCounts', { grants: String(h.counts.grants ?? '?'), principals: String(h.counts.principals ?? '?'), tables: String(h.counts.tables ?? '?') })}</div> : null}</td>
                    <td style={{ fontSize: 12 }}>{h.reason || h.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {confirming && r ? (
        <ConfirmAck
          lines={confirmParts(r, view.annotations).map((p) => partText(p, t))}
          hash={r.hash}
          reason={reason.trim()}
          busy={busy}
          onCancel={closeConfirm}
          onConfirm={() => void acknowledge(r.hash)}
        />
      ) : null}
    </div>
  );
}

function DiffLists({ diff, annotations }: { diff: BundleDiff; annotations: PolicyDataView['annotations'] }) {
  const t = useTranslations('admin');
  return (
    <div>
      {(Object.keys(LIST_LABEL) as (keyof BundleDiff)[]).map((key) => {
        const d = diff[key];
        if (d.removedTotal === 0 && d.addedTotal === 0) return null;
        return (
          <details key={key} open={d.removedTotal > 0} style={{ marginBottom: 8 }}>
            <summary>{t.rich('policy.diffSummary', { label: t(`policy.list.${LIST_KEY[key]}`), removed: d.removedTotal, added: d.addedTotal, strong: (c) => <strong>{c}</strong> })}</summary>
            {d.removedTotal > 0 ? (
              <ul aria-label={t('policy.diffRemovedAria', { label: t(`policy.list.${LIST_KEY[key]}`) })} style={{ fontSize: 13 }}>
                {d.removed.map((id) => (
                  <li key={id}>
                    <code>{id}</code>
                    {annotations[id] ? <span className={`badge ${STATE_BADGE[annotations[id]]}`} style={{ marginLeft: 6 }}>{t(`policy.principalState.${STATE_KEY[annotations[id]]}`)}</span> : null}
                  </li>
                ))}
                {d.removedTotal > d.removed.length ? <li className="muted">{t('policy.andMore', { count: d.removedTotal - d.removed.length })}</li> : null}
              </ul>
            ) : null}
            {d.addedTotal > 0 ? (
              <p className="muted" style={{ fontSize: 12 }}>
                {d.addedTotal > d.added.length
                  ? t('policy.addedMore', { list: d.added.join(', '), count: d.addedTotal - d.added.length })
                  : t('policy.added', { list: d.added.join(', ') })}
              </p>
            ) : null}
          </details>
        );
      })}
    </div>
  );
}

function ConfirmAck({ lines, hash, reason, busy, onCancel, onConfirm }: {
  lines: string[]; hash: string; reason: string; busy: boolean; onCancel: () => void; onConfirm: () => void;
}) {
  const t = useTranslations('admin');
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { cancelRef.current?.focus(); }, []);
  // While the request runs both buttons are disabled (an in-flight acknowledgement cannot be taken
  // back): focus stays IN the dialog, on its container, rather than falling to <body>.
  useEffect(() => { if (busy) dialogRef.current?.focus(); }, [busy]);
  useEffect(() => (busy ? undefined : onEscape(onCancel)), [busy, onCancel]);
  // Keep Tab inside the dialog.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Tab' || !dialogRef.current) return;
    const f = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled])'));
    if (f.length === 0) { e.preventDefault(); dialogRef.current.focus(); return; }
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  return (
    <div className="pa-confirm-backdrop" onClick={(e) => { if (isBackdropClick(e.target, e.currentTarget) && !busy) onCancel(); }}>
      <div
        className="pa-confirm"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pd-confirm-title"
        aria-describedby="pd-confirm-body"
        ref={dialogRef}
        tabIndex={-1}
        aria-busy={busy}
        onKeyDown={onKeyDown}
        onClick={(e) => e.stopPropagation()}
        data-testid="policy-data-confirm"
      >
        <h3 id="pd-confirm-title">{t('policy.confirm.title')}</h3>
        <div id="pd-confirm-body">
          <ul style={{ fontSize: 13, maxHeight: 280, overflow: 'auto' }}>{lines.map((l) => <li key={l}>{l}</li>)}</ul>
          <p className="muted" style={{ fontSize: 12 }}>{t('policy.confirm.reason', { reason })}</p>
          <div className="danger-note">{t.rich('policy.confirm.danger', { hash, code: (c) => <code>{c}</code> })}</div>
        </div>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 10, marginTop: 14 }}>
          <button ref={cancelRef} className="btn ghost" onClick={onCancel} disabled={busy}>{t('policy.confirm.cancel')}</button>
          <button className="btn" onClick={onConfirm} disabled={busy}>{busy ? <span className="spin" role="status" aria-label={t('policy.confirm.acknowledgingAria')} /> : t('policy.confirm.acknowledge')}</button>
        </div>
      </div>
    </div>
  );
}
