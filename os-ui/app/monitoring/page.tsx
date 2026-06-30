/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';
import PageHeader from '@/components/PageHeader';
import { useApi } from '@/lib/useApi';
import type { HealthItem, Overview } from '@/lib/monitoring';
import AttentionStrip from '@/components/monitoring/AttentionStrip';
import LensCard from '@/components/monitoring/LensCard';
import AlertsRow from '@/components/monitoring/AlertsRow';
import TraceDrawer from '@/components/monitoring/TraceDrawer';
import { scopeLabel } from '@/components/monitoring/health';
import '../monitoring.css';

/**
 * Monitoring — the READ/OBSERVE plane. Attention-first: the few things that need
 * a human lead; the five lenses follow; greens recede. Everything is read-only —
 * no button here mutates. Run items drill into the Langfuse trace drawer.
 */
export default function MonitoringPage() {
  const { data, loading, error, reload } = useApi<Overview>('/api/monitoring');
  const [selected, setSelected] = useState<HealthItem | null>(null);

  return (
    <>
      <PageHeader title="Monitoring" crumb="health · spend · traces — the read plane" />
      <div className="content">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <p className="lead" style={{ marginBottom: 0 }}>
            What your agents, pipelines and systems are doing — scoped to your identity.
            Monitoring shows health, watches spend, and traces runs; it never sets policy
            or caps (that is Governance).
          </p>
          <button className="btn ghost" onClick={reload} disabled={loading}>
            {loading ? <span className="spin" /> : 'Refresh'}
          </button>
        </div>

        {data && (
          <div className="row" style={{ marginTop: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="pill">
              <span className="live" />
              {scopeLabel(data.scope)}
            </span>
            {data.scope.via === 'identity' && (
              <span className="muted" style={{ fontSize: 12 }}>
                OPA offline — scope mirrored from identity.
              </span>
            )}
          </div>
        )}

        {error ? <div className="error" style={{ marginTop: 20 }}>{error}</div> : null}

        {!data && loading ? (
          <div className="stub-page" style={{ marginTop: 20 }}>Loading the read plane…</div>
        ) : null}

        {data && (
          <>
            <div className="section-title">Needs attention</div>
            <AttentionStrip items={data.attention} onOpen={setSelected} />

            <div className="section-title">Five lenses</div>
            <div className="mon-lens-grid">
              {data.lenses.map((lens) => (
                <LensCard key={lens.id} lens={lens} onOpen={setSelected} />
              ))}
            </div>

            <div className="section-title">Operational alerts</div>
            <AlertsRow alerts={data.alerts} />
          </>
        )}
      </div>

      {selected && <TraceDrawer item={selected} onClose={() => setSelected(null)} />}
    </>
  );
}
