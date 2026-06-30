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
  scan: { passed: boolean; summary: { sast: number; deps: number; secrets: number }; findings: Finding[]; scannedAt: string };
  requested: {
    writeTools: string[];
    connections: string[];
    data: string[];
    knowledge: string[];
    footprint: { cpu: string; memory: string; estMonthlyUsd: number };
  };
  diff: { files: { path: string; added: number; removed: number }[]; added: number; removed: number };
  decision: 'pending' | 'approved' | 'denied';
  decidedBy?: string;
  note?: string;
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

export default function ReviewCard({
  card,
  canReview,
  onDecide,
}: {
  card: ReviewCardData;
  canReview: boolean;
  onDecide?: (decision: 'approve' | 'deny', note?: string) => void;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const r = card.requested;
  const decided = card.decision !== 'pending';

  async function decide(decision: 'approve' | 'deny') {
    if (!onDecide || busy) return;
    setBusy(true);
    try {
      await onDecide(decision, note || undefined);
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
        <span className={`badge ${card.scan.passed ? 'ok' : 'err'}`}>
          security scan {card.scan.passed ? 'passed' : 'FAILED'}
        </span>{' '}
        <span className="muted" style={{ fontSize: 12 }}>
          sast {card.scan.summary.sast} · deps {card.scan.summary.deps} · secrets {card.scan.summary.secrets}
        </span>
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
          {card.decision} by {card.decidedBy}{card.note ? ` — ${card.note}` : ''}
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
          <button className="btn" onClick={() => decide('approve')} disabled={busy}>
            {busy ? <span className="spin" /> : 'Approve & go live'}
          </button>
          <button className="btn ghost" onClick={() => decide('deny')} disabled={busy}>Deny</button>
        </div>
      ) : (
        <div className="hint" style={{ marginTop: 10 }}>Awaiting a Builder/Admin in {card.domain} to review.</div>
      )}
    </div>
  );
}
