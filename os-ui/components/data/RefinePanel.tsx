/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useMemo, useState } from 'react';
import AgentChat from '@/components/AgentChat';
import {
  compileSilver,
  personalSchema,
  slug,
  CAST_TYPES,
  FILTER_OPS,
  type CastType,
  type FilterOp,
  type TransformOp,
} from '@/lib/data/transform';

type Layer = 'silver' | 'gold';
type Stage = { layer: Layer; copy: { title: string; subtitle: string; tool: string } };
type BuildRow = { tool: string; status: 'ok' | 'fail'; detail: string; error?: string };
type BuildReport = { ok: boolean; rows: BuildRow[]; mode?: 'live' | 'offline-mock' };

// Gold refinement is the JOIN builder (dataset reuse) — see GoldJoinPanel. This panel
// is the REAL Silver transform: guided ops → one governed CTAS.

// ------------------------------------------------------------------- Silver ops ---

type Clean = 'none' | 'trim' | 'normalize';
type ColUI = { type: 'keep' | CastType; clean: Clean; rename: string; key: boolean; drop: boolean };
type FilterUI = { column: string; op: FilterOp; value: string };

const FRESH: ColUI = { type: 'keep', clean: 'none', rename: '', key: false, drop: false };

function buildOps(cols: string[], ui: Record<string, ColUI>, filters: FilterUI[], dedupe: boolean): TransformOp[] {
  const ops: TransformOp[] = [];
  for (const c of cols) {
    const u = ui[c] ?? FRESH;
    if (u.drop) {
      ops.push({ kind: 'drop', column: c });
      continue;
    }
    if (u.clean !== 'none') ops.push({ kind: u.clean, column: c });
    if (u.type !== 'keep') ops.push({ kind: 'cast', column: c, type: u.type });
    if (u.rename.trim()) ops.push({ kind: 'rename', column: c, to: u.rename.trim() });
  }
  for (const f of filters) {
    if (!f.column) continue;
    ops.push(
      f.op === 'not_null' || f.op === 'not_blank'
        ? { kind: 'filter', column: f.column, op: f.op }
        : { kind: 'filter', column: f.column, op: f.op, value: f.value },
    );
  }
  if (dedupe) {
    const keys = cols.filter((c) => (ui[c] ?? FRESH).key && !(ui[c] ?? FRESH).drop);
    ops.push({ kind: 'dedupe', keys });
  }
  return ops;
}

function SilverBuilder({
  datasetId,
  datasetName,
  owner,
  domain,
  tier,
  columns,
  onCommitted,
}: {
  datasetId: string;
  datasetName: string;
  owner: string;
  domain: string;
  tier: string;
  columns: string[];
  onCommitted: (stages: unknown[]) => void;
}) {
  const [cols, setCols] = useState<string[]>(() => Array.from(new Set(columns.filter(Boolean))));
  const [ui, setUi] = useState<Record<string, ColUI>>({});
  const [filters, setFilters] = useState<FilterUI[]>([]);
  const [dedupe, setDedupe] = useState(false);
  const [newCol, setNewCol] = useState('');
  const [showCode, setShowCode] = useState(false);
  const [err, setErr] = useState('');
  const [report, setReport] = useState<BuildReport | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (c: string, patch: Partial<ColUI>) => setUi((m) => ({ ...m, [c]: { ...FRESH, ...m[c], ...patch } }));

  // Target/source FQNs mirror the server's silverPlan (personal schema for an
  // un-promoted dataset, else the domain) so the preview matches what runs.
  const schema = tier === 'dataset' ? personalSchema(owner) : domain;
  const s = slug(datasetName);
  const source = `iceberg.${schema}.bronze_${s}`;
  const target = `iceberg.${schema}.silver_${s}`;

  const ops = useMemo(() => buildOps(cols, ui, filters, dedupe), [cols, ui, filters, dedupe]);
  const compiled = useMemo(() => {
    if (cols.length === 0) return { sql: '', error: 'Add the Bronze columns you want to clean.' };
    try {
      return { sql: compileSilver({ source, target, columns: cols, ops }), error: '' };
    } catch (e) {
      return { sql: '', error: (e as Error).message };
    }
  }, [source, target, cols, ops]);

  function addColumn() {
    const name = newCol.trim();
    if (!name) return;
    setCols((c) => (c.includes(name) ? c : [...c, name]));
    setNewCol('');
  }

  async function apply() {
    setErr(''); setReport(null); setBusy(true);
    try {
      const res = await fetch(`/api/data/datasets/${datasetId}/transform`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ops, columns: cols }),
      });
      const data = await res.json();
      if (!res.ok) { setErr(data.error ?? 'Could not build the Silver version'); return; }
      if (data.build && !data.build.ok) { setReport(data.build); setErr(data.error ?? 'The transform did not pass'); return; }
      onCommitted(data.stages ?? []);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="guided-panel">
      <p className="muted" style={{ marginTop: 0 }}>
        Clean your Bronze columns — rename, set the type, tidy the text, drop what you don’t need,
        keep only the rows you want, and remove duplicates. It writes one governed table
        (<code className="mono">silver_{s}</code>) that only ever reads what you’re allowed to see.
      </p>

      {cols.length === 0 ? (
        <div className="hint" style={{ marginTop: 0 }}>No columns yet — add the ones your Bronze table has.</div>
      ) : (
        <div className="table-wrap" style={{ marginTop: 6 }}>
          <table>
            <thead>
              <tr>
                <th>Column</th><th>Type</th><th>Clean</th><th>Rename to</th><th>Key</th><th>Drop</th>
              </tr>
            </thead>
            <tbody>
              {cols.map((c) => {
                const u = ui[c] ?? FRESH;
                return (
                  <tr key={c} style={u.drop ? { opacity: 0.5 } : undefined}>
                    <td className="mono">{c}</td>
                    <td>
                      <select value={u.type} onChange={(e) => set(c, { type: e.target.value as ColUI['type'] })} disabled={u.drop}>
                        <option value="keep">keep</option>
                        {CAST_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </td>
                    <td>
                      <select value={u.clean} onChange={(e) => set(c, { clean: e.target.value as Clean })} disabled={u.drop}>
                        <option value="none">—</option>
                        <option value="trim">trim</option>
                        <option value="normalize">normalize</option>
                      </select>
                    </td>
                    <td>
                      <input value={u.rename} placeholder={c} disabled={u.drop} style={{ maxWidth: 150 }}
                        onChange={(e) => set(c, { rename: e.target.value })} />
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <input type="checkbox" checked={u.key} disabled={u.drop} onChange={(e) => set(c, { key: e.target.checked })} />
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <input type="checkbox" checked={u.drop} onChange={(e) => set(c, { drop: e.target.checked })} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="row" style={{ gap: 8, marginTop: 10, alignItems: 'center' }}>
        <input value={newCol} placeholder="add a column…" style={{ maxWidth: 200 }}
          onChange={(e) => setNewCol(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addColumn(); }} />
        <button className="btn ghost sm" onClick={addColumn} disabled={!newCol.trim()}>Add</button>
      </div>

      <label className="row" style={{ gap: 8, marginTop: 12, alignItems: 'center' }}>
        <input type="checkbox" checked={dedupe} onChange={(e) => setDedupe(e.target.checked)} />
        <span>Remove duplicate rows</span>
        <span className="hint" style={{ margin: 0 }}>
          {dedupe
            ? cols.some((c) => (ui[c] ?? FRESH).key)
              ? '— keep one row per checked Key.'
              : '— no Key checked: keep only fully-distinct rows.'
            : ''}
        </span>
      </label>

      {/* Keep rows where … (filters) */}
      <div className="section-title" style={{ marginTop: 16 }}>Keep rows where</div>
      {filters.map((f, i) => (
        <div className="row" key={i} style={{ gap: 8, marginBottom: 8, alignItems: 'center' }}>
          <select value={f.column} onChange={(e) => setFilters((fs) => fs.map((x, j) => (j === i ? { ...x, column: e.target.value } : x)))}>
            <option value="">column…</option>
            {cols.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <select value={f.op} onChange={(e) => setFilters((fs) => fs.map((x, j) => (j === i ? { ...x, op: e.target.value as FilterOp } : x)))}>
            {FILTER_OPS.map((o) => <option key={o} value={o}>{o === 'not_null' ? 'is not null' : o === 'not_blank' ? 'is not blank' : o}</option>)}
          </select>
          {f.op !== 'not_null' && f.op !== 'not_blank' ? (
            <input value={f.value} placeholder="value" style={{ maxWidth: 160 }}
              onChange={(e) => setFilters((fs) => fs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
          ) : null}
          <button className="btn ghost sm" onClick={() => setFilters((fs) => fs.filter((_, j) => j !== i))}>Remove</button>
        </div>
      ))}
      <button className="btn ghost sm" onClick={() => setFilters((fs) => [...fs, { column: '', op: '=', value: '' }])}>+ Add a condition</button>

      {/* Show the code — the exact governed CTAS this runs. */}
      <div style={{ marginTop: 14 }}>
        <button className={`btn ghost sm${showCode ? ' on' : ''}`} onClick={() => setShowCode((v) => !v)}>
          {showCode ? 'Hide the code' : '‹ › Show the code'}
        </button>
        {showCode ? (
          compiled.error ? (
            <div className="error" style={{ marginTop: 10 }}>{compiled.error}</div>
          ) : (
            <textarea className="mono" rows={7} value={compiled.sql} readOnly spellCheck={false} style={{ marginTop: 10 }} />
          )
        ) : null}
      </div>

      {err ? <div className="error" style={{ marginTop: 12 }}>{err}</div> : null}
      {report ? (
        <div className="table-wrap" style={{ marginTop: 10 }}>
          <table>
            <thead><tr><th>Step</th><th>Result</th><th>Detail</th></tr></thead>
            <tbody>
              {report.rows.map((r) => (
                <tr key={r.tool}>
                  <td className="mono">{r.tool}</td>
                  <td className={r.status === 'ok' ? 'ok-note' : 'error'}>{r.status === 'ok' ? '✓' : '✗'}</td>
                  <td>{r.error ?? r.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="row" style={{ marginTop: 14, gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
        {report?.mode === 'offline-mock' ? <span className="hint" style={{ margin: 0 }}>offline preview — no live table written</span> : null}
        <button className="btn" onClick={apply} disabled={busy || !!compiled.error}>
          {busy ? <span className="spin" /> : 'Build Silver version'}
        </button>
      </div>
      <p className="hint" style={{ textAlign: 'right' }}>
        The Silver step lights only after this table is written into Trino and a probe reads it back — no faked check.
      </p>

      <div className="section-title">Or ask the data agent</div>
      <AgentChat
        agent="data-product"
        label="data agent"
        minHeight={170}
        placeholder={`Tell the data agent how to clean “${datasetName}”…`}
        starters={[`Clean ${datasetName}: dedupe and set the key.`, `Type the columns in ${datasetName} and drop blanks.`]}
      />
    </div>
  );
}

/** The Silver refinement panel. (Gold refinement is the join builder, GoldJoinPanel.) */
export default function RefinePanel({
  datasetId,
  datasetName,
  owner,
  domain,
  tier,
  columns,
  onCommitted,
}: {
  datasetId: string;
  datasetName: string;
  owner: string;
  domain: string;
  tier: string;
  columns: string[];
  stage: Stage;
  onCommitted: (stages: unknown[]) => void;
}) {
  return (
    <SilverBuilder
      datasetId={datasetId}
      datasetName={datasetName}
      owner={owner}
      domain={domain}
      tier={tier}
      columns={columns}
      onCommitted={onCommitted}
    />
  );
}
