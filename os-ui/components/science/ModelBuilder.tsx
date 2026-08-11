/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useUser } from '@/lib/useUser';
import { roleAtLeast } from '@/lib/core/session';
import { canManageArtifact } from '@/lib/governance/edit-scope';
import type { Visibility } from '@/lib/core/lifecycle';
import { visibilityForTier } from '@/lib/core/artifact-model';
import DomainTag from '@/components/DomainTag';
import { ConfirmProvider } from '@/components/lifecycle/ConfirmDialog';
import LifecycleActions from '@/components/lifecycle/LifecycleActions';
import PromoteButton, { type PromoteTier } from '@/components/lifecycle/PromoteButton';
import DemoteButton from '@/components/lifecycle/DemoteButton';
import StageShell from '@/components/core/StageShell';
import { initialStageState, markDone, goTo, type StageState } from '@/lib/core/stages';
import BuilderModeToggle from '@/components/core/BuilderModeToggle';
import type { ViewMode } from '@/lib/core/view-mode';
import { phraseMetric } from '@/lib/science/ui-format';
import { SCI_STAGES, atLeast, type SciStageId, type SciCtx } from './stages';
import NewModel from './NewModel';
import LaunchStep from './builder/LaunchStep';
import PredictPanel from './PredictPanel';
import UsageChart from './UsageChart';
import ScienceChat, { type ModelDefinition } from './ScienceChat';
import { postJson } from './shared';
import {
  TIER_BADGE, TIER_LABEL, TASK_LABEL, BUILD_STATE,
  type ModelSummary, type ModelGroups, type ModelBuildState, type PredictResult, type ModelSpec,
} from './shared';

const SCI_MODE_KEY = 'science.viewMode';

const lcVis = (tier: ModelSummary['tier']): Visibility => visibilityForTier(tier);
const ladderTier = (tier: ModelSummary['tier']): PromoteTier =>
  tier === 'Domain' ? 'Shared' : tier === 'Marketplace' ? 'Marketplace' : 'Personal';

/** The reachable stage that matches a persisted buildState (open an existing model there). */
function openStageFor(bs: ModelBuildState | undefined): SciStageId {
  if (!bs) return 'design';
  if (bs === 'deployed') return 'monitor';
  return 'launch'; // training / trained / deploying / deploy_failed / archived all live in Launch
}

/**
 * The Science guided builder — Design · Launch · Monitor on the OS-wide staged primitive
 * (lib/core/stages.ts + components/core/StageShell.tsx). A fresh model starts on Design (a
 * prompt-first chat with a manual form behind progressive disclosure), walks to Launch (one
 * fused "Train & launch"), then Monitor (try it on a real row, health, real usage, govern). An
 * existing model opens at the stage matching its state. ONE persistent assistant chat is mounted
 * across every stage; it only proposes — every mutation goes through the governed routes on an
 * explicit Apply.
 */
export default function ModelBuilder({
  existing,
  onBack,
  onChanged,
  onOpenConsole,
}: {
  existing: ModelSummary | null;
  onBack: () => void;
  onChanged: () => void;
  onOpenConsole: () => void;
}) {
  const { user } = useUser();

  const [viewMode, setViewMode] = useState<ViewMode>('simple');
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const saved = window.localStorage.getItem(SCI_MODE_KEY);
    if (saved === 'simple' || saved === 'developer') setViewMode(saved as ViewMode);
  }, []);
  const setModePersisted = (m: ViewMode) => {
    setViewMode(m);
    if (typeof window !== 'undefined') window.localStorage.setItem(SCI_MODE_KEY, m);
  };
  const developer = viewMode === 'developer';

  const [model, setModel] = useState<ModelSummary | null>(existing);
  const [predicted, setPredicted] = useState(false);
  const [, setLastResult] = useState<PredictResult | null>(null);
  const [defPrefill, setDefPrefill] = useState<ModelDefinition | null>(null);
  const [pickedDataset, setPickedDataset] = useState<{ id: string; fqn: string; name: string } | null>(null);
  const [createErr, setCreateErr] = useState('');
  // Bumped by the Launch chat card's Apply → LaunchStep starts the fused train.
  const [launchNonce, setLaunchNonce] = useState(0);
  // Monitor try-it focus signal (the chat's "score an example" card scrolls to it).
  const tryItRef = useRef<HTMLDivElement | null>(null);

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
  const ctx: SciCtx = { hasSpec: !!model?.spec, buildState: bs, predicted };

  const [stage, setStage] = useState<StageState<SciStageId>>(() => {
    const base = initialStageState(SCI_STAGES);
    return existing ? { ...base, current: openStageFor(existing.buildState) } : base;
  });

  useEffect(() => {
    if (atLeast(bs, 'trained')) setStage((s) => markDone(s, 'launch'));
    if (bs === 'deployed') setStage((s) => markDone(markDone(s, 'launch'), 'monitor'));
  }, [bs]);

  const canManage = !!user && !!model && canManageArtifact(user, { owner: model.owner, domain: model.domain });
  const canApprove = !!user && roleAtLeast(user.role, 'builder');

  const lastMetric = useMemo(
    () => phraseMetric(model?.metrics?.primaryMetric ?? model?.spec?.optimizeMetric, model?.metrics?.primary),
    [model?.metrics, model?.spec?.optimizeMetric],
  );

  const badge = model ? BUILD_STATE[bs] : null;

  // Create a draft from a validated chat definition (Design → Apply). Goes through the SAME
  // governed create route the manual form uses — the assistant never mutates directly.
  const createFromDefinition = useCallback(async (def: ModelDefinition) => {
    setCreateErr('');
    // ALWAYS reflect the suggestion in the always-visible controls below (dataset + target +
    // inputs physically populate) so the user sees the assistant's choice and can tweak it.
    setDefPrefill(def);
    if (!def.datasetFqn || !def.targetColumn || !def.features?.length) {
      // Not enough to create outright → the populated form lets the user finish the choice.
      return;
    }
    const spec = {
      sourceDataProductFqn: def.datasetFqn,
      sourceDatasetId: def.datasetId,
      targetColumn: def.targetColumn,
      taskType: def.taskType ?? 'binary_classification',
      features: def.features,
    } as unknown as ModelSpec;
    try {
      const res = await postJson<{ model: ModelSummary; policy: ModelSummary['policy'] }>('/api/science/model', {
        op: 'create',
        name: def.datasetName ? `${def.datasetName} — ${def.targetColumn}` : def.targetColumn,
        spec,
      });
      const created = { ...res.model, policy: res.policy };
      setModel(created);
      setStage((s) => goTo(SCI_STAGES, markDone(s, 'design'), 'launch', { ...ctx, hasSpec: true }));
    } catch (e) {
      setCreateErr((e as Error).message);
    }
  }, [ctx]);

  const renameModel = useCallback(async () => {
    if (!model) return;
    const next = window.prompt('Rename model', model.name);
    if (next === null) return;
    const name = next.trim();
    if (!name || name === model.name) return;
    try {
      const res = await fetch(`/api/science/model/${encodeURIComponent(model.model)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'rename', name }),
      });
      if (!res.ok) { window.alert((await res.json().catch(() => ({}))).error ?? 'Rename failed'); return; }
      await refresh();
    } catch (e) { window.alert((e as Error).message); }
  }, [model, refresh]);

  const focusTryIt = useCallback(() => {
    tryItRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, []);

  // The Design assistant for a NEW model (no spec yet) is rendered ON TOP of the always-visible
  // form (not in StageShell's below-body slot), so the calm chat sits above the three controls.
  const designChatOnTop = (stageId: SciStageId) => stageId === 'design' && !model;

  const designChat = (
    <ScienceChat
      key="design"
      stage="design"
      modelId={undefined}
      datasetId={pickedDataset?.id}
      starters={['Which customers will churn', 'Expected order value next month']}
      onApplyDefinition={createFromDefinition}
    />
  );

  return (
    <ConfirmProvider>
      <div className="row" style={{ alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <button className="btn ghost sm" onClick={onBack}>← All models</button>
        <BuilderModeToggle
          mode={viewMode}
          onChange={setModePersisted}
          developerHint="The raw model training/serving spec + handles for this model"
        />
      </div>

      {model ? (
        <>
          <div className="row" style={{ alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <h2 style={{ margin: 0 }}>{model.name}</h2>
            {canManage ? (
              <button className="btn ghost sm" title="Rename this model (display name only — its serving key never changes)" onClick={renameModel}>✎ Rename</button>
            ) : null}
            {model.tier === 'Domain' || model.tier === 'Marketplace' ? <DomainTag domain={model.domain} /> : null}
            <span className={`badge ${TIER_BADGE[model.tier]}`}>{TIER_LABEL[model.tier]}</span>
            {badge ? (
              <span className="row" style={{ gap: 5, alignItems: 'center' }}>
                <span className={`status-dot ${badge.dot}`} />
                <span className="muted">{badge.label}</span>
              </span>
            ) : null}
            {canManage ? (
              <div style={{ marginLeft: 'auto' }}>
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
                    refresh(); onBack();
                  } }}
                  onChanged={refresh}
                  showVersions={false}
                  compact
                />
              </div>
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

      {developer && model ? (
        <ScienceDeveloperView model={model} />
      ) : null}

      <StageShell
        stages={SCI_STAGES}
        state={stage}
        ctx={ctx}
        onState={setStage}
        ariaLabel="Model stages"
        assistant={(st) =>
          // Design-for-a-new-model renders its assistant ON TOP of the always-visible form
          // (in the body) rather than here, so it isn't duplicated in the below-body slot.
          designChatOnTop(st.id) ? null : (
            <ScienceChat
              key={st.id}
              stage={st.id}
              modelId={model?.model}
              datasetId={st.id === 'design' ? pickedDataset?.id : undefined}
              starters={
                st.id === 'design'
                  ? ['Which customers will churn', 'Expected order value next month']
                  : st.id === 'launch'
                  ? ['What happens when I launch?']
                  : ['How is this model doing?']
              }
              onApplyDefinition={st.id === 'design' && !model ? createFromDefinition : undefined}
              onApplyLaunch={st.id === 'launch' && canManage ? () => setLaunchNonce((n) => n + 1) : undefined}
              onApplyScoreExample={st.id === 'monitor' ? focusTryIt : undefined}
            />
          )
        }
      >
        {stage.current === 'design' ? (
          model ? (
            <div className="card">
              <div className="muted">
                This model is defined — <code>{model.spec?.sourceDataProductFqn}</code>,{' '}
                {model.spec ? TASK_LABEL[model.spec.taskType] : 'task'}. Continue to <strong>Launch</strong> →.
              </div>
            </div>
          ) : (
            <div>
              <div className="card" style={{ borderLeft: '3px solid var(--gold)' }}>
                <div className="section-title" style={{ marginTop: 0 }}>Describe what you want to predict</div>
                <p className="muted" style={{ marginTop: -4, marginBottom: 0 }}>
                  Tell the assistant your goal in plain words — it reads your datasets’ columns and values,
                  then names a real dataset, the column to predict and the inputs to learn from. Its choice
                  drops straight into the controls below, where you can adjust anything before you create.
                </p>
              </div>

              {/* Assistant ON TOP, then the dataset / predictor / inputs controls ALWAYS visible. */}
              {designChat}

              {createErr ? <div className="error" style={{ marginTop: 10 }}>{createErr}</div> : null}

              <div style={{ marginTop: 12 }}>
                <NewModel
                  prefill={defPrefill}
                  developer={developer}
                  onDataset={setPickedDataset}
                  onCreated={(m) => { setModel(m); setStage((s) => goTo(SCI_STAGES, markDone(s, 'design'), 'launch', { ...ctx, hasSpec: true })); }}
                />
              </div>
            </div>
          )
        ) : null}

        {stage.current === 'launch' ? (
          model?.spec ? (
            <LaunchStep model={model} canManage={canManage} developer={developer} startNonce={launchNonce} onChanged={refresh} />
          ) : (
            <div className="card"><div className="muted">Design the model before launching it.</div></div>
          )
        ) : null}

        {stage.current === 'monitor' && model ? (
          <MonitorStage
            model={model}
            developer={developer}
            lastMetric={lastMetric}
            canManage={canManage}
            canApprove={canApprove}
            onChanged={refresh}
            onOpenConsole={onOpenConsole}
            tryItRef={tryItRef}
            onPredicted={(r) => { setLastResult(r); setPredicted(true); setStage((s) => markDone(s, 'monitor')); }}
          />
        ) : stage.current === 'monitor' ? (
          <div className="chat-empty">Launch the model first — there is nothing to monitor yet.</div>
        ) : null}
      </StageShell>
    </ConfirmProvider>
  );
}

/* ─────────────────────────── Developer surface ─────────────────────────── */

function ScienceDeveloperView({ model }: { model: ModelSummary }) {
  const raw = {
    model: model.model,
    buildState: model.buildState ?? 'draft',
    spec: model.spec ?? null,
    metrics: model.metrics ?? null,
    kserveService: model.kserveService ?? null,
    mlflowRunId: model.mlflowRunId ?? null,
    versions: model.versions,
    policy: model.policy,
    usage: model.usage ?? null,
    lastTrainingError: model.lastTrainingError ?? null,
    lastDeployError: model.lastDeployError ?? null,
  };
  return (
    <div className="grant-block" style={{ marginTop: 4, marginBottom: 4 }}>
      <div className="comp-label">Model spec &amp; policy (JSON)</div>
      <p className="hint" style={{ marginTop: 4 }}>
        Read-only — the training/serving spec registered in the science registry, plus the compiled OPA
        predict policy and real usage. Build state: <span className="mono">{model.buildState ?? 'draft'}</span>
        {model.kserveService ? <> · serving: <span className="mono">{model.kserveService}</span></> : null}
        {model.mlflowRunId ? <> · MLflow run: <span className="mono">{model.mlflowRunId}</span></> : null}
      </p>
      <pre className="codeblock" style={{ marginTop: 8, fontSize: 12, whiteSpace: 'pre-wrap', overflowX: 'auto' }}>
        {JSON.stringify(raw, null, 2)}
      </pre>
    </div>
  );
}

/* ─────────────────────────── Monitor ─────────────────────────── */

/**
 * The Monitor stage of a DEPLOYED model — (a) Try it on a real row, (b) live Health (ISVC ready
 * + the real registered metric), (c) real Usage (count/denied/last-called + a score-distribution
 * chart from `buckets`; honest empty state when nothing has been scored), (d) Govern (promote /
 * demote / lifecycle). No fabricated drift badges — monitoring is what actually exists.
 */
function MonitorStage({
  model, developer, lastMetric, canManage, canApprove, onChanged, onOpenConsole, tryItRef, onPredicted,
}: {
  model: ModelSummary;
  developer: boolean;
  lastMetric: string | null;
  canManage: boolean;
  canApprove: boolean;
  onChanged: () => void;
  onOpenConsole: () => void;
  tryItRef: React.RefObject<HTMLDivElement | null>;
  onPredicted: (r: PredictResult) => void;
}) {
  const usage = model.usage;
  const scored = usage ? Object.values(usage.buckets).reduce((n, day) => n + Object.values(day).reduce((a, b) => a + b, 0), 0) : 0;

  return (
    <div>
      <div className="section-title" style={{ marginTop: 4 }}>Try it</div>
      <div ref={tryItRef}>
        <PredictPanel model={model} developer={developer} onResult={onPredicted} />
      </div>

      <div className="section-title">Health</div>
      <div className="card">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
          <Kv k="Status" v={model.buildState === 'deployed' ? 'Live and serving' : (BUILD_STATE[model.buildState ?? 'draft'].label)} />
          <Kv k="Accuracy on held-back data" v={lastMetric ?? '— not recorded yet'} />
          <Kv k="Serving endpoint" v={model.kserveService ?? '—'} mono />
          <Kv k="Latest version" v={model.versions[0]?.version ?? '— none registered'} mono />
        </div>
        {developer && model.versions.length ? (
          <>
            <div className="comp-label" style={{ marginTop: 16 }}>Versions</div>
            <div className="tile-meta muted" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
              {model.versions.map((v) => (
                <span key={v.version}>
                  <code>{v.version}</code> · {v.stage} · {v.metricName ?? 'metric'} {(v.metric ?? v.auc).toFixed(3)}
                  {v.certified ? <span className="badge ok" style={{ marginLeft: 6 }}>certified</span> : null}
                </span>
              ))}
            </div>
          </>
        ) : null}
      </div>

      <div className="section-title">Usage</div>
      <div className="card">
        {usage && usage.count > 0 ? (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
              <Kv k="Predictions" v={String(usage.count)} />
              <Kv k="Denied by governance" v={String(usage.denied)} />
              <Kv k="Last called" v={usage.lastCalledAt ? new Date(usage.lastCalledAt).toLocaleString() : '—'} />
            </div>
            {scored > 0 ? (
              <>
                <div className="comp-label" style={{ marginTop: 16 }}>Score distribution</div>
                <UsageChart usage={usage} />
              </>
            ) : (
              <p className="hint" style={{ marginTop: 12 }}>
                Calls recorded, but none returned a score to chart yet (denied or unscored).
              </p>
            )}
          </>
        ) : (
          <p className="muted" style={{ margin: 0 }}>
            No predictions yet. Once this model is called — from Try it above, an app, or an agent — its usage
            and score distribution appear here.
          </p>
        )}
      </div>

      {canManage ? (
        <>
          <div className="section-title">Govern</div>
          <div className="card">
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <div>
                <div className="comp-label">Promote up the ladder</div>
                <p className="hint" style={{ marginTop: 0 }}>
                  Promoting/certifying widens who can call <code>predict</code> — automatically, via the compiled policy.
                </p>
              </div>
              <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <PromoteButton
                  id={model.model}
                  kind="model"
                  tier={ladderTier(model.tier)}
                  promoteUrl={`/api/science/model/${encodeURIComponent(model.model)}/promote`}
                  canApprove={canApprove}
                  onDone={onChanged}
                />
                <DemoteButton
                  kind="model"
                  tier={model.tier === 'Marketplace' ? 'Marketplace' : model.tier === 'Domain' ? 'Shared' : 'Personal'}
                  demoteUrl={`/api/science/model/${encodeURIComponent(model.model)}/demote`}
                  onDone={onChanged}
                />
              </div>
            </div>
          </div>
        </>
      ) : null}

      {developer ? (
        <>
          <div className="section-title">Developer</div>
          <div className="card">
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <span className="muted">Drop into the raw Layer-4 stack — notebooks, the experiment registry and the serving runtime.</span>
              <button className="btn ghost" onClick={onOpenConsole}>Open console →</button>
            </div>
          </div>
        </>
      ) : null}
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
