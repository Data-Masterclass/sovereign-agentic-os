/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';
import { postJson } from './shared';
import type { Cadence, Channel, DashboardSummary, ReportResponse } from './shared';

const CADENCES: Cadence[] = ['daily', 'weekly', 'monthly'];
const CHANNEL_OPTS: Channel[] = ['email', 'slack', 'in_app'];

/**
 * Scheduled reports — deliver a dashboard snapshot on a cadence. "Send now" is the manual
 * trigger the scheduler also calls; the route advances the report's lastSentAt and returns
 * the send record.
 */
export default function Reports({ dashboard }: { dashboard: DashboardSummary }) {
  const [cadence, setCadence] = useState<Cadence>('weekly');
  const [channel, setChannel] = useState<Channel>('email');
  const [result, setResult] = useState<ReportResponse | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const sendNow = async () => {
    setError('');
    setResult(null);
    setBusy(true);
    try {
      const report = {
        id: `${dashboard.id}-${cadence}`,
        dashboardId: dashboard.id,
        cadence,
        channel,
        lastSentAt: 0,
      };
      const res = await postJson<ReportResponse>('/api/dashboards/reports', { report });
      setResult(res);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="agent-editor" style={{ marginTop: 18 }}>
      <div className="agent-editor-title">Scheduled report — {dashboard.name}</div>
      <p className="hint" style={{ marginTop: 4 }}>A snapshot of this dashboard, delivered on a cadence.</p>

      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', marginTop: 12 }}>
        <label>
          <span className="comp-label">Cadence</span>
          <select value={cadence} onChange={(e) => setCadence(e.target.value as Cadence)} style={{ width: '100%' }}>
            {CADENCES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label>
          <span className="comp-label">Channel</span>
          <select value={channel} onChange={(e) => setChannel(e.target.value as Channel)} style={{ width: '100%' }}>
            {CHANNEL_OPTS.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
      </div>

      <div className="row" style={{ marginTop: 16 }}>
        <button className="btn" onClick={sendNow} disabled={busy}>
          {busy ? <span className="spin" /> : 'Send now'}
        </button>
      </div>

      {error ? <div className="error" style={{ marginTop: 12 }}>{error}</div> : null}

      {result ? (
        <div className="passthrough-note" style={{ marginTop: 14 }}>
          ✓ Sent <strong>{dashboard.name}</strong> via <strong>{result.send.channel}</strong> at{' '}
          {new Date(result.send.sentAt).toLocaleString()} — cadence <strong>{result.report.cadence}</strong>.
        </div>
      ) : null}
    </div>
  );
}
