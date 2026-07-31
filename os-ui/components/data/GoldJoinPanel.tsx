/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useEffect, useMemo, useState } from 'react';
import { useToast } from '@/components/core/Toast';
import {
  compileGoldJoin,
  personalSchema,
  slug,
  JOIN_TYPES,
  CAST_TYPES,
  type JoinType,
  type CastType,
  type GoldDimension,
  type JoinInput,
  type KeyAdapt,
} from '@/lib/data/transform';
import type { GoldSpec } from '@/lib/data/dataset-schema';
import { domainSchema } from '@/lib/data/store-fqn';
import GoldJoinGraph, { type JoinGraphTable, type JoinGraphEdge } from './GoldJoinGraph';
import ExplorePanel from './ExplorePanel';

/**
 * Gold JOIN builder — dataset REUSE (data-tab stage 4). Pick 1..n OTHER datasets you
 * can see, choose the join keys and project the columns → one governed CTAS writes
 * `gold_<slug>` in YOUR schema, reading each joined table AS YOU (so masking holds).
 * Measures are NOT defined here — they belong to the Publish stage (and the Metrics
 * tab), where governed measures are declared on top of the finished Gold table. Calm +
 * guided: the machinery (aliases, the exact SQL) stays hidden behind "Show the code"
 * until you ask for it; the Gold step lights only after the table is written into
 * Trino and a probe reads it back.
 */

type Joinable = { id: string; name: string; domain: string; tier: string; fqn: string; columns: string[] };
type BuildRow = { tool: string; status: 'ok' | 'fail'; detail: string; error?: string };
type BuildReport = { ok: boolean; rows: BuildRow[]; mode?: 'live' | 'offline-mock' };

/** `adaptMode` is the guided "adapt keys" choice: none (exact match), coerce both sides
 *  to a type, or normalize text. `adaptType` is the target type when `adaptMode==='cast'`. */
type JoinRow = { datasetId: string; type: JoinType; baseCol: string; joinCol: string; adaptMode: 'none' | 'cast' | 'text'; adaptType: CastType };
type DimRow = { source: string; as: string }; // source = "ref::column"

const NONE = '';

/** Re-hydrate the panel's editable rows from a stored {@link GoldSpec}. The stored spec
 *  IS the panel's own vocabulary (datasetId-keyed joins, `ref::column` dim refs),
 *  so this is a defaulting map, not a translation — an absent spec yields empty rows. */
function hydrateJoins(spec?: GoldSpec): JoinRow[] {
  return (spec?.joins ?? []).map((j) => ({
    datasetId: j.datasetId,
    type: j.type === 'left' ? 'left' : 'inner',
    baseCol: j.baseCol,
    joinCol: j.joinCol,
    adaptMode: j.adaptMode === 'cast' || j.adaptMode === 'text' ? j.adaptMode : 'none',
    adaptType: (CAST_TYPES as readonly string[]).includes(j.adaptType ?? '') ? (j.adaptType as CastType) : 'varchar',
  }));
}
function hydrateDims(spec?: GoldSpec): DimRow[] {
  return (spec?.dimensions ?? []).map((d) => ({ source: d.source, as: d.as ?? '' }));
}

/** Decode a "ref::column" select value into a ColRef, or null when unset. */
function colRef(v: string): { ref: number; column: string } | null {
  if (!v) return null;
  const i = v.indexOf('::');
  if (i < 0) return null;
  const ref = Number(v.slice(0, i));
  const column = v.slice(i + 2);
  if (!Number.isInteger(ref) || !column) return null;
  return { ref, column };
}

export default function GoldJoinPanel({
  datasetId,
  datasetName,
  owner,
  domain,
  tier,
  columns,
  silverBuilt,
  goldBuilt,
  initialSpec,
  onCommitted,
  onContinue,
}: {
  datasetId: string;
  datasetName: string;
  owner: string;
  domain: string;
  tier: string;
  columns: string[];
  /** Whether a Silver version exists yet. Gold is MATERIALIZED from Silver, so with no
   *  Silver the build is disabled and the panel says why (a calm prerequisite, not an
   *  error) — the same dependency `canBuildStage(versions, 'gold')` models server-side. */
  silverBuilt: boolean;
  /** Whether a Gold version already exists. Drives the "already built ✓ — explore /
   *  rebuild" state so the definition is never a one-shot black box. */
  goldBuilt: boolean;
  /** The stored raw Gold spec — RE-HYDRATES the joins/columns so an existing
   *  Gold definition stays visible + editable + rebuildable. Absent ⇒ a fresh build. */
  initialSpec?: GoldSpec;
  /** Reload the dataset (record the ✓) WITHOUT auto-advancing the stepper — the user
   *  stays on the Gold step to explore the result and chooses when to continue. */
  onCommitted: (stages: unknown[]) => void;
  /** The user chose to move on — advance to the next stage (Data Quality). */
  onContinue: () => void;
}) {
  const [joinable, setJoinable] = useState<Joinable[]>([]);
  const [loadErr, setLoadErr] = useState('');
  // Seed the editable state from the stored spec (re-hydration) so an existing Gold
  // definition opens visible + editable, not blank. A FRESH dataset opens with ALL
  // base columns kept by default — remove what you don't want (or clear and hand-pick).
  const [joins, setJoins] = useState<JoinRow[]>(() => hydrateJoins(initialSpec));
  const [dims, setDims] = useState<DimRow[]>(() =>
    initialSpec?.dimensions?.length
      ? hydrateDims(initialSpec)
      : Array.from(new Set(columns.filter(Boolean))).map((c) => ({ source: `0::${c}`, as: '' })),
  );
  const [showCode, setShowCode] = useState(false);
  const [err, setErr] = useState('');
  const [report, setReport] = useState<BuildReport | null>(null);
  const [busy, setBusy] = useState<'' | 'build' | 'pass'>('');
  // `builtOk` shows the SUCCESS state (Gold built ✓ + preview/stats + Continue) — set on
  // a live build in this session, and true on open when a Gold version already exists.
  const [builtOk, setBuiltOk] = useState(goldBuilt);
  const toast = useToast();

  // ALWAYS surface the build mode on success — a ✓ that silently ran as the
  // offline mock (no live table) must say so, not just the failure path.
  function announceMode(build: { mode?: string } | undefined, what: string) {
    if (build?.mode === 'offline-mock') {
      toast.info(`${what} recorded as an offline preview — no live table was written (cluster unreachable).`);
    } else {
      toast.success(`${what} written live to Trino — the table is queryable.`);
    }
  }

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/data/datasets/${datasetId}/joinable`, { cache: 'no-store' });
        const data = await res.json();
        if (!res.ok) { setLoadErr(data.error ?? 'Could not load datasets to join'); return; }
        setJoinable(data.datasets ?? []);
      } catch (e) { setLoadErr((e as Error).message); }
    })();
  }, [datasetId]);

  const baseCols = useMemo(() => Array.from(new Set(columns.filter(Boolean))), [columns]);
  const byId = useMemo(() => new Map(joinable.map((j) => [j.id, j])), [joinable]);

  // Only fully-specified joins take part — their ORDER fixes the table refs (base = 0,
  // the i-th active join = ref i+1), matching exactly how the server compiles the CTAS.
  const activeJoins = useMemo(
    () => joins.filter((j) => j.datasetId && j.baseCol && j.joinCol && byId.has(j.datasetId)),
    [joins, byId],
  );

  /** Column sources for the keep-columns pickers, refs aligned with activeJoins. */
  const sources = useMemo(() => {
    const out: { ref: number; label: string; columns: string[] }[] = [
      { ref: 0, label: `${datasetName} (this dataset)`, columns: baseCols },
    ];
    activeJoins.forEach((j, i) => {
      const d = byId.get(j.datasetId);
      out.push({ ref: i + 1, label: d?.name ?? j.datasetId, columns: d?.columns ?? [] });
    });
    return out;
  }, [datasetName, baseCols, activeJoins, byId]);

  const target = useMemo(() => {
    // Builds ALWAYS run in the owner's personal lane (see RefinePanel) — the domain
    // copy is refreshed by the publish CTAS after the build.
    const schema = personalSchema(owner);
    return `iceberg.${schema}.gold_${slug(datasetName)}`;
  }, [owner, datasetName]);

  // Visual join graph: the base + each fully-specified join as nodes, each key as a
  // labelled edge. Pure derivation of the guided state — updates as picks/keys change.
  const graphTables = useMemo<JoinGraphTable[]>(() => {
    const keptOf = (ref: number) => dims.filter((d) => colRef(d.source)?.ref === ref).length || undefined;
    const out: JoinGraphTable[] = [{ ref: 0, name: `${datasetName}`, base: true, kept: keptOf(0) }];
    activeJoins.forEach((j, i) => {
      out.push({ ref: i + 1, name: byId.get(j.datasetId)?.name ?? j.datasetId, kept: keptOf(i + 1) });
    });
    return out;
  }, [datasetName, activeJoins, byId, dims]);

  const graphEdges = useMemo<JoinGraphEdge[]>(() =>
    activeJoins.map((j, i) => ({
      fromRef: 0,
      toRef: i + 1,
      type: j.type,
      label: `${j.baseCol} = ${j.joinCol}`,
      adapted: j.adaptMode !== 'none',
    })), [activeJoins]);

  // Assemble the compiler inputs from the guided state (client preview == server plan).
  const spec = useMemo(() => {
    const schema = personalSchema(owner);
    const s = slug(datasetName);
    const source = `iceberg.${schema}.silver_${s}`;
    const jin: JoinInput[] = activeJoins.map((j) => {
      const adapt: KeyAdapt | undefined =
        j.adaptMode === 'cast' ? { mode: 'cast', type: j.adaptType }
          : j.adaptMode === 'text' ? { mode: 'text' }
            : undefined;
      return {
        table: byId.get(j.datasetId)!.fqn,
        type: j.type,
        on: [{ left: { ref: 0, column: j.baseCol }, right: j.joinCol, ...(adapt ? { adapt } : {}) }],
      };
    });
    const dimensions: GoldDimension[] = dims
      .map((d) => {
        const c = colRef(d.source);
        return c ? { col: c, ...(d.as.trim() ? { as: d.as.trim() } : {}) } : null;
      })
      .filter((x): x is GoldDimension => x !== null);
    // Measures are declared in the Publish stage (and the Metrics tab), never here —
    // Gold is a row-level projection/join, so the spec always carries an empty list.
    return { source, target, joins: jin, dimensions, measures: [] };
  }, [tier, owner, domain, datasetName, activeJoins, byId, dims, target]);

  // The RAW editable spec to PERSIST (the panel's own vocabulary) — only the active
  // (fully-specified) joins, so re-hydration reopens exactly what was built. Dims are
  // stored verbatim (their `ref::column` strings ARE the panel's row format).
  const rawSpec = useMemo<GoldSpec>(() => ({
    joins: activeJoins.map((j) => ({
      datasetId: j.datasetId,
      type: j.type,
      baseCol: j.baseCol,
      joinCol: j.joinCol,
      ...(j.adaptMode !== 'none' ? { adaptMode: j.adaptMode } : {}),
      ...(j.adaptMode === 'cast' ? { adaptType: j.adaptType } : {}),
    })),
    dimensions: dims.filter((d) => colRef(d.source)).map((d) => ({ source: d.source, ...(d.as.trim() ? { as: d.as.trim() } : {}) })),
    measures: [],
  }), [activeJoins, dims]);

  // A join is OPTIONAL. With zero joins this compiles a single-table Gold projection of
  // the Silver base — the compiler still requires at least one column or measure, so an
  // empty spec surfaces its own honest reason (no special-casing here).
  const compiled = useMemo(() => {
    try {
      return { sql: compileGoldJoin(spec), error: '' };
    } catch (e) {
      return { sql: '', error: (e as Error).message };
    }
  }, [spec]);

  function addJoin() {
    setJoins((j) => [...j, { datasetId: '', type: 'inner', baseCol: '', joinCol: '', adaptMode: 'none', adaptType: 'varchar' }]);
  }

  /** Fill every column of every current source (the base + each active join) that isn't
   *  already kept — the "start from everything, then prune" flow, join-aware. */
  function addAllColumns() {
    setDims((ds) => {
      const have = new Set(ds.map((d) => d.source));
      const missing = sources.flatMap((s) => s.columns.map((c) => `${s.ref}::${c}`)).filter((v) => !have.has(v));
      return [...ds.filter((d) => d.source), ...missing.map((v) => ({ source: v, as: '' }))];
    });
  }
  function patchJoin(i: number, patch: Partial<JoinRow>) {
    setJoins((js) => js.map((x, k) => (k === i ? { ...x, ...patch } : x)));
  }

  /** When a dataset is picked, auto-match keys with the SAME name (the one-click common
   *  case): if exactly one base column shares a name with a their-column, prefill both.
   *  The user can override; this just removes the busywork when names already agree. */
  function pickDataset(i: number, datasetId: string) {
    const picked = byId.get(datasetId);
    const theirs = new Set((picked?.columns ?? []).map((c) => c.toLowerCase()));
    const match = baseCols.find((c) => theirs.has(c.toLowerCase()));
    const theirCol = match ? (picked?.columns ?? []).find((c) => c.toLowerCase() === match.toLowerCase()) ?? '' : '';
    patchJoin(i, { datasetId, baseCol: match ?? '', joinCol: theirCol, adaptMode: 'none' });
  }

  async function build() {
    setErr(''); setReport(null); setBusy('build');
    try {
      const res = await fetch(`/api/data/datasets/${datasetId}/gold-join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          // spec.joins is built in activeJoins order, so refs stay aligned server-side.
          picks: spec.joins.map((j, i) => ({ datasetId: activeJoins[i].datasetId, type: j.type, on: j.on })),
          dimensions: spec.dimensions,
          measures: spec.measures,
          // The raw editable spec, persisted verbatim so the panel re-hydrates on reopen.
          goldSpec: rawSpec,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setErr(data.error ?? 'Could not build the Gold join'); return; }
      if (data.build && !data.build.ok) { setReport(data.build); setErr(data.error ?? 'The join did not pass'); return; }
      announceMode(data.build, 'Gold');
      // SUCCESS — stay on the Gold step (no auto-advance): show the built state + the
      // resulting gold table (preview + stats) so the user can explore, then CHOOSE to
      // continue. `onCommitted` reloads + records the ✓ only.
      setBuiltOk(true);
      onCommitted(data.stages ?? []);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function passThrough() {
    setErr(''); setBusy('pass');
    try {
      const res = await fetch(`/api/data/datasets/${datasetId}/version`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ layer: 'gold', passThrough: true }),
      });
      const data = await res.json();
      if (!res.ok) { setErr(data.error ?? 'Could not pass through'); return; }
      // A pass-through is a REAL CTAS copy now — an honest ✗ registers nothing.
      if (data.error || (data.build && !data.build.ok)) { setReport(data.build ?? null); setErr(data.error ?? 'The pass-through did not materialize'); return; }
      announceMode(data.build, 'Gold (pass-through)');
      setBuiltOk(true);
      onCommitted(data.stages ?? []);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(''); }
  }

  const SourceOptions = () => (
    <>
      {sources.map((s) => (
        <optgroup key={s.ref} label={s.label}>
          {s.columns.map((c) => <option key={`${s.ref}::${c}`} value={`${s.ref}::${c}`}>{c}</option>)}
        </optgroup>
      ))}
    </>
  );

  return (
    <div className="guided-panel">
      <p className="muted" style={{ marginTop: 0 }}>
        Make it business-ready. Keep the columns you want from{' '}
        <code className="mono">silver_{slug(datasetName)}</code> — and, optionally, <strong>reuse</strong> data you
        already trust by joining in other datasets you can see. It writes one governed Gold table
        (<code className="mono">gold_{slug(datasetName)}</code>) that only ever reads what you’re allowed to see.
        A join is optional; a single-table Gold is fine. Measures come later — you define them in
        the <strong>Publish</strong> stage, on top of this finished table.
      </p>

      {loadErr ? <div className="error">{loadErr}</div> : null}

      {/* Join to … (optional) */}
      <div className="section-title" style={{ marginTop: 8 }}>Join to <span className="muted" style={{ fontWeight: 400 }}>(optional)</span></div>
      {joinable.length === 0 && !loadErr ? (
        <div className="hint" style={{ marginTop: 0 }}>
          No shared datasets to reuse yet — that’s fine, you can still build a single-table Gold from your
          columns below. To join later, ask a colleague to share (promote) one, or promote your own.
        </div>
      ) : null}
      {joins.map((j, i) => {
        const picked = byId.get(j.datasetId);
        const keysChosen = !!j.baseCol && !!j.joinCol;
        const autoMatched = keysChosen && j.baseCol.toLowerCase() === j.joinCol.toLowerCase() && j.adaptMode === 'none';
        return (
          <div key={i} className="join-row" style={{ marginBottom: 10 }}>
            <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <select value={j.datasetId} onChange={(e) => pickDataset(i, e.target.value)}>
                <option value="">dataset…</option>
                {joinable.map((d) => <option key={d.id} value={d.id}>{d.name} · {d.domain}</option>)}
              </select>
              <select value={j.type} onChange={(e) => patchJoin(i, { type: e.target.value as JoinType })}>
                {JOIN_TYPES.map((t) => <option key={t} value={t}>{t === 'inner' ? 'inner join' : 'left join'}</option>)}
              </select>
              <span className="muted">on</span>
              <select value={j.baseCol} onChange={(e) => patchJoin(i, { baseCol: e.target.value })}>
                <option value="">this column…</option>
                {baseCols.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <span className="muted">=</span>
              <select value={j.joinCol} disabled={!picked} onChange={(e) => patchJoin(i, { joinCol: e.target.value })}>
                <option value="">their column…</option>
                {(picked?.columns ?? []).map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              {autoMatched ? <span className="chip ok" title="Keys with the same name matched automatically">auto-matched</span> : null}
              <button className="btn ghost sm" onClick={() => setJoins((js) => js.filter((_, k) => k !== i))}>Remove</button>
            </div>
            {/* Adapt keys — only surfaced once both keys are chosen (advanced-only). When
                the keys differ by type or text format, reconcile them so they line up. */}
            {keysChosen ? (
              <div className="row" style={{ gap: 8, alignItems: 'center', marginTop: 6, marginLeft: 4 }}>
                <span className="hint" style={{ margin: 0 }}>Keys don’t match?</span>
                <select value={j.adaptMode} onChange={(e) => patchJoin(i, { adaptMode: e.target.value as JoinRow['adaptMode'] })}>
                  <option value="none">they match as-is</option>
                  <option value="text">ignore case &amp; spacing</option>
                  <option value="cast">force to the same type</option>
                </select>
                {j.adaptMode === 'cast' ? (
                  <select value={j.adaptType} onChange={(e) => patchJoin(i, { adaptType: e.target.value as CastType })}>
                    {CAST_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
      <button className="btn ghost sm" onClick={addJoin} disabled={joinable.length === 0}>+ Add a dataset</button>

      {/* Visual join graph — how the chosen tables interconnect (keys as edges). */}
      <GoldJoinGraph tables={graphTables} edges={graphEdges} />

      {/* Keep columns — ALL columns are kept by default; remove the ones you don't
          want, or clear everything and hand-pick. */}
      <div className="section-title" style={{ marginTop: 16 }}>Keep columns</div>
      <p className="hint" style={{ marginTop: 0 }}>
        All columns are kept by default — remove the ones you don’t want, or <em>Remove all</em> and add just the ones you do.
      </p>
      {dims.map((d, i) => (
        <div className="row" key={i} style={{ gap: 8, marginBottom: 8, alignItems: 'center' }}>
          <select value={d.source} onChange={(e) => setDims((ds) => ds.map((x, k) => (k === i ? { ...x, source: e.target.value } : x)))}>
            <option value="">column…</option>
            <SourceOptions />
          </select>
          <span className="muted">as</span>
          <input value={d.as} placeholder="(same name)" style={{ maxWidth: 160 }}
            onChange={(e) => setDims((ds) => ds.map((x, k) => (k === i ? { ...x, as: e.target.value } : x)))} />
          <button className="btn ghost sm" onClick={() => setDims((ds) => ds.filter((_, k) => k !== i))}>Remove</button>
        </div>
      ))}
      <div className="row" style={{ gap: 8 }}>
        <button className="btn ghost sm" onClick={() => setDims((ds) => [...ds, { source: NONE, as: '' }])}>+ Add a column</button>
        <button className="btn ghost sm" onClick={addAllColumns}>Add all columns</button>
        <button className="btn ghost sm" onClick={() => setDims([])} disabled={dims.length === 0}>Remove all</button>
      </div>

      {/* Show the code — the exact governed CTAS this runs. */}
      <div style={{ marginTop: 14 }}>
        <button className={`btn ghost sm${showCode ? ' on' : ''}`} onClick={() => setShowCode((v) => !v)}>
          {showCode ? 'Hide the code' : '‹ › Show the code'}
        </button>
        {showCode ? (
          compiled.error ? (
            <div className="error" style={{ marginTop: 10 }}>{compiled.error}</div>
          ) : (
            <textarea className="mono" rows={8} value={compiled.sql} readOnly spellCheck={false} style={{ marginTop: 10 }} />
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

      {/* Gold is MATERIALIZED from Silver — with no Silver version the build is a calm,
          disabled prerequisite (not an error): say why, right where the action lives. */}
      {!silverBuilt ? (
        <div className="hint" style={{ marginTop: 14 }}>
          Build the <strong>Silver</strong> version first — Gold is materialized from Silver.
        </div>
      ) : null}

      <div className="row" style={{ marginTop: 14, gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
        {/* Clear IN-PROGRESS signal so a build never looks like "nothing happened". */}
        {busy === 'build' ? <span className="hint" style={{ margin: 0 }}>Building Gold…</span> : null}
        {report?.mode === 'offline-mock' ? <span className="hint" style={{ margin: 0 }}>offline preview — no live table written</span> : null}
        <button className="btn" onClick={build} disabled={busy !== '' || !silverBuilt || !!compiled.error}>
          {busy === 'build' ? <span className="spin" /> : builtOk ? 'Rebuild Gold version' : 'Build Gold version'}
        </button>
      </div>
      <p className="hint" style={{ textAlign: 'right' }}>
        The Gold step lights only after this Gold table is written into Trino and a probe reads it back — no faked check.
      </p>

      {/* SUCCESS state — the Gold table exists. Stay on the step: confirm it, let the user
          EXPLORE the result (preview + descriptive stats, governed + masked), and CHOOSE
          when to continue. Editing above + Rebuild keeps the definition reproducible. */}
      {builtOk ? (
        <div style={{ marginTop: 18, borderTop: '1px solid var(--border)', paddingTop: 16 }}>
          <div className="row" style={{ alignItems: 'center', gap: 8 }}>
            <span className="ok-note" style={{ fontWeight: 600 }}>Gold built ✓</span>
            <span className="hint" style={{ margin: 0 }}>
              <code className="mono">gold_{slug(datasetName)}</code> is live and queryable. Explore it below, or change the
              definition above and Rebuild.
            </span>
          </div>

          <div className="section-title" style={{ marginTop: 16 }}>Your Gold table</div>
          {/* Reuse the existing governed preview + profiling machinery — first rows +
              per-column type / completeness / distinct / range / top values, all masked. */}
          <ExplorePanel datasetId={datasetId} builtLayers={['gold']} />

          <div className="row" style={{ marginTop: 14, gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn" onClick={onContinue} disabled={busy !== ''}>Continue to Validate →</button>
          </div>
        </div>
      ) : null}

      <div className="passthrough-note">
        <strong>Already business-ready?</strong>{' '}
        Pass through — your <em>Silver</em> version carries forward as Gold unchanged.
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn ghost" onClick={passThrough} disabled={busy !== '' || !silverBuilt}>
            {busy === 'pass' ? <span className="spin" /> : 'Pass through Gold…'}
          </button>
        </div>
      </div>
    </div>
  );
}
