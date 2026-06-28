/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import PageHeader from '@/components/PageHeader';
import { useApi } from '@/lib/useApi';

type Svc = {
  key: string;
  label: string;
  blurb: string;
  consoleUrl: string;
  forward: string;
  up: boolean;
  detail: string;
};
type Data = { services: Svc[]; up: number; total: number };

export default function SciencePage() {
  const { data, loading, error, reload } = useApi<Data>('/api/science');

  return (
    <>
      <PageHeader title="Science" crumb="Layer 4 — features, models & notebooks (ML, not LLMs)" />
      <div className="content">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <p className="lead" style={{ marginBottom: 0 }}>
            Traditional ML / data science: work in notebooks (JupyterHub), build features
            (Featureform), train and track models (MLflow), and deploy them for inference
            (KServe). This is the <strong>Layer-4</strong> capability — off unless the domain
            does ML, so services below show as <em>absent</em> until enabled. Health is pinged
            server-side; consoles open in their own UI.
          </p>
          <button className="btn ghost" onClick={reload} disabled={loading}>
            {loading ? <span className="spin" /> : 'Refresh'}
          </button>
        </div>

        {error ? <div className="error" style={{ marginTop: 20 }}>{error}</div> : null}

        {data ? (
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
                    <span className={`badge ${s.up ? 'ok' : 'muted'}`}>
                      {s.up ? 'reachable' : s.detail}
                    </span>
                  </div>
                  <div className="muted" style={{ marginTop: 8 }}>{s.blurb}</div>
                  <div className="codeblock">{s.forward}</div>
                  <div className="row" style={{ marginTop: 10, justifyContent: 'flex-end' }}>
                    <a
                      className="btn ghost"
                      href={s.consoleUrl}
                      target="_blank"
                      rel="noreferrer"
                      style={s.up ? undefined : { opacity: 0.6 }}
                    >
                      Open {s.label} →
                    </a>
                  </div>
                </div>
              ))}
            </div>

            <div className="section-title">The ML golden path</div>
            <div style={{ display: 'grid', gap: 12 }}>
              {[
                { icon: '∿', label: 'Explore in a notebook', desc: 'JupyterHub against governed data' },
                { icon: '◆', label: 'Engineer features', desc: 'Define + serve features in Featureform' },
                { icon: '∑', label: 'Train & track', desc: 'Runs, params, and models in MLflow' },
                { icon: '⌁', label: 'Serve for inference', desc: 'Deploy the model behind KServe' },
              ].map((g) => (
                <div className="golden" key={g.label}>
                  <span className="ico">{g.icon}</span>
                  <div>
                    <div style={{ fontWeight: 600 }}>{g.label}</div>
                    <div className="muted">{g.desc}</div>
                  </div>
                </div>
              ))}
            </div>

            <div className="hint" style={{ marginTop: 16 }}>
              Set <code>JUPYTERHUB_URL</code>, <code>MLFLOW_URL</code>,{' '}
              <code>FEATUREFORM_URL</code>, <code>KSERVE_URL</code> to the in-cluster Services
              (server-side health) and the matching <code>*_CONSOLE_URL</code> for the browser
              links. Defaults assume Layer-4 is deployed in <code>agentic-os</code>.
            </div>
          </>
        ) : loading ? (
          <div className="stub-page" style={{ marginTop: 20 }}>Pinging Layer-4 services…</div>
        ) : null}
      </div>
    </>
  );
}
