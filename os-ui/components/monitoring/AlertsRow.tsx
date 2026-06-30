/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import type { Alert } from '@/lib/monitoring';

/**
 * Operational alerts — system/run health only. Self-heals shown calmly (a
 * check); notifications shown as a bell. The boundary line encodes that
 * business-KPI alerts belong to Dashboards, not here.
 */
export default function AlertsRow({ alerts }: { alerts: Alert[] }) {
  return (
    <>
      <div className="mon-alerts">
        {alerts.length === 0 ? (
          <div className="mon-alert">
            <span className="mon-alert-icon sev-warning">○</span>
            <span className="mon-alert-body">
              <span className="mon-alert-detail">No operational alerts.</span>
            </span>
          </div>
        ) : (
          alerts.map((a) => (
            <div className="mon-alert" key={a.id}>
              <span className={`mon-alert-icon sev-${a.severity}`}>
                {a.severity === 'critical' ? '▲' : '◆'}
              </span>
              <span className="mon-alert-body">
                <span className="mon-alert-title">
                  {a.title}
                  {a.source === 'mock' && (
                    <span className="mon-tag" style={{ marginLeft: 7 }}>mock</span>
                  )}
                </span>
                <span className="mon-alert-detail">{a.detail}</span>
              </span>
              {a.disposition === 'self-healed' ? (
                <span className="mon-disp healed" title="Self-healed">✓ self-healed</span>
              ) : (
                <span className="mon-disp" title="Notified">🔔 notified</span>
              )}
            </div>
          ))
        )}
      </div>
      <div className="hint">
        Operational alerts only — business-KPI alerts live in Dashboards.
      </div>
    </>
  );
}
