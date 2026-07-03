/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';
import PageHeader from '@/components/PageHeader';
import MetricsRegistry from '@/components/metrics/MetricsRegistry';
import DefineMetric from '@/components/metrics/DefineMetric';
import ExploreMetric from '@/components/metrics/ExploreMetric';
import GovernMetric from '@/components/metrics/GovernMetric';
import LiveCube from '@/components/metrics/LiveCube';
import type { MetricSummary } from '@/components/metrics/shared';

/**
 * The Metrics tab — one definition of every number. Four governed surfaces (registry,
 * define, explore, govern) over the metrics route contracts, plus a quiet Live Cube
 * inspection. The selected metric is shared so registry → explore / govern flows feel
 * like one surface; defining or governing bumps the registry so tiers stay honest.
 */
type View = 'registry' | 'define' | 'explore' | 'govern' | 'cube';

export default function MetricsPage() {
  const [view, setView] = useState<View>('registry');
  const [selected, setSelected] = useState<MetricSummary | null>(null);
  const [registryKey, setRegistryKey] = useState(0);

  const select = (m: MetricSummary, go?: View) => { setSelected(m); if (go) setView(go); };
  const refreshRegistry = () => setRegistryKey((k) => k + 1);

  return (
    <>
      <PageHeader title="Metrics" crumb="registry · define · explore · govern — one definition of every number" tutorial="metrics" mcpTab="metrics" />
      <div className="content">
        <div className="tabstrip">
          <button className={view === 'registry' ? 'active' : ''} onClick={() => setView('registry')}>Registry</button>
          <button className={view === 'define' ? 'active' : ''} onClick={() => setView('define')}>Define</button>
          <button className={view === 'explore' ? 'active' : ''} onClick={() => setView('explore')}>Explore</button>
          <button className={view === 'govern' ? 'active' : ''} onClick={() => setView('govern')}>Govern</button>
          <button className={view === 'cube' ? 'active' : ''} onClick={() => setView('cube')}>Live Cube</button>
        </div>

        {view === 'registry' ? (
          <MetricsRegistry
            key={registryKey}
            selectedId={selected?.id ?? null}
            onSelect={(m) => select(m)}
            onExplore={(m) => select(m, 'explore')}
            onGovern={(m) => select(m, 'govern')}
          />
        ) : null}

        {view === 'define' ? <DefineMetric onDefined={refreshRegistry} /> : null}

        {view === 'explore' ? <ExploreMetric metric={selected} /> : null}

        {view === 'govern' ? <GovernMetric metric={selected} onGoverned={refreshRegistry} /> : null}

        {view === 'cube' ? <LiveCube /> : null}
      </div>
    </>
  );
}
