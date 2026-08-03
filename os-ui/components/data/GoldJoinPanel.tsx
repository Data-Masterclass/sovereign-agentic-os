/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  compileGoldJoin,
  personalSchema,
  slug,
  JOIN_TYPES,
  CAST_TYPES,
  MEASURE_OPS,
  type JoinType,
  type CastType,
  type GoldDimension,
  type GoldDerived,
  type MeasureOp,
  type JoinInput,
  type KeyAdapt,
} from '@/lib/data/transform';
import type { GoldSpec } from '@/lib/data/dataset-schema';
import { domainSchema } from '@/lib/data/store-fqn';
import GoldJoinGraph, { type JoinGraphTable, type JoinGraphEdge } from './GoldJoinGraph';
import AiAction from './StageAssistant';
import BuildResultDialog, { type BuildResult } from './BuildResultDialog';
import QueryError from './QueryError';

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
/** One row-level derived field: `name` = `left` (a "ref::column") `op` (`right` column |
 *  `rightValue` constant). `rightMode` toggles which of the two the row uses. */
type DerivedRow = { name: string; left: string; op: MeasureOp; rightMode: 'column' | 'const'; right: string; rightValue: string };

const NONE = '';

/** Friendly labels for the derived-field operators (the stored/compiled op stays the
 *  ASCII `+ - * /`; only the picker shows the math glyphs). */
const OP_LABEL: Record<MeasureOp, string> = { '+': '+', '-': '−', '*': '×', '/': '÷' };

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
/** Re-hydrate the derived rows from a stored spec (the panel's own `ref::column`
 *  vocabulary). A stored row with a `right` column is a column-op-column; one with a
 *  finite `rightValue` is a column-op-constant. */
function hydrateDerived(spec?: GoldSpec): DerivedRow[] {
  return (spec?.derived ?? []).map((d) => {
    const op = (MEASURE_OPS as readonly string[]).includes(d.op) ? (d.op as MeasureOp) : '+';
    const hasConst = typeof d.rightValue === 'number' && Number.isFinite(d.rightValue) && !d.right;
    return {
      name: d.name ?? '',
      left: d.left ?? '',
      op,
      rightMode: hasConst ? 'const' : 'column',
      right: d.right ?? '',
      rightValue: hasConst ? String(d.rightValue) : '',
    };
  });
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

/** Compile ONE editable derived row into a {@link GoldDerived}, or null when incomplete
 *  (no name / no left column / a constant that isn't a finite number). The server
 *  re-validates every field — this just keeps a half-filled row out of the preview. */
function derivedOf(r: DerivedRow): GoldDerived | null {
  const left = colRef(r.left);
  if (!r.name.trim() || !left) return null;
  if (r.rightMode === 'const') {
    const v = Number(r.rightValue);
    if (!r.rightValue.trim() || !Number.isFinite(v)) return null;
    return { name: r.name.trim(), left, op: r.op, right: { value: v } };
  }
  const right = colRef(r.right);
  if (!right) return null;
  return { name: r.name.trim(), left, op: r.op, right };
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
  curated = false,
  legacyJoins = false,
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
  /** Whether a Silver version exists yet. Gold is MATERIALIZED from Silver, so with no
   *  Silver the build is disabled and the panel says why (a calm prerequisite, not an
   *  error) — the same dependency `canBuildStage(versions, 'gold')` models server-side.
   *  IGNORED for a curated dataset (its base is an explicit dataset, not its own Silver). */
  silverBuilt: boolean;
  /** Whether a Gold version already exists. Drives the "already built ✓ — explore /
   *  rebuild" state so the definition is never a one-shot black box. */
  goldBuilt: boolean;
  /** The stored raw Gold spec — RE-HYDRATES the joins/columns so an existing
   *  Gold definition stays visible + editable + rebuildable. Absent ⇒ a fresh build. */
  initialSpec?: GoldSpec;
  /** CURATED mode: this dataset has no own Silver — it composes from existing governed
   *  datasets, so ref 0 is an EXPLICIT base dataset chosen here (not the own-silver base).
   *  The join section is always shown; pass-through Gold is hidden. */
  curated?: boolean;
  /** Legacy grandfathering: an ingested dataset whose STORED spec already has joins keeps
   *  the join editor visible (so nothing breaks), even though new ingested datasets hide
   *  it. Ignored when `curated` (curated always shows joins). */
  legacyJoins?: boolean;
  /** The section's primary-action label. Curated names this section "Composition" and
   *  passes "Save Composition"; unset falls back to the classic "Build Gold version". */
  saveLabel?: string;
  /** Reload the dataset (record the ✓) WITHOUT auto-advancing — the caller reloads the
   *  flat Edit surface in place. */
  onCommitted: (stages: unknown[]) => void;
  /** Retained for API compatibility (the simplified surface no longer shows a Continue
   *  button — every section is already visible in one scroll). */
  onContinue: () => void;
}) {
  const [joinable, setJoinable] = useState<Joinable[]>([]);
  const [loadErr, setLoadErr] = useState('');
  // CURATED base (ref 0): the explicit dataset this compose builds from. Seeded from the
  // stored spec's baseDatasetId so an existing curated definition reopens on the same base;
  // an ingested dataset never uses this (its base is its own Silver). Its columns replace
  // the base column source once its detail loads.
  const [baseId, setBaseId] = useState<string>(() => initialSpec?.baseDatasetId ?? '');
  const [baseCols0, setBaseCols0] = useState<string[]>([]);
  // Whether the join section is shown at all: curated always; ingested only when the stored
  // spec already carries joins (legacy grandfathering). New ingested datasets hide it.
  const showJoinSection = curated || legacyJoins;
  const [joins, setJoins] = useState<JoinRow[]>(() => hydrateJoins(initialSpec));
  const [dims, setDims] = useState<DimRow[]>(() =>
    initialSpec?.dimensions?.length
      ? hydrateDims(initialSpec)
      // A curated dataset's base columns aren't known until its base detail loads, so it
      // starts with no default kept columns; an ingested one keeps all its own columns.
      : curated
        ? []
        : Array.from(new Set(columns.filter(Boolean))).map((c) => ({ source: `0::${c}`, as: '' })),
  );
  // Derived fields (optional): row-level columns computed from joined columns. Seeded
  // from the stored spec so an existing definition reopens editable, else empty.
  const [derivedRows, setDerivedRows] = useState<DerivedRow[]>(() => hydrateDerived(initialSpec));
  const [showCode, setShowCode] = useState(false);
  const [err, setErr] = useState('');
  const [report, setReport] = useState<BuildReport | null>(null);
  const [busy, setBusy] = useState<'' | 'build'>('');
  // `builtOk` shows the SUCCESS state (Gold built ✓ + preview/stats + Continue) — set on
  // a live build in this session, and true on open when a Gold version already exists.
  const [builtOk, setBuiltOk] = useState(goldBuilt);

  // The build OUTCOME announces itself as a CENTRAL modal (BuildResultDialog) — the old
  // bottom-right toast was easy to miss. The simplified surface has every section visible
  // in one scroll, so there's no "Continue to …" step — success just confirms, big.
  const [buildResult, setBuildResult] = useState<BuildResult | null>(null);
  function announceMode(build: { mode?: string } | undefined, what: string) {
    setBuildResult({
      ok: true,
      what,
      detail: `${target} is live and queryable.`,
      offline: build?.mode === 'offline-mock',
    });
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

  const byId = useMemo(() => new Map(joinable.map((j) => [j.id, j])), [joinable]);

  // CURATED base columns (ref 0): the joinable list already carries each dataset's columns
  // (it is the same governed set the base can be picked from), so the base's columns come
  // from there. A fetch fallback covers the rare base that isn't in the joinable list.
  useEffect(() => {
    if (!curated || !baseId) { setBaseCols0([]); return; }
    const fromList = byId.get(baseId)?.columns ?? [];
    if (fromList.length) { setBaseCols0(fromList); return; }
    let live = true;
    (async () => {
      try {
        const res = await fetch(`/api/data/datasets/${baseId}`, { cache: 'no-store' });
        const d = await res.json();
        if (live && res.ok) {
          const cols = ((d?.dataset?.goldColumns?.length ? d.dataset.goldColumns : d?.dataset?.columns) ?? []) as { name: string }[];
          setBaseCols0(cols.map((c) => c.name).filter(Boolean));
        }
      } catch { if (live) setBaseCols0([]); }
    })();
    return () => { live = false; };
  }, [curated, baseId, byId]);

  // Ref 0 columns: the curated base's columns, else this ingested dataset's own columns.
  const baseCols = useMemo(
    () => Array.from(new Set((curated ? baseCols0 : columns).filter(Boolean))),
    [curated, baseCols0, columns],
  );

  // Only fully-specified joins take part — their ORDER fixes the table refs (base = 0,
  // the i-th active join = ref i+1), matching exactly how the server compiles the CTAS.
  const activeJoins = useMemo(
    () => joins.filter((j) => j.datasetId && j.baseCol && j.joinCol && byId.has(j.datasetId)),
    [joins, byId],
  );

  /** Column sources for the keep-columns pickers, refs aligned with activeJoins. Ref 0 is
   *  the curated BASE dataset (when curated), else this ingested dataset itself. */
  const sources = useMemo(() => {
    const baseLabel = curated
      ? (baseId ? `${byId.get(baseId)?.name ?? baseId} (base)` : 'base dataset — pick one')
      : `${datasetName} (this dataset)`;
    const out: { ref: number; label: string; columns: string[] }[] = [
      { ref: 0, label: baseLabel, columns: baseCols },
    ];
    activeJoins.forEach((j, i) => {
      const d = byId.get(j.datasetId);
      out.push({ ref: i + 1, label: d?.name ?? j.datasetId, columns: d?.columns ?? [] });
    });
    return out;
  }, [curated, baseId, datasetName, baseCols, activeJoins, byId]);

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
    // Ref 0 source: a curated compose reads its EXPLICIT base's physical table (from the
    // joinable list, the same FQN the server resolves via assetTarget); an ingested one
    // reads its own frozen Silver. An unpicked curated base yields an empty source, so the
    // client compile shows an honest "pick a base" error rather than a phantom FQN.
    const source = curated ? (byId.get(baseId)?.fqn ?? '') : `iceberg.${schema}.silver_${s}`;
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
    const derived: GoldDerived[] = derivedRows
      .map(derivedOf)
      .filter((x): x is GoldDerived => x !== null);
    // Measures are declared in the Publish stage (and the Metrics tab), never here —
    // Gold is a row-level projection/join, so the spec always carries an empty list.
    return { source, target, joins: jin, dimensions, derived, measures: [] };
  }, [curated, baseId, owner, datasetName, activeJoins, byId, dims, derivedRows, target]);

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
    // Only fully-specified derived rows are stored, in the panel's `ref::column` format —
    // a `right` column OR a finite `rightValue` constant (never both). Empty ⇒ omitted.
    ...(() => {
      const derived = derivedRows
        .filter((r) => derivedOf(r) !== null)
        .map((r) => (r.rightMode === 'const'
          ? { name: r.name.trim(), left: r.left, op: r.op, rightValue: Number(r.rightValue) }
          : { name: r.name.trim(), left: r.left, op: r.op, right: r.right }));
      return derived.length > 0 ? { derived } : {};
    })(),
    // The explicit curated base (ref 0) — persisted so the compose reopens on the same base.
    // Absent for an ingested dataset (own-silver base, byte-stable).
    ...(curated && baseId ? { baseDatasetId: baseId } : {}),
    measures: [],
  }), [curated, baseId, activeJoins, dims, derivedRows]);

  // A join is OPTIONAL. With zero joins this compiles a single-table Gold projection of
  // the base — the compiler still requires at least one column or measure, so an empty
  // spec surfaces its own honest reason. A curated compose additionally needs its base
  // picked first (empty source ⇒ the compiler's own FQN error, made friendly here).
  const compiled = useMemo(() => {
    if (curated && !baseId) return { sql: '', error: 'Pick a base dataset to compose from.' };
    try {
      return { sql: compileGoldJoin(spec), error: '' };
    } catch (e) {
      return { sql: '', error: (e as Error).message };
    }
  }, [spec, curated, baseId]);

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
  function patchDerived(i: number, patch: Partial<DerivedRow>) {
    setDerivedRows((rs) => rs.map((x, k) => (k === i ? { ...x, ...patch } : x)));
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
          derived: spec.derived,
          measures: spec.measures,
          // The explicit curated base (ref 0) — the server re-resolves it via getDataset
          // (entitlement + active domain) before compiling. Omitted for an ingested dataset.
          ...(curated && baseId ? { baseDatasetId: baseId } : {}),
          // The raw editable spec, persisted verbatim so the panel re-hydrates on reopen.
          goldSpec: rawSpec,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        const msg = data.error ?? 'Could not build the Gold join';
        setErr(msg); setBuildResult({ ok: false, what: 'Gold', detail: msg });
        return;
      }
      if (data.build && !data.build.ok) {
        const msg = data.error ?? 'The join did not pass';
        setReport(data.build); setErr(msg); setBuildResult({ ok: false, what: 'Gold', detail: msg });
        return;
      }
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
      {/* The AI helper for composing. The manual "Pass through Gold" shortcut is gone: an
          ingested dataset now materializes Gold AUTOMATICALLY after its Transformation (the
          same governed pass-through, fired by the builder), and a curated compose never had
          one — its Gold IS this composition. */}
      <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginBottom: 10 }}>
        <AiAction
          datasetId={datasetId} stage="harmonize" cta="Propose a clean/join"
          title="AI proposes how to clean and join this dataset"
          payload={() => ({ name: datasetName, columns })}
        />
      </div>

      {loadErr ? <div className="error">{loadErr}</div> : null}

      {/* Base dataset (curated only) — the EXPLICIT ref-0 source this compose builds from.
          Governed: only datasets you can read + your active domain holds are offered. */}
      {curated ? (
        <>
          <div className="section-title" style={{ marginTop: 8 }}>Base dataset</div>
          {joinable.length === 0 && !loadErr ? (
            <div className="hint" style={{ marginTop: 0 }}>
              No governed datasets to compose from yet — promote a dataset to your domain (or ask a colleague to) first.
            </div>
          ) : (
            <div className="row" style={{ gap: 8, alignItems: 'center', marginBottom: 8 }}>
              <select value={baseId} onChange={(e) => { setBaseId(e.target.value); setDims([]); }}>
                <option value="">base dataset…</option>
                {joinable.map((d) => <option key={d.id} value={d.id}>{d.name} · {d.domain}</option>)}
              </select>
              {baseId && baseCols.length > 0 ? <span className="chip ok" title="Base columns loaded">{baseCols.length} columns</span> : null}
            </div>
          )}
        </>
      ) : null}

      {/* Join to … (optional). Shown for a curated compose (combining datasets is its
          purpose) and for a legacy ingested dataset whose stored spec already has joins
          (grandfathering — nothing breaks). New ingested datasets don't combine here. */}
      {showJoinSection ? (
      <>
      <div className="section-title" style={{ marginTop: 8 }}>Join to <span className="muted" style={{ fontWeight: 400 }}>(optional)</span></div>
      {joinable.length === 0 && !loadErr ? (
        <div className="hint" style={{ marginTop: 0 }}>
          No shared datasets to reuse yet — you can still build a single-table Gold from your columns below.
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
      </>
      ) : null}

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

      {/* Derived fields (optional) — a new row-level column computed from two columns
          (margin = price − cost) or a column and a constant (vat = price × 0.19). */}
      <div className="section-title" style={{ marginTop: 16 }}>Derived fields <span className="muted" style={{ fontWeight: 400 }}>(optional)</span></div>
      <p className="hint" style={{ marginTop: 0 }}>
        Numeric columns only — a text column needs <code className="mono">CAST(col AS double)</code> or a fixed type in Transformation. Divide is null-safe.
      </p>
      {derivedRows.map((r, i) => (
        <div className="row" key={i} style={{ gap: 8, marginBottom: 8, alignItems: 'center' }}>
          <input value={r.name} placeholder="name" style={{ maxWidth: 140 }}
            onChange={(e) => patchDerived(i, { name: e.target.value })} />
          <span className="muted">=</span>
          <select value={r.left} onChange={(e) => patchDerived(i, { left: e.target.value })}>
            <option value="">column…</option>
            <SourceOptions />
          </select>
          <select value={r.op} style={{ maxWidth: 64 }} onChange={(e) => patchDerived(i, { op: e.target.value as MeasureOp })}>
            {MEASURE_OPS.map((o) => <option key={o} value={o}>{OP_LABEL[o]}</option>)}
          </select>
          <select value={r.rightMode} style={{ maxWidth: 110 }}
            onChange={(e) => patchDerived(i, { rightMode: e.target.value as DerivedRow['rightMode'] })}>
            <option value="column">column</option>
            <option value="const">constant</option>
          </select>
          {r.rightMode === 'column' ? (
            <select value={r.right} onChange={(e) => patchDerived(i, { right: e.target.value })}>
              <option value="">column…</option>
              <SourceOptions />
            </select>
          ) : (
            <input value={r.rightValue} placeholder="0" type="number" style={{ maxWidth: 100 }}
              onChange={(e) => patchDerived(i, { rightValue: e.target.value })} />
          )}
          <button className="btn ghost sm" onClick={() => setDerivedRows((rs) => rs.filter((_, k) => k !== i))}>Remove</button>
        </div>
      ))}
      <div className="row" style={{ gap: 8 }}>
        <button className="btn ghost sm" onClick={() => setDerivedRows((rs) => [...rs, { name: '', left: NONE, op: '-', rightMode: 'column', right: NONE, rightValue: '' }])}>+ Add a derived field</button>
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

      {/* Prerequisite hint, right where the action lives (a calm disabled state, not an
          error). Ingested Gold is materialized from Silver; a curated compose needs its
          explicit base picked first. */}
      {!curated && !silverBuilt ? (
        <div className="hint" style={{ marginTop: 14 }}>
          Build the <strong>Silver</strong> version first — Gold is materialized from Silver.
        </div>
      ) : curated && !baseId ? (
        <div className="hint" style={{ marginTop: 14 }}>
          Pick a <strong>base dataset</strong> above — a curated dataset composes from data you already trust.
        </div>
      ) : null}

      <div className="row" style={{ marginTop: 14, gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
        {/* Clear IN-PROGRESS signal so a build never looks like "nothing happened". */}
        {busy === 'build' ? <span className="hint" style={{ margin: 0 }}>Building Gold…</span> : null}
        {report?.mode === 'offline-mock' ? <span className="hint" style={{ margin: 0 }}>offline preview — no live table written</span> : null}
        <button className="btn primary" onClick={build} disabled={busy !== '' || (curated ? !baseId : !silverBuilt) || !!compiled.error}>
          {busy === 'build' ? <span className="spin" /> : saveLabel ?? (builtOk ? 'Rebuild Gold version' : 'Build Gold version')}
        </button>
      </div>

      {/* SUCCESS state — the table exists. A calm confirmation; the full preview (with the
          layer toggle) lives in View, so Edit no longer repeats a preview here. Editing
          above + saving again keeps the definition reproducible. */}
      {builtOk ? (
        <div style={{ marginTop: 18, borderTop: '1px solid var(--border)', paddingTop: 16 }}>
          <div className="row" style={{ alignItems: 'center', gap: 8 }}>
            <span className="ok-note" style={{ fontWeight: 600 }}>{saveLabel ? 'Composition saved ✓' : 'Gold built ✓'}</span>
            <span className="hint" style={{ margin: 0 }}>
              <code className="mono">gold_{slug(datasetName)}</code> is live. Edit above and save again to update it.
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
