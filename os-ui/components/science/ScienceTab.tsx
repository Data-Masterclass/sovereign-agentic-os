/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';
import PageHeader from '@/components/PageHeader';
import { useApi } from '@/lib/useApi';
import { useTabNavReset } from '@/lib/core/tab-nav';
import ModelTiles from './ModelTiles';
import ModelDetail from './ModelDetail';
import NewModel from './NewModel';
import DevConsole from './DevConsole';
import type { ModelGroups, ModelSummary } from './shared';

type View =
  | { kind: 'list' }
  | { kind: 'detail'; model: ModelSummary }
  | { kind: 'new' }
  | { kind: 'console' };

/**
 * The Science experience — the OS's ONE-view pattern, mirroring DashboardsTab:
 *   list    — the grouped model grid (All · My · Shared · Marketplace) + ＋ New model;
 *   detail  — one model, where Overview, Predict, the tier ladder, Lifecycle and the
 *             Developer console fold in as facets;
 *   new     — the Define step of the builder (registers a draft), returning to the list;
 *   console — the raw Layer-4 stack (JupyterHub/MLflow/Featureform/KServe), the escape hatch.
 *
 * Phase 1 wraps the live churn/KServe slice as the first model. Guided train/deploy,
 * a real training runtime, and inline eval/monitor charts are Phases 2–4.
 */
export default function ScienceTab() {
  const [view, setView] = useState<View>({ kind: 'list' });
  const [showArchived, setShowArchived] = useState(false);
  const models = useApi<ModelGroups>(`/api/science/model${showArchived ? '?archived=1' : ''}`);

  // Clicking the Science sidebar link returns to the list from any sub-view.
  useTabNavReset(() => setView({ kind: 'list' }));

  const mlEnabled = models.data?.mlEnabled;

  return (
    <>
      <PageHeader title="Science" crumb="model-as-a-service — define · predict · promote · govern (ML, not LLMs)" tutorial="science" />
      <div className="content">
        {view.kind === 'console' ? (
          <DevConsole onBack={() => setView({ kind: 'list' })} />
        ) : view.kind === 'new' ? (
          <>
            <button className="btn ghost sm" onClick={() => setView({ kind: 'list' })} style={{ marginBottom: 14 }}>← All models</button>
            <NewModel onCreated={(m) => { models.reload(); setView({ kind: 'detail', model: m }); }} />
          </>
        ) : view.kind === 'detail' ? (
          <ModelDetail
            model={view.model}
            onBack={() => setView({ kind: 'list' })}
            onChanged={() => models.reload()}
            onOpenConsole={() => setView({ kind: 'console' })}
          />
        ) : models.data && mlEnabled === false ? (
          <DisabledSurface onOpenConsole={() => setView({ kind: 'console' })} />
        ) : (
          <>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 280 }}>
                <p className="lead" style={{ marginTop: 4 }}>
                  Traditional ML as a <strong>governed service</strong>. Define a model over your governed
                  data, open one to try its <strong>predict</strong> front door, then promote it up the
                  <em> same</em> visibility ladder that governs every other artifact. This is the{' '}
                  <strong>Layer-4</strong> capability — off by default and GPU-cost-gated.
                </p>
                <p className="hint" style={{ marginTop: 0 }}>
                  Need the raw stack? Open the{' '}
                  <button
                    type="button"
                    onClick={() => setView({ kind: 'console' })}
                    style={{ background: 'none', border: 'none', padding: 0, color: 'var(--teal)', textDecoration: 'underline', cursor: 'pointer', font: 'inherit' }}
                  >
                    Developer console
                  </button>{' '}
                  for MLflow, Featureform, JupyterHub and KServe directly.
                </p>
              </div>
              <div className="row" style={{ gap: 8, marginTop: 4 }}>
                <button className="btn ghost" style={{ opacity: 1 }} onClick={() => setShowArchived((v) => !v)} title="Archived models are hidden by default">
                  {showArchived ? 'Hide archived' : 'Show archived'}
                </button>
                <button className="btn" onClick={() => setView({ kind: 'new' })}>＋ New model</button>
              </div>
            </div>

            <ModelTiles
              data={models.data}
              loading={models.loading}
              error={models.error}
              onOpen={(m) => setView({ kind: 'detail', model: m })}
              showArchived={showArchived}
            />
          </>
        )}
      </div>
    </>
  );
}

function DisabledSurface({ onOpenConsole }: { onOpenConsole: () => void }) {
  return (
    <>
      <div className="section-title">Science is off for this domain</div>
      <div className="card" style={{ borderLeft: '3px solid var(--gold)' }}>
        <p style={{ marginTop: 0 }}>
          <strong>Layer 4 (ML) is disabled.</strong> It is off by default and GPU-cost-gated — an{' '}
          <strong>Admin</strong> turns it on per domain when that team actually does data science. While
          it is off, no models, features, notebooks, or the governed <code>predict</code> service exist,
          and no GPU is reserved.
        </p>
        <div className="hint" style={{ marginTop: 4 }}>
          To enable for a domain, an Admin sets <code>ML_ENABLED=true</code> (or <code>ml.enabled=true</code>{' '}
          in the domain config) and the Layer-4 services come up. Then the full model-as-service tab —
          model tiles, the tier ladder, both <code>predict</code> front doors and the lifecycle — renders here.
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn ghost" onClick={onOpenConsole}>Open Developer console →</button>
        </div>
      </div>
    </>
  );
}
