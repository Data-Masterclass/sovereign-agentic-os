/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';
import Link from 'next/link';
import PageHeader from '@/components/PageHeader';
import { useApi } from '@/lib/useApi';
import type { DashboardGroups, MetricGroups, DashboardSummary, DashTier } from './shared';
import Tiles from './Tiles';
import NewDashboard from './NewDashboard';
import Alerts from './Alerts';
import Reports from './Reports';
import Govern from './Govern';

type Tab = 'tiles' | 'new' | 'alerts' | 'reports' | 'govern';

/**
 * The Dashboards experience. Tiles open inline with the viewer's own RLS (guest token),
 * a dual-mode builder lands one governed spec, and alerts / reports / govern act on the
 * selected dashboard. Metrics are DEFINED in the Metrics tab — here we only consume them.
 */
export default function DashboardsTab({ supersetUrl }: { supersetUrl: string }) {
  const [tab, setTab] = useState<Tab>('tiles');
  const [selected, setSelected] = useState<DashboardSummary | null>(null);
  const dashboards = useApi<DashboardGroups>('/api/dashboards');
  const metrics = useApi<MetricGroups>('/api/metrics');

  const onGoverned = (tier: DashTier) => {
    setSelected((s) => (s ? { ...s, tier } : s));
    dashboards.reload();
  };

  return (
    <>
      <PageHeader title="Dashboards" crumb="open · build · alert · report · govern — on governed metrics" tutorial="dashboards" />
      <div className="content">
        <p className="lead">
          Compose dashboards over your <strong>governed metrics</strong>. Open a tile — it embeds with
          your own row-level security — build a new one by drag-and-drop or with the agent, then set
          alerts, schedule reports, and promote it for the domain.
        </p>
        <p className="hint" style={{ marginTop: 0 }}>
          Metrics are <strong>defined in the Metrics tab</strong> —{' '}
          <Link href="/metrics" style={{ color: 'var(--teal)', textDecoration: 'underline' }}>open Metrics →</Link>.
          Dashboards only consume governed metrics.
        </p>

        <div className="tabstrip">
          <button className={tab === 'tiles' ? 'active' : ''} onClick={() => setTab('tiles')}>Tiles</button>
          <button className={tab === 'new' ? 'active' : ''} onClick={() => setTab('new')}>New dashboard</button>
          <button className={tab === 'alerts' ? 'active' : ''} onClick={() => setTab('alerts')}>Alerts</button>
          <button className={tab === 'reports' ? 'active' : ''} onClick={() => setTab('reports')}>Reports</button>
          <button className={tab === 'govern' ? 'active' : ''} onClick={() => setTab('govern')}>Govern</button>
        </div>

        {selected ? (
          <div className="hint" style={{ marginTop: 12 }}>
            Selected dashboard: <strong>{selected.name}</strong> — used by Reports + Govern.
          </div>
        ) : null}

        {tab === 'tiles' ? (
          <Tiles
            data={dashboards.data}
            loading={dashboards.loading}
            error={dashboards.error}
            selected={selected}
            onSelect={setSelected}
            supersetUrl={supersetUrl}
          />
        ) : null}
        {tab === 'new' ? (
          <NewDashboard metrics={metrics.data} loading={metrics.loading} onBuilt={() => dashboards.reload()} />
        ) : null}
        {tab === 'alerts' ? <Alerts metrics={metrics.data} loading={metrics.loading} /> : null}
        {tab === 'reports' ? <Reports selected={selected} /> : null}
        {tab === 'govern' ? <Govern selected={selected} onGoverned={onGoverned} /> : null}
      </div>
    </>
  );
}
