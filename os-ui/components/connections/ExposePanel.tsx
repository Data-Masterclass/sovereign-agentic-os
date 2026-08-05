/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

/**
 * <ExposePanel /> — the admin-only Expose surface on a warehouse connection's detail, now a
 * STAGED flow (lakehouse-expose-experience.md, Phase A). An exposure set says "these tables
 * from this connection are visible to these domains"; it compiles straight to OPA (each table
 * → a `data.governance.tables` shared-with entry), so a live external catalog opens to exactly
 * the assigned domains and stays fail-closed for everyone else.
 *
 * The exposure-set LIST is the landing collection, ABOVE the stage rail:
 *   • New   → enters the flow at Catalog with an empty selection.
 *   • Edit  → loads the set and enters at Review; all gated stages are reachable to walk back.
 *   • Revoke→ stays on the list with the existing confirm.
 * The staged flow (StageShell, components/core/StageShell.tsx) is Catalog · Organize · Assign ·
 * Review (components/connections/expose/stages.ts):
 *   • Catalog  — snapshot health + Refresh + drift chip; the shared CatalogBrowser (schema mode).
 *   • Organize — the browser in category mode (Phase A: schema fallback + a quiet AI note).
 *   • Assign   — the calm form (name auto-suggested from selection, domains, mode, tier, note;
 *                Simple hides cron with an hourly note, Developer shows cron + fullRefresh).
 *   • Review   — human-impact card, grouped read-only list, drift warnings, one primary
 *                Create/Update; Developer shows the compiled governance preview + policy result.
 *
 * Selection is ONE Set<'schema.table'> owned here, shared by Catalog + Organize, with a
 * persistent "N tables selected" badge in the rail aside. OS gold/black language throughout.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import StageShell from '@/components/core/StageShell';
import { initialStageState, goTo, markDone, type StageState } from '@/lib/core/stages';
import BuilderModeToggle from '@/components/core/BuilderModeToggle';
import type { ViewMode } from '@/lib/core/view-mode';
import CatalogBrowser, { keyOf, type TableRef, type CatalogClassification } from './CatalogBrowser';
import { cursorSupportForPlatform } from '@/lib/connections/operational-cursor';
import type { ReactNode } from 'react';
import type { Placement } from './category-tree';
import { EXPOSE_STAGES, type ExposeStageId, type ExposeCtx } from './expose/stages';
import ExposeChat, { type SelectionSuggestion, type ExposureSuggestion } from './expose/ExposeChat';
import { postJSON } from './shared';

type Snapshot = {
  connectionId: string;
  catalog: string;
  status: 'live' | 'stale' | 'unreachable';
  takenAt: string;
  tables: TableRef[];
  prevDiff: { added: TableRef[]; removed: TableRef[] };
  detail: string;
};
/** Per-entity agent-action grant (Phase 3), keyed by lowercased entity name. */
type ActionGrant = { read?: boolean; search?: boolean; create?: boolean; update?: boolean };
type ExposureSet = {
  id: string;
  name: string;
  domains: string[];
  mode: 'live' | 'sync';
  tier: 'silver' | 'gold';
  tables: TableRef[];
  note?: string;
  syncDefaults?: { schedule?: string; fullRefresh?: boolean };
  actions?: Record<string, ActionGrant>;
  writeApproved?: boolean;
  revoked?: boolean;
  updatedAt: string;
};
type DomainOpt = { id: string; name: string };

/** The merged classification the GET returns (taxonomy + per-table placement + run detail). */
type MergedClassification = {
  taxonomy: { id: string; name: string }[];
  seed?: 'source' | 'os-domains' | 'starter' | 'empty';
  placements: Record<string, Placement>;
  lastRunAt?: string;
  lastRunDetail?: string;
  /** Present when unseeded — the chooser's honest pre-select. */
  suggestedSeed?: 'source' | 'os-domains' | 'starter' | 'empty';
};

const EXPOSE_MODE_KEY = 'connections.expose.viewMode';

/** Auto-suggest a set name from the selection — the dominant schema, or the table count. */
function suggestName(tables: TableRef[]): string {
  if (tables.length === 0) return '';
  const bySchema = new Map<string, number>();
  for (const t of tables) bySchema.set(t.schema, (bySchema.get(t.schema) ?? 0) + 1);
  const [topSchema] = [...bySchema.entries()].sort((a, b) => b[1] - a[1])[0] ?? [''];
  if (bySchema.size === 1 && topSchema) return `${topSchema} tables`;
  return `${tables.length} tables${topSchema ? ` (mostly ${topSchema})` : ''}`;
}

export default function ExposePanel({
  connectionId,
  catalog,
  operational = false,
  actionsEnabled = false,
}: {
  connectionId: string;
  /** The warehouse Trino catalog, or the operational platform label ('salesforce') — a
   *  human identity for the header; operational exposures carry no federated catalog. */
  catalog: string;
  /** True for an operational (Salesforce/Kajabi) source — the mode is locked to Sync. */
  operational?: boolean;
  /** OPERATIONAL_ACTIONS_ENABLED — gates the "Agent actions (optional)" section. */
  actionsEnabled?: boolean;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [sets, setSets] = useState<ExposureSet[]>([]);
  const [domains, setDomains] = useState<DomainOpt[]>([]);
  const [classification, setClassification] = useState<MergedClassification | null>(null);
  const [organizeErr, setOrganizeErr] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');

  const [viewMode, setViewMode] = useState<ViewMode>('simple');
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const saved = window.localStorage.getItem(EXPOSE_MODE_KEY);
    if (saved === 'simple' || saved === 'developer') setViewMode(saved as ViewMode);
  }, []);
  const setModePersisted = (m: ViewMode) => {
    setViewMode(m);
    if (typeof window !== 'undefined') window.localStorage.setItem(EXPOSE_MODE_KEY, m);
  };
  const developer = viewMode === 'developer';

  // The cursor-honesty chip for an operational entity row (Phase 1) — real, from the
  // client-safe registry, never guessed. `catalog` carries the platform label when
  // operational. Absent (undefined) for warehouse rows, which have no cursor semantics.
  const opPlatform = operational ? (catalog === 'salesforce' || catalog === 'kajabi' ? catalog : undefined) : undefined;
  const renderRowExtras = opPlatform
    ? (t: TableRef): ReactNode => {
        const cur = cursorSupportForPlatform(opPlatform, t.table);
        return (
          <span className="badge muted" style={{ fontSize: 10.5 }} title={cur.note}>{cur.chip}</span>
        );
      }
    : undefined;

  // --- the flow ---------------------------------------------------------------
  const [flowOpen, setFlowOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [driftOnly, setDriftOnly] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [nameTouched, setNameTouched] = useState(false);

  // --- exposure form state ---------------------------------------------------
  const [editingId, setEditingId] = useState<string | null>(null); // null = create
  const [name, setName] = useState('');
  const [pickedDomains, setPickedDomains] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<'live' | 'sync'>(operational ? 'sync' : 'live');
  const [tier, setTier] = useState<'silver' | 'gold'>('silver');
  const [note, setNote] = useState('');
  const [syncSchedule, setSyncSchedule] = useState('0 * * * *');
  const [fullRefresh, setFullRefresh] = useState(false);
  // Agent actions (operational exposures only, Phase 3): per-entity read/search/create/
  // update toggles, keyed by the lowercased entity (table) name. Defaults all off.
  const [actions, setActions] = useState<Record<string, ActionGrant>>({});

  const load = useCallback(async () => {
    const [snapRes, setsRes, domRes, clsRes] = await Promise.all([
      fetch(`/api/connections/${connectionId}/snapshot`).then((r) => r.json()).catch(() => ({})),
      fetch(`/api/connections/${connectionId}/exposures`).then((r) => r.json()).catch(() => ({})),
      fetch('/api/platform-admin/domains').then((r) => r.json()).catch(() => ({})),
      fetch(`/api/connections/${connectionId}/classification`).then((r) => r.json()).catch(() => ({})),
    ]);
    setSnapshot((snapRes.snapshot as Snapshot) ?? null);
    setSets((setsRes.exposures as ExposureSet[]) ?? []);
    const doms = ((domRes.domains as { id: string; name: string; archived?: boolean }[]) ?? [])
      .filter((d) => !d.archived)
      .map((d) => ({ id: d.id, name: d.name }));
    setDomains(doms);
    setClassification((clsRes.classification as MergedClassification) ?? null);
  }, [connectionId]);

  useEffect(() => { void load(); }, [load]);

  // --- Organize (Phase B) -----------------------------------------------------
  // Seed the taxonomy (the "how should folders be organized?" choice), then reload.
  const chooseSeed = useCallback(async (seed: string) => {
    setBusy('seed'); setOrganizeErr('');
    try {
      const r = await postJSON(`/api/connections/${connectionId}/classification`, { action: 'seed', seed });
      if (r.ok) setClassification((r.data.classification as MergedClassification) ?? null);
      else setOrganizeErr((r.data.error as string) ?? 'Could not set folders.');
    } finally { setBusy(''); }
  }, [connectionId]);

  // Run the classifier (full or only-new), server-side; the honest run detail comes back.
  const organizeWithAi = useCallback(async (mode: 'run' | 'run-new') => {
    setBusy(mode); setOrganizeErr('');
    try {
      const r = await postJSON(`/api/connections/${connectionId}/classification`, { action: mode });
      if (r.ok) setClassification((r.data.classification as MergedClassification) ?? null);
      else setOrganizeErr((r.data.error as string) ?? 'The catalog could not be organized right now.');
    } finally { setBusy(''); }
  }, [connectionId]);

  // A human move — stored as a permanent override that wins over any future run.
  const moveTable = useCallback(async (fqn: string, category: string) => {
    const r = await postJSON(`/api/connections/${connectionId}/classification`, { action: 'override', fqn, category });
    if (r.ok) setClassification((r.data.classification as MergedClassification) ?? null);
    else setOrganizeErr((r.data.error as string) ?? 'Could not move the table.');
  }, [connectionId]);

  // The classification shaped for the CatalogBrowser's category mode (taxonomy + placements).
  const browserClassification: CatalogClassification | undefined = useMemo(() => {
    if (!classification || !classification.seed) return undefined;
    return { taxonomy: classification.taxonomy, placements: classification.placements, lastRunDetail: classification.lastRunDetail };
  }, [classification]);

  // "Classify new": the snapshot has tables with no placement yet (added since the last run).
  const unclassifiedCount = useMemo(() => {
    if (!classification) return 0;
    let n = 0;
    for (const t of snapshot?.tables ?? []) {
      const p = classification.placements[keyOf(t)];
      if (!p || p.source === 'unsorted') n++;
    }
    return n;
  }, [classification, snapshot]);

  async function refresh() {
    setBusy('refresh'); setMsg('');
    try {
      const r = await postJSON(`/api/connections/${connectionId}/snapshot`);
      if (r.ok) { setSnapshot((r.data.snapshot as Snapshot) ?? null); setMsg('✓ Snapshot refreshed.'); }
      else setMsg(`✗ ${(r.data.error as string) ?? 'Refresh failed'}`);
    } finally { setBusy(''); }
  }

  // The tables the browser shows: the snapshot rows, optionally filtered to drift.
  const driftKeys = useMemo(() => {
    const d = snapshot?.prevDiff;
    if (!d) return new Set<string>();
    return new Set([...d.added, ...d.removed].map(keyOf));
  }, [snapshot]);

  const browserTables: TableRef[] = useMemo(() => {
    const rows = snapshot?.tables ?? [];
    return driftOnly ? rows.filter((t) => driftKeys.has(keyOf(t))) : rows;
  }, [snapshot, driftOnly, driftKeys]);

  // The selected tables resolved to refs (include edited-set tables a refresh may have dropped).
  const selectedTables: TableRef[] = useMemo(() => {
    const byKey = new Map<string, TableRef>();
    for (const t of snapshot?.tables ?? []) byKey.set(keyOf(t), t);
    for (const s of sets) for (const t of s.tables) if (!byKey.has(keyOf(t))) byKey.set(keyOf(t), t);
    return [...selected].map((k) => byKey.get(k)).filter((t): t is TableRef => Boolean(t));
  }, [selected, snapshot, sets]);

  // Auto-suggest the name from the selection until the admin edits it by hand.
  const suggestedName = useMemo(() => suggestName(selectedTables), [selectedTables]);
  useEffect(() => {
    if (!nameTouched && !editingId) setName(suggestedName);
  }, [suggestedName, nameTouched, editingId]);

  function togglePickedDomain(id: string) {
    const next = new Set(pickedDomains);
    if (next.has(id)) next.delete(id); else next.add(id);
    setPickedDomains(next);
  }

  const showActions = operational && actionsEnabled;

  function resetForm() {
    setEditingId(null); setName(''); setNameTouched(false); setPickedDomains(new Set());
    setMode(operational ? 'sync' : 'live'); setTier('silver'); setNote(''); setFullRefresh(false); setSelected(new Set());
    setDriftOnly(false); setSearch(''); setActions({});
  }

  // --- stage state (owned here, ctx derived fresh each render) ----------------
  const [stage, setStage] = useState<StageState<ExposeStageId>>(() => initialStageState(EXPOSE_STAGES));
  const [organizeVisited, setOrganizeVisited] = useState(false);

  const ctx: ExposeCtx = {
    hasSnapshot: !!snapshot,
    snapshotStatus: snapshot ? snapshot.status : 'none',
    selectedCount: selected.size,
    hasName: name.trim().length > 0,
    hasDomains: pickedDomains.size > 0,
    classified: organizeVisited || selected.size > 0,
  };

  function startNew() {
    resetForm();
    setStage(initialStageState(EXPOSE_STAGES)); // opens at Catalog, empty done-set
    setOrganizeVisited(false);
    setFlowOpen(true);
    setMsg('');
  }

  function editSet(s: ExposureSet) {
    setEditingId(s.id);
    setName(s.name); setNameTouched(true);
    setPickedDomains(new Set(s.domains));
    setMode(s.mode); setTier(s.tier); setNote(s.note ?? '');
    setActions(s.actions ?? {});
    setFullRefresh(!!s.syncDefaults?.fullRefresh);
    if (s.syncDefaults?.schedule) setSyncSchedule(s.syncDefaults.schedule);
    const sel = new Set(s.tables.map(keyOf));
    setSelected(sel);
    setOrganizeVisited(true);
    // Enter at Review; every gated stage is reachable (selection + name + domains all set),
    // and the done-set starts empty so nothing shows a premature ✓.
    const editCtx: ExposeCtx = {
      hasSnapshot: !!snapshot, snapshotStatus: snapshot ? snapshot.status : 'none',
      selectedCount: sel.size, hasName: s.name.trim().length > 0, hasDomains: s.domains.length > 0,
      classified: true,
    };
    setStage(goTo(EXPOSE_STAGES, initialStageState(EXPOSE_STAGES), 'review', editCtx));
    setFlowOpen(true);
    setMsg('');
  }

  async function save() {
    setBusy('save'); setMsg('');
    try {
      const payload = {
        name: name.trim(),
        domains: [...pickedDomains],
        mode, tier,
        note: note.trim() || undefined,
        tables: selectedTables,
        ...(mode === 'sync'
          ? { syncDefaults: { schedule: syncSchedule.trim() || undefined, fullRefresh: fullRefresh || undefined } }
          : {}),
        // Agent actions (operational + flag on): only entities that are still selected,
        // keyed by lowercased entity name, with any true flag.
        ...(showActions
          ? { actions: Object.fromEntries(
              selectedTables
                .map((t) => [t.table.toLowerCase(), actions[t.table.toLowerCase()]] as const)
                .filter(([, g]) => g && (g.read || g.search || g.create || g.update)),
            ) }
          : {}),
      };
      const r = editingId
        ? await patchJSON(`/api/connections/${connectionId}/exposures/${editingId}`, payload)
        : await postJSON(`/api/connections/${connectionId}/exposures`, payload);
      if (r.ok) {
        setMsg(`✓ ${editingId ? 'Exposure updated' : 'Exposure created'} — ${describePolicy(r.data.policy)}`);
        resetForm();
        setFlowOpen(false);
        await load();
      } else {
        setMsg(`✗ ${(r.data.error as string) ?? 'Save failed'}`);
      }
    } finally { setBusy(''); }
  }

  async function revoke(s: ExposureSet) {
    if (typeof window !== 'undefined' && !window.confirm(`Revoke "${s.name}"? Live reads of its tables drop to zero rows for the assigned domains.`)) return;
    setBusy(`revoke-${s.id}`); setMsg('');
    try {
      const res = await fetch(`/api/connections/${connectionId}/exposures/${s.id}`, { method: 'DELETE' });
      const data = await res.json();
      if (res.ok) { setMsg(`✓ Revoked "${s.name}" — ${describePolicy(data.policy)}`); await load(); }
      else setMsg(`✗ ${(data.error as string) ?? 'Revoke failed'}`);
    } finally { setBusy(''); }
  }

  // --- ExposeChat apply handlers (the assistant only proposes; these are the clicks) -----
  // Classify: jump to Organize, and run the classifier if a taxonomy seed is already chosen
  // (else the Organize stage shows the seed chooser — the run route would error without one).
  const applyClassify = useCallback(() => {
    setOrganizeVisited(true);
    setStage((s) => goTo(EXPOSE_STAGES, s, 'organize', ctx));
    if (classification?.seed) void organizeWithAi('run');
  }, [classification, organizeWithAi, ctx]);

  // Selection: merge the validated `schema.table` keys into the selection Set, jump to Organize.
  const applySelection = useCallback((sug: SelectionSuggestion) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const k of sug.tables) next.add(k);
      return next;
    });
    setOrganizeVisited(true);
    setStage((s) => goTo(EXPOSE_STAGES, s, 'organize', { ...ctx, selectedCount: selected.size + sug.tables.length, classified: true }));
  }, [ctx, selected]);

  // Exposure: prefill the Assign form (name/domains/mode/tier) + set the selection from the
  // validated tables, then jump to Review — the admin still clicks Create there.
  const applyExposure = useCallback((sug: ExposureSuggestion) => {
    const sel = new Set(sug.tables);
    setSelected(sel);
    if (sug.name) { setName(sug.name); setNameTouched(true); }
    setPickedDomains(new Set(sug.domains));
    if (sug.mode) setMode(sug.mode);
    if (sug.tier) setTier(sug.tier);
    setOrganizeVisited(true);
    const nextCtx: ExposeCtx = {
      hasSnapshot: !!snapshot, snapshotStatus: snapshot ? snapshot.status : 'none',
      selectedCount: sel.size, hasName: (sug.name ?? name).trim().length > 0, hasDomains: sug.domains.length > 0,
      classified: true,
    };
    setStage((s) => goTo(EXPOSE_STAGES, s, 'review', nextCtx));
  }, [snapshot, name]);

  const activeSets = sets.filter((s) => !s.revoked);

  return (
    <div className="guided-panel" style={{ marginTop: 14 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <span className="comp-label" style={{ margin: 0 }}>Expose to domains</span>
        <BuilderModeToggle
          mode={viewMode}
          onChange={setModePersisted}
          developerHint="The compiled governance entries + cron / full-refresh controls"
        />
      </div>
      <p className="hint" style={{ marginTop: 8, marginBottom: 10 }}>
        Choose {operational ? 'entities' : 'tables'} from <span className="mono">{catalog}</span> and the domains that may use them.
        {operational
          ? ' Operational sources sync a governed copy into each domain — there is no live federation.'
          : ' Exposure compiles straight to policy — an unexposed external table reads zero rows for everyone.'}
      </p>

      {/* Landing collection — the exposure-set list ABOVE the rail. */}
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span className="hint" style={{ fontSize: 11.5, margin: 0 }}>
          {activeSets.length === 0 ? 'No exposure sets yet.' : `${activeSets.length} exposure set(s)`}
        </span>
        {!flowOpen ? (
          <button className="btn primary" style={{ padding: '4px 12px', fontSize: 12 }} onClick={startNew}>+ New exposure</button>
        ) : null}
      </div>

      {activeSets.length > 0 ? (
        <div className="table-wrap" style={{ marginBottom: 12 }}>
          <table>
            <thead><tr><th>Name</th><th>Domains</th><th>Mode · Tier</th><th>Tables</th><th></th></tr></thead>
            <tbody>
              {activeSets.map((s) => (
                <tr key={s.id}>
                  <td>{s.name}</td>
                  <td className="mono" style={{ fontSize: 11.5 }}>{s.domains.join(', ')}</td>
                  <td className="muted" style={{ fontSize: 11.5 }}>{s.mode} · {s.tier}</td>
                  <td className="muted" style={{ fontSize: 11.5 }}>{s.tables.length}</td>
                  <td>
                    <div className="row" style={{ gap: 6 }}>
                      <button className="btn ghost" style={{ padding: '3px 9px', fontSize: 12 }} onClick={() => editSet(s)} disabled={busy !== ''}>Edit</button>
                      <button className="btn ghost" style={{ padding: '3px 9px', fontSize: 12 }} onClick={() => revoke(s)} disabled={busy !== ''}>
                        {busy === `revoke-${s.id}` ? <span className="spin" /> : 'Revoke'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {msg && !flowOpen ? <div className={msg.startsWith('✗') ? 'error' : 'answer'} style={{ marginBottom: 10 }}>{msg}</div> : null}

      {/* The staged flow — only while a New/Edit is open. */}
      {flowOpen ? (
        <div className="card" style={{ borderLeft: '3px solid var(--gold)', padding: 14 }}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <strong style={{ fontSize: 13 }}>{editingId ? 'Edit exposure' : 'New exposure'}</strong>
            <button className="btn ghost sm" onClick={() => { resetForm(); setFlowOpen(false); }}>Close</button>
          </div>

          <StageShell
            stages={EXPOSE_STAGES}
            state={stage}
            ctx={ctx}
            onState={(next) => { if (next.current === 'organize') setOrganizeVisited(true); setStage(next); }}
            ariaLabel="Exposure stages"
            aside={
              <span className="badge muted" style={{ fontSize: 11 }}>
                {selected.size} table{selected.size === 1 ? '' : 's'} selected
              </span>
            }
            assistant={(st) => (
              // ONE persistent thread across all four stages — mounted position-stable (no
              // per-stage key), so the conversation survives navigating Catalog↔Review.
              <ExposeChat
                connectionId={connectionId}
                stage={st.id}
                onApplyClassify={applyClassify}
                onApplySelection={applySelection}
                onApplyExposure={applyExposure}
              />
            )}
          >
            {stage.current === 'catalog' ? (
              <CatalogStage
                snapshot={snapshot}
                busy={busy}
                onRefresh={refresh}
                search={search}
                onSearch={setSearch}
                driftOnly={driftOnly}
                onDriftOnly={setDriftOnly}
                driftCount={driftKeys.size}
                connectionId={connectionId}
                tables={browserTables}
                selection={selected}
                onSelection={setSelected}
                renderRowExtras={renderRowExtras}
              />
            ) : null}

            {stage.current === 'organize' ? (
              <OrganizeStage
                connectionId={connectionId}
                tables={browserTables}
                renderRowExtras={renderRowExtras}
                selection={selected}
                onSelection={setSelected}
                search={search}
                onSearch={setSearch}
                classification={classification}
                browserClassification={browserClassification}
                developer={developer}
                busy={busy}
                organizeErr={organizeErr}
                unclassifiedCount={unclassifiedCount}
                snapshotUnreachable={snapshot?.status === 'unreachable'}
                onChooseSeed={chooseSeed}
                onOrganize={organizeWithAi}
                onMove={moveTable}
              />
            ) : null}

            {stage.current === 'assign' ? (
              <AssignStage
                developer={developer}
                name={name}
                onName={(v) => { setName(v); setNameTouched(true); }}
                domains={domains}
                picked={pickedDomains}
                onToggleDomain={togglePickedDomain}
                operational={operational}
                mode={mode} onMode={setMode}
                tier={tier} onTier={setTier}
                note={note} onNote={setNote}
                syncSchedule={syncSchedule} onSyncSchedule={setSyncSchedule}
                fullRefresh={fullRefresh} onFullRefresh={setFullRefresh}
                selectedCount={selectedTables.length}
                showActions={showActions}
                selectedTables={selectedTables}
                actions={actions}
                onToggleAction={(entity, kind) => setActions((prev) => {
                  const k = entity.toLowerCase();
                  const cur = { ...(prev[k] ?? {}) };
                  cur[kind] = !cur[kind];
                  return { ...prev, [k]: cur };
                })}
                onEditSelection={() => setStage((s) => goTo(EXPOSE_STAGES, s, 'catalog', ctx))}
              />
            ) : null}

            {stage.current === 'review' ? (
              <ReviewStage
                catalog={catalog}
                developer={developer}
                name={name}
                pickedDomains={[...pickedDomains].map((id) => domains.find((d) => d.id === id)?.name ?? id)}
                mode={mode} tier={tier}
                selectedTables={selectedTables}
                removedDrift={snapshot?.prevDiff.removed ?? []}
                busy={busy}
                editing={!!editingId}
                showActions={showActions}
                actions={actions}
                onSave={save}
                onEditSelection={() => setStage((s) => goTo(EXPOSE_STAGES, s, 'catalog', ctx))}
              />
            ) : null}
          </StageShell>

          {msg ? <div className={msg.startsWith('✗') ? 'error' : 'answer'} style={{ marginTop: 10 }}>{msg}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

/* ─────────────────────────── Catalog ─────────────────────────── */

function CatalogStage({
  snapshot, busy, onRefresh, search, onSearch, driftOnly, onDriftOnly, driftCount,
  connectionId, tables, selection, onSelection, renderRowExtras,
}: {
  snapshot: Snapshot | null;
  busy: string;
  onRefresh: () => void;
  search: string;
  onSearch: (v: string) => void;
  driftOnly: boolean;
  onDriftOnly: (v: boolean) => void;
  driftCount: number;
  connectionId: string;
  tables: TableRef[];
  selection: Set<string>;
  onSelection: (next: Set<string>) => void;
  renderRowExtras?: (t: TableRef) => ReactNode;
}) {
  const unreachable = snapshot?.status === 'unreachable';
  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <span className="hint" style={{ margin: 0, fontSize: 11.5 }}>
          {snapshot
            ? `snapshot from ${new Date(snapshot.takenAt).toLocaleString()} · ${snapshot.status}${unreachable ? '' : ` · ${snapshot.tables.length} table(s)`}`
            : 'no snapshot yet'}
        </span>
        <button className="btn ghost" style={{ padding: '3px 9px', fontSize: 12 }} onClick={onRefresh} disabled={busy !== ''}>
          {busy === 'refresh' ? <span className="spin" /> : snapshot ? 'Refresh' : 'Take a snapshot'}
        </button>
      </div>

      {snapshot && driftCount > 0 ? (
        <div className="row" style={{ gap: 8, alignItems: 'center', marginBottom: 6 }}>
          <button
            type="button"
            className={driftOnly ? 'badge warn' : 'badge muted'}
            style={{ cursor: 'pointer', border: 'none', fontSize: 11 }}
            onClick={() => onDriftOnly(!driftOnly)}
          >
            drift: +{snapshot.prevDiff.added.length} / −{snapshot.prevDiff.removed.length}
          </button>
          {driftOnly ? <span className="hint" style={{ fontSize: 11, margin: 0 }}>showing changed tables only</span> : null}
        </div>
      ) : null}

      {!snapshot ? (
        <div className="chat-empty" style={{ textAlign: 'center', padding: 18 }}>
          <p className="muted" style={{ marginTop: 0 }}>No snapshot of this catalog yet. Take one to browse and pick tables.</p>
          <button className="btn primary" onClick={onRefresh} disabled={busy !== ''}>
            {busy === 'refresh' ? <span className="spin" /> : 'Take a snapshot'}
          </button>
        </div>
      ) : unreachable ? (
        <p className="muted" style={{ fontSize: 12, padding: 8 }}>
          Catalog not queryable — register it, then Refresh. {snapshot.detail}
        </p>
      ) : (
        <>
          <input
            type="text" value={search} onChange={(e) => onSearch(e.target.value)}
            placeholder="Search schemas / tables…" style={{ width: '100%', marginBottom: 8 }}
          />
          <CatalogBrowser
            connectionId={connectionId}
            tables={tables}
            selection={selection}
            onSelection={onSelection}
            mode="schema"
            search={search}
            renderRowExtras={renderRowExtras}
          />
        </>
      )}
    </div>
  );
}

/* ─────────────────────────── Organize ─────────────────────────── */

const SEED_OPTIONS: { id: 'source' | 'os-domains' | 'starter' | 'empty'; title: string; desc: string }[] = [
  { id: 'source', title: 'Mirror the source structure', desc: 'One folder per source schema — best when the source is well-organized.' },
  { id: 'os-domains', title: 'Mirror the OS domains', desc: 'One folder per domain — makes Assign near-automatic (folder → domain).' },
  { id: 'starter', title: 'Starter set', desc: 'Financial, Customer, Product, Orders, Logistics, HR, Marketing, Reference, Operational.' },
  { id: 'empty', title: 'Empty', desc: 'Start with just Unsorted; add folders yourself, then let AI fill them.' },
];

function OrganizeStage({
  connectionId, tables, selection, onSelection, search, onSearch,
  classification, browserClassification, developer, busy, organizeErr, unclassifiedCount,
  snapshotUnreachable, onChooseSeed, onOrganize, onMove, renderRowExtras,
}: {
  connectionId: string;
  tables: TableRef[];
  selection: Set<string>;
  onSelection: (next: Set<string>) => void;
  search: string;
  onSearch: (v: string) => void;
  classification: MergedClassification | null;
  browserClassification: CatalogClassification | undefined;
  developer: boolean;
  busy: string;
  organizeErr: string;
  unclassifiedCount: number;
  snapshotUnreachable: boolean;
  onChooseSeed: (seed: string) => void;
  onOrganize: (mode: 'run' | 'run-new') => void;
  onMove: (fqn: string, category: string) => void;
  renderRowExtras?: (t: TableRef) => ReactNode;
}) {
  // No seed chosen yet → the "how should folders be organized?" chooser (owner-designed).
  const needsSeed = !classification?.seed;
  const suggested = classification?.suggestedSeed ?? 'starter';
  // Whether the AI has ever run (any placement is an AI/override fact, not the not-classified floor).
  const hasRun = !!classification?.lastRunAt;
  const running = busy === 'run' || busy === 'run-new';

  return (
    <div>
      <p className="hint" style={{ marginTop: 0 }}>
        Organizing groups related tables so you can expose a whole area at once. This is optional —
        exposure never waits on it.
      </p>

      {organizeErr ? (
        <div className="error" style={{ marginBottom: 8 }}>
          {organizeErr} You can still expose by schema — organizing never blocks it.
        </div>
      ) : null}

      {needsSeed ? (
        <div className="card" style={{ padding: 12, marginBottom: 8 }}>
          <strong style={{ fontSize: 13 }}>How should folders be organized?</strong>
          <div style={{ marginTop: 8, display: 'grid', gap: 6 }}>
            {SEED_OPTIONS.map((o) => (
              <button
                key={o.id}
                type="button"
                className={o.id === suggested ? 'card' : 'card ghost'}
                style={{ textAlign: 'left', padding: 10, cursor: 'pointer', borderLeft: o.id === suggested ? '3px solid var(--gold)' : undefined }}
                onClick={() => onChooseSeed(o.id)}
                disabled={busy !== ''}
              >
                <div className="row" style={{ gap: 6, alignItems: 'center' }}>
                  <strong style={{ fontSize: 12.5 }}>{o.title}</strong>
                  {o.id === suggested ? <span className="badge muted" style={{ fontSize: 10 }}>suggested</span> : null}
                </div>
                <div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>{o.desc}</div>
              </button>
            ))}
          </div>
          {busy === 'seed' ? <p className="hint" style={{ fontSize: 11 }}><span className="spin" /> setting up folders…</p> : null}
        </div>
      ) : (
        <>
          <div className="row" style={{ gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
            {!hasRun ? (
              <button className="btn primary" style={{ padding: '4px 12px', fontSize: 12 }} onClick={() => onOrganize('run')} disabled={busy !== ''}>
                {running ? <span className="spin" /> : 'Organize with AI'}
              </button>
            ) : (
              <button className="btn ghost" style={{ padding: '3px 10px', fontSize: 12 }} onClick={() => onOrganize('run')} disabled={busy !== ''}>
                {busy === 'run' ? <span className="spin" /> : 'Re-organize all'}
              </button>
            )}
            {hasRun && unclassifiedCount > 0 ? (
              <button className="btn" style={{ padding: '3px 10px', fontSize: 12 }} onClick={() => onOrganize('run-new')} disabled={busy !== ''}>
                {busy === 'run-new' ? <span className="spin" /> : `Classify ${unclassifiedCount} new`}
              </button>
            ) : null}
            {snapshotUnreachable ? (
              <span className="hint" style={{ fontSize: 11, margin: 0 }}>Catalog unreachable — showing the schema view.</span>
            ) : null}
          </div>

          <input
            type="text" value={search} onChange={(e) => onSearch(e.target.value)}
            placeholder="Search names, folders, or the AI’s reason…" style={{ width: '100%', marginBottom: 8 }}
          />

          <CatalogBrowser
            connectionId={connectionId}
            tables={tables}
            selection={selection}
            onSelection={onSelection}
            mode="category"
            search={search}
            classification={browserClassification}
            onMove={onMove}
            developer={developer}
            renderRowExtras={renderRowExtras}
          />
        </>
      )}
    </div>
  );
}

/* ─────────────────────────── Assign ─────────────────────────── */

function AssignStage({
  developer, operational, name, onName, domains, picked, onToggleDomain, mode, onMode, tier, onTier,
  note, onNote, syncSchedule, onSyncSchedule, fullRefresh, onFullRefresh, selectedCount, onEditSelection,
  showActions, selectedTables, actions, onToggleAction,
}: {
  developer: boolean;
  operational: boolean;
  name: string;
  onName: (v: string) => void;
  domains: DomainOpt[];
  picked: Set<string>;
  onToggleDomain: (id: string) => void;
  mode: 'live' | 'sync';
  onMode: (m: 'live' | 'sync') => void;
  tier: 'silver' | 'gold';
  onTier: (t: 'silver' | 'gold') => void;
  note: string;
  onNote: (v: string) => void;
  syncSchedule: string;
  onSyncSchedule: (v: string) => void;
  fullRefresh: boolean;
  onFullRefresh: (v: boolean) => void;
  selectedCount: number;
  showActions: boolean;
  selectedTables: TableRef[];
  actions: Record<string, ActionGrant>;
  onToggleAction: (entity: string, kind: keyof ActionGrant) => void;
  onEditSelection: () => void;
}) {
  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span className="hint" style={{ margin: 0, fontSize: 11.5 }}>
          {selectedCount} table{selectedCount === 1 ? '' : 's'} selected
        </span>
        <button className="btn ghost sm" onClick={onEditSelection}>Edit selection</button>
      </div>

      <label className="hint" style={{ fontSize: 11.5 }}>Name</label>
      <input type="text" value={name} onChange={(e) => onName(e.target.value)} placeholder="e.g. Sales schemas → Commerce" style={{ width: '100%', marginBottom: 8 }} />

      <label className="hint" style={{ fontSize: 11.5 }}>Domains</label>
      <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
        {domains.length === 0 ? <span className="muted" style={{ fontSize: 12 }}>No domains found.</span> : domains.map((d) => (
          <button key={d.id} type="button" onClick={() => onToggleDomain(d.id)}
            className={picked.has(d.id) ? 'btn' : 'btn ghost'} style={{ padding: '3px 9px', fontSize: 12 }}>
            {d.name}
          </button>
        ))}
      </div>

      <div className="row" style={{ gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
        <div>
          <label className="hint" style={{ fontSize: 11.5 }}>Mode</label>
          {operational ? (
            <>
              <select value="sync" disabled style={{ display: 'block' }}>
                <option value="sync">Sync (copy)</option>
              </select>
              <p className="hint" style={{ fontSize: 11, marginTop: 4 }}>
                Operational sources sync; there is no live mode.
              </p>
            </>
          ) : (
            <select value={mode} onChange={(e) => onMode(e.target.value as 'live' | 'sync')} style={{ display: 'block' }}>
              <option value="live">Live (federated)</option>
              <option value="sync">Sync (copy)</option>
            </select>
          )}
        </div>
        <div>
          <label className="hint" style={{ fontSize: 11.5 }}>Tier</label>
          <select value={tier} onChange={(e) => onTier(e.target.value as 'silver' | 'gold')} style={{ display: 'block' }}>
            <option value="silver">silver</option>
            <option value="gold">gold</option>
          </select>
        </div>
      </div>

      {mode === 'sync' ? (
        developer ? (
          <div style={{ marginBottom: 8 }}>
            <label className="hint" style={{ fontSize: 11.5 }}>Sync schedule (cron)</label>
            <input type="text" value={syncSchedule} onChange={(e) => onSyncSchedule(e.target.value)} className="mono" style={{ width: '100%', marginBottom: 6 }} />
            <label className="row" style={{ gap: 6, alignItems: 'center', fontSize: 12 }}>
              <input type="checkbox" checked={fullRefresh} onChange={(e) => onFullRefresh(e.target.checked)} />
              Full refresh each run (re-copy the whole table)
            </label>
          </div>
        ) : (
          <p className="hint" style={{ fontSize: 11.5, marginTop: 0 }}>Synced copies refresh hourly by default.</p>
        )
      ) : null}

      {showActions ? (
        <details style={{ marginBottom: 8 }}>
          <summary className="hint" style={{ fontSize: 11.5, cursor: 'pointer' }}>
            Agent actions (optional)
          </summary>
          {developer ? (
            <p className="hint" style={{ fontSize: 11, marginTop: 6 }}>
              Compiles to <span className="mono">sf_get_record</span> · <span className="mono">sf_search</span> (read),
              <span className="mono"> sf_create_record</span> · <span className="mono">sf_update_record</span> (write-approval).
              Writes stay compiled-out until an admin approves.
            </p>
          ) : (
            <p className="hint" style={{ fontSize: 11, marginTop: 6 }}>read · search · create · update</p>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
            {selectedTables.length === 0 ? (
              <span className="muted" style={{ fontSize: 12 }}>No entities selected.</span>
            ) : selectedTables.map((t) => {
              const k = t.table.toLowerCase();
              const g = actions[k] ?? {};
              return (
                <div key={k} className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span className="mono" style={{ fontSize: 12, minWidth: 120 }}>{t.table}</span>
                  {(['read', 'search', 'create', 'update'] as const).map((kind) => (
                    <label key={kind} className="row" style={{ gap: 4, alignItems: 'center', fontSize: 11.5 }}>
                      <input type="checkbox" checked={!!g[kind]} onChange={() => onToggleAction(t.table, kind)} />
                      {kind}
                    </label>
                  ))}
                </div>
              );
            })}
          </div>
        </details>
      ) : null}

      <label className="hint" style={{ fontSize: 11.5 }}>Note (optional)</label>
      <textarea rows={2} value={note} onChange={(e) => onNote(e.target.value)} style={{ width: '100%', marginBottom: 4 }} />
    </div>
  );
}

/* ─────────────────────────── Review ─────────────────────────── */

function ReviewStage({
  catalog, developer, name, pickedDomains, mode, tier, selectedTables, removedDrift, busy, editing,
  showActions, actions, onSave, onEditSelection,
}: {
  catalog: string;
  developer: boolean;
  name: string;
  pickedDomains: string[];
  mode: 'live' | 'sync';
  tier: 'silver' | 'gold';
  selectedTables: TableRef[];
  removedDrift: TableRef[];
  busy: string;
  editing: boolean;
  showActions: boolean;
  actions: Record<string, ActionGrant>;
  onSave: () => void;
  onEditSelection: () => void;
}) {
  // The plain-English action grant line for the impact card (Phase 3).
  const actionImpact = useMemo(() => {
    if (!showActions) return '';
    const reads = new Set<string>();
    const writes = new Set<string>();
    for (const t of selectedTables) {
      const g = actions[t.table.toLowerCase()];
      if (!g) continue;
      if (g.read || g.search) reads.add(t.table);
      if (g.create || g.update) writes.add(t.table);
    }
    if (reads.size === 0 && writes.size === 0) return 'Agents gain no actions (data-only).';
    const readPart = reads.size ? `READ ${[...reads].join(', ')}` : '';
    const writePart = writes.size
      ? `WRITE ${[...writes].join(', ')} (held for admin approval)`
      : 'no writes';
    return `Agents in ${pickedDomains.join(', ') || 'the assigned domains'} may ${[readPart, writePart].filter(Boolean).join('; ')}.`;
  }, [showActions, selectedTables, actions, pickedDomains]);
  const grouped = useMemo(() => {
    const bySchema = new Map<string, TableRef[]>();
    for (const t of selectedTables) {
      if (!bySchema.has(t.schema)) bySchema.set(t.schema, []);
      bySchema.get(t.schema)!.push(t);
    }
    return [...bySchema.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [selectedTables]);

  const removedKeys = useMemo(() => new Set(removedDrift.map(keyOf)), [removedDrift]);
  const selectedRemoved = selectedTables.filter((t) => removedKeys.has(keyOf(t)));

  const domainWord = pickedDomains.length === 0
    ? 'no domains yet'
    : pickedDomains.length === 1 ? pickedDomains[0] : pickedDomains.join(', ');
  const canSave = name.trim() && pickedDomains.length > 0 && selectedTables.length > 0 && busy === '';

  return (
    <div>
      <div className="card" style={{ borderLeft: '3px solid var(--gold)' }}>
        <p style={{ margin: 0 }}>
          <strong>{selectedTables.length} table{selectedTables.length === 1 ? '' : 's'}</strong> become readable by{' '}
          <strong>{domainWord}</strong>, {mode === 'live' ? 'live' : 'as a synced copy'}, at the <strong>{tier}</strong> tier.
          Everyone else stays at zero rows.
        </p>
        {actionImpact ? (
          <p style={{ margin: '6px 0 0', fontSize: 12.5 }}>{actionImpact}</p>
        ) : null}
      </div>

      {selectedRemoved.length > 0 ? (
        <div className="error" style={{ marginTop: 10 }}>
          ⚠ {selectedRemoved.length} selected table{selectedRemoved.length === 1 ? ' was' : 's were'} removed in the latest
          snapshot: {selectedRemoved.map(keyOf).join(', ')}. Exposing {selectedRemoved.length === 1 ? 'it' : 'them'} will read
          zero rows until the source returns.
        </div>
      ) : null}

      <div style={{ marginTop: 10 }}>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <span className="comp-label" style={{ margin: 0 }}>Tables ({selectedTables.length})</span>
          <button className="btn ghost sm" onClick={onEditSelection}>Edit selection</button>
        </div>
        <div className="table-wrap" style={{ maxHeight: 200, overflow: 'auto', marginTop: 6 }}>
          {grouped.length === 0 ? (
            <p className="muted" style={{ fontSize: 12, padding: 8 }}>No tables selected — go back to Catalog to pick some.</p>
          ) : grouped.map(([schema, ts]) => (
            <div key={schema} style={{ marginBottom: 6 }}>
              <div className="mono" style={{ fontWeight: 600, fontSize: 12.5 }}>{schema} <span className="muted" style={{ fontWeight: 400 }}>({ts.length})</span></div>
              <div style={{ paddingLeft: 16 }}>
                {ts.map((t) => (
                  <div key={keyOf(t)} className="mono" style={{ fontSize: 12, color: removedKeys.has(keyOf(t)) ? 'var(--err, #c33)' : undefined }}>{t.table}</div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {developer ? (
        <div style={{ marginTop: 12 }}>
          <span className="hint" style={{ fontSize: 11.5 }}>Compiled governance entries (data.governance.tables)</span>
          <pre className="codeblock" style={{ fontSize: 11, marginTop: 6, whiteSpace: 'pre-wrap', overflowX: 'auto' }}>
{JSON.stringify(compiledPreview(catalog, selectedTables, pickedDomains), null, 2)}
          </pre>
        </div>
      ) : null}

      <div className="row" style={{ gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
        <button className="btn primary" onClick={onSave} disabled={!canSave}>
          {busy === 'save' ? <span className="spin" /> : editing ? 'Update exposure' : 'Create exposure'}
        </button>
      </div>
    </div>
  );
}

/* ─────────────────────────── helpers ─────────────────────────── */

/** A client-side preview of the entries the compiler emits — for the Developer view.
 *  The AUTHORITATIVE compile happens server-side (`lib/data/policy/compiler.ts`); this
 *  merely mirrors its shape so an admin sees exactly what the set opens up. */
function compiledPreview(catalog: string, tables: TableRef[], domainNames: string[]): Record<string, { visibility: string; shared_with: string[] }> {
  const out: Record<string, { visibility: string; shared_with: string[] }> = {};
  for (const t of tables) {
    out[`${catalog}.${t.schema}.${t.table}`] = { visibility: 'shared', shared_with: [...domainNames].sort() };
  }
  return out;
}

function describePolicy(policy: unknown): string {
  const p = policy as { ok?: boolean; pushed?: number; detail?: string } | undefined;
  if (!p) return 'policy recompiled';
  return p.ok ? `${p.pushed ?? 0} table(s) compiled to policy` : `policy push deferred (${p.detail ?? 'OPA unreachable'})`;
}

/** PATCH via fetch — `postJSON` is POST-only; an edit uses PATCH so the route's verb gate
 *  is honoured. Same `{ ok, status, data }` shape as `postJSON` so `save()` reads uniformly. */
async function patchJSON(url: string, body: unknown): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const res = await fetch(url, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}
