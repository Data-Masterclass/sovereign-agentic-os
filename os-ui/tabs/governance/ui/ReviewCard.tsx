/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Deploy review card — security scan, requested resources, footprint and diff for one deploy
 * USER STORY: As a builder reviewing a software deploy I want the scan result, the governed resources and
 *             cost asked for, and the change diff on one card with approve/deny, so that I decide on facts.
 * ARCHITECTURE:
 *   - Presentation only; the role gate and the scan gate are enforced server-side (`scanGate` in
 *     `tabs/software/lib/review.ts`, `decideDeploy`). This card only avoids offering a press the
 *     server would refuse.
 *   - Used by `tabs/software/ui/SoftwareBuilder.tsx` and the `app/(experimental)/software` review pages.
 *   - Three scan states: passed, failed, and no verdict. Only an admin, with a written reason, may
 *     approve without a verdict (`canAcknowledgeNoScan`).
 */
'use client';

import { useState } from 'react';
import { useTranslations, useFormat } from '@core/i18n/client';

type Severity = 'info' | 'low' | 'medium' | 'high' | 'critical';
type Finding = { category: 'sast' | 'deps' | 'secrets'; severity: Severity; title: string; detail: string; path?: string };
export type ReviewCardData = {
  id: string;
  appId: string;
  appName: string;
  domain: string;
  requestedBy: string;
  requestedAt: string;
  reason: 'first-deploy' | 'scope-broadened';
  // `unavailable` + `reason` are the THIRD scan state (review M1, 2026-11-18): no scanner engine
  // ran, so there is no verdict — distinct from a verdict of "failed". Optional, so a card
  // serialised before this existed still renders.
  scan: {
    passed: boolean;
    summary: { sast: number; deps: number; secrets: number };
    findings: Finding[];
    scannedAt: string;
    unavailable?: boolean;
    reason?: string;
    /** `findings` is a capped view; `summary` and `passed` still count them all. */
    truncated?: boolean;
    /** A blocking finding exists that the cap left out of `findings`. */
    blockingBeyondCap?: boolean;
    /** Which engine answered, when one did (e.g. `trivy (aquasec/trivy:0.58.2)`). */
    engine?: string;
    /** Categories NO engine covered — rendered as "not run", never as a clean zero. */
    notRun?: ('sast' | 'deps' | 'secrets')[];
  };
  requested: {
    writeTools: string[];
    connections: string[];
    data: string[];
    knowledge: string[];
    footprint: { cpu: string; memory: string; estMonthlyUsd: number };
  };
  diff: { files: { path: string; added: number; removed: number }[]; added: number; removed: number };
  /** Non-blocking review warnings (e.g. references to ungranted datasets). */
  warnings?: string[];
  decision: 'pending' | 'approved' | 'denied';
  decidedBy?: string;
  note?: string;
  /** Set when an admin approved this deploy while there was NO security verdict. */
  approvedWithoutScan?: boolean;
  /** Set when an admin approved it on a scan that RAN but could not cover these categories. */
  approvedWithUncoveredCategories?: ('sast' | 'deps' | 'secrets')[];
  noScanReason?: string;
};

function sevClass(s: Severity): string {
  if (s === 'critical' || s === 'high') return 'badge err';
  if (s === 'medium') return 'badge warn';
  return 'badge muted';
}

const SEVERITY_KEYS = {
  info: 'review.severity.info', low: 'review.severity.low', medium: 'review.severity.medium', high: 'review.severity.high', critical: 'review.severity.critical',
} as const;

/** `label` already carries its colon (it is a translated "connections:"), so French can space it. */
function Chips({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div style={{ marginTop: 6 }}>
      <span className="muted" style={{ fontSize: 12 }}>{label} </span>
      {items.map((t) => (
        <span key={t} className="badge muted mono" style={{ marginRight: 6, fontSize: 11 }}>{t}</span>
      ))}
    </div>
  );
}

/** The written reason's floor, mirroring `NO_SCAN_REASON_MIN` in `tabs/software/lib/review.ts`. */
// Mirrors `AUDITED_OVERRIDE_REASON_MIN` in `@core/policy/approvals`, which is the AUTHORITY —
// `decideDeploy` enforces it server-side and refuses a short reason with a 400 whatever this
// client believes. The value is duplicated rather than imported because that module is
// `server-only` and this is a client component; `scanner-chart.test.ts` pins the two equal.
const NO_SCAN_REASON_MIN = 20;

export default function ReviewCard({
  card,
  canReview,
  canAcknowledgeNoScan = false,
  onDecide,
}: {
  card: ReviewCardData;
  canReview: boolean;
  /**
   * May THIS viewer approve a deploy that has no security verdict? ADMIN ONLY, decided
   * server-side and passed in. Optional and false by default, so every existing call site keeps
   * exactly today's behaviour (a disabled Approve with the reason beside it) until it opts in —
   * and so a non-admin is never shown a control the server would refuse.
   */
  canAcknowledgeNoScan?: boolean;
  onDecide?: (
    decision: 'approve' | 'deny',
    note?: string,
    opts?: { acknowledgeNoScan?: boolean; reason?: string },
  ) => void;
}) {
  const t = useTranslations('governance');
  const f = useFormat();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [ack, setAck] = useState(false);
  const [ackReason, setAckReason] = useState('');
  const r = card.requested;
  const decided = card.decision !== 'pending';

  // The three not-passed states, mirroring `scanGate` in `tabs/software/lib/review.ts` (which is
  // the AUTHORITY — this only avoids offering a press the server would refuse):
  //   no verdict  — nothing ran.
  //   blocking    — the engine found a secret or a high/critical finding. Never acknowledgeable.
  //   uncovered   — it ran, found nothing blocking, and named a category it could not cover
  //                 (`deps`, when the tree declares dependencies and commits no lockfile).
  const noVerdict = card.scan.unavailable === true;
  // `findings` is a CAPPED list; `blockingBeyondCap` is what it cannot say. Mirrors `scanGate`
  // in `tabs/software/lib/review.ts`, which is the authority (re-review L-B).
  const blocking =
    card.scan.blockingBeyondCap === true ||
    card.scan.findings.some(
      (f) => f.category === 'secrets' || f.severity === 'high' || f.severity === 'critical',
    );
  const uncovered = (card.scan.notRun ?? []).filter((c) => c !== 'sast');
  const uncoveredGate = !noVerdict && !card.scan.passed && !blocking && uncovered.length > 0;
  const incomplete = noVerdict || uncoveredGate;
  const mayAck = incomplete && canAcknowledgeNoScan;
  const ackReady = ack && ackReason.trim().length >= NO_SCAN_REASON_MIN;
  // Approve is blocked on an incomplete scan — UNLESS an admin has explicitly acknowledged it in
  // writing. `decideDeploy` enforces the identical rule; this only stops a press that would
  // certainly 409/400.
  const approveBlocked = incomplete && !(mayAck && ackReady);

  async function decide(decision: 'approve' | 'deny') {
    if (!onDecide || busy) return;
    setBusy(true);
    try {
      await onDecide(
        decision,
        note || undefined,
        decision === 'approve' && mayAck && ackReady
          ? { acknowledgeNoScan: true, reason: ackReason.trim() }
          : undefined,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ display: 'block' }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ margin: 0 }}>{card.appName}</h3>
        <span className={`badge ${decided ? (card.decision === 'approved' ? 'ok' : 'err') : 'warn'}`}>
          {t(`review.decision.${card.decision}`)}
        </span>
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
        {t('review.requestedLine', { kind: card.reason === 'first-deploy' ? 'first' : 'broadened', by: card.requestedBy, domain: card.domain })}
      </div>

      {/* Security scan */}
      <div style={{ marginTop: 12 }}>
        {/* THREE states, not two (review M1, 2026-11-18). A scan that no engine ran used to
            render as "security scan FAILED (0 findings)" — which reads as "we looked and it is
            broken" when it means "nothing looked". The approver has to be able to tell those
            apart, because only one of them is fixed by changing the code. */}
        <span className={`badge ${noVerdict || uncoveredGate ? 'warn' : card.scan.passed ? 'ok' : 'err'}`}>
          {noVerdict
            ? t('review.scan.notRun')
            : card.scan.passed
              ? t('review.scan.passed')
              : uncoveredGate
                ? t('review.scan.incomplete', { cats: uncovered.join(', ') })
                : t('review.scan.failed')}
        </span>{' '}
        <span className="muted" style={{ fontSize: 12 }}>
          {/* A category NO engine covered is printed as "not run", never as `0`. Trivy finds
              dependency vulnerabilities and committed secrets; it is not a SAST engine, and
              there is no allowlisted one to wire (Semgrep's engine is LGPL-2.1), so `sast 0`
              would be a clean bill of health nobody issued. */}
          {(['sast', 'deps', 'secrets'] as const).map((c, i) => (
            <span key={c}>
              {i > 0 ? ' · ' : null}
              {c}{' '}
              {card.scan.notRun?.includes(c) ? (
                <em title={t('review.scan.categoryNotRunTitle')}>{t('review.scan.categoryNotRun')}</em>
              ) : (
                card.scan.summary[c]
              )}
            </span>
          ))}
          {card.scan.engine ? ` · ${card.scan.engine}` : card.scan.unavailable ? null : ` · ${t('review.scan.offlineBaseline')}`}
          {card.scan.unavailable ? ` · ${t('review.scan.offlineOnly')}` : null}
        </span>
        {/* The reason is shown whenever there is one — not only when the scan is `unavailable`.
            A LIVE scan can also carry one: "dependencies were NOT scanned, there is no lockfile"
            is the single most important sentence on such a card, and hiding it behind the
            no-verdict state is how a `deps 0` over unresolved dependencies would read as clean. */}
        {card.scan.reason ? (
          <div className="hint" style={{ marginTop: 6 }}>{card.scan.reason}</div>
        ) : null}
        {card.scan.truncated ? (
          <div className="hint" style={{ marginTop: 6 }}>
            {t('review.scan.truncated', { beyond: card.scan.blockingBeyondCap ? 'yes' : 'no' })}
          </div>
        ) : null}
        {card.scan.notRun?.includes('sast') && !card.scan.unavailable ? (
          <div className="hint" style={{ marginTop: 6 }}>
            {t('review.scan.sastNotRun')}
          </div>
        ) : null}
        {card.scan.findings.length > 0 ? (
          <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
            {card.scan.findings.map((fd, i) => (
              <li key={i} style={{ fontSize: 12, marginBottom: 3 }}>
                <span className={sevClass(fd.severity)} style={{ fontSize: 10 }}>{fd.severity in SEVERITY_KEYS ? t(SEVERITY_KEYS[fd.severity]) : fd.severity}</span>{' '}
                {fd.title}
                {fd.path ? <span className="muted mono"> · {fd.path}</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {/* Non-blocking warnings (e.g. references to ungranted datasets) */}
      {card.warnings && card.warnings.length > 0 ? (
        <div style={{ marginTop: 10 }}>
          {card.warnings.map((w, i) => (
            <div key={i} className="badge warn" style={{ display: 'block', whiteSpace: 'pre-wrap', fontSize: 12, padding: 8 }}>
              ⚠ {w}
            </div>
          ))}
        </div>
      ) : null}

      {/* Requested governed resources */}
      <div style={{ marginTop: 10 }}>
        <Chips label={t('review.chips.connections')} items={r.connections} />
        <Chips label={t('review.chips.data')} items={r.data} />
        <Chips label={t('review.chips.knowledge')} items={r.knowledge} />
        <Chips label={t('review.chips.writeTools')} items={r.writeTools} />
      </div>

      {/* Footprint + diff */}
      <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
        {t('review.footprint', {
          cpu: r.footprint.cpu,
          memory: r.footprint.memory,
          usd: f.number(r.footprint.estMonthlyUsd, { maximumFractionDigits: 2 }),
          files: card.diff.files.length,
          added: card.diff.added,
          removed: card.diff.removed,
        })}
      </div>

      {decided ? (
        <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
          {/* "approved" and "approved WITHOUT a security verdict" are different facts, and the
              second one must never be readable as the first. */}
          {card.approvedWithUncoveredCategories?.length && card.decision === 'approved' ? (
            <>
              <span className="badge warn">
                {t('review.decided.withoutCats', { cats: card.approvedWithUncoveredCategories.join('/') })}
              </span>{' '}
              {t('review.decided.by', { by: card.decidedBy ?? '' })}
              {card.noScanReason ? (
                <div style={{ marginTop: 4 }}>{t('review.decided.reason', { reason: card.noScanReason })}</div>
              ) : null}
              {card.note ? <div style={{ marginTop: 4 }}>{t('review.decided.note', { note: card.note })}</div> : null}
            </>
          ) : card.approvedWithoutScan && card.decision === 'approved' ? (
            <>
              <span className="badge warn">{t('review.decided.withoutScan')}</span>{' '}
              {t('review.decided.by', { by: card.decidedBy ?? '' })}
              {card.noScanReason ? (
                <div style={{ marginTop: 4 }}>{t('review.decided.reason', { reason: card.noScanReason })}</div>
              ) : null}
              {card.note ? <div style={{ marginTop: 4 }}>{t('review.decided.note', { note: card.note })}</div> : null}
            </>
          ) : (
            <>
              {t('review.decided.plain', { decision: card.decision, by: card.decidedBy ?? '', hasNote: card.note ? 'yes' : 'no', note: card.note ?? '' })}
            </>
          )}
        </div>
      ) : canReview ? (
        <div className="row" style={{ gap: 8, marginTop: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t('review.notePlaceholder')}
            style={{ flex: 1, minWidth: 160 }}
          />
          {/* Approve is DISABLED when there is no verdict to approve, with the reason on the
              button itself — `decideDeploy` would refuse the call anyway (409), and an enabled
              button that always fails is a worse experience than a disabled one that says why.
              Deny stays available: refusing a deploy needs no scanner.
              THE ONE EXCEPTION (2026-11-19): an ADMIN may acknowledge the missing verdict in
              writing, which is audited. The controls below appear for nobody else. */}
          <button
            className="btn"
            onClick={() => decide('approve')}
            disabled={busy || approveBlocked}
            title={approveBlocked ? card.scan.reason : undefined}
          >
            {busy
              ? <span className="spin" />
              : mayAck && ackReady
                ? uncoveredGate ? t('review.approveWithoutCats', { cats: uncovered.join('/') }) : t('review.approveWithoutScan')
                : t('review.approveGoLive')}
          </button>
          <button className="btn ghost" onClick={() => decide('deny')} disabled={busy}>{t('review.deny')}</button>
          {incomplete && !mayAck ? (
            <span className="hint" style={{ flexBasis: '100%' }}>
              {uncoveredGate
                ? t('review.cannotApprove.uncovered', { cats: uncovered.join(', '), deps: uncovered.includes('deps') ? 'yes' : 'no' })
                : t('review.cannotApprove.noVerdict', { reason: card.scan.reason ?? '' })}
            </span>
          ) : null}
          {mayAck ? (
            <div style={{ flexBasis: '100%', marginTop: 4 }}>
              <label className="row" style={{ gap: 6, alignItems: 'flex-start', fontSize: 12 }}>
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                <span>
                  {uncoveredGate
                    ? t.rich('review.ack.uncovered', {
                        catsSlash: uncovered.join('/'),
                        cats: uncovered.join(', '),
                        deps: uncovered.includes('deps') ? 'yes' : 'no',
                        strong: (c) => <strong>{c}</strong>,
                      })
                    : t.rich('review.ack.noVerdict', { strong: (c) => <strong>{c}</strong> })}
                </span>
              </label>
              {ack ? (
                <>
                  <textarea
                    value={ackReason}
                    onChange={(e) => setAckReason(e.target.value)}
                    placeholder={t('review.ack.reasonPlaceholder', { min: NO_SCAN_REASON_MIN })}
                    rows={2}
                    style={{ width: '100%', marginTop: 6 }}
                  />
                  <span className="hint">
                    {ackReason.trim().length < NO_SCAN_REASON_MIN
                      ? t('review.ack.moreNeeded', { count: NO_SCAN_REASON_MIN - ackReason.trim().length })
                      : t('review.ack.stored')}
                  </span>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="hint" style={{ marginTop: 10 }}>{t('review.awaiting', { domain: card.domain })}</div>
      )}
    </div>
  );
}
