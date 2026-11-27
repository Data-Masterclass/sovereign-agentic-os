/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useMemo, useState } from 'react';
import { useTranslations, useFormat, useServerMessage } from '@core/i18n/client';
import {
  acceptedCount,
  decisionsToFixes,
  type RowDecision,
  type RowFix,
} from '@tabs/data/lib/dq-fix';

/**
 * AI-PROPOSED REMEDIATIONS for ONE failing quality rule (Validate stage).
 *
 * The flow the user sees — complexity hidden behind three calm moments:
 *   1. "Propose fixes" → the rule re-runs, failing rows appear (honest "showing N
 *      of M"), and the assistant proposes EITHER one batch transform (with a real
 *      before→after preview and a MEASURED "fixes all/some"), OR per-row values in
 *      a table the user walks row by row (Accept · edit inline · Skip), OR an
 *      honest "needs a structural fix" diagnosis.
 *   2. The top bar holds the two promised controls: "Apply AI recommendations"
 *      (accept everything the AI proposed) and "Apply N accepted changes" (execute
 *      exactly what was accepted/edited — nothing more).
 *   3. After apply the rule is RE-RUN server-side and the fresh verdict shows — a
 *      fix that didn't fix stays red. The audit line carries the remediation batch
 *      id + pre-apply snapshot id (revert via Console — stated honestly).
 *
 * Assistant offline ⇒ a calm note; the failing rows still show and manual per-row
 * fixes still work when the dataset declares a key column. Nothing EVER applies
 * without an explicit click on an Apply button.
 */

// ---- local mirrors of the server contracts (house style: mirrors lib/data/dq-fix-server) --
type CheckResultLite = { id: string; label: string; status: 'pass' | 'fail' | 'not_run'; violations: number | null; reason?: string };
type BatchProposal = { kind: 'batch'; sqlExpr: string; rationale: string; estimatedFix?: 'all' | 'partial' };
type RowsProposal = { kind: 'rows'; fixes: RowFix[]; rationale?: string };
type NoneProposal = { kind: 'none'; diagnosis: string };
type Proposal = BatchProposal | RowsProposal | NoneProposal;
type Envelope = {
  checkId: string;
  label: string;
  status: 'pass' | 'fail' | 'not_run';
  violations: number | null;
  reason?: string;
  sample: { columns: string[]; rows: string[][]; showing: number; total: number } | null;
  proposal: Proposal | null;
  preview: { changes: number; residual: number | null; estimatedFix: 'all' | 'partial' | null; pairs: { before: string; after: string }[] } | null;
  rowsEligible: boolean;
  rowsIneligibleReason?: string;
  pkColumn?: string;
  offline: boolean;
  offlineReason?: string;
  proposalReason?: string;
};
type ApplyOutcome = {
  rowsChanged: number | null;
  recheck: CheckResultLite;
  remediation: { batchId: string; snapshotIdBefore: string | null; fqn: string } | null;
};

export default function QualityFixPanel({
  datasetId,
  checkId,
  column,
  canEdit,
  onApplied,
}: {
  datasetId: string;
  checkId: string;
  /** The checked column (for the offending-value column of the table). */
  column: string;
  canEdit: boolean;
  onApplied: (recheck: CheckResultLite) => void;
}) {
  const t = useTranslations('data');
  const serverMsg = useServerMessage();
  const f = useFormat();
  const [busy, setBusy] = useState<'' | 'propose' | 'apply'>('');
  const [err, setErr] = useState('');
  const [env, setEnv] = useState<Envelope | null>(null);
  const [decisions, setDecisions] = useState<Record<string, RowDecision | undefined>>({});
  const [outcome, setOutcome] = useState<ApplyOutcome | null>(null);

  const propose = useCallback(async () => {
    setBusy('propose'); setErr(''); setOutcome(null); setDecisions({});
    try {
      const res = await fetch(`/api/data/datasets/${datasetId}/dq/propose`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ checkId }),
      });
      const data = await res.json();
      if (!res.ok) { setErr(serverMsg(data, t('qualityFix.analyzeFailed'))); return; }
      setEnv(data as Envelope);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(''); }
  }, [datasetId, checkId, t]);

  // The row-fix working set: the AI's fixes, or — with no proposal but a declared key
  // (e.g. assistant offline) — the failing sample itself, editable by hand.
  const rowFixes: RowFix[] = useMemo(() => {
    if (env?.proposal?.kind === 'rows') return env.proposal.fixes;
    if (env && env.rowsEligible && env.pkColumn && env.sample && (!env.proposal || env.proposal.kind === 'none')) {
      const pkIdx = env.sample.columns.findIndex((c) => c.toLowerCase() === env.pkColumn!.toLowerCase());
      const colIdx = env.sample.columns.findIndex((c) => c.toLowerCase() === column.toLowerCase());
      if (pkIdx < 0 || colIdx < 0) return [];
      return env.sample.rows.map((r) => ({
        pk: r[pkIdx] ?? '', column, current: r[colIdx] ?? '', proposed: r[colIdx] ?? '',
      })).filter((f) => f.pk.length > 0);
    }
    return [];
  }, [env, column]);

  const manualOnly = rowFixes.length > 0 && env?.proposal?.kind !== 'rows';
  const accepted = acceptedCount(decisions);

  const apply = useCallback(async (payload: { mode: 'batch'; sqlExpr: string } | { mode: 'rows'; fixes: { pk: string; proposed: string }[] }) => {
    setBusy('apply'); setErr('');
    try {
      const res = await fetch(`/api/data/datasets/${datasetId}/dq/apply`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ checkId, ...payload }),
      });
      const data = await res.json();
      if (!res.ok) { setErr(serverMsg(data, t('qualityFix.applyFailed'))); return; }
      const out = data as ApplyOutcome;
      setOutcome(out);
      onApplied(out.recheck);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(''); }
  }, [datasetId, checkId, onApplied, t]);

  const applyBatch = useCallback(() => {
    if (env?.proposal?.kind === 'batch') void apply({ mode: 'batch', sqlExpr: env.proposal.sqlExpr });
  }, [env, apply]);

  const applyAccepted = useCallback(() => {
    const fixes = decisionsToFixes(rowFixes, decisions);
    if (fixes.length > 0) void apply({ mode: 'rows', fixes });
  }, [rowFixes, decisions, apply]);

  const acceptAllRows = useCallback(() => {
    const next: Record<string, RowDecision> = {};
    for (const f of rowFixes) next[f.pk] = { kind: 'accept' };
    setDecisions(next);
  }, [rowFixes]);

  // ------------------------------------------------------------------ render --

  if (!env) {
    return (
      <div style={{ padding: '10px 0 6px' }}>
        {err ? <div className="error" style={{ marginBottom: 8 }}>{err}</div> : null}
        <div className="row" style={{ gap: 10, alignItems: 'center' }}>
          <button className="btn sm" onClick={propose} disabled={busy !== ''}>
            {busy === 'propose' ? <span className="spin" /> : t('qualityFix.propose')}
          </button>
          <span className="hint" style={{ margin: 0 }}>
            {t('qualityFix.nothingChanged')}
          </span>
        </div>
      </div>
    );
  }

  if (env.status === 'pass') {
    return <p className="ok-note" style={{ fontSize: 12.5, margin: '8px 0' }}>{t('qualityFix.passesNow')}</p>;
  }
  if (env.status === 'not_run') {
    return <p className="muted" style={{ fontSize: 12.5, margin: '8px 0' }}>{env.reason ?? t('qualityFix.couldNotRun')}</p>;
  }

  const p = env.proposal;
  const batch = p?.kind === 'batch' ? p : null;
  const showRowsTable = rowFixes.length > 0;

  return (
    <div style={{ padding: '10px 0 6px' }}>
      {err ? <div className="error" style={{ marginBottom: 8 }}>{err}</div> : null}

      {/* ── TOP BAR — the two promised controls + honest counts ── */}
      <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>
          {t('qualityFix.failingRows', { count: env.violations ?? 0 })}
        </span>
        {env.sample && env.sample.showing < env.sample.total ? (
          <span className="muted" style={{ fontSize: 12 }}>{t('qualityFix.showing', { showing: env.sample.showing, total: env.sample.total })}</span>
        ) : null}
        {canEdit && batch ? (
          <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={applyBatch} disabled={busy !== '' || !!outcome}>
            {busy === 'apply' ? <span className="spin" /> : t('qualityFix.applyRecommendation')}
          </button>
        ) : null}
        {canEdit && showRowsTable && !batch ? (
          <>
            {p?.kind === 'rows' ? (
              <button className="btn ghost sm" style={{ marginLeft: 'auto' }} onClick={acceptAllRows} disabled={busy !== '' || !!outcome}>
                {t('qualityFix.applyRecommendations')}
              </button>
            ) : <span style={{ marginLeft: 'auto' }} />}
            <button className="btn sm" onClick={applyAccepted} disabled={busy !== '' || accepted === 0 || !!outcome}>
              {busy === 'apply' ? <span className="spin" /> : t('qualityFix.applyAccepted', { count: accepted })}
            </button>
          </>
        ) : null}
        <button className="btn ghost sm" onClick={propose} disabled={busy !== ''} title={t('qualityFix.rerunTitle')}>↻</button>
      </div>

      {/* ── assistant offline — calm, honest; manual path stays open ── */}
      {env.offline ? (
        <p className="muted" style={{ fontSize: 12.5, margin: '0 0 10px' }}>
          {t(showRowsTable ? 'qualityFix.offlineManual' : 'qualityFix.offline', { reason: env.offlineReason ?? t('qualityFix.offlineReasonDefault') })}
        </p>
      ) : null}
      {env.proposalReason ? (
        <p className="muted" style={{ fontSize: 12.5, margin: '0 0 10px' }}>{env.proposalReason}</p>
      ) : null}

      {/* ── kind:none — the honest structural-fix label + diagnosis ── */}
      {p?.kind === 'none' ? (
        <p style={{ fontSize: 13, margin: '0 0 10px' }}>
          <span className="badge vis-personal" style={{ marginRight: 8 }}>{t('qualityFix.structural')}</span>
          <span className="muted">{p.diagnosis}</span>
        </p>
      ) : null}

      {/* ── batch proposal — one class, one decision, measured honestly ── */}
      {batch ? (
        <div style={{ marginBottom: 12 }}>
          <p style={{ fontSize: 13, margin: '0 0 6px' }}>
            {t.rich('qualityFix.recommendation', { column, expr: batch.sqlExpr, code: (c) => <code className="mono">{c}</code> })}
          </p>
          <p className="muted" style={{ fontSize: 12.5, margin: '0 0 8px' }}>
            {batch.rationale}
            {env.preview ? (
              env.preview.residual === 0
                ? t('qualityFix.fixesAll', { count: f.number(env.preview.changes) })
                : t('qualityFix.fixesSome', { fixed: f.number(env.preview.changes - (env.preview.residual ?? 0)), total: f.number(env.preview.changes), residual: env.preview.residual === null ? String(null) : f.number(env.preview.residual) })
            ) : null}
          </p>
          {env.preview && env.preview.pairs.length > 0 ? (
            <div className="table-wrap">
              <table>
                <thead><tr><th>{t('qualityFix.col.current')}</th><th>{t('qualityFix.col.proposed')}</th></tr></thead>
                <tbody>
                  {env.preview.pairs.map((pr, i) => (
                    <tr key={i}>
                      <td className="mono" style={{ fontSize: 12 }}>{pr.before || '∅'}</td>
                      <td className="mono" style={{ fontSize: 12, color: 'var(--ok, #2e9e6b)' }}>{pr.after || '∅'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* ── per-row problems table — Accept · edit inline · Skip ── */}
      {showRowsTable ? (
        <div className="table-wrap" style={{ marginBottom: 10 }}>
          <table>
            <thead>
              <tr>
                <th>{env.pkColumn ?? t('qualityFix.col.row')}</th>
                <th>{t('qualityFix.col.currentOf', { column })}</th>
                <th>{manualOnly ? t('qualityFix.col.yourValue') : t('qualityFix.col.aiProposed')}</th>
                {canEdit ? <th style={{ width: 170 }} /> : null}
              </tr>
            </thead>
            <tbody>
              {rowFixes.map((fx) => {
                const d = decisions[fx.pk];
                const editing = d?.kind === 'edit';
                const isAccepted = !!d && d.kind !== 'skip';
                return (
                  <tr key={fx.pk} style={d?.kind === 'skip' ? { opacity: 0.45 } : undefined}>
                    <td className="mono" style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{fx.pk}</td>
                    <td className="mono" style={{ fontSize: 12 }}>{fx.current || '∅'}</td>
                    <td title={fx.rationale}>
                      {editing ? (
                        <input
                          className="mono"
                          style={{ fontSize: 12, width: '100%', minWidth: 90 }}
                          value={d.kind === 'edit' ? d.value : fx.proposed}
                          autoFocus
                          onChange={(e) => setDecisions((m) => ({ ...m, [fx.pk]: { kind: 'edit', value: e.target.value } }))}
                        />
                      ) : (
                        <span className="mono" style={{ fontSize: 12, color: isAccepted ? 'var(--ok, #2e9e6b)' : undefined }}>
                          {fx.proposed || '∅'}
                          {fx.rationale ? <span className="muted" style={{ marginLeft: 6, fontSize: 11 }} title={fx.rationale}>ⓘ</span> : null}
                        </span>
                      )}
                    </td>
                    {canEdit ? (
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <button
                          className="btn ghost sm"
                          aria-pressed={isAccepted && !editing}
                          style={isAccepted && !editing ? { fontWeight: 600 } : undefined}
                          onClick={() => setDecisions((m) => ({ ...m, [fx.pk]: { kind: 'accept' } }))}
                          disabled={busy !== '' || !!outcome}
                        >
                          {isAccepted && !editing ? t('qualityFix.accepted') : t('qualityFix.accept')}
                        </button>
                        <button
                          className="btn ghost sm"
                          onClick={() => setDecisions((m) => ({ ...m, [fx.pk]: { kind: 'edit', value: d?.kind === 'edit' ? d.value : fx.proposed } }))}
                          disabled={busy !== '' || !!outcome}
                        >
                          {t('qualityFix.edit')}
                        </button>
                        <button
                          className="btn ghost sm"
                          onClick={() => setDecisions((m) => ({ ...m, [fx.pk]: { kind: 'skip' } }))}
                          disabled={busy !== '' || !!outcome}
                        >
                          {t('qualityFix.skip')}
                        </button>
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {/* rows-mode unavailable — the one-line hint that unlocks it */}
      {!showRowsTable && !batch && p?.kind !== 'none' && env.rowsIneligibleReason ? (
        <p className="muted" style={{ fontSize: 12.5, margin: '0 0 10px' }}>{env.rowsIneligibleReason}</p>
      ) : null}

      {/* ── outcome — the REAL re-check + the honest revert line ── */}
      {outcome ? (
        <div style={{ marginTop: 4 }}>
          {outcome.recheck.status === 'pass' ? (
            <p className="ok-note" style={{ fontSize: 13, margin: '0 0 4px' }}>
              {typeof outcome.rowsChanged === 'number'
                ? t('qualityFix.outcome.passedRows', { rows: outcome.rowsChanged })
                : t('qualityFix.outcome.passed')}
            </p>
          ) : outcome.recheck.status === 'fail' ? (
            <p style={{ fontSize: 13, margin: '0 0 4px', color: 'var(--danger, #d64545)' }}>
              {typeof outcome.rowsChanged === 'number'
                ? t('qualityFix.outcome.failedRows', { rows: outcome.rowsChanged, count: outcome.recheck.violations ?? 0 })
                : t('qualityFix.outcome.failed', { count: outcome.recheck.violations ?? 0 })}
            </p>
          ) : (
            <p className="muted" style={{ fontSize: 13, margin: '0 0 4px' }}>{t('qualityFix.outcome.notRun', { reason: outcome.recheck.reason ?? '' })}</p>
          )}
          {outcome.remediation ? (
            <p className="muted" style={{ fontSize: 12, margin: 0 }}>
              {outcome.remediation.snapshotIdBefore
                ? t.rich('qualityFix.remediation.withSnapshot', {
                    batchId: outcome.remediation.batchId,
                    snapshot: outcome.remediation.snapshotIdBefore,
                    call: `CALL iceberg.system.rollback_to_snapshot('${outcome.remediation.fqn.split('.')[1]}', '${outcome.remediation.fqn.split('.')[2]}', ${outcome.remediation.snapshotIdBefore})`,
                    code: (c) => <code className="mono" style={{ fontSize: 11 }}>{c}</code>,
                  })
                : t.rich('qualityFix.remediation.noSnapshot', {
                    batchId: outcome.remediation.batchId,
                    code: (c) => <code className="mono" style={{ fontSize: 11 }}>{c}</code>,
                  })}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
