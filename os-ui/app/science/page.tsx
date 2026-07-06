/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useState } from 'react';
import PageHeader from '@/components/PageHeader';
import { useApi } from '@/lib/useApi';
import { useUser } from '@/lib/useUser';
import { useToolWindow } from '@/components/ToolWindowProvider';

// Layer-4 tools embeddable same-origin (lib/tool-proxy.ts). JupyterHub needs
// WebSockets (kernels) and KServe has no human UI, so those keep native links.
const EMBEDDABLE_SCIENCE: Record<string, string> = { mlflow: 'MLflow', featureform: 'Featureform' };
import { roleAtLeast } from '@/lib/session';
import type {
  ServiceModel,
  CompiledPredictPolicy,
  ModelTier,
  ConsumptionMode,
} from '@/lib/science/types';

/* ---------------------------------------------------------------- gate (A) */

type Svc = {
  key: string;
  label: string;
  blurb: string;
  consoleUrl: string;
  forward: string;
  up: boolean;
  detail: string;
};
type GateData = { mlEnabled: boolean; services: Svc[]; up: number; total: number };

/* ------------------------------------------------------------- churn (B) */

type Stage = {
  key: string;
  n: number;
  label: string;
  desc: string;
  backend: string;
  status: 'live' | 'ready' | 'pending';
  actor: 'Creator' | 'Builder' | 'User' | 'Platform';
};
type FeatureRow = { name: string; entity: string; offline: string; online: string };
type ChurnData = {
  model: string;
  dataProduct: string;
  featureSet: string;
  stages: Stage[];
  featuresLive: boolean;
  features: FeatureRow[];
  sample: { account: string; features: Record<string, number> };
};

/* ---------------------------------------------------- model-as-service (C–G) */

type ModelWithPolicy = ServiceModel & { policy: CompiledPredictPolicy };
type DriftPoint = { week: string; auc: number; psi: number; predictions: number };
type Drift = {
  live: boolean;
  series: DriftPoint[];
  threshold: number;
  retrainDue: boolean;
  latestPsi: number;
  latestAuc: number;
};
type Adapter = { name: string; kind: string; live: boolean };
type ModelData = {
  mlEnabled: boolean;
  gpuEnabled: boolean;
  models: ModelWithPolicy[];
  drift: Drift | null;
  adapters: Adapter[];
};

type PredictResult = {
  decision: 'allow' | 'deny' | 'requires_approval';
  frontDoor: 'rest' | 'mcp';
  tier: ModelTier;
  policy: string;
  model?: string;
  principal?: string;
  requestedBy?: string;
  account?: string;
  score?: number;
  band?: 'low' | 'medium' | 'high';
  source?: string;
  modelVersion?: string;
  reason?: string;
  traceId?: string;
};

type StepDecision = { decision: 'allow' | 'requires_approval' | 'blocked'; reason: string };
type AgentStep = { key: string; label: string; kind: string; adapter: string; decision: StepDecision };
type AgentResult = {
  goal: string;
  mode: string;
  preset: string;
  steps: AgentStep[];
  certifyAttempt: { blocked: boolean; reason: string };
};

/* ====================================================================== page */

export default function SciencePage() {
  const { data, loading, error, reload } = useApi<GateData>('/api/science');

  return (
    <>
      <PageHeader title="Science" crumb="Layer 4 — model-as-a-service (ML, not LLMs)" tutorial="science" />
      <div className="content">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <p className="lead" style={{ marginBottom: 0 }}>
            Traditional ML / data science as a <strong>governed service</strong>: explore in
            notebooks, build features (Featureform), train + track (MLflow), deploy for inference
            (KServe) — then expose the model through one endpoint with two front doors and{' '}
            <em>the same</em> visibility ladder that governs every other artifact. This is the{' '}
            <strong>Layer-4</strong> capability — off by default and GPU-cost-gated.
          </p>
          <button className="btn ghost" onClick={reload} disabled={loading}>
            {loading ? <span className="spin" /> : 'Refresh'}
          </button>
        </div>

        {error ? <div className="error" style={{ marginTop: 20 }}>{error}</div> : null}

        {loading && !data ? (
          <div className="stub-page" style={{ marginTop: 20 }}>Pinging Layer-4…</div>
        ) : data && !data.mlEnabled ? (
          <DisabledSurface />
        ) : data ? (
          <>
            <ServicesGrid data={data} />
            <ChurnSlice />
            <ModelService />
            <AgentPanel />
          </>
        ) : null}
      </div>
    </>
  );
}

/* ----------------------------------------------------------- A. disabled gate */

function DisabledSurface() {
  return (
    <>
      <div className="section-title">Science is off for this domain</div>
      <div className="card" style={{ borderLeft: '3px solid var(--gold)' }}>
        <p style={{ marginTop: 0 }}>
          <strong>Layer 4 (ML) is disabled.</strong> It is off by default and GPU-cost-gated —
          an <strong>Admin</strong> turns it on per domain when that team actually does data
          science. While it is off, no features, models, notebooks, or the governed{' '}
          <code>predict</code> service exist, and no GPU is reserved.
        </p>
        <div className="hint" style={{ marginTop: 4 }}>
          To enable for a domain, an Admin sets <code>ML_ENABLED=true</code> (or{' '}
          <code>ml.enabled=true</code> in the domain config) and the Layer-4 services come up. Then
          the full model-as-service flow — tier ladder, dual front doors, drift monitoring, and the
          two-mode ML agent — renders here.
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------ B. Layer-4 health grid */

function ServicesGrid({ data }: { data: GateData }) {
  const { openTool } = useToolWindow();
  return (
    <>
      <div className="section-title">
        Layer-4 stack
        <span className={`count-pill${data.up === data.total ? ' ok' : ' warn'}`}>
          {data.up}/{data.total} reachable
        </span>
      </div>
      <div className="grid">
        {data.services.map((s) => (
          <div className="card launch-card" key={s.key}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <div className="row" style={{ alignItems: 'center', gap: 9 }}>
                <span className={`status-dot ${s.up ? 'up' : 'down'}`} />
                <h3 style={{ margin: 0 }}>{s.label}</h3>
              </div>
              <span className={`badge ${s.up ? 'ok' : 'muted'}`}>{s.up ? 'reachable' : s.detail}</span>
            </div>
            <div className="muted" style={{ marginTop: 8 }}>{s.blurb}</div>
            <div className="codeblock">{s.forward}</div>
            <div className="row" style={{ marginTop: 10, justifyContent: 'flex-end' }}>
              {EMBEDDABLE_SCIENCE[s.key] ? (
                <button
                  className="btn"
                  onClick={() => openTool(s.key, EMBEDDABLE_SCIENCE[s.key])}
                  style={s.up ? undefined : { opacity: 0.6 }}
                >
                  Open {s.label}
                </button>
              ) : (
                <a
                  className="btn ghost"
                  href={s.consoleUrl}
                  target="_blank"
                  rel="noreferrer"
                  style={s.up ? undefined : { opacity: 0.6 }}
                >
                  Open {s.label} →
                </a>
              )}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

/* --------------------------------------------------- B. guided new-model flow */

function ChurnSlice() {
  const { data, loading, error } = useApi<ChurnData>('/api/science/churn');

  if (error) return <div className="error">{error}</div>;
  if (loading || !data) {
    return (
      <>
        <div className="section-title">Features</div>
        <div className="stub-page" style={{ marginTop: 8 }}>Loading the feature set…</div>
      </>
    );
  }

  return (
    <>
      <div className="section-title">
        Features — <code>{data.featureSet}</code>
        <span className={`count-pill${data.featuresLive ? ' ok' : ''}`}>
          {data.featuresLive ? 'Featureform live' : 'seed'}
        </span>
      </div>
      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>Feature</th>
              <th>Entity</th>
              <th>Offline (Iceberg)</th>
              <th>Online (Valkey)</th>
            </tr>
          </thead>
          <tbody>
            {data.features.length === 0 ? (
              <tr>
                <td className="muted" colSpan={4}>
                  No features registered yet — the guided flow defines them in Featureform.
                </td>
              </tr>
            ) : (
              data.features.map((f) => (
                <tr key={f.name}>
                  <td><code>{f.name}</code></td>
                  <td>{f.entity}</td>
                  <td className="muted">{f.offline}</td>
                  <td className="muted">{f.online}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ============================================ C–G. model-as-service section */

const TIERS: ModelTier[] = ['Personal', 'Domain', 'Marketplace'];
const TIER_VIS: Record<ModelTier, string> = {
  Personal: 'vis-personal',
  Domain: 'vis-shared',
  Marketplace: 'vis-certified',
};

function ModelService() {
  const { data, loading, error, reload } = useApi<ModelData>('/api/science/model');
  const model = data?.models?.[0];

  if (loading && !data) {
    return (
      <>
        <div className="section-title">Model as a service</div>
        <div className="stub-page" style={{ marginTop: 8 }}>Loading the model service…</div>
      </>
    );
  }
  if (error) return <div className="error">{error}</div>;
  if (!model) {
    // A fresh tenant has an empty model registry. Say so explicitly (rather than
    // rendering nothing) so the tier ladder / front doors / monitoring don't just
    // vanish without explanation.
    return (
      <>
        <div className="section-title" style={{ marginTop: 28 }}>Model as a service</div>
        <div className="stub-page" style={{ marginTop: 8 }}>
          No deployed models yet. Register one through the guided <strong>New model</strong> path
          above (or a platform seed); the tier ladder, both <code>predict</code> front doors, drift
          monitoring, and marketplace consumption appear here once a model exists.
        </div>
      </>
    );
  }

  return (
    <>
      <TierLadder model={model} reload={reload} gpuEnabled={data?.gpuEnabled ?? false} />
      <FrontDoors model={model} />
      {data?.drift ? <Monitoring drift={data.drift} model={model} reload={reload} /> : null}
      <Marketplace model={model} reload={reload} />
    </>
  );
}

/* ---------------------------------------------------------- C. tier ladder */

function TierLadder({
  model,
  reload,
  gpuEnabled,
}: {
  model: ModelWithPolicy;
  reload: () => void;
  gpuEnabled: boolean;
}) {
  const { user } = useUser();
  const isBuilder = !!user && roleAtLeast(user.role, 'builder');
  const isAdmin = user?.role === 'admin';

  const [busy, setBusy] = useState('');
  const [opErr, setOpErr] = useState('');
  const [certifyMode, setCertifyMode] = useState<ConsumptionMode>('read-in-place');

  const curIdx = TIERS.indexOf(model.tier);
  const p = model.policy;

  const runOp = useCallback(
    async (body: { op: string; mode?: ConsumptionMode }) => {
      setBusy(body.op);
      setOpErr('');
      try {
        const res = await fetch('/api/science/model', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: model.model, ...body }),
        });
        const j = await res.json();
        if (!res.ok) {
          setOpErr(j.error ?? `${body.op} failed (${res.status})`);
        } else {
          reload();
        }
      } catch (e) {
        setOpErr((e as Error).message);
      } finally {
        setBusy('');
      }
    },
    [model.model, reload],
  );

  return (
    <>
      <div className="section-title" style={{ marginTop: 28 }}>
        Model as a service — tier ladder
        <span className={`count-pill${gpuEnabled ? ' ok' : ''}`}>{gpuEnabled ? 'GPU on' : 'CPU'}</span>
      </div>
      <p className="muted" style={{ marginTop: -4 }}>
        <strong>{model.name}</strong> (<code>{model.model}</code>) is callable through both front
        doors at its <em>current</em> tier. Promoting or certifying widens who can call —
        automatically, via the compiled policy. There is no separate publish step.
      </p>

      {/* ladder */}
      <div className="card">
        <div className="row" style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {TIERS.map((t, i) => {
            const state = i < curIdx ? 'done' : i === curIdx ? 'current' : 'future';
            return (
              <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <span
                  className={`badge ${TIER_VIS[t]}`}
                  style={
                    state === 'current'
                      ? { boxShadow: '0 0 0 2px var(--gold-line)', fontWeight: 700 }
                      : state === 'future'
                        ? { opacity: 0.45 }
                        : undefined
                  }
                >
                  {t}
                  {state === 'current' ? ' • current' : ''}
                </span>
                {i < TIERS.length - 1 ? <span style={{ color: 'var(--text-faint)' }}>→</span> : null}
              </span>
            );
          })}
          <span className="badge muted" style={{ marginLeft: 'auto' }}>
            stage: {model.stage}
          </span>
        </div>

        {/* compiled callable scope */}
        <div className="comp-label" style={{ marginTop: 16 }}>Compiled callable scope (who can call predict)</div>
        <div className="codeblock" style={{ marginTop: 6 }}>
          {[
            '{',
            `  tier:              "${p.tier}",`,
            `  allowedDomains:    [${p.allowedDomains.map((d) => `"${d}"`).join(', ')}],`,
            `  allowedPrincipals: [${p.allowedPrincipals.map((d) => `"${d}"`).join(', ')}],`,
            `  crossDomain:       ${p.crossDomain},`,
            `  consumptionMode:   ${p.consumptionMode ? `"${p.consumptionMode}"` : 'null'}`,
            '}',
          ].join('\n')}
        </div>
        <div className="hint">
          {p.crossDomain
            ? 'Marketplace tier: any domain may call, subject to its own import grant.'
            : `Scoped to ${p.allowedDomains.length} domain(s) — promote to widen.`}
        </div>

        {/* lifecycle actions */}
        <div className="comp-actions" style={{ flexWrap: 'wrap' }}>
          <LifecycleButton
            label="Promote → Domain"
            busy={busy === 'promote'}
            disabled={model.tier !== 'Personal' || !isBuilder}
            note={
              model.tier !== 'Personal'
                ? 'Already Domain+'
                : !isBuilder
                  ? 'Builder promotes'
                  : 'Personal → Domain'
            }
            onClick={() => runOp({ op: 'promote' })}
          />
          <LifecycleButton
            label="Go-live → Production"
            busy={busy === 'go-live'}
            disabled={model.stage !== 'Staging' || !isBuilder}
            note={
              model.stage !== 'Staging'
                ? `stage ${model.stage}`
                : !isBuilder
                  ? 'Builder ships'
                  : 'Staging → Production'
            }
            onClick={() => runOp({ op: 'go-live' })}
          />
        </div>

        {/* Certify → Marketplace (Admin), with consumption-mode chooser */}
        <div
          className="row"
          style={{ alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)' }}
        >
          <div className="rt-seg" role="group" aria-label="Consumption mode">
            {(['read-in-place', 'fork-allowed'] as ConsumptionMode[]).map((m) => (
              <button
                key={m}
                type="button"
                className={`rt-seg-opt${certifyMode === m ? ' active' : ''}`}
                onClick={() => setCertifyMode(m)}
                disabled={model.tier === 'Marketplace'}
              >
                {m === 'read-in-place' ? 'Read-in-place' : 'Fork-allowed'}
              </button>
            ))}
          </div>
          <LifecycleButton
            label="Certify → Marketplace"
            busy={busy === 'certify'}
            disabled={model.tier !== 'Domain' || !isAdmin}
            note={
              model.tier === 'Marketplace'
                ? 'Certified'
                : model.tier !== 'Domain'
                  ? 'Promote to Domain first'
                  : !isAdmin
                    ? 'Admin certifies'
                    : `as ${certifyMode}`
            }
            onClick={() => runOp({ op: 'certify', mode: certifyMode })}
          />
        </div>

        {opErr ? <div className="error" style={{ marginTop: 12 }}>{opErr}</div> : null}
      </div>
    </>
  );
}

function LifecycleButton({
  label,
  note,
  busy,
  disabled,
  onClick,
}: {
  label: string;
  note: string;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <div style={{ display: 'inline-flex', flexDirection: 'column', gap: 3 }}>
      <button className="btn sm" onClick={onClick} disabled={disabled || busy}>
        {busy ? <span className="spin" /> : label}
      </button>
      <span className="hint" style={{ margin: 0, textAlign: 'center' }}>{note}</span>
    </div>
  );
}

/* ---------------------------------------------------------- D. dual front doors */

function FrontDoors({ model }: { model: ModelWithPolicy }) {
  const [rest, setRest] = useState<PredictResult | null>(null);
  const [mcp, setMcp] = useState<PredictResult | null>(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  const call = useCallback(async (door: 'rest' | 'mcp') => {
    setBusy(door);
    setErr('');
    const path = door === 'rest' ? '/api/science/predict/rest' : '/api/science/predict';
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ account: 'sample-account' }),
      });
      const j = await res.json();
      if (!res.ok && res.status !== 202 && res.status !== 403) {
        setErr(j.error ?? `predict failed (${res.status})`);
      } else if (door === 'rest') {
        setRest(j as PredictResult);
      } else {
        setMcp(j as PredictResult);
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy('');
    }
  }, []);

  return (
    <>
      <div className="section-title" style={{ marginTop: 28 }}>Two front doors — one endpoint, one policy</div>
      <p className="muted" style={{ marginTop: -4 }}>
        The same KServe model is reachable two ways. Both run the <em>identical</em> compiled policy
        ({model.policy.tier} tier) + OPA <code>predict</code> grant, then a Langfuse trace — REST and
        MCP can never diverge.
      </p>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
        <DoorCard title="REST API" who="Software app / external" door="rest" busy={busy === 'rest'} result={rest} onCall={() => call('rest')} />
        <DoorCard title="MCP tool" who="Agent (sales-assistant)" door="mcp" busy={busy === 'mcp'} result={mcp} onCall={() => call('mcp')} />
      </div>
      {err ? <div className="error" style={{ marginTop: 12 }}>{err}</div> : null}
    </>
  );
}

const DECISION_CLS: Record<PredictResult['decision'], string> = {
  allow: 'ok',
  deny: 'err',
  requires_approval: 'warn',
};

function DoorCard({
  title,
  who,
  door,
  busy,
  result,
  onCall,
}: {
  title: string;
  who: string;
  door: 'rest' | 'mcp';
  busy: boolean;
  result: PredictResult | null;
  onCall: () => void;
}) {
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ margin: 0 }}>{title}</h3>
        <span className="badge muted">{door}</span>
      </div>
      <div className="muted" style={{ marginTop: 6 }}>{who}</div>
      <div className="row" style={{ marginTop: 12, gap: 10, alignItems: 'center' }}>
        <button className="btn sm" onClick={onCall} disabled={busy}>
          {busy ? <span className="spin" /> : `Call as ${title}`}
        </button>
        {result ? <span className={`badge ${DECISION_CLS[result.decision]}`}>OPA {result.decision}</span> : null}
      </div>
      {result ? (
        <div className="codeblock" style={{ marginTop: 12 }}>
          {[
            '{',
            `  decision:  "${result.decision}",`,
            `  frontDoor: "${result.frontDoor}",`,
            `  principal: "${result.principal ?? ''}",`,
            result.requestedBy ? `  requestedBy: "${result.requestedBy}",  // your session` : '  requestedBy: null,  // your session',
            `  tier:      "${result.tier}",`,
            `  policy:    "${result.policy}",`,
            typeof result.score === 'number'
              ? `  score:     ${result.score.toFixed(3)},  band: "${result.band}",`
              : `  reason:    "${result.reason ?? ''}",`,
            `  traceId:   "${result.traceId}"`,
            '}',
          ].join('\n')}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------ E. monitoring */

function Monitoring({
  drift,
  model,
  reload,
}: {
  drift: Drift;
  model: ModelWithPolicy;
  reload: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const versions = model.versions ?? [];
  const newer = versions[0];
  const older = versions[1];

  async function retrain() {
    setBusy(true);
    setErr('');
    setMsg('');
    try {
      const res = await fetch('/api/science/model', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'retrain', model: model.model }),
      });
      const j = await res.json();
      if (!res.ok) setErr(j.error ?? `retrain failed (${res.status})`);
      else {
        setMsg(`Retrain triggered — ${j.retrain?.live ? 'Dagster run' : 'staged offline'} ${j.retrain?.runId ?? ''}`);
        reload();
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="section-title" style={{ marginTop: 28 }}>
        Monitoring — drift & retrain
        <span className={`count-pill${drift.retrainDue ? ' warn' : ' ok'}`}>
          {drift.retrainDue ? 'retrain due' : 'healthy'}
        </span>
      </div>
      <p className="muted" style={{ marginTop: -4 }}>
        The same signals the Monitoring tab watches, scoped to this model: feature drift (PSI) rising
        toward the retrain threshold while AUC sags. Latest PSI <strong>{drift.latestPsi.toFixed(3)}</strong>,
        AUC <strong>{drift.latestAuc.toFixed(3)}</strong>.
      </p>

      <div className="card">
        <DriftChart series={drift.series} threshold={drift.threshold} />
        <div className="canvas-legend" style={{ marginTop: 6 }}>
          <span><span className="legend-line" style={{ borderTopColor: 'var(--gold)' }} /> PSI (drift)</span>
          <span><span className="legend-line" style={{ borderTopColor: 'var(--teal)' }} /> AUC</span>
          <span><span className="legend-line ho" /> retrain threshold ({drift.threshold})</span>
        </div>
      </div>

      {/* version compare */}
      {newer && older ? (
        <div className="grid" style={{ marginTop: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
          {[newer, older].map((v) => (
            <div className="card" key={v.version}>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ margin: 0 }}>{model.model} <span className="muted">{v.version}</span></h3>
                <span className={`badge ${v.stage === 'Production' ? 'ok' : 'muted'}`}>{v.stage}</span>
              </div>
              <div className="muted" style={{ marginTop: 8 }}>
                AUC <strong>{v.auc.toFixed(3)}</strong> · run <code>{v.runId}</code>
              </div>
              {v.certified ? <span className="badge ok" style={{ marginTop: 8, display: 'inline-block' }}>certified</span> : null}
            </div>
          ))}
        </div>
      ) : null}

      <div className="row" style={{ marginTop: 14, gap: 10, alignItems: 'center' }}>
        <button className="btn" onClick={retrain} disabled={busy || !drift.retrainDue}>
          {busy ? <span className="spin" /> : 'Trigger retrain'}
        </button>
        {!drift.retrainDue ? <span className="hint" style={{ margin: 0 }}>Enabled when PSI crosses the threshold.</span> : null}
        {msg ? <span className="badge ok">{msg}</span> : null}
      </div>
      {err ? <div className="error" style={{ marginTop: 10 }}>{err}</div> : null}
      <div className="hint" style={{ marginTop: 8 }}>
        Cross-link: the <strong>Monitoring</strong> tab shows these same drift signals platform-wide.
      </div>
    </>
  );
}

function DriftChart({ series, threshold }: { series: DriftPoint[]; threshold: number }) {
  const W = 580;
  const H = 200;
  const pad = { l: 36, r: 36, t: 14, b: 26 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const n = series.length;
  const xAt = (i: number) => pad.l + (n > 1 ? (iw * i) / (n - 1) : 0);

  const psiMax = 0.3;
  const yPsi = (v: number) => pad.t + ih * (1 - Math.min(v, psiMax) / psiMax);
  const aucMin = 0.8;
  const aucMax = 0.9;
  const yAuc = (v: number) => pad.t + ih * (1 - (Math.min(Math.max(v, aucMin), aucMax) - aucMin) / (aucMax - aucMin));

  const psiLine = series.map((d, i) => `${i === 0 ? 'M' : 'L'}${xAt(i).toFixed(1)},${yPsi(d.psi).toFixed(1)}`).join(' ');
  const aucLine = series.map((d, i) => `${i === 0 ? 'M' : 'L'}${xAt(i).toFixed(1)},${yAuc(d.auc).toFixed(1)}`).join(' ');
  const base = pad.t + ih;
  const psiArea = `M${xAt(0).toFixed(1)},${base} ${series
    .map((d, i) => `L${xAt(i).toFixed(1)},${yPsi(d.psi).toFixed(1)}`)
    .join(' ')} L${xAt(n - 1).toFixed(1)},${base} Z`;
  const yThresh = yPsi(threshold);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: 'block' }} role="img" aria-label="PSI and AUC drift over 8 weeks">
      {[0, 0.25, 0.5, 0.75, 1].map((g) => {
        const y = pad.t + ih * g;
        return <line key={g} x1={pad.l} y1={y} x2={W - pad.r} y2={y} stroke="var(--border)" strokeWidth={1} />;
      })}
      <line x1={pad.l} y1={yThresh} x2={W - pad.r} y2={yThresh} stroke="var(--text-faint)" strokeWidth={1} strokeDasharray="5 4" />
      <path d={psiArea} fill="var(--gold-soft)" stroke="none" />
      <path d={psiLine} fill="none" stroke="var(--gold)" strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
      <path d={aucLine} fill="none" stroke="var(--teal)" strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
      {series.map((d, i) => (
        <text key={d.week} x={xAt(i)} y={H - 8} textAnchor="middle" fontSize={9} fill="var(--text-faint)">
          {d.week}
        </text>
      ))}
    </svg>
  );
}

/* --------------------------------------------------------- G. marketplace */

function Marketplace({ model, reload }: { model: ModelWithPolicy; reload: () => void }) {
  const { user } = useUser();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ mode: string } | null>(null);
  const [err, setErr] = useState('');

  const certified = model.tier === 'Marketplace';

  async function importToDomain() {
    setBusy(true);
    setErr('');
    setResult(null);
    try {
      const res = await fetch('/api/science/model', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'import', model: model.model }),
      });
      const j = await res.json();
      if (!res.ok) setErr(j.error ?? `import failed (${res.status})`);
      else {
        setResult(j.import ?? null);
        reload();
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="section-title" style={{ marginTop: 28 }}>
        Marketplace consumption
        <span className={`count-pill${certified ? ' ok' : ''}`}>{certified ? 'certified' : 'not yet certified'}</span>
      </div>
      <div className="card">
        {certified ? (
          <>
            <div className="muted">
              Certified into the Marketplace as{' '}
              <span className={`badge ${model.consumptionMode === 'fork-allowed' ? 'warn' : 'ok'}`}>
                {model.consumptionMode ?? 'read-in-place'}
              </span>
              .{' '}
              {model.consumptionMode === 'fork-allowed'
                ? 'Other domains may fork their own copy.'
                : 'Other domains call it in place — a grant, no copy.'}
            </div>
            <div className="row" style={{ marginTop: 12, gap: 10, alignItems: 'center' }}>
              <button className="btn sm" onClick={importToDomain} disabled={busy}>
                {busy ? <span className="spin" /> : `Import to ${user?.domains[0] ? `${user.domains[0]} domain` : 'your domain'}`}
              </button>
              {result ? (
                <span className={`badge ${result.mode === 'fork-allowed' ? 'warn' : 'ok'}`}>
                  {result.mode === 'fork-allowed' ? 'Forked a copy' : 'Granted — read in place'}
                </span>
              ) : null}
            </div>
            {err ? <div className="error" style={{ marginTop: 10 }}>{err}</div> : null}
          </>
        ) : (
          <div className="muted">
            Once an Admin certifies this model into the Marketplace, its consumption mode (read-in-place
            or fork-allowed) and an “Import to your domain” action appear here.
          </div>
        )}
      </div>
    </>
  );
}

/* ======================================================== F. two-mode ML agent */

const STEP_CLS: Record<StepDecision['decision'], string> = {
  allow: 'ok',
  requires_approval: 'warn',
  blocked: 'err',
};

function AgentPanel() {
  const [mode, setMode] = useState<'in-tab' | 'autonomous'>('in-tab');
  const [preset, setPreset] = useState<'read-propose' | 'bounded-writes'>('read-propose');
  const [gpuQuota, setGpuQuota] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [result, setResult] = useState<AgentResult | null>(null);

  async function run() {
    setBusy(true);
    setErr('');
    setResult(null);
    try {
      const res = await fetch('/api/science/agent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode, preset, gpuQuota }),
      });
      const j = await res.json();
      if (!res.ok) setErr(j.error ?? `agent failed (${res.status})`);
      else setResult(j as AgentResult);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="section-title" style={{ marginTop: 28 }}>ML agent — guided AutoML, two modes</div>
      <p className="muted" style={{ marginTop: -4 }}>
        The agent turns a goal into a plan (explore → features → train → register → deploy-to-Staging)
        and proposes each step under your chosen governance. It <strong>never ships</strong>: certify
        and go-live are always a human Builder.
      </p>

      <div className="card">
        <div className="row" style={{ gap: 18, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div>
            <div className="comp-label">Mode</div>
            <div className="rt-seg" role="group" aria-label="Agent mode">
              {(['in-tab', 'autonomous'] as const).map((m) => (
                <button key={m} type="button" className={`rt-seg-opt${mode === m ? ' active' : ''}`} onClick={() => setMode(m)}>
                  {m === 'in-tab' ? 'In-tab' : 'Autonomous'}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="comp-label">Preset</div>
            <div className="rt-seg" role="group" aria-label="Safety preset">
              {(['read-propose', 'bounded-writes'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`rt-seg-opt${preset === m ? ' active' : ''}`}
                  onClick={() => setPreset(m)}
                  disabled={mode === 'in-tab'}
                >
                  {m === 'read-propose' ? 'Read-propose' : 'Bounded-writes'}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="comp-label">GPU quota</div>
            <input
              type="text"
              inputMode="numeric"
              value={String(gpuQuota)}
              onChange={(e) => setGpuQuota(Number(e.target.value.replace(/[^0-9]/g, '')) || 0)}
              style={{ width: 90 }}
            />
          </div>
          <button className="btn" onClick={run} disabled={busy}>
            {busy ? <span className="spin" /> : 'Run agent'}
          </button>
        </div>

        {err ? <div className="error" style={{ marginTop: 12 }}>{err}</div> : null}

        {result ? (
          <>
            <div style={{ display: 'grid', gap: 8, marginTop: 16 }}>
              {result.steps.map((s) => (
                <div className="golden" key={s.key}>
                  <span className="ico" style={{ fontSize: 12 }}>{s.adapter}</span>
                  <div style={{ flex: 1 }}>
                    <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                      <div style={{ fontWeight: 600 }}>{s.label}</div>
                      <span className={`badge ${STEP_CLS[s.decision.decision]}`}>{s.decision.decision}</span>
                    </div>
                    <div className="muted">{s.decision.reason}</div>
                  </div>
                </div>
              ))}
            </div>
            <div
              className="card"
              style={{
                marginTop: 14,
                borderColor: result.certifyAttempt.blocked ? 'var(--teal-dim)' : 'rgba(229,104,95,0.35)',
                borderLeft: `3px solid ${result.certifyAttempt.blocked ? 'var(--teal)' : 'var(--danger)'}`,
              }}
            >
              <div className="row" style={{ alignItems: 'center', gap: 8 }}>
                <span className={`badge ${result.certifyAttempt.blocked ? 'ok' : 'err'}`}>
                  {result.certifyAttempt.blocked ? 'certify blocked' : 'INVARIANT FAILED'}
                </span>
                <strong>The agent cannot certify or go-live — a human Builder ships.</strong>
              </div>
              <div className="muted" style={{ marginTop: 6 }}>{result.certifyAttempt.reason}</div>
            </div>
          </>
        ) : null}
      </div>
    </>
  );
}
