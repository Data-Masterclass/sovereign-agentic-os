/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';

/**
 * The Builder deploy-review card (Software golden path §D). Presents the four
 * things a reviewer needs — the security scan, the governed resources requested,
 * the cost/resource footprint, and the change diff — and (for a Builder) the
 * approve/deny controls. Pure presentation; the role gate lives server-side.
 */

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
  noScanReason?: string;
};

function sevClass(s: Severity): string {
  if (s === 'critical' || s === 'high') return 'badge err';
  if (s === 'medium') return 'badge warn';
  return 'badge muted';
}

function Chips({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div style={{ marginTop: 6 }}>
      <span className="muted" style={{ fontSize: 12 }}>{label}: </span>
      {items.map((t) => (
        <span key={t} className="badge muted mono" style={{ marginRight: 6, fontSize: 11 }}>{t}</span>
      ))}
    </div>
  );
}

/** The written reason's floor, mirroring `NO_SCAN_REASON_MIN` in `tabs/software/lib/review.ts`. */
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
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [ack, setAck] = useState(false);
  const [ackReason, setAckReason] = useState('');
  const r = card.requested;
  const decided = card.decision !== 'pending';

  const noVerdict = card.scan.unavailable === true;
  const mayAck = noVerdict && canAcknowledgeNoScan;
  const ackReady = ack && ackReason.trim().length >= NO_SCAN_REASON_MIN;
  // Approve is blocked when there is no verdict — UNLESS an admin has explicitly acknowledged it
  // in writing. `decideDeploy` enforces the identical rule; this only stops a press that would
  // certainly 409/400.
  const approveBlocked = noVerdict && !(mayAck && ackReady);

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
          {card.decision}
        </span>
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
        {card.reason === 'first-deploy' ? 'First deploy' : 'Scope-broadening change'} · requested by {card.requestedBy} · {card.domain}
      </div>

      {/* Security scan */}
      <div style={{ marginTop: 12 }}>
        {/* THREE states, not two (review M1, 2026-11-18). A scan that no engine ran used to
            render as "security scan FAILED (0 findings)" — which reads as "we looked and it is
            broken" when it means "nothing looked". The approver has to be able to tell those
            apart, because only one of them is fixed by changing the code. */}
        <span className={`badge ${card.scan.unavailable ? 'warn' : card.scan.passed ? 'ok' : 'err'}`}>
          security scan {card.scan.unavailable ? 'NOT RUN' : card.scan.passed ? 'passed' : 'FAILED'}
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
                <em title="No engine covered this category">not run</em>
              ) : (
                card.scan.summary[c]
              )}
            </span>
          ))}
          {card.scan.engine ? ` · ${card.scan.engine}` : card.scan.unavailable ? null : ' · offline baseline'}
          {card.scan.unavailable ? ' · from the offline baseline only' : null}
        </span>
        {card.scan.unavailable ? (
          <div className="hint" style={{ marginTop: 6 }}>{card.scan.reason}</div>
        ) : null}
        {card.scan.notRun?.includes('sast') && !card.scan.unavailable ? (
          <div className="hint" style={{ marginTop: 6 }}>
            Static analysis (SAST) was NOT run: this scanner covers dependency vulnerabilities and
            committed secrets only. No SAST engine is bundled — Semgrep&rsquo;s engine is LGPL-2.1
            and is excluded by the project licence allowlist — so read the diff yourself for logic
            flaws.
          </div>
        ) : null}
        {card.scan.findings.length > 0 ? (
          <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
            {card.scan.findings.map((f, i) => (
              <li key={i} style={{ fontSize: 12, marginBottom: 3 }}>
                <span className={sevClass(f.severity)} style={{ fontSize: 10 }}>{f.severity}</span>{' '}
                {f.title}
                {f.path ? <span className="muted mono"> · {f.path}</span> : null}
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
        <Chips label="connections" items={r.connections} />
        <Chips label="data" items={r.data} />
        <Chips label="knowledge" items={r.knowledge} />
        <Chips label="write tools" items={r.writeTools} />
      </div>

      {/* Footprint + diff */}
      <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
        footprint: {r.footprint.cpu} CPU · {r.footprint.memory} · ~${r.footprint.estMonthlyUsd}/mo
        {' · '}diff: {card.diff.files.length} files, +{card.diff.added}/-{card.diff.removed}
      </div>

      {decided ? (
        <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
          {/* "approved" and "approved WITHOUT a security verdict" are different facts, and the
              second one must never be readable as the first. */}
          {card.approvedWithoutScan && card.decision === 'approved' ? (
            <>
              <span className="badge warn">approved without a security verdict</span>{' '}
              by {card.decidedBy}
              {card.noScanReason ? (
                <div style={{ marginTop: 4 }}>reason given: {card.noScanReason}</div>
              ) : null}
              {card.note ? <div style={{ marginTop: 4 }}>note: {card.note}</div> : null}
            </>
          ) : (
            <>
              {card.decision} by {card.decidedBy}{card.note ? ` — ${card.note}` : ''}
            </>
          )}
        </div>
      ) : canReview ? (
        <div className="row" style={{ gap: 8, marginTop: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note (optional)"
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
            {busy ? <span className="spin" /> : mayAck && ackReady ? 'Approve without a scan' : 'Approve & go live'}
          </button>
          <button className="btn ghost" onClick={() => decide('deny')} disabled={busy}>Deny</button>
          {noVerdict && !mayAck ? (
            <span className="hint" style={{ flexBasis: '100%' }}>
              Cannot approve: there is no security verdict. {card.scan.reason} Wire a scanner, or
              ask an Administrator to approve without one — that decision is recorded.
            </span>
          ) : null}
          {mayAck ? (
            <div style={{ flexBasis: '100%', marginTop: 4 }}>
              <label className="row" style={{ gap: 6, alignItems: 'flex-start', fontSize: 12 }}>
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                <span>
                  <strong>Approve without a security verdict.</strong> No scanner produced a result
                  for this deploy. Approving anyway is recorded against your name in the audit log,
                  with the reason below.
                </span>
              </label>
              {ack ? (
                <>
                  <textarea
                    value={ackReason}
                    onChange={(e) => setAckReason(e.target.value)}
                    placeholder="Why are you approving without a security verdict? (required, min 20 characters)"
                    rows={2}
                    style={{ width: '100%', marginTop: 6 }}
                  />
                  <span className="hint">
                    {ackReason.trim().length < NO_SCAN_REASON_MIN
                      ? `${NO_SCAN_REASON_MIN - ackReason.trim().length} more character(s) needed — this reason is the permanent record.`
                      : 'This reason will be stored on the approval and in the audit log.'}
                  </span>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="hint" style={{ marginTop: 10 }}>Awaiting a Builder/Admin in {card.domain} to review.</div>
      )}
    </div>
  );
}
