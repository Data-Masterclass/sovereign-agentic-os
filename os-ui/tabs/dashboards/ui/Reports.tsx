/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';
import { postJson } from '@tabs/dashboards/ui/shared';
import type { DashboardSummary, ReportResponse } from '@tabs/dashboards/ui/shared';
import { REPORT_COPY_KEYS } from '@tabs/dashboards/lib/report-copy';
import { useTranslations, useFormat, useServerMessage } from '@core/i18n/client';

/**
 * Report notice — posts ONE in-app notification naming this dashboard. There is no scheduler and
 * no saved cadence, so the panel offers none and says so (report-copy.ts, report-honesty.test.ts).
 */
export default function Reports({ dashboard }: { dashboard: DashboardSummary }) {
  const [result, setResult] = useState<ReportResponse | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const t = useTranslations('dashboards');
  const serverMsg = useServerMessage();
  const f = useFormat();

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
      const res = await postJson<ReportResponse>('/api/dashboards/reports', { report }, (status) => t('errors.requestFailed', { status }), serverMsg);
      setResult(res);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="agent-editor" style={{ marginTop: 18 }}>
      <div className="agent-editor-title">{t(REPORT_COPY_KEYS.heading, { name: dashboard.name })}</div>
      <p className="hint" style={{ marginTop: 4 }}>{t(REPORT_COPY_KEYS.intro)}</p>
      <p className="hint" style={{ marginTop: 8 }}>{t(REPORT_COPY_KEYS.schedulingUnavailable)}</p>

      <div className="row" style={{ marginTop: 16 }}>
        <button className="btn" onClick={sendNow} disabled={busy}>
          {busy ? <span className="spin" /> : t(REPORT_COPY_KEYS.button)}
        </button>
      </div>

      {error ? <div className="error" style={{ marginTop: 12 }}>{error}</div> : null}

      {result ? (
        <div className="passthrough-note" style={{ marginTop: 14 }}>
          {t.rich(REPORT_COPY_KEYS.postedLine, {
            name: dashboard.name,
            // The same parts `toLocaleString()` showed, in the user's language.
            at: f.dateTime(result.send.sentAt, { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' }),
            strong: (c) => <strong>{c}</strong>,
          })}
        </div>
      ) : null}
    </div>
  );
}
