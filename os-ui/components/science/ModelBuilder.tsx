/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useUser } from '@/lib/useUser';
import { roleAtLeast } from '@/lib/core/session';
import { canManageArtifact } from '@/lib/governance/edit-scope';
import type { Visibility } from '@/lib/core/lifecycle';
import DomainTag from '@/components/DomainTag';
import { ConfirmProvider } from '@/components/lifecycle/ConfirmDialog';
import LifecycleActions from '@/components/lifecycle/LifecycleActions';
import PromoteButton, { type PromoteTier } from '@/components/lifecycle/PromoteButton';
import StageShell from '@/components/core/StageShell';
import { initialStageState, markDone, goTo, type StageState } from '@/lib/core/stages';
import { SCI_STAGES, atLeast, type SciStageId, type SciCtx } from './stages';
import NewModel from './NewModel';
import TrainStep from './builder/TrainStep';
import DeployStep from './builder/DeployStep';
import PredictPanel from './PredictPanel';
import StageAssistant, { type ModelDefinition } from './StageAssistant';
import {
  TIER_BADGE, TIER_LABEL, TASK_LABEL, BUILD_STATE,
  type ModelSummary, type ModelGroups, type ModelBuildState, type PredictResult,
} from './shared';

/** Model tier → the OS-wide lifecycle visibility (drives the delete gate). */
const lcVis = (tier: ModelSummary['tier']): Visibility =>
  tier === 'Domain' ? 'shared' : tier === 'Marketplace' ? 'certified' : 'personal';
/** Model tier → the shared ladder tier the PromoteButton speaks. */
const ladderTier = (tier: ModelSummary['tier']): PromoteTier =>
  tier === 'Domain' ? 'Shared' : tier === 'Marketplace' ? 'Marketplace' : 'Personal';

/** The reachable stage that matches a persisted buildState (open an existing model there). */
function openStageFor(bs: ModelBuildState | undefined): SciStageId {
  if (!bs) return 'define';
  if (bs === 'deployed' || bs === 'monitored') return 'monitor';
  if (atLeast(bs, 'trained')) return 'deploy';
  if (bs === 'training') return 'train';
  return 'define';
}

/**
 * The Science guided builder — Define · Train · Deploy · Predict · Monitor on the OS-wide
 * staged primitive (lib/core/stages.ts + components/core/StageShell.tsx; the Dashboards
 * builder is the reference adoption). Creating AND operating a model are ONE flow: a fresh
 * model starts on Define (registers a draft), then walks forward as its REAL persisted
 * `buildState` settles (draft → training → trained → deploying → deployed); an EXISTING
 * model opens at the stage matching its state. Each stage reuses the tab's existing bodies
 * as-is (NewModel, the P0 TrainStep + DeployStep, the generic PredictPanel, PromoteButton,
 * LifecycleActions) — nothing is rewritten, only re-hosted. Gating reads buildState directly.
 */
export default function ModelBuilder({
  existing,
  onBack,
  onChanged,
  onOpenConsole,
}: {
  /** Open an already-built model, or null to create a new one (starts on Define). */
  existing: ModelSummary | null;
  onBack: () => void;
  /** Refresh the tab's list after any lifecycle change. */
  onChanged: () => void;
  onOpenConsole: () => void;
}) {
  const { user } = useUser();

  // The model we operate on: the one opened, or the draft just created. Refreshed from the
  // governed list after train/deploy/lifecycle so buildState (the gate source) stays live.
  const [model, setModel] = useState<ModelSummary | null>(existing);
  const [predicted, setPredicted] = useState(false);
  const [lastResult, setLastResult] = useState<PredictResult | null>(null);
  const [defColumns, setDefColumns] = useState<string[]>([]);
  const [defPrefill, setDefPrefill] = useState<ModelDefinition | null>(null);
  const [defPrompt, setDefPrompt] = useState('');

  // Re-fetch this model from the governed list (single source of truth for buildState).
  const refresh = useCallback(async () => {
    onChanged();
    const id = model?.model;
    if (!id) return;
    try {
      const res = await fetch('/api/science/model?archived=1', { cache: 'no-store' });
      if (!res.ok) return;
      const data: ModelGroups = await res.json();
      const found = (data.models ?? []).find((m) => m.model === id);
      if (found) setModel(found);
    } catch { /* keep last-known model */ }
  }, [model?.model, onChanged]);

  const bs: ModelBuildState = model?.buildState ?? 'draft';

  const ctx: SciCtx = {
    hasSpec: !!model?.spec,
    buildState: bs,
    predicted,
  };

  // Open on the stage matching the model's state: a new model on Define, an existing one
  // at the furthest reached stage. Nothing pre-marked (the core primitive's rule).
  const [stage, setStage] = useState<StageState<SciStageId>>(() => {
    const base = initialStageState(SCI_STAGES);
    return existing ? { ...base, current: openStageFor(existing.buildState) } : base;
  });

  // Once a train/deploy transition lands the model in a new state, record the stage ✓ so the
  // rail reflects real progress (gated on the live condition by the core primitive).
  useEffect(() => {
    if (atLeast(bs, 'trained')) setStage((s) => markDone(s, 'train'));
    if (bs === 'deployed' || bs === 'monitored') setStage((s) => markDone(markDone(s, 'deploy'), 'monitor'));
  }, [bs]);

  const canManage = !!user && !!model && canManageArtifact(user, { owner: model.owner, domain: model.domain });
  const canApprove = !!user && roleAtLeast(user.role, 'builder');

  const lastMetric = useMemo(() => {
    if (typeof model?.metrics?.primary !== 'number') return '';
    return `${model.metrics.primaryMetric ?? model.spec?.optimizeMetric ?? 'metric'} ${model.metrics.primary.toFixed(3)}`;
  }, [model?.metrics, model?.spec?.optimizeMetric]);

  const badge = model ? BUILD_STATE[bs] : null;

  return (
    <ConfirmProvider>
      <button className="btn ghost sm" onClick={onBack} style={{ marginBottom: 14 }}>← All models</button>

      {model ? (
        <>
          <div className="row" style={{ alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <h2 style={{ margin: 0 }}>{model.name}</h2>
            {model.tier === 'Domain' || model.tier === 'Marketplace' ? <DomainTag domain={model.domain} /> : null}
            <span className={`badge ${TIER_BADGE[model.tier]}`}>{TIER_LABEL[model.tier]}</span>
            {badge ? (
              <span className="row" style={{ gap: 5, alignItems: 'center' }}>
                <span className={`status-dot ${badge.dot}`} />
                <span className="muted">{badge.label}</span>
              </span>
            ) : null}
          </div>
          <div className="tile-meta" style={{ marginTop: 6 }}>
            <span className="muted mono" style={{ fontSize: 12 }}>{model.model}</span>
            <span className="dot-sep">·</span>
            <span className="muted">owner {model.owner}</span>
            {model.spec ? <><span className="dot-sep">·</span><span className="muted">{TASK_LABEL[model.spec.taskType]}</span></> : null}
          </div>
        </>
      ) : (
        <h2 style={{ marginTop: 0 }}>New model</h2>
      )}

      <StageShell
        stages={SCI_STAGES}
        state={stage}
        ctx={ctx}
        onState={setStage}
        ariaLabel="Model stages"
        assistant={(st) =>
          st.id === 'define' && !model ? (
            <StageAssistant
              stage="define"
              label="Describe your goal — I’ll suggest a trainable task, target and features from the dataset’s columns."
              cta="Suggest a definition"
              disabled={defColumns.length === 0}
              payload={() => ({ prompt: defPrompt, columns: defColumns })}
              onDefinition={(def) => setDefPrefill(def)}
            />
          ) : st.id === 'train' ? (
            <StageAssistant
              stage="train"
              label="Explain a training failure in plain language."
              cta="Explain the failure"
              disabled={bs !== 'draft' && !model?.lastTrainingError}
              payload={() => ({ reason: model?.lastTrainingError ?? '' })}
            />
          ) : st.id === 'deploy' ? (
            <StageAssistant
              stage="deploy"
              label="Explain why the model couldn’t deploy."
              cta="Explain the failure"
              disabled={bs !== 'deploy_failed'}
              payload={() => ({ reason: model?.lastDeployError ?? '' })}
            />
          ) : st.id === 'predict' ? (
            <StageAssistant
              stage="predict"
              label="Interpret the last score against its risk band."
              cta="Interpret the score"
              disabled={!predicted || !lastResult}
              payload={() => ({ score: lastResult?.score, band: lastResult?.band, metric: model?.metrics?.primaryMetric })}
            />
          ) : st.id === 'monitor' ? (
            <StageAssistant
              stage="monitor"
              label="Interpret the model’s current health."
              cta="Interpret health"
              payload={() => ({ metric: lastMetric, drift: '' })}
            />
          ) : null
        }
      >
        {stage.current === 'define' ? (
          model ? (
            <div className="card">
              <div className="muted">
                This model is defined — <code>{model.spec?.sourceDataProductFqn}</code>,{' '}
                {model.spec ? TASK_LABEL[model.spec.taskType] : 'task'}. Continue to <strong>Train</strong> →.
              </div>
            </div>
          ) : (
            <>
              <div style={{ marginBottom: 10 }}>
                <label className="comp-label" htmlFor="mb-goal" style={{ display: 'block', marginBottom: 4 }}>Goal (optional — powers the assistant)</label>
                <input
                  id="mb-goal"
                  value={defPrompt}
                  onChange={(e) => setDefPrompt(e.target.value)}
                  placeholder="Predict which customers will churn next quarter"
                  style={{ width: '100%', maxWidth: 720 }}
                />
              </div>
              <NewModel
                prefill={defPrefill}
                onColumns={setDefColumns}
                onCreated={(m) => { setModel(m); setStage((s) => goTo(SCI_STAGES, markDone(s, 'define'), 'train', { ...ctx, hasSpec: true })); }}
              />
            </>
          )
        ) : null}

        {stage.current === 'train' ? (
          model?.spec ? (
            <TrainStep model={model} canManage={canManage} onChanged={refresh} />
          ) : (
            <div className="card"><div className="muted">Define a build spec before training this model.</div></div>
          )
        ) : null}

        {stage.current === 'deploy' ? (
          model?.spec ? (
            <DeployStep model={model} canManage={canManage} onChanged={refresh} />
          ) : (
            <div className="card"><div className="muted">Train the model before deploying it.</div></div>
          )
        ) : null}

        {stage.current === 'predict' ? (
          model ? (
            <PredictPanel
              model={model}
              onResult={(r) => { setLastResult(r); setPredicted(true); setStage((s) => markDone(s, 'predict')); }}
            />
          ) : null
        ) : null}

        {stage.current === 'monitor' && model ? (
          <MonitorStage
            model={model}
            lastMetric={lastMetric}
            canManage={canManage}
            canApprove={canApprove}
            onChanged={refresh}
            onOpenConsole={onOpenConsole}
            onDeleted={onBack}
          />
        ) : stage.current === 'monitor' ? (
          <div className="chat-empty">Deploy the model first — there is nothing to monitor yet.</div>
        ) : null}
      </StageShell>
    </ConfirmProvider>
  );
}

/* ─────────────────────────── Monitor ─────────────────────────── */

/**
 * The Monitor stage — the model's live health + its governance controls, all on a DEPLOYED
 * model. Metrics are the real registered headline number; drift telemetry is not wired to a
 * real monitor yet, so it is an HONEST placeholder (no fabricated drift charts). Lifecycle
 * reuses the shared PromoteButton + LifecycleActions exactly as ModelDetail did.
 */
function MonitorStage({
  model, lastMetric, canManage, canApprove, onChanged, onOpenConsole, onDeleted,
}: {
  model: ModelSummary;
  lastMetric: string;
  canManage: boolean;
  canApprove: boolean;
  onChanged: () => void;
  onOpenConsole: () => void;
  onDeleted: () => void;
}) {
  return (
    <div>
      <div className="section-title" style={{ marginTop: 4 }}>Metrics</div>
      <div className="card">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
          <Kv k="Headline metric" v={lastMetric || '— not recorded yet'} />
          <Kv k="Serving endpoint" v={model.kserveService ?? '—'} mono />
          <Kv k="Latest version" v={model.versions[0]?.version ?? '— none registered'} mono />
        </div>
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
        ) : null}
      </div>

      <div className="section-title">Drift</div>
      <div className="card" style={{ borderLeft: '3px solid var(--gold)' }}>
        <p style={{ marginTop: 0 }} className="muted">
          Live drift telemetry isn’t wired to a real monitor for this model yet — no fabricated
          charts here. Once a serving-side feature/label monitor is in place, input drift and
          prediction drift will render inline. The metric above is the model’s real registered score.
        </p>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <span className="badge muted">Input drift — not yet monitored</span>
          <span className="badge muted">Prediction drift — not yet monitored</span>
        </div>
      </div>

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
                handlers={{ onDelete: async () => {
                  const res = await fetch(`/api/science/model/${encodeURIComponent(model.model)}`, { method: 'DELETE' });
                  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Delete failed');
                  onChanged(); onDeleted();
                } }}
                onChanged={onChanged}
                showVersions={false}
              />
            </div>
          </div>
        </>
      ) : null}

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
    </div>
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
