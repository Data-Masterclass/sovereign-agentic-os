/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useEffect, useMemo, useState } from 'react';
import type { CleanDraft } from './StageAssistant';
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
import { inferColumnTypes, type TypeSuggestion } from '@/lib/data/infer-types';
import BuildResultDialog, { type BuildResult } from './BuildResultDialog';
import QueryError from './QueryError';

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
  silverBuilt,
  proposal,
  saveLabel,
  onCommitted,
  onContinue,
}: {
  datasetId: string;
  datasetName: string;
  owner: string;
  domain: string;
  tier: string;
  columns: string[];
  /** Whether a Silver version already exists. Drives the "already built ✓ — explore /
   *  rebuild" state so cleaning is never a one-shot black box (mirrors the Gold panel). */
  silverBuilt: boolean;
  /** An AI "Clean it up" proposal — applied into the guided controls when it arrives
   *  (never auto-builds; the user reviews and clicks Build). */
  proposal?: CleanDraft | null;
  /** The section's primary-action label. The simplified Data Edit surface names this
   *  section "Transformation" and passes "Save Transformations" so the section closes with
   *  one obvious verb; defaults to the classic "Build Silver version" when unset. */
  saveLabel?: string;
  /** Reload the dataset (record the ✓) WITHOUT auto-advancing — the caller may then also
   *  auto-materialize Gold (metrics need it). */
  onCommitted: (stages: unknown[]) => void;
  /** The user chose to move on — advance to the next stage. */
  onContinue: () => void;
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
  // `builtOk` shows the SUCCESS state (Silver built ✓ + preview + Continue) — set on a
  // live build in this session, and true on open when a Silver version already exists.
  const [builtOk, setBuiltOk] = useState(silverBuilt);

  const set = (c: string, patch: Partial<ColUI>) => setUi((m) => ({ ...m, [c]: { ...FRESH, ...m[c], ...patch } }));

  // TYPE AUTODETECT — read the governed 50-row Bronze preview once and infer each
  // column's likely type from the ACTUAL values (deterministic, lib/data/infer-types).
  // Bronze stays honest all-text; this is the approved-suggestion half: the user SEES
  // what the data looks like and clicks Apply — nothing is cast without approval.
  const [typeSuggestions, setTypeSuggestions] = useState<TypeSuggestion[]>([]);
  const [detectLoaded, setDetectLoaded] = useState(false);
  const [suggestionsDismissed, setSuggestionsDismissed] = useState(false);
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetch(`/api/data/datasets/${datasetId}/preview?layer=bronze&limit=50`, { cache: 'no-store' });
        const data = await res.json();
        if (!live || !res.ok || !data?.available) return;
        setTypeSuggestions(inferColumnTypes(data.columns ?? [], data.rows ?? []));
        setDetectLoaded(true);
      } catch { /* no preview → no suggestions; the manual dropdowns are unaffected */ }
    })();
    return () => { live = false; };
  }, [datasetId]);
  // Only suggest what the user hasn't decided: columns still at 'keep' and present.
  const openSuggestions = typeSuggestions.filter(
    (s) => cols.includes(s.column) && (ui[s.column] ?? FRESH).type === 'keep' && !(ui[s.column] ?? FRESH).drop,
  );
  const applySuggestions = () => {
    for (const s of openSuggestions) set(s.column, { type: s.type });
  };

  // Apply an AI "Clean it up" proposal into the guided controls when one arrives.
  // Junk-tolerant by construction: unknown columns and unknown casts are ignored, every
  // field falls back to its FRESH default. Fills the editors only — never builds.
  useEffect(() => {
    if (!proposal) return;
    const casts = new Set<string>(CAST_TYPES);
    // Cross-check AI casts against the DATA (the same detector the suggestions banner
    // uses). The model proposes from column NAMES — 'customer_id' reads numeric while
    // the values say 'CUS-2002', and that cast fails the build with a raw Trino
    // INVALID_CAST_ARGUMENT. A cast the sampled data contradicts falls back to text.
    // Only enforced once the preview actually loaded (no preview → trust the model,
    // as before — there is nothing to check against).
    const detected = new Map(typeSuggestions.map((t) => [t.column, t.type]));
    const dataAllows = (name: string, cast: CastType): boolean => {
      if (!detectLoaded || cast === 'varchar') return true;
      const d = detected.get(name);
      if (!d) return false; // mixed/text data — no lossless cast exists
      if (d === cast) return true;
      if (cast === 'double') return d === 'integer' || d === 'bigint'; // widening is safe
      if (cast === 'bigint') return d === 'integer';
      if (cast === 'timestamp') return d === 'date';
      return false;
    };
    for (const p of proposal.columns ?? []) {
      if (!p || typeof p.name !== 'string' || !cols.includes(p.name)) continue;
      const cast = p.cast && casts.has(p.cast) ? (p.cast as CastType) : null;
      set(p.name, {
        type: cast && dataAllows(p.name, cast) ? cast : 'keep',
        clean: p.clean === 'trim' || p.clean === 'normalize' ? p.clean : 'none',
        // Only IDENT-safe renames — a model-proposed name with a space/hyphen would
        // fail the compile and gray the Build button with no visible reason.
        rename: typeof p.rename === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(p.rename) ? p.rename : '',
        key: !!p.key,
        drop: !!p.drop,
      });
    }
    setDedupe(!!proposal.dedupe);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proposal]);

  // Target/source FQNs mirror the server's silverPlan: builds ALWAYS run in the
  // owner's personal lane (Bronze physically lives only there, for every tier); the
  // governed domain copy is refreshed by the publish CTAS after the build.
  const schema = personalSchema(owner);
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

  // The build OUTCOME announces itself as a CENTRAL modal (BuildResultDialog) —
  // the old bottom-right toast was easy to miss. Success offers the explicit
  // "Continue to Harmonize →" confirmation; failure shows the honest error big.
  const [buildResult, setBuildResult] = useState<BuildResult | null>(null);

  async function apply() {
    setErr(''); setReport(null); setBusy(true);
    try {
      const res = await fetch(`/api/data/datasets/${datasetId}/transform`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ops, columns: cols }),
      });
      const data = await res.json();
      if (!res.ok) {
        const msg = data.error ?? 'Could not build the Silver version';
        setErr(msg);
        setBuildResult({ ok: false, what: 'Silver', detail: msg });
        return;
      }
      if (data.build && !data.build.ok) {
        const msg = data.error ?? 'The transform did not pass';
        setReport(data.build); setErr(msg);
        setBuildResult({ ok: false, what: 'Silver', detail: msg });
        return;
      }
      // SUCCESS — the modal is the loud announcement (incl. the honest offline-preview
      // note); the panel underneath still shows the built state + preview, and the user
      // CHOOSES to continue from the modal — no auto-advance, no hunt for a button.
      setBuiltOk(true);
      onCommitted(data.stages ?? []);
      setBuildResult({
        ok: true,
        what: 'Transformation',
        detail: `${data.target ?? target} is live and queryable, and served for metrics automatically.`,
        offline: data.build?.mode === 'offline-mock',
      });
    } catch (e) {
      const msg = (e as Error).message;
      setErr(msg);
      setBuildResult({ ok: false, what: 'Silver', detail: msg });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="guided-panel">
      {/* Detected types — data-grounded suggestions, applied only on the user's click. */}
      {openSuggestions.length > 0 && !suggestionsDismissed ? (
        <div className="passthrough-note" style={{ marginBottom: 12 }}>
          <strong>Types detected from your data</strong>{' '}
          <span className="muted" style={{ fontSize: 13 }}>
            (from the first 50 source rows — every sampled value matched):
          </span>
          <div style={{ margin: '6px 0 0' }}>
            {openSuggestions.map((s) => (
              <span key={s.column} className="chip" style={{ marginRight: 8 }}>
                <code className="mono">{s.column}</code> → {s.type}
              </span>
            ))}
          </div>
          <div className="row" style={{ marginTop: 10, gap: 8 }}>
            <button className="btn sm" onClick={applySuggestions}>Apply suggested types</button>
            <button className="btn ghost sm" onClick={() => setSuggestionsDismissed(true)}>Dismiss</button>
          </div>
        </div>
      ) : null}

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
                      {/* Bronze is always all-text — the no-op option says so honestly
                          instead of an opaque "keep". */}
                      <select value={u.type} onChange={(e) => set(c, { type: e.target.value as ColUI['type'] })} disabled={u.drop}>
                        <option value="keep">text</option>
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

      {/* A compile problem DISABLES the Build button — say why right here, always
          (previously the reason hid inside the collapsed "Show the code" section,
          leaving a dead-looking button). */}
      {compiled.error && cols.length > 0 ? (
        <div className="error" style={{ marginTop: 12 }}>Can’t build yet — {compiled.error}</div>
      ) : null}

      {err ? <QueryError error={err} style={{ marginTop: 12 }} /> : null}
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
        {/* Clear IN-PROGRESS signal so a build never looks like "nothing happened". */}
        {busy ? <span className="hint" style={{ margin: 0 }}>Building Silver…</span> : null}
        {report?.mode === 'offline-mock' ? <span className="hint" style={{ margin: 0 }}>offline preview — no live table written</span> : null}
        <button className="btn primary" onClick={apply} disabled={busy || !!compiled.error}>
          {busy ? <span className="spin" /> : saveLabel ?? (builtOk ? 'Rebuild Silver version' : 'Build Silver version')}
        </button>
      </div>

      {/* SUCCESS state — the table exists. A calm confirmation; the full preview (with the
          layer toggle) lives in View, so Edit no longer repeats a preview here. Editing
          above + saving again keeps the definition reproducible. */}
      {builtOk ? (
        <div style={{ marginTop: 18, borderTop: '1px solid var(--border)', paddingTop: 16 }}>
          <div className="row" style={{ alignItems: 'center', gap: 8 }}>
            <span className="ok-note" style={{ fontWeight: 600 }}>Transformation saved ✓</span>
            <span className="hint" style={{ margin: 0 }}>
              <code className="mono">silver_{s}</code> is live. Edit above and save again to update it.
            </span>
          </div>
        </div>
      ) : null}

      {/* Central build-outcome popup — the honest success/failure announcement. */}
      {buildResult ? (
        <BuildResultDialog
          result={buildResult}
          onContinue={() => setBuildResult(null)}
          onClose={() => setBuildResult(null)}
        />
      ) : null}
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
  silverBuilt,
  proposal,
  saveLabel,
  onCommitted,
  onContinue,
}: {
  datasetId: string;
  datasetName: string;
  owner: string;
  domain: string;
  tier: string;
  columns: string[];
  silverBuilt: boolean;
  stage: Stage;
  /** An AI "Clean it up" proposal — filled into the guided controls when it arrives. */
  proposal?: CleanDraft | null;
  /** The section's primary-action label (e.g. "Save Transformations"). */
  saveLabel?: string;
  onCommitted: (stages: unknown[]) => void;
  onContinue: () => void;
}) {
  return (
    <SilverBuilder
      datasetId={datasetId}
      datasetName={datasetName}
      owner={owner}
      domain={domain}
      tier={tier}
      columns={columns}
      silverBuilt={silverBuilt}
      proposal={proposal}
      saveLabel={saveLabel}
      onCommitted={onCommitted}
      onContinue={onContinue}
    />
  );
}
