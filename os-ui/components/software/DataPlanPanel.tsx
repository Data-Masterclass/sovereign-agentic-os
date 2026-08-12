/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';
import type { SuggestedDataset } from '@/lib/software/data-plan';
import { DUMMY_ROWS_DEFAULT } from '@/lib/software/data-plan';

/**
 * DataPlanPanel (0.6.101) — the SELF-CONTAINED data-resolution surface for the Software
 * builder. Given the CREATE-NEW datasets the Design assistant proposed (`suggestedDatasets`),
 * it lets the user resolve each need by creating a governed dataset EMPTY (schema only) or
 * with AI DUMMY rows so the story is demoable. BINDING an existing dataset is the separate
 * `suggestedGrants` card (prefer it — this panel only creates).
 *
 * Deliberately decoupled from the Design stage internals (it holds only its own local state
 * and POSTs the resolve route) so a follow-up wave can lift it into its own "Choose Context"
 * stage without untangling it. The host passes the datasets + the appId + an `onResolved`
 * callback (fired with the updated app after each create) so it can reload; nothing else.
 */

type Status = { state: 'idle' | 'busy' | 'done' | 'error'; detail?: string; warn?: string };

/** The resolve outcome the route returns (mirrors ResolveDataPlanResult; app is opaque here). */
type ResolveResult = {
  datasetId: string;
  datasetName: string;
  fill: SuggestedDataset['fill'];
  rowsPersisted: number;
  materialized: boolean;
  /** Whether it was promoted to a Domain asset (readable by ANY domain user). */
  promoted: boolean;
  /** LOUD owner-only warning when it stayed Personal (Creator / offline / failed publish). */
  warning?: string;
  app: unknown;
  error?: string;
};

export default function DataPlanPanel({
  appId,
  datasets,
  onResolved,
  onDismiss,
}: {
  appId: string;
  datasets: SuggestedDataset[];
  /** Fired with the updated app after a dataset is created + granted, so the host reloads. */
  onResolved: (app: unknown) => void;
  /** Drop the whole plan card locally (resolves nothing). */
  onDismiss?: () => void;
}) {
  // Per-item chosen fill, seeded from the assistant's proposal (default 'empty' — the safe,
  // no-generation choice). The user flips to 'dummy' when they want demoable rows.
  const [fills, setFills] = useState<Record<number, SuggestedDataset['fill']>>(() =>
    Object.fromEntries(datasets.map((d, i) => [i, d.fill])),
  );
  const [status, setStatus] = useState<Record<number, Status>>({});

  const resolve = async (i: number) => {
    const item = datasets[i];
    const fill = fills[i] ?? item.fill;
    setStatus((s) => ({ ...s, [i]: { state: 'busy' } }));
    try {
      const res = await fetch(`/api/apps/${appId}/data-plan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dataset: { ...item, fill } }),
      });
      const data = (await res.json().catch(() => ({}))) as ResolveResult;
      if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
      const madeIt =
        fill === 'dummy'
          ? `Created «${data.datasetName}» with ${data.rowsPersisted} sample row${data.rowsPersisted === 1 ? '' : 's'}${data.materialized ? '' : ' (offline — schema saved)'}`
          : `Created empty «${data.datasetName}» (schema only)`;
      // Promoted ⇒ a Domain asset ANY domain user can read through the app. Not promoted ⇒
      // it stayed Personal (owner-only) and we surface the LOUD warning the server returned.
      const detail = data.promoted
        ? `${madeIt}, promoted to a domain asset, and granted it — the app can read it for everyone in the domain.`
        : `${madeIt} and granted it.`;
      setStatus((s) => ({ ...s, [i]: { state: 'done', detail, warn: data.warning } }));
      onResolved(data.app);
    } catch (e) {
      setStatus((s) => ({ ...s, [i]: { state: 'error', detail: (e as Error).message } }));
    }
  };

  if (datasets.length === 0) return null;

  return (
    <div className="dpp">
      <div className="dpp-head">
        <span className="dpp-label">Data plan — resolve each need ({datasets.length})</span>
        {onDismiss ? (
          <button type="button" className="btn ghost sm" onClick={onDismiss}>Decline</button>
        ) : null}
      </div>
      <p className="dpp-hint">
        Each story below needs data. Prefer to <strong>Link an existing dataset</strong> (the grant card / “Suggested
        context” above) when one fits and the app only needs to read it. <strong>Create a new dataset</strong> here
        when the app owns/writes its own data or you want dummy rows to build against — <strong>empty</strong>{' '}
        (schema only) or with realistic <strong>sample data</strong> so it’s demoable. Created datasets are real,
        governed, in your personal lane, and clearly labelled sample.
      </p>
      <ul className="dpp-list">
        {datasets.map((d, i) => {
          const st = status[i] ?? { state: 'idle' };
          const fill = fills[i] ?? d.fill;
          const done = st.state === 'done';
          return (
            <li key={`${d.name}:${i}`} className="dpp-item">
              <div className="dpp-item-head">
                <strong>{d.name}</strong>
                <span className="muted" style={{ fontSize: 12 }}>
                  {' '}· {d.columns.length} column{d.columns.length === 1 ? '' : 's'}
                </span>
                {d.purpose ? <span className="muted" style={{ fontSize: 12 }}> — {d.purpose}</span> : null}
              </div>
              <div className="dpp-cols">
                {d.columns.map((c) => (
                  <span key={c.name} className="dpp-col">
                    {c.name}<span className="muted"> :{c.type}</span>
                  </span>
                ))}
              </div>
              <div className="dpp-actions">
                <label className="dpp-fill">
                  <input
                    type="radio"
                    name={`fill-${i}`}
                    checked={fill === 'empty'}
                    disabled={done || st.state === 'busy'}
                    onChange={() => setFills((f) => ({ ...f, [i]: 'empty' }))}
                  />
                  Empty (schema only)
                </label>
                <label className="dpp-fill">
                  <input
                    type="radio"
                    name={`fill-${i}`}
                    checked={fill === 'dummy'}
                    disabled={done || st.state === 'busy'}
                    onChange={() => setFills((f) => ({ ...f, [i]: 'dummy' }))}
                  />
                  Sample data (~{d.rows ?? DUMMY_ROWS_DEFAULT} rows)
                </label>
                <button
                  type="button"
                  className="btn sm"
                  disabled={done || st.state === 'busy'}
                  onClick={() => void resolve(i)}
                >
                  {st.state === 'busy' ? <span className="spin" /> : done ? 'Created ✓' : 'Create & grant'}
                </button>
              </div>
              {st.detail ? (
                <div className={st.state === 'error' ? 'error' : 'muted'} style={{ fontSize: 12, marginTop: 4 }}>
                  {st.detail}
                </div>
              ) : null}
              {st.warn ? (
                <div className="dpp-warn" role="alert">
                  ⚠ {st.warn}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      <style jsx>{`
        .dpp {
          border: 1px solid var(--gold-line);
          background: var(--gold-soft);
          border-radius: 8px;
          padding: 10px 12px;
        }
        .dpp-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
        .dpp-label { font-weight: 600; font-size: 12.5px; }
        .dpp-hint { color: var(--text-muted); font-size: 12px; margin: 6px 0 8px; }
        .dpp-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
        .dpp-item { border-top: 1px solid var(--border); padding-top: 8px; }
        .dpp-item-head { font-size: 13px; }
        .dpp-cols { display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0 6px; }
        .dpp-col {
          font-size: 11px; font-family: var(--mono, monospace);
          border: 1px solid var(--border); border-radius: 4px; padding: 1px 5px;
          background: var(--panel);
        }
        .dpp-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
        .dpp-fill { display: flex; align-items: center; gap: 5px; font-size: 12.5px; cursor: pointer; }
        .dpp-warn {
          margin-top: 6px; font-size: 12px; line-height: 1.4;
          border: 1px solid var(--warn-line, #d0a24c); border-radius: 6px;
          background: var(--warn-soft, rgba(208, 162, 76, 0.12));
          color: var(--warn-text, #8a6116); padding: 6px 8px;
        }
      `}</style>
    </div>
  );
}
