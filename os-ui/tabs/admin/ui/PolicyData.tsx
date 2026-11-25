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
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useUser } from '@core/ui/useUser';
import { roleAtLeast } from '@core/kernel/session';
import { onEscape, isBackdropClick } from '@core/kernel/overlay-dismiss';
import { sectionMinRole } from '@tabs/admin/lib/sections';
import {
  HISTORY_LABEL, LIST_LABEL, STATE_BADGE, STATE_LABEL, ackFailureMessage, confirmLines, reasonError, syncState,
  type BundleDiff, type PolicyDataView,
} from '@tabs/admin/lib/policy-data-view';

export default function PolicyData() {
  const { user, loading } = useUser();
  const role = user?.role ?? null;
  if (loading || role === null || !roleAtLeast(role, sectionMinRole('policy-data'))) return null;
  return <PolicyDataInner />;
}

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

function PolicyDataInner() {
  const [view, setView] = useState<PolicyDataView | null>(null);
  const [error, setError] = useState('');
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const ackButton = useRef<HTMLButtonElement | null>(null);

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
        setNotice({ kind: 'ok', text: body.compiled ? `Acknowledged. OPA now gets revision ${body.detail}.` : `Acknowledged, but the recompile did not pass: ${body.detail}` });
        setReason('');
        setTouched(false);
      } else {
        const m = ackFailureMessage(res.status, body);
        setNotice({ kind: 'err', text: m.text });
      }
    } catch (e) {
      setNotice({ kind: 'err', text: (e as Error).message });
    } finally {
      setBusy(false);
      setConfirming(false);
      await load();
    }
  }

  if (error && !view) return <div className="error" role="alert">Policy data status could not be read: {error}</div>;
  if (!view) return <p className="muted">Reading policy data status…</p>;

  const state = syncState(view, Date.now(), (s) => new Date(s).toLocaleString());
  const r = view.refused;
  const reasonMsg = reasonError(reason);

  return (
    <div data-testid="policy-data">
      <div className="section-title">Policy data</div>
      <p className="hint">
        The os-data bundle OPA downloads: grants, governance principals and tables, users. A compile that removes more than {view.maxDropPercent} %,
        fewer tables, or an internal table is refused and OPA keeps the last good revision until an admin acknowledges it here.
        A refusal older than {view.refusalAlertMinutes} min is raised in Monitoring and in every admin&apos;s notifications.
      </p>

      <section className="card" style={{ marginBottom: 16 }} aria-labelledby="pd-state">
        <h3 id="pd-state" style={{ marginTop: 0 }}>
          <span className={`badge ${state.kind === 'in-sync' ? 'ok' : state.kind === 'refused' ? 'err' : 'warn'}`} style={{ marginRight: 8 }}>
            {state.kind === 'in-sync' ? 'in sync' : state.kind === 'refused' ? 'refused' : state.kind === 'error' ? 'error' : 'none'}
          </span>
          {state.headline}
        </h3>
        <div role={state.kind === 'refused' ? 'alert' : undefined} className={state.kind === 'refused' ? 'danger-note' : 'muted'}>{state.sub}</div>
        <dl className="row" style={{ gap: 24, marginTop: 12, flexWrap: 'wrap', fontSize: 13 }}>
          <div><dt className="muted">Current revision</dt><dd style={{ margin: 0 }}><code>{view.revision ?? '—'}</code></dd></div>
          <div><dt className="muted">Last update</dt><dd style={{ margin: 0 }}>{fmt(view.compiledAt)}</dd></div>
          <div><dt className="muted">Last checked</dt><dd style={{ margin: 0 }}>{fmt(view.checkedAt)}</dd></div>
        </dl>
      </section>

      {r ? (
        <section className="card" style={{ marginBottom: 16 }} aria-labelledby="pd-refused" data-testid="policy-data-refused">
          <h3 id="pd-refused" style={{ marginTop: 0 }}>Refused update <code style={{ fontSize: 12 }}>{r.hash}</code></h3>
          <p className="muted" style={{ fontSize: 12 }}>Last refused {fmt(r.at)} · threshold {r.maxDropPercent} %</p>
          <ul>{r.reasons.map((x) => <li key={x}>{x}</li>)}</ul>
          {r.baseStats ? (
            <p style={{ fontSize: 13 }}>
              Grant principals {r.baseStats.grants} → {r.stats.grants} · governance principals {r.baseStats.principals} → {r.stats.principals} · tables {r.baseStats.tables} → {r.stats.tables}
            </p>
          ) : null}
          {r.diff ? <DiffLists diff={r.diff} annotations={view.annotations} /> : <p className="muted">The removed items cannot be listed: the baseline holds counts only.</p>}
          {r.diff && !view.directoryAuthoritative ? <p className="muted" style={{ fontSize: 12 }}>User states are not shown: the user directory is not loaded.</p> : null}

          <div style={{ marginTop: 16 }}>
            <label htmlFor="pd-reason" style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>Reason for accepting this update</label>
            <textarea
              id="pd-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              onBlur={() => setTouched(true)}
              rows={2}
              style={{ width: '100%' }}
              aria-invalid={touched && !!reasonMsg}
              aria-describedby="pd-reason-help"
              placeholder="e.g. cohort of trial users archived on purpose (ticket 123)"
            />
            <div id="pd-reason-help" className={touched && reasonMsg ? 'error' : 'muted'} style={{ fontSize: 12 }}>
              {reasonMsg ?? 'Kept in the audit trail with your user id and the content hash.'}
            </div>
            <button
              ref={ackButton}
              className="btn"
              style={{ marginTop: 10 }}
              disabled={!!reasonMsg || busy}
              onClick={() => setConfirming(true)}
              data-testid="policy-data-ack"
            >
              Acknowledge {r.hash}…
            </button>
          </div>
        </section>
      ) : null}

      {notice ? <div className={notice.kind === 'ok' ? 'ok-note' : 'error'} role="status" style={{ marginBottom: 16 }}>{notice.text}</div> : null}

      <section className="card" aria-labelledby="pd-history">
        <h3 id="pd-history" style={{ marginTop: 0 }}>History</h3>
        {view.history.length === 0 ? <p className="muted">No refusal or acknowledgement recorded.</p> : (
          <div className="table-wrap">
            <table data-testid="policy-data-history">
              <thead><tr><th>When</th><th>What</th><th>Who</th><th>Content</th><th>Reason / detail</th></tr></thead>
              <tbody>
                {view.history.map((h, i) => (
                  <tr key={`${h.at}-${i}`}>
                    <td>{fmt(h.at)}</td>
                    <td>{HISTORY_LABEL[h.kind] ?? h.kind}</td>
                    <td>{h.actor}</td>
                    <td><code style={{ fontSize: 11 }}>{h.hash || '—'}</code>{h.counts ? <div className="muted" style={{ fontSize: 11 }}>{h.counts.grants ?? '?'} grants · {h.counts.principals ?? '?'} principals · {h.counts.tables ?? '?'} tables</div> : null}</td>
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
          lines={confirmLines(r, view.annotations)}
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
  return (
    <div>
      {(Object.keys(LIST_LABEL) as (keyof BundleDiff)[]).map((key) => {
        const d = diff[key];
        if (d.removedTotal === 0 && d.addedTotal === 0) return null;
        return (
          <details key={key} open={d.removedTotal > 0} style={{ marginBottom: 8 }}>
            <summary>{LIST_LABEL[key]}: <strong>{d.removedTotal} removed</strong>, {d.addedTotal} added</summary>
            {d.removedTotal > 0 ? (
              <ul aria-label={`${LIST_LABEL[key]} removed`} style={{ fontSize: 13 }}>
                {d.removed.map((id) => (
                  <li key={id}>
                    <code>{id}</code>
                    {annotations[id] ? <span className={`badge ${STATE_BADGE[annotations[id]]}`} style={{ marginLeft: 6 }}>{STATE_LABEL[annotations[id]]}</span> : null}
                  </li>
                ))}
                {d.removedTotal > d.removed.length ? <li className="muted">… and {d.removedTotal - d.removed.length} more</li> : null}
              </ul>
            ) : null}
            {d.addedTotal > 0 ? (
              <p className="muted" style={{ fontSize: 12 }}>
                Added: {d.added.join(', ')}{d.addedTotal > d.added.length ? ` … and ${d.addedTotal - d.added.length} more` : ''}
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
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { cancelRef.current?.focus(); }, []);
  useEffect(() => (busy ? undefined : onEscape(onCancel)), [busy, onCancel]);
  // Keep Tab inside the dialog.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Tab' || !dialogRef.current) return;
    const f = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled])'));
    if (f.length === 0) return;
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
        onKeyDown={onKeyDown}
        onClick={(e) => e.stopPropagation()}
        data-testid="policy-data-confirm"
      >
        <h3 id="pd-confirm-title">Accept this policy data update?</h3>
        <div id="pd-confirm-body">
          <ul style={{ fontSize: 13, maxHeight: 280, overflow: 'auto' }}>{lines.map((l) => <li key={l}>{l}</li>)}</ul>
          <p className="muted" style={{ fontSize: 12 }}>Reason: {reason}</p>
          <div className="danger-note">This is an audited, one-shot override of a safety guard for content <code>{hash}</code> only.</div>
        </div>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 10, marginTop: 14 }}>
          <button ref={cancelRef} className="btn ghost" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="btn" onClick={onConfirm} disabled={busy}>{busy ? <span className="spin" aria-label="Acknowledging" /> : 'Acknowledge'}</button>
        </div>
      </div>
    </div>
  );
}
