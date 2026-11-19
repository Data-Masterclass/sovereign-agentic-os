/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';
import { postJson } from '@tabs/dashboards/ui/shared';
import type { DashboardSummary, ReportResponse } from '@tabs/dashboards/ui/shared';
import { REPORT_COPY } from '@tabs/dashboards/lib/report-copy';

/**
 * Report notice — posts ONE in-app notification naming this dashboard. There is no scheduler and
 * no saved cadence, so the panel offers none and says so (report-copy.ts, report-honesty.test.ts).
 */
export default function Reports({ dashboard }: { dashboard: DashboardSummary }) {
  const [result, setResult] = useState<ReportResponse | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const sendNow = async () => {
    setError('');
    setResult(null);
    setBusy(true);
    try {
      const report = {
        id: `${dashboard.id}-manual`,
        dashboardId: dashboard.id,
        // The route's record shape still carries a cadence; nothing schedules on it.
        cadence: 'weekly',
        channel: 'in_app',
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
      <div className="agent-editor-title">{REPORT_COPY.title} — {dashboard.name}</div>
      <p className="hint" style={{ marginTop: 4 }}>{REPORT_COPY.intro}</p>
      <p className="hint" style={{ marginTop: 8 }}>{REPORT_COPY.schedulingUnavailable}</p>

      <div className="row" style={{ marginTop: 16 }}>
        <button className="btn" onClick={sendNow} disabled={busy}>
          {busy ? <span className="spin" /> : REPORT_COPY.button}
        </button>
      </div>

      {error ? <div className="error" style={{ marginTop: 12 }}>{error}</div> : null}

      {result ? (
        <div className="passthrough-note" style={{ marginTop: 14 }}>
          {REPORT_COPY.posted} — <strong>{dashboard.name}</strong>, at{' '}
          {new Date(result.send.sentAt).toLocaleString()}.
        </div>
      ) : null}
    </div>
  );
}
