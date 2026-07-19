/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useState } from 'react';
import { useUser } from '@/lib/useUser';
import { roleAtLeast } from '@/lib/core/session';
import { canManageArtifact } from '@/lib/governance/edit-scope';
import type { Visibility } from '@/lib/core/lifecycle';
import DomainTag from '@/components/DomainTag';
import { ConfirmProvider } from '@/components/lifecycle/ConfirmDialog';
import LifecycleActions from '@/components/lifecycle/LifecycleActions';
import PromoteButton, { type PromoteTier } from '@/components/lifecycle/PromoteButton';
import TrainStep from './builder/TrainStep';
import DeployStep from './builder/DeployStep';
import {
  TIER_BADGE,
  TIER_LABEL,
  TASK_LABEL,
  BUILD_STATE,
  type ModelSummary,
  type PredictResult,
} from './shared';

/** Model tier → the OS-wide lifecycle visibility (drives the delete gate). */
const lcVis = (tier: ModelSummary['tier']): Visibility =>
  tier === 'Domain' ? 'shared' : tier === 'Marketplace' ? 'certified' : 'personal';

/** Model tier → the shared ladder tier the PromoteButton speaks. */
const ladderTier = (tier: ModelSummary['tier']): PromoteTier =>
  tier === 'Domain' ? 'Shared' : tier === 'Marketplace' ? 'Marketplace' : 'Personal';

/**
 * A single model's DETAIL — ONE calm scrolling view (no subtabs), mirroring
 * DashboardDetail. Top to bottom:
 *   1. Overview — spec (task, source, features, metric) + current metrics + versions;
 *   2. Predict — the live "Try it" front door (reuses the churn /predict endpoint);
 *   3. Train / Evaluate / Monitor — HONEST Phase-2+ template states (guided train,
 *      real runtime + inline charts are later phases);
 *   4. Lifecycle — the shared Promote/Certify control + Archive/Delete/Version;
 *   5. Developer — Open console (the raw Layer-4 escape hatch).
 */
export default function ModelDetail({
  model,
  onBack,
  onChanged,
  onOpenConsole,
}: {
  model: ModelSummary;
  onBack: () => void;
  onChanged: () => void;
  onOpenConsole: () => void;
}) {
  const { user } = useUser();
  const canManage = !!user && canManageArtifact(user, { owner: model.owner, domain: model.domain });
  // Models promote at the Builder rung — a Builder+ sees "Promote" (not "Propose").
  const canApprove = !!user && roleAtLeast(user.role, 'builder');
  const bs = model.buildState ? BUILD_STATE[model.buildState] : null;
  const spec = model.spec;

  return (
    <ConfirmProvider>
      <button className="btn ghost sm" onClick={onBack} style={{ marginBottom: 14 }}>← All models</button>

      <div className="row" style={{ alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>{model.name}</h2>
        {model.tier === 'Domain' || model.tier === 'Marketplace' ? <DomainTag domain={model.domain} /> : null}
        <span className={`badge ${TIER_BADGE[model.tier]}`}>{TIER_LABEL[model.tier]}</span>
        {bs ? (
          <span className="row" style={{ gap: 5, alignItems: 'center' }}>
            <span className={`status-dot ${bs.dot}`} />
            <span className="muted">{bs.label}</span>
          </span>
        ) : null}
      </div>
      <div className="tile-meta" style={{ marginTop: 6 }}>
        <span className="muted mono" style={{ fontSize: 12 }}>{model.model}</span>
        <span className="dot-sep">·</span>
        <span className="muted">stage {model.stage}</span>
        <span className="dot-sep">·</span>
        <span className="muted">owner {model.owner}</span>
      </div>
      {model.description ? <p className="muted" style={{ marginTop: 10 }}>{model.description}</p> : null}

      {/* 1 — Overview */}
      <div className="section-title" style={{ marginTop: 20 }}>Overview</div>
      <div className="card">
        {spec ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
            <Kv k="Task" v={TASK_LABEL[spec.taskType]} />
            <Kv k="Algorithm" v={spec.algorithm} />
            <Kv k="Source data product" v={spec.sourceDataProductFqn} mono />
            <Kv k="Target column" v={spec.targetColumn ?? '— (unsupervised)'} mono />
            <Kv k="Optimize metric" v={spec.optimizeMetric} />
            <Kv k="Train/test split" v={`${Math.round(spec.trainTestSplit * 100)} / ${Math.round((1 - spec.trainTestSplit) * 100)}`} />
            <Kv k="Features" v={spec.features.length ? spec.features.join(', ') : '—'} mono />
            {typeof model.metrics?.primary === 'number' ? (
              <Kv k="Current metric" v={`${model.metrics.primaryMetric ?? spec.optimizeMetric} ${model.metrics.primary.toFixed(3)}`} />
            ) : null}
          </div>
        ) : (
          <div className="muted">This model has no build spec yet.</div>
        )}
        {model.versions.length ? (
          <>
            <div className="comp-label" style={{ marginTop: 16 }}>Versions</div>
            <div className="tile-meta muted" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
              {model.versions.map((v) => (
                <span key={v.version}>
                  <code>{v.version}</code> · {v.stage} · AUC {v.auc.toFixed(3)}
                  {v.certified ? <span className="badge ok" style={{ marginLeft: 6 }}>certified</span> : null}
                </span>
              ))}
            </div>
          </>
        ) : (
          <div className="hint" style={{ marginTop: 12 }}>No registered versions yet — train the model to create one (Phase 2).</div>
        )}
      </div>

      {/* 2 — Predict (the live front door) */}
      <div className="section-title">Predict</div>
      <PredictPanel model={model} />

      {/* 3 — Train + Deploy (real runtimes) · Evaluate / Monitor (honest Phase-4 placeholders) */}
      <div className="section-title">Train · Deploy · Monitor</div>
      {spec ? (
        <>
          <TrainStep model={model} canManage={canManage} onChanged={onChanged} />
          <DeployStep model={model} canManage={canManage} onChanged={onChanged} />
        </>
      ) : (
        <div className="card"><div className="muted">Define a build spec before training this model.</div></div>
      )}
      <div className="card" style={{ borderLeft: '3px solid var(--gold)', marginTop: 12 }}>
        <p style={{ marginTop: 0 }} className="muted">
          Inline <strong>evaluation</strong> and drift <strong>monitoring</strong> charts land in the next
          phase. Training and the one-click deploy to a per-model KServe endpoint run for real above.
        </p>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <span className="badge muted">Evaluate — Phase 4 (inline)</span>
          <span className="badge muted">Monitor — Phase 4 (drift)</span>
        </div>
      </div>

      {/* 4 — Lifecycle: promote/certify + archive/delete/version */}
      {canManage ? (
        <>
          <div className="section-title">Lifecycle</div>
          <div className="card">
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <div>
                <div className="comp-label">Promote up the ladder</div>
                <p className="hint" style={{ marginTop: 0 }}>
                  Promoting/certifying widens who can call <code>predict</code> — automatically, via the
                  compiled policy. No separate publish step.
                </p>
              </div>
              <PromoteButton
                id={model.model}
                kind="model"
                tier={ladderTier(model.tier)}
                promoteUrl={`/api/science/model/${encodeURIComponent(model.model)}/promote`}
                canApprove={canApprove}
                onDone={onChanged}
              />
            </div>
            <div className="row" style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)', justifyContent: 'flex-end' }}>
              <LifecycleActions
                id={model.model}
                name={model.name}
                kind="model"
                visibility={lcVis(model.tier)}
                archived={model.archived ?? false}
                api={`/api/science/model/${encodeURIComponent(model.model)}`}
                onChanged={onChanged}
                showVersions={false}
              />
            </div>
          </div>
        </>
      ) : null}

      {/* 5 — Developer escape hatch */}
      <div className="section-title">Developer</div>
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span className="muted">
            Drop into the raw Layer-4 stack — notebooks, the experiment registry, the feature store and the
            serving runtime.
          </span>
          <button className="btn ghost" onClick={onOpenConsole}>Open console →</button>
        </div>
      </div>
    </ConfirmProvider>
  );
}

function Kv({ k, v, mono = false }: { k: string; v: string; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span className="comp-label" style={{ marginBottom: 2 }}>{k}</span>
      <span className={mono ? 'mono' : undefined}>{v}</span>
    </div>
  );
}

const DECISION_CLS: Record<PredictResult['decision'], string> = {
  allow: 'ok',
  deny: 'err',
  requires_approval: 'warn',
};

/**
 * The "Try it" front door — the governed `predict` endpoint, generic over ANY
 * DEPLOYED model. Renders spec-driven feature inputs (the model's own feature
 * names) and scores through /api/science/predict AS THE SIGNED-IN USER. A model
 * that is not deployed yet gets an honest pointer to the Deploy step.
 */
function PredictPanel({ model }: { model: ModelSummary }) {
  const [result, setResult] = useState<PredictResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [features, setFeatures] = useState<Record<string, string>>({});
  const featureNames = model.spec?.features ?? [];
  const deployed = model.buildState === 'deployed' || model.buildState === 'monitored';

  const call = useCallback(async () => {
    setBusy(true);
    setErr('');
    try {
      const vector: Record<string, number> = {};
      for (const name of featureNames) {
        const v = Number(features[name]);
        vector[name] = Number.isFinite(v) ? v : 0;
      }
      const res = await fetch('/api/science/predict', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: model.model, account: 'sample-account', features: vector }),
      });
      const j = await res.json();
      if (!res.ok && res.status !== 202 && res.status !== 403) {
        setErr(j.error ?? `predict failed (${res.status})`);
      } else {
        setResult(j as PredictResult);
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [featureNames, features, model.model]);

  if (!deployed) {
    return (
      <div className="card">
        <div className="muted">
          No live serving endpoint for this model yet — train it, then use <strong>Deploy</strong> below to
          create its KServe endpoint and enable the governed <code>predict</code> front door.
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="muted" style={{ marginBottom: 10 }}>
        Call the governed <code>predict</code> service as yourself. It runs the compiled policy
        ({model.policy.tier} tier) + the OPA <code>predict</code> grant (the owner always may), then a
        Langfuse trace.
      </div>
      {featureNames.length ? (
        <div className="row" style={{ gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
          {featureNames.map((name) => (
            <label key={name} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span className="comp-label mono" style={{ fontSize: 11 }}>{name}</span>
              <input
                className="input sm mono"
                style={{ width: 130 }}
                type="number"
                placeholder="0"
                value={features[name] ?? ''}
                onChange={(e) => setFeatures((f) => ({ ...f, [name]: e.target.value }))}
              />
            </label>
          ))}
        </div>
      ) : null}
      <div className="row" style={{ gap: 10, alignItems: 'center' }}>
        <button className="btn sm" onClick={call} disabled={busy}>
          {busy ? <span className="spin" /> : 'Try it — predict'}
        </button>
        {result ? <span className={`badge ${DECISION_CLS[result.decision]}`}>OPA {result.decision}</span> : null}
      </div>
      {result ? (
        <div className="codeblock" style={{ marginTop: 12 }}>
          {[
            '{',
            `  decision:  "${result.decision}",`,
            `  frontDoor: "${result.frontDoor}",`,
            `  tier:      "${result.tier}",`,
            typeof result.score === 'number'
              ? `  score:     ${result.score.toFixed(3)},${result.band ? `  band: "${result.band}",` : ''}`
              : `  reason:    "${result.reason ?? ''}",`,
            `  source:    "${result.source ?? ''}",`,
            `  traceId:   "${result.traceId ?? ''}"`,
            '}',
          ].join('\n')}
        </div>
      ) : null}
      {err ? <div className="error" style={{ marginTop: 10 }}>{err}</div> : null}
    </div>
  );
}
