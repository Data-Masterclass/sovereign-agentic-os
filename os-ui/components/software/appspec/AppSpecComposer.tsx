/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

/**
 * `<AppSpecComposer>` — the Build-stage COMPOSE editor for a DECLARATIVE (spec) app (AppSpec Phase
 * 4a). It replaces the code-build chat when an app is `serveMode:'spec'`. The user assembles the app
 * by SELECTING, never coding:
 *   • LEFT  — the tab list: add / rename / reorder / remove, each showing its pattern + a reads/
 *             writes badge.
 *   • CENTER— the tab editor: pick a pattern (VIEW vs INTERACTIVE shelves, implemented ones only,
 *             coming-soon greyed) → configure by choosing a granted dataset + real COLUMNS from the
 *             fetched schema (checkboxes, never a text field name) + labels/formats/filters from
 *             selects → assign the app's stories.
 *   • RIGHT — a live preview (the real `<AppSpecRenderer>` on a same-origin `os` client) + a "How
 *             this app works" summary from `describeApp`.
 * On every change the composed spec runs through `parseAppSpec` + `validateAppSpec` (via the internal
 * POST /api/apps/[id]/spec route on save); typed `{path,reason,fix}` issues surface INLINE next to the
 * offending control. Save persists through the existing `setAppSpec` door → the spec is live at
 * `/apps/<slug>` immediately.
 *
 * All non-trivial logic (state reducers, config assembly, issue mapping, column caching) lives in the
 * pure, unit-tested `lib/software/appspec/compose-*.ts`; this file is the React skin over it.
 */

import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import Markdown from '@/components/Markdown';
import '@/lib/app-ui/theme.css';
import { createOsClient } from '@/lib/app-sdk/index.ts';
import { roleAtLeast, type Role } from '@/lib/core/session';
import { AppSpecRenderer, type RendererIdentity } from './AppSpecRenderer.tsx';
import { PATTERNS, isImplementedPattern, type PatternId } from '@/lib/software/appspec/patterns.ts';
import { parseAppSpec, ROLE_GATES, THEME_CSS_MAX, CUSTOM_HTML_MAX, CUSTOM_CSS_MAX, CUSTOM_JS_MAX, type StoryRef } from '@/lib/software/appspec/schema.ts';
import { describeApp } from '@/lib/software/appspec/describe.ts';
import { parseFunctions } from '@/lib/software/appspec/functions-schema.ts';
import {
  initialState,
  stateFromSpec,
  composeSpec,
  addTab,
  removeTab,
  moveTab,
  renameTab,
  setTabPattern,
  setTabConfig,
  setTabStories,
  setTabRoleGate,
  setTabCustom,
  clearTabCustom,
  setThemeCss,
  setFunctions,
  type ComposeState,
} from '@/lib/software/appspec/compose-model.ts';
import {
  slotsFor,
  isComposable,
  isBespoke,
  datasetIdOf,
  metricIdOf,
  columnSourceDatasetId,
  withDataset,
  withSingleField,
  withColumns,
  withColumnFormat,
  withMultiField,
  withBool,
  withText,
  withEnum,
  withMetric,
  withRecordsSource,
  withDatasetSource,
  sourceIsRecords,
  withFilterFields,
  withFilterControl,
  filterFieldsOf,
  FORMAT_OPTIONS,
  CONTROL_OPTIONS,
  GRANULARITIES,
  CHART_KINDS,
  extractColumnNames,
  type ComposeSlot,
} from '@/lib/software/appspec/compose-fields.ts';
import {
  newMetricCard,
  cardSource,
  setCardLabel,
  setCardSourceKind,
  setCardMetric,
  setCardFunction,
  setCardDataset,
  setCardAgg,
  setCardField,
  kpiCards,
  newMarkdownBlock,
  newKpiBlock,
  newTableBlock,
  landingBlocks,
  setMarkdownContent,
  setKpiBlockCards,
  setTableBlockDataset,
  setTableBlockColumns,
  newWizardStep,
  newFormField,
  wizardSteps,
  formFields,
  setFieldAttr,
  setStepTitle,
  newAggregateFunction,
  newExpressionFunction,
  appFunctions,
  setFunctionHeader,
  setFunctionKind,
  setAggDataset,
  setAggOp,
  setAggField,
  setExpr,
} from '@/lib/software/appspec/compose-blocks.ts';
import {
  locateIssues,
  issuesForTab,
  issuesForSlot,
  issuesForFunction,
  appLevelIssues,
  functionIssues,
  hasBlockingErrors,
  type LocatedIssue,
} from '@/lib/software/appspec/compose-issues.ts';
import type { AppSpec, CustomBody, FieldType, TableColumn, FormField } from '@/lib/software/appspec/schema.ts';
import type {
  PatternConfig,
  KpiCard,
  KpiOverviewConfig,
  LandingConfig,
  LandingBlock,
  AssignmentConfig,
  IntakeWizardConfig,
  ChartExplorerConfig,
} from '@/lib/software/appspec/patterns.ts';
import type { AppFunction, AggOp } from '@/lib/software/appspec/functions-schema.ts';

// ------------------------------------------------------------------ props / types ----

type GrantItem = { id: string; name: string };
type Story = { epicId: string; storyId: string; label: string };

export type ComposerApp = {
  id: string;
  slug: string;
  name: string;
  description: string;
  /** The LIVE, published spec (when the app has gone live) — served at /apps/<slug>. */
  spec?: AppSpec;
  /**
   * The AUTOSAVED candidate spec (os-ui 0.6.135). The editor re-hydrates from `draftSpec` when
   * present (the work-in-progress), else from `spec` (draft == live). Autosave writes it back to
   * the server on every change; Publish promotes it to `spec`.
   */
  draftSpec?: AppSpec;
  /** The app's granted datasets + metrics (ids only on the app; names resolved by the parent). */
  grantedData: GrantItem[];
  grantedMetrics: GrantItem[];
  /** The app's designed epics/stories, flattened for the tab↔story multiselect. */
  stories: Story[];
};

// ------------------------------------------------------------ dataset schema cache ----
// The schema (column names) of a granted dataset, fetched once + cached per id. A pure Map keyed by
// dataset id; the fetch runs client-side against the governed /api/data/datasets/[id] route (returns
// `dataset.columns: {name}[]`). We NEVER offer a free-text field name — the user ticks these.

type SchemaState = { status: 'idle' | 'loading' | 'ready' | 'error'; columns: string[] };

function useDatasetSchemas() {
  const [cache, setCache] = useState<Record<string, SchemaState>>({});
  const inflight = useRef<Set<string>>(new Set());

  const load = useCallback((id: string) => {
    if (!id || inflight.current.has(id)) return;
    setCache((c) => (c[id]?.status === 'ready' ? c : { ...c, [id]: { status: 'loading', columns: [] } }));
    inflight.current.add(id);
    fetch(`/api/data/datasets/${encodeURIComponent(id)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('schema fetch failed'))))
      .then((d: { dataset?: { columns?: { name?: string }[]; goldColumns?: { name?: string }[] } }) => {
        // Prefer the built Gold output columns (post-join names the app actually reads); fall back
        // to the documented base columns. BOTH arrive as `{name, description}` column DOCS from the
        // API (`goldOutputColumns` → ColumnDoc[]), so we map each to its string `name` — rendering a
        // raw column object as a JSX child is React #31. The result is always a `string[]`.
        const gold = extractColumnNames(d.dataset?.goldColumns);
        const base = extractColumnNames(d.dataset?.columns);
        const columns = gold.length > 0 ? gold : base;
        setCache((c) => ({ ...c, [id]: { status: 'ready', columns } }));
      })
      .catch(() => setCache((c) => ({ ...c, [id]: { status: 'error', columns: [] } })))
      .finally(() => inflight.current.delete(id));
  }, []);

  return { cache, load };
}

/** Every dataset id this editor state references (deduped) — so we preload each one's schema. */
function datasetsReferenced(state: ComposeState): string[] {
  const ids = new Set<string>();
  const add = (id: string | undefined) => { if (id) ids.add(id); };
  for (const t of state.tabs) {
    if (t.custom) { add(t.custom.data?.datasetId); continue; }
    add(columnSourceDatasetId(t.config)); // own source OR a metric's dataset
    const cfg = t.config as Record<string, unknown>;
    // assignment's assignee dataset
    const at = cfg.assignTo as { datasetId?: string } | undefined;
    add(at?.datasetId);
    // landing table blocks
    if (t.pattern === 'landing') {
      for (const b of (cfg.blocks as LandingBlock[] | undefined) ?? []) {
        if (b.kind === 'table') add(b.source.datasetId);
        if (b.kind === 'kpi') for (const c of b.cards) add(c.dataset?.datasetId);
      }
    }
    // kpi-overview dataset cards
    if (t.pattern === 'kpi-overview') {
      for (const c of (cfg.cards as KpiCard[] | undefined) ?? []) add(c.dataset?.datasetId);
    }
  }
  // aggregate functions' datasets
  for (const f of state.functions) if (f.kind === 'aggregate') add(f.source.datasetId);
  return [...ids];
}

/** True when the working draft is still the fresh-app default: a single records-table tab with no
 *  stories linked and no custom block. Used to decide whether "Generate my app" is the PRIMARY call
 *  to action (empty) or a secondary confirm-first "Regenerate" (a real app already exists). */
function isDefaultDraft(state: ComposeState): boolean {
  if (state.tabs.length !== 1) return false;
  const t = state.tabs[0];
  return t.pattern === 'records-table' && !t.custom && (t.stories?.length ?? 0) === 0 && state.functions.length === 0;
}

// ------------------------------------------------------------------- the composer ----

export default function AppSpecComposer({
  app,
  userRole,
  onSaved,
  onGoContext,
  mode = 'developer',
}: {
  app: ComposerApp;
  userRole: Role;
  onSaved?: () => void;
  /** Jump to Choose Context — surfaced inline where a tab needs a dataset but none is granted. */
  onGoContext?: () => void;
  /**
   * Simple ⇄ Developer (os-ui 0.6.138, Lovable-style). In SIMPLE the user builds by TALKING to
   * the assistant: only the live preview + assistant show (no tab list / config / advanced). In
   * DEVELOPER the full manual composer shows. Autosave, generate + assistant-apply work identically
   * in both. Defaults to 'developer' so any other caller keeps the full editor.
   */
  mode?: 'simple' | 'developer';
}) {
  const developer = mode === 'developer';
  // Load the DRAFT (autosaved candidate) if present, else the LIVE spec (draft == live), else a
  // fresh starter (os-ui 0.6.135 — the DRAFT/LIVE model).
  const [state, setState] = useState<ComposeState>(() =>
    app.draftSpec
      ? stateFromSpec(app.draftSpec)
      : app.spec
        ? stateFromSpec(app.spec)
        : initialState({ name: app.name, description: app.description, firstDatasetId: app.grantedData[0]?.id }),
  );
  const [activeTab, setActiveTab] = useState(0);
  const [located, setLocated] = useState<LocatedIssue[]>([]);

  // --- autosave (0.6.135): there is NO Save button. Every change autosaves the candidate
  // `draftSpec` to the SERVER (debounced) so the app always persists + always shows in the tiles,
  // even mid-build — across sessions and other viewers, which the old localStorage-only draft
  // (0.6.130) never did. Publish is the only explicit go-live gate. `saveState` drives a subtle
  // "Saving… / Saved" indicator; it is NOT a button. `draftReady` gates the writer so the initial
  // hydrate can't trigger a spurious save.
  const baseState = useCallback(
    () =>
      app.draftSpec
        ? stateFromSpec(app.draftSpec)
        : app.spec
          ? stateFromSpec(app.spec)
          : initialState({ name: app.name, description: app.description, firstDatasetId: app.grantedData[0]?.id }),
    [app.draftSpec, app.spec, app.name, app.description, app.grantedData],
  );
  const [draftReady, setDraftReady] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Persist the current working spec to the server draft door (best-effort autosave). Structural
  // partials save fine — the draft door has no serve gate; only Publish validates.
  //
  // DATA-LOSS FIX (os-ui 0.6.138): after a successful save we refresh the in-memory `app` via
  // `onSaved` (→ the page's reload) so `app.draftSpec` matches what was just autosaved. Without
  // this, navigating Build↔Test&Publish UNMOUNTS this composer and remounting re-hydrates from the
  // STALE `app.draftSpec` (undefined for a fresh app) → the work vanished from the UI even though
  // it was safe on the server. The composer's `state` is the source of truth once mounted (the
  // `useState` initializer runs on mount only), so refreshing `app` here never resets `state` or
  // loses the cursor; it only makes a later REMOUNT hydrate from the fresh server draft.
  const persistDraft = useCallback(
    async (composeState: ComposeState) => {
      setSaveState('saving');
      try {
        const res = await fetch(`/api/apps/${app.id}/spec/draft`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ draft: composeSpec(composeState) }),
        });
        setSaveState(res.ok ? 'saved' : 'error');
        if (res.ok) onSaved?.();
      } catch {
        setSaveState('error');
      }
    },
    [app.id, onSaved],
  );

  // Mark hydration complete on mount so the debounced writer below can start.
  useEffect(() => {
    setDraftReady(true);
  }, []);

  // The latest edited state + whether a debounced save is still pending — read by the
  // unmount flush below so a fast "build tabs → press Test & Publish" (which UNMOUNTS this
  // composer before the 800ms debounce fires) never loses those last edits (os-ui 0.6.138).
  const pendingRef = useRef<{ state: ComposeState; dirty: boolean }>({ state, dirty: false });
  pendingRef.current.state = state;

  // Debounced autosave: ~800ms after the last edit, flush the draft to the server.
  useEffect(() => {
    if (!draftReady) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    pendingRef.current.dirty = true;
    saveTimer.current = setTimeout(() => {
      pendingRef.current.dirty = false;
      void persistDraft(state);
    }, 800);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [draftReady, state, persistDraft]);

  // FLUSH-ON-UNMOUNT (os-ui 0.6.138): if the composer unmounts (stage navigation Build→Test&
  // Publish, or a route change) with a save still pending, send it now — best-effort, keepalive
  // so it survives a page unload too. This closes the "edited within the last 800ms, then left"
  // gap that the debounce cleanup would otherwise drop.
  useEffect(() => {
    return () => {
      if (!pendingRef.current.dirty) return;
      try {
        void fetch(`/api/apps/${app.id}/spec/draft`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ draft: composeSpec(pendingRef.current.state) }),
          keepalive: true,
        });
      } catch {
        /* best-effort — nothing to surface on the way out */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.id]);

  // Reset the composer to its base (live spec / starter) — used by Start-from-blank / Discard.
  const discardDraft = useCallback(() => {
    setState(baseState());
  }, [baseState]);

  const { cache: schemas, load: loadSchema } = useDatasetSchemas();

  // Ensure the schema is loaded for EVERY dataset this spec references — a tab's own source, a
  // metric's underlying dataset (chart-explorer), landing table blocks, an assignment's assignee
  // dataset and a custom block's injected data. So field pickers always have real columns to tick.
  useEffect(() => {
    for (const id of datasetsReferenced(state)) loadSchema(id);
  }, [state, loadSchema]);

  const active = state.tabs[activeTab] ?? state.tabs[0];
  const activeIndex = state.tabs[activeTab] ? activeTab : 0;

  // The composed spec (parse-checked locally for a live preview) + its structural issues.
  const composed = useMemo(() => composeSpec(state), [state]);
  const parsed = useMemo(() => parseAppSpec(composed), [composed]);
  const previewSpec: AppSpec | null = parsed.ok ? parsed.spec : null;

  const os = useMemo(() => createOsClient({ appSlug: app.slug }), [app.slug]);
  const identity: RendererIdentity = { role: userRole as Role };

  // Every edit flows through here; the debounced autosave effect flushes it to the server draft.
  const patch = useCallback((next: ComposeState) => {
    setState(next);
  }, []);

  // --- Generate my app (0.6.131): build the whole spec UP from the app's epics/stories + granted
  // data via the server route, then load the returned spec as an editable draft. When the working
  // draft is still at its default (one records-table tab, no stories, no saved spec), the button is
  // the PRIMARY call to action; once a real spec exists it becomes a secondary, confirm-first
  // "Regenerate from design" that REPLACES the working draft.
  const [generating, setGenerating] = useState(false);
  const [genNote, setGenNote] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const atDefault = useMemo(() => !app.spec && isDefaultDraft(state), [app.spec, state]);
  const hasStories = (app.stories?.length ?? 0) > 0;
  const hasData = app.grantedData.length > 0;
  const canGenerate = hasStories;
  // The "what changed" note the chat may set after loading a generated/edited spec.
  const [chatSpecLoaded, setChatSpecLoaded] = useState(0);

  // Load a fresh spec (from generate OR the chat assistant) into the editor as the working draft.
  const loadSpec = useCallback((spec: AppSpec) => {
    setState(stateFromSpec(spec));
    setActiveTab(0);
    setLocated([]);
    setChatSpecLoaded((n) => n + 1);
  }, []);

  const generate = useCallback(async () => {
    setGenerating(true);
    setGenNote(null);
    try {
      const res = await fetch(`/api/apps/${app.id}/spec/generate`, { method: 'POST' });
      const d = (await res.json().catch(() => ({}))) as { ok?: boolean; spec?: AppSpec; error?: string };
      if (d.ok && d.spec) {
        loadSpec(d.spec);
        const storyCount = new Set(d.spec.tabs.flatMap((t) => (t.stories ?? []).map((s) => s.storyId))).size;
        setGenNote({ kind: 'ok', text: `Generated ${d.spec.tabs.length} tab${d.spec.tabs.length === 1 ? '' : 's'} from ${storyCount} stor${storyCount === 1 ? 'y' : 'ies'} — review and Save.` });
      } else {
        setGenNote({ kind: 'error', text: d.error ?? 'The build assistant could not generate your app. Add a tab yourself, or try again.' });
      }
    } catch {
      setGenNote({ kind: 'error', text: 'Could not reach the build assistant. Please try again in a moment.' });
    } finally {
      setGenerating(false);
    }
  }, [app.id, loadSpec]);

  const onGenerateClick = useCallback(() => {
    if (!atDefault) {
      const ok = window.confirm('Regenerate the app from your epics and stories? This REPLACES your current working draft.');
      if (!ok) return;
    }
    void generate();
  }, [atDefault, generate]);

  // --- AUTO-GENERATE ON FIRST LOAD (0.6.134): when Build opens for a FRESH spec app (no meaningful
  // saved spec, no restored draft, still at the default single-tab starter) AND there's material to
  // build from (≥1 story AND ≥1 granted dataset), fire the generator ONCE automatically. Later
  // visits (a saved spec, or a restored draft) load that work untouched — we NEVER regenerate over
  // saved work. No material ⇒ no auto-fire (the calm empty state points to Design / Choose Context).
  const autoFired = useRef(false);
  useEffect(() => {
    if (!draftReady || autoFired.current) return;
    autoFired.current = true; // one-shot for this mount, regardless of outcome
    if (app.spec || app.draftSpec) return; // saved work exists — load it, don't regenerate
    if (!atDefault || !hasStories || !hasData) return; // no material, or user already started
    void generate();
    // atDefault/hasStories/hasData are read once at the moment draftReady flips; the ref guards reruns.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftReady]);

  // "Start from blank" — replace the working draft with the minimal single-tab starter spec.
  const startFromBlank = useCallback(() => {
    const ok = window.confirm('Start from a blank app? This REPLACES your current working draft with an empty starter.');
    if (!ok) return;
    setState(initialState({ name: app.name, firstDatasetId: app.grantedData[0]?.id }));
    setActiveTab(0);
    setLocated([]);
    setGenNote(null);
    setChatSpecLoaded((n) => n + 1);
  }, [app.name, app.grantedData]);

  const appIssues = appLevelIssues(located);
  const tabIssues = issuesForTab(located, activeIndex);
  const blocking = hasBlockingErrors(located);
  const description = useMemo(() => (previewSpec ? describeApp(previewSpec) : null), [previewSpec]);
  // The theme + custom-block + function editors are BUILDER-gated (advanced, opt-in).
  const canAdvanced = roleAtLeast(userRole as Role, 'builder');

  return (
    <div className="sc-appspec">
      <div className="sc-appspec-head">
        <div>
          <div className="section-title">{developer ? 'Compose your app' : 'Build with the assistant'}</div>
          <p className="hint" style={{ marginTop: 2 }}>
            {developer
              ? <>Build it by picking patterns and mapping your governed data — no code. Your work autosaves as a draft; use <strong>Test &amp; Publish</strong> to go live at <Link className="sw-quiet-link" href={`/apps/${app.slug}`}>/apps/{app.slug}</Link>.</>
              : <>Describe what you want and the assistant builds it — the live preview updates as you go. Your work autosaves; use <strong>Test &amp; Publish</strong> to go live at <Link className="sw-quiet-link" href={`/apps/${app.slug}`}>/apps/{app.slug}</Link>. Switch to <strong>Developer</strong> to edit tabs by hand.</>}
          </p>
        </div>
        {/* Autosave indicator — NOT a button. There is no Save button (0.6.135); every change
            debounce-saves the draft to the server, and this shows the outcome quietly. */}
        <div className="row" style={{ gap: 8, alignItems: 'center' }} aria-live="polite">
          {saveState === 'saving' ? (
            <span className="hint" style={{ margin: 0, display: 'inline-flex', gap: 6, alignItems: 'center' }}><span className="spin" /> Saving…</span>
          ) : saveState === 'saved' ? (
            <span className="hint" style={{ margin: 0 }}>Draft saved</span>
          ) : saveState === 'error' ? (
            <span className="error" style={{ margin: 0 }}>Couldn’t save the draft — retrying on your next edit.</span>
          ) : null}
        </div>
      </div>

      {/* Building-your-app progress — auto-generate on first load (0.6.134) reads the user's epics,
          stories and granted data and builds the tabs for them. Shown while the generator runs. */}
      {generating ? (
        <div className="grant-block" style={{ marginTop: 10, display: 'flex', gap: 12, alignItems: 'center' }}>
          <span className="spin" />
          <div>
            <div className="section-title" style={{ margin: 0 }}>Building your app from your epics &amp; stories…</div>
            <p className="hint" style={{ margin: '2px 0 0' }}>
              Reading your epics, user stories and granted data, and composing the tabs. This takes a moment.
            </p>
          </div>
        </div>
      ) : null}

      {/* Calm EMPTY state — a fresh app with NO material to build from (no stories, or no granted
          data). We do NOT auto-generate; we point the user to the stage that unblocks it. */}
      {atDefault && !generating && (!hasStories || !hasData) ? (
        <div className="grant-block" style={{ marginTop: 10, display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <div>
            <div className="section-title" style={{ margin: 0 }}>Let’s build this from your design</div>
            <p className="hint" style={{ margin: '2px 0 0' }}>
              {!hasStories
                ? 'Design at least one epic with a user story first — then the assistant builds your app from them.'
                : 'Grant at least one dataset in Choose Context — then the assistant builds your tabs on real data.'}
            </p>
          </div>
          {!hasData && onGoContext ? (
            <button type="button" className="btn ghost sm" onClick={onGoContext}>Choose Context →</button>
          ) : null}
        </div>
      ) : null}

      {genNote ? (
        <div className="grant-block" style={{ marginTop: 10 }}>
          <span className={genNote.kind === 'ok' ? 'badge ok' : 'error'} style={{ margin: 0 }}>{genNote.text}</span>
        </div>
      ) : null}

      {appIssues.length > 0 ? (
        <div className="grant-block" style={{ marginTop: 10 }}>
          {appIssues.map((l, i) => (
            <IssueLine key={i} issue={l} />
          ))}
        </div>
      ) : null}

      {/* DEVELOPER-ONLY manual surface (os-ui 0.6.138) — draft controls, app-name field and the tab
          grid. In SIMPLE mode these are hidden; the user builds by talking to the assistant below. */}
      {developer ? (
      <>
      {/* Draft controls — grouped (0.6.134/0.6.135): "Reset based on Design" + "Start from blank"
          hard-overwrite the working draft (both confirm-gated); "Discard draft" resets to the last
          published version. All autosave; nothing goes live until Publish. Small buttons, together. */}
      <div className="sc-draft-note" style={{ marginTop: 10 }}>
        <span className="hint" style={{ margin: 0 }}>
          Rebuild from your design, or start over — your work autosaves, and goes live only on Publish.
        </span>
        <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {canGenerate ? (
            <button
              type="button"
              className="btn ghost sm"
              onClick={onGenerateClick}
              disabled={generating}
              title="Rebuild this app from your epics and stories (replaces the current draft)"
            >
              {generating ? <span className="spin" /> : 'Reset based on Design'}
            </button>
          ) : null}
          <button
            type="button"
            className="btn ghost sm"
            onClick={startFromBlank}
            disabled={generating}
            title="Empty the app to a minimal starter (replaces the current draft)"
          >
            Start from blank
          </button>
          {app.spec ? (
            <button type="button" className="btn ghost sm" onClick={discardDraft} title="Discard draft changes and reset to the last published version">
              Discard draft
            </button>
          ) : null}
        </span>
      </div>

      {/* App name — the Define-stage PURPOSE already serves as the description, so the composer no
          longer duplicates it here (0.6.134). Only the app name stays editable. */}
      <div className="sc-appspec-details">
        <div className="sc-detail-field">
          <label className="comp-label" htmlFor="sc-app-name">App name</label>
          <input
            id="sc-app-name"
            className="input"
            value={state.name}
            onChange={(e) => patch({ ...state, name: e.target.value })}
            placeholder="My app"
          />
        </div>
      </div>

      <div className="sc-appspec-grid">
        {/* LEFT — the tab list. */}
        <aside className="sc-appspec-tabs">
          <div className="comp-label">Tabs</div>
          <ul className="sc-tablist">
            {state.tabs.map((t, i) => {
              const def = PATTERNS[t.pattern];
              const isCustom = !!t.custom;
              const writes = !isCustom && def.category === 'interactive';
              const errs = issuesForTab(located, i).some((l) => l.level === 'error');
              return (
                // The reorder/remove controls are REAL buttons, siblings of the tab button (not
                // nested inside it — that was invalid, unfocusable and aria-hidden). Mi1.
                <li key={t.id} className={`sc-tabrow-wrap${i === activeIndex ? ' is-active' : ''}`}>
                  <button
                    type="button"
                    className={`sc-tabrow${i === activeIndex ? ' is-active' : ''}`}
                    onClick={() => setActiveTab(i)}
                  >
                    <span className="sc-tabrow-main">
                      <span className="sc-tabrow-label">{t.label || 'Untitled tab'}</span>
                      <span className="sc-tabrow-sub">
                        {isCustom ? 'Custom block' : def.label}
                        <span className={`badge ${isCustom ? 'muted' : writes ? 'warn' : 'muted'} sc-io-badge`}>{isCustom ? 'sandboxed' : writes ? 'writes' : 'reads'}</span>
                        {errs ? <span className="badge err sc-io-badge">needs attention</span> : null}
                      </span>
                    </span>
                  </button>
                  <span className="sc-tabrow-ctrls">
                    <button type="button" className="sc-mini" aria-label={`Move ${t.label || 'tab'} up`} title="Move up" onClick={() => { patch(moveTab(state, i, -1)); setActiveTab(Math.max(0, i - 1)); }}>↑</button>
                    <button type="button" className="sc-mini" aria-label={`Move ${t.label || 'tab'} down`} title="Move down" onClick={() => { patch(moveTab(state, i, 1)); setActiveTab(Math.min(state.tabs.length - 1, i + 1)); }}>↓</button>
                    {state.tabs.length > 1 ? (
                      <button type="button" className="sc-mini sc-mini-danger" aria-label={`Remove ${t.label || 'tab'}`} title="Remove tab" onClick={() => { patch(removeTab(state, i)); setActiveTab(0); }}>×</button>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
          <button
            type="button"
            className="btn ghost sm"
            style={{ marginTop: 8, width: '100%' }}
            onClick={() => { const ds = app.grantedData[0]?.id; patch(addTab(state, 'records-table', ds ? { datasetId: ds } : {})); setActiveTab(state.tabs.length); }}
          >
            + Add tab
          </button>
        </aside>

        {/* CENTER — the tab editor. */}
        <section className="sc-appspec-editor">
          {active ? (
            <TabEditor
              index={activeIndex}
              tab={active}
              app={app}
              schemas={schemas}
              located={located}
              canAdvanced={canAdvanced}
              onGoContext={onGoContext}
              functionIds={state.functions.map((f) => f.id)}
              onLabel={(label) => patch(renameTab(state, activeIndex, label))}
              onPattern={(p) => patch(setTabPattern(state, activeIndex, p, datasetIdOf(active.config)))}
              onConfig={(cfg) => patch(setTabConfig(state, activeIndex, cfg))}
              onStories={(s) => patch(setTabStories(state, activeIndex, s))}
              onRoleGate={(r) => patch(setTabRoleGate(state, activeIndex, r))}
              onCustom={(c) => patch(setTabCustom(state, activeIndex, c))}
              onClearCustom={() => patch(clearTabCustom(state, activeIndex))}
            />
          ) : null}
          {tabIssues.length > 0 ? (
            <div className="grant-block" style={{ marginTop: 12 }}>
              <div className="comp-label">This tab</div>
              {tabIssues.map((l, i) => (
                <IssueLine key={i} issue={l} />
              ))}
            </div>
          ) : null}
        </section>
      </div>
      </>
      ) : null}

      {/* BELOW — live preview + legibility, full width under the configuration. */}
      <section className="sc-appspec-preview">
        <div className="comp-label">Live preview</div>
        <div className="sc-preview-frame">
          {previewSpec ? (
            <PreviewBoundary resetKey={JSON.stringify(previewSpec)}>
              <AppSpecRenderer spec={previewSpec} os={os} identity={identity} />
            </PreviewBoundary>
          ) : (
            <p className="hint" style={{ padding: 12 }}>
              Finish the highlighted fields to preview your app.
            </p>
          )}
        </div>
        {description ? <HowItWorks description={description} /> : null}
      </section>

      {/* ASSISTANT — the conversational Build assistant (0.6.134). Explains what's being built and
          refines the app by APPLYING edits directly (agentic): the user types "make Orders a kanban
          by status" / "add a KPI tab for total revenue", the assistant edits the spec, the live
          preview updates, and the user Saves when happy. Every edit is schema+governance validated
          server-side; an un-satisfiable instruction changes nothing and is explained in plain words. */}
      <section className="sc-appspec-assistant">
        <BuildAssistantChat
          appId={app.id}
          currentSpec={previewSpec}
          specLoadedSignal={chatSpecLoaded}
          busy={generating}
          onApply={loadSpec}
        />
      </section>

      {/* ADVANCED — builder-gated: app theme CSS + the app-wide governed functions[]. Developer-only
          (os-ui 0.6.138) — hidden in Simple mode alongside the rest of the manual surface. */}
      {developer && canAdvanced ? (
        <AdvancedSettings
          state={state}
          schemas={schemas}
          located={located}
          grantedData={app.grantedData}
          onThemeCss={(css) => patch(setThemeCss(state, css))}
          onFunctions={(fns) => patch(setFunctions(state, fns))}
        />
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------- tab editor ----

function TabEditor({
  index,
  tab,
  app,
  schemas,
  located,
  canAdvanced,
  onGoContext,
  functionIds,
  onLabel,
  onPattern,
  onConfig,
  onStories,
  onRoleGate,
  onCustom,
  onClearCustom,
}: {
  index: number;
  tab: ComposeState['tabs'][number];
  app: ComposerApp;
  schemas: Record<string, SchemaState>;
  located: LocatedIssue[];
  canAdvanced: boolean;
  onGoContext?: () => void;
  functionIds: string[];
  onLabel: (label: string) => void;
  onPattern: (p: PatternId) => void;
  onConfig: (cfg: PatternConfig) => void;
  onStories: (s: StoryRef[]) => void;
  onRoleGate: (r: ComposeState['tabs'][number]['roleGate']) => void;
  onCustom: (c: CustomBody) => void;
  onClearCustom: () => void;
}) {
  const isCustom = !!tab.custom;
  return (
    <div>
      {/* Tab label + role gate. */}
      <div className="row" style={{ gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <label className="sc-field" style={{ flex: '1 1 220px' }}>
          <span className="comp-label">Tab name</span>
          <input className="sb-input" value={tab.label} onChange={(e) => onLabel(e.target.value)} placeholder="Records" />
        </label>
        <label className="sc-field">
          <span className="comp-label">Visible to</span>
          <select className="sb-select" value={tab.roleGate ?? ''} onChange={(e) => onRoleGate((e.target.value || undefined) as ComposeState['tabs'][number]['roleGate'])}>
            <option value="">Everyone</option>
            {ROLE_GATES.map((r) => (
              <option key={r} value={r}>{r.replace('_', ' ')}+</option>
            ))}
          </select>
        </label>
      </div>

      {isCustom ? (
        /* A sandboxed custom-block tab (builder-only). */
        <div style={{ marginTop: 16 }}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="comp-label" style={{ margin: 0 }}>Custom block</span>
            <button type="button" className="btn ghost sm" onClick={onClearCustom} title="Switch this tab back to a pattern">
              ← Back to patterns
            </button>
          </div>
          <CustomBlockEditor index={index} body={tab.custom!} app={app} schemas={schemas} located={located} onCustom={onCustom} />
        </div>
      ) : (
        <>
          {/* Pattern picker. */}
          <div style={{ marginTop: 16 }}>
            <span className="comp-label">Pattern</span>
            <PatternPicker value={tab.pattern} onPick={onPattern} />
          </div>

          {/* Config form. */}
          <div style={{ marginTop: 16 }}>
            <span className="comp-label">Configure</span>
            <ConfigForm
              index={index}
              pattern={tab.pattern}
              config={tab.config}
              app={app}
              schemas={schemas}
              located={located}
              functionIds={functionIds}
              onGoContext={onGoContext}
              onConfig={onConfig}
            />
          </div>

          {/* Story assignment. */}
          {app.stories.length > 0 ? (
            <div style={{ marginTop: 16 }}>
              <span className="comp-label">Serves user stories</span>
              <StoryMultiselect all={app.stories} value={tab.stories} onChange={onStories} />
            </div>
          ) : null}

          {/* Escape hatch — turn this tab into a sandboxed custom block (builder only). */}
          {canAdvanced ? (
            <div style={{ marginTop: 18 }}>
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => onCustom({ kind: 'custom', html: '<div>\n  <!-- Your HTML here -->\n</div>' })}
                title="Advanced: render this tab as a sandboxed HTML/CSS/JS block"
              >
                Use a custom block instead…
              </button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- pattern picker ----

function PatternPicker({ value, onPick }: { value: PatternId; onPick: (p: PatternId) => void }) {
  const all = Object.values(PATTERNS);
  const views = all.filter((p) => p.category === 'view');
  const interactives = all.filter((p) => p.category === 'interactive');
  return (
    <div className="sc-pattern-shelves">
      <Shelf title="View — read your data" defs={views} value={value} onPick={onPick} />
      <Shelf title="Interactive — capture input" defs={interactives} value={value} onPick={onPick} />
    </div>
  );
}

function Shelf({
  title,
  defs,
  value,
  onPick,
}: {
  title: string;
  defs: (typeof PATTERNS)[PatternId][];
  value: PatternId;
  onPick: (p: PatternId) => void;
}) {
  return (
    <div className="sc-shelf">
      <div className="sc-shelf-title">{title}</div>
      <div className="sc-pattern-grid">
        {defs.map((d) => {
          const impl = isImplementedPattern(d.id);
          const active = value === d.id;
          return (
            <button
              key={d.id}
              type="button"
              className={`sc-pattern-card${active ? ' is-active' : ''}${impl ? '' : ' is-soon'}`}
              disabled={!impl}
              aria-pressed={active}
              onClick={() => impl && onPick(d.id)}
              title={impl ? d.description : `${d.label} — coming soon`}
            >
              <span className="sc-pattern-name">{d.label}{!impl ? <span className="badge muted sc-io-badge">soon</span> : null}</span>
              <span className="sc-pattern-desc">{d.description}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- config form ----

function ConfigForm({
  index,
  pattern,
  config,
  app,
  schemas,
  located,
  functionIds,
  onGoContext,
  onConfig,
}: {
  index: number;
  pattern: PatternId;
  config: PatternConfig;
  app: ComposerApp;
  schemas: Record<string, SchemaState>;
  located: LocatedIssue[];
  functionIds: string[];
  onGoContext?: () => void;
  onConfig: (cfg: PatternConfig) => void;
}) {
  if (!isComposable(pattern)) {
    return (
      <p className="hint" style={{ marginTop: 6 }}>
        This pattern isn’t editable in the composer yet — it stays valid and rendered from its saved
        config. Use the assistant to configure it for now.
      </p>
    );
  }

  // Bespoke sub-editors (their own repeatable-item form, not the generic slot list).
  if (isBespoke(pattern)) {
    if (pattern === 'kpi-overview') return <KpiCardsEditor config={config as KpiOverviewConfig} app={app} schemas={schemas} functionIds={functionIds} onConfig={onConfig} />;
    if (pattern === 'landing') return <LandingEditor config={config as LandingConfig} app={app} schemas={schemas} functionIds={functionIds} onConfig={onConfig} />;
    if (pattern === 'intake-wizard') return <WizardEditor config={config as IntakeWizardConfig} onConfig={onConfig} />;
    if (pattern === 'assignment') return <AssignmentEditor config={config as AssignmentConfig} app={app} schemas={schemas} onConfig={onConfig} />;
  }

  const slots = slotsFor(pattern);
  // Field pickers read the columns of the pattern's data source — its own dataset, OR the underlying
  // dataset of a metric-backed pattern (chart-explorer). So one schema powers every field control.
  const ds = columnSourceDatasetId(config);
  const schema = ds ? schemas[ds] : undefined;
  const columns = schema?.status === 'ready' ? schema.columns : [];

  return (
    <div className="sc-config" style={{ marginTop: 6 }}>
      {slots.map((slot) => (
        <SlotControl
          key={`${slot.kind}:${slot.key}`}
          slot={slot}
          index={index}
          config={config}
          app={app}
          columns={columns}
          schemaState={schema}
          located={located}
          onGoContext={onGoContext}
          onConfig={onConfig}
        />
      ))}
      {/* `form` has no dataset source — its fields are authored with a simple field builder. */}
      {pattern === 'form' ? <FormFieldsBuilder config={config} onConfig={onConfig} /> : null}
    </div>
  );
}

function SlotControl({
  slot,
  index,
  config,
  app,
  columns,
  schemaState,
  located,
  onGoContext,
  onConfig,
}: {
  slot: ComposeSlot;
  index: number;
  config: PatternConfig;
  app: ComposerApp;
  columns: string[];
  schemaState?: SchemaState;
  located: LocatedIssue[];
  onGoContext?: () => void;
  onConfig: (cfg: PatternConfig) => void;
}) {
  const slotKey = slot.key;
  const slotIssues = issuesForSlot(located, index, slotKey);
  const needsSchema = slot.kind === 'columns' || slot.kind === 'single-field' || slot.kind === 'multi-field';
  // A `source:'records'` interactive pattern has NO fixed schema — its record keys are named by the
  // author (a legitimate typed key on the app's own log, not a governed dataset column). We render a
  // small text input for those field slots instead of a schema-backed picker.
  const recordsMode = sourceIsRecords(config);
  const loading = needsSchema && !recordsMode && schemaState?.status === 'loading';
  const noData = needsSchema && !recordsMode && (!schemaState || schemaState.status === 'error' || (schemaState.status === 'ready' && columns.length === 0));

  return (
    <div className="sc-slot">
      <div className="sc-slot-label">
        {slot.label}
        {'optional' in slot && slot.optional ? <span className="muted"> (optional)</span> : null}
      </div>
      {slot.help ? <div className="hint sc-slot-help">{slot.help}</div> : null}

      {slot.kind === 'dataset' ? (
        <DatasetSelect config={config} grants={app.grantedData} onGoContext={onGoContext} onConfig={onConfig} />
      ) : slot.kind === 'metric' ? (
        <MetricSelect slot={slot} config={config} grants={app.grantedMetrics} onConfig={onConfig} />
      ) : slot.kind === 'source-choice' ? (
        <SourceChoice config={config} grants={app.grantedData} onGoContext={onGoContext} onConfig={onConfig} />
      ) : slot.kind === 'enum' ? (
        <select
          className="sb-select"
          value={String((config as Record<string, unknown>)[slot.key] ?? '')}
          onChange={(e) => onConfig(withEnum(config, slot.key, e.target.value))}
        >
          {slot.options.map((o) => (<option key={o} value={o}>{o}</option>))}
        </select>
      ) : loading ? (
        <p className="hint">Loading fields…</p>
      ) : noData ? (
        <p className="hint">Pick a data source above to choose its fields.</p>
      ) : recordsMode && slot.kind === 'single-field' ? (
        <input
          className="sb-input"
          placeholder="record key, e.g. title"
          value={String((config as Record<string, unknown>)[slot.key] ?? '')}
          onChange={(e) => onConfig(withSingleField(config, slot.key, e.target.value))}
        />
      ) : recordsMode && slot.kind === 'multi-field' ? (
        <input
          className="sb-input"
          placeholder="comma-separated record keys"
          value={(((config as Record<string, unknown>)[slot.key] as string[] | undefined) ?? []).join(', ')}
          onChange={(e) => onConfig(withMultiField(config, slot.key, e.target.value.split(',').map((s) => s.trim())))}
        />
      ) : slot.kind === 'single-field' ? (
        <SingleFieldSelect slot={slot} config={config} columns={columns} optional={slot.optional} onConfig={onConfig} />
      ) : slot.kind === 'columns' ? (
        <ColumnsPicker slot={slot} config={config} columns={columns} onConfig={onConfig} />
      ) : slot.kind === 'multi-field' ? (
        <MultiFieldPicker slot={slot} config={config} columns={columns} onConfig={onConfig} />
      ) : slot.kind === 'bool' ? (
        <label className="sc-check">
          <input type="checkbox" checked={!!(config as Record<string, unknown>)[slot.key]} onChange={(e) => onConfig(withBool(config, slot.key, e.target.checked))} />
          <span>{slot.label}</span>
        </label>
      ) : slot.kind === 'text' ? (
        <input
          className="sb-input"
          value={String((config as Record<string, unknown>)[slot.key] ?? '')}
          placeholder={slot.placeholder}
          onChange={(e) => onConfig(withText(config, slot.key, e.target.value))}
        />
      ) : null}

      {slotIssues.map((l, i) => (
        <IssueLine key={i} issue={l} />
      ))}
    </div>
  );
}

/** Shown IN PLACE of an empty dataset picker: an app with zero granted datasets would otherwise
 *  render a select with only the "Choose…" placeholder and no options — which reads as broken.
 *  This names the cause and jumps straight to Choose Context to fix it. */
function NoDatasetsGranted({ onGoContext }: { onGoContext?: () => void }) {
  return (
    <div className="hint" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <span>No datasets granted yet — this tab reads data, so grant one first.</span>
      {onGoContext ? (
        <button type="button" className="btn ghost sm" onClick={onGoContext}>Choose Context →</button>
      ) : null}
    </div>
  );
}

function DatasetSelect({ config, grants, onGoContext, onConfig }: { config: PatternConfig; grants: GrantItem[]; onGoContext?: () => void; onConfig: (c: PatternConfig) => void }) {
  const current = datasetIdOf(config) ?? '';
  if (grants.length === 0 && !current) return <NoDatasetsGranted onGoContext={onGoContext} />;
  return (
    <select className="sb-select" value={current} onChange={(e) => onConfig(withDataset(config, e.target.value))}>
      <option value="">Choose a granted dataset…</option>
      {grants.map((g) => (
        <option key={g.id} value={g.id}>{g.name}</option>
      ))}
      {/* If the saved dataset is no longer granted, keep it visible so its issue is legible. */}
      {current && !grants.some((g) => g.id === current) ? <option value={current}>{current} (not granted)</option> : null}
    </select>
  );
}

/** Pick a granted METRIC into `config[slot.key] = { metricId }`. */
function MetricSelect({
  slot,
  config,
  grants,
  onConfig,
}: {
  slot: Extract<ComposeSlot, { kind: 'metric' }>;
  config: PatternConfig;
  grants: GrantItem[];
  onConfig: (c: PatternConfig) => void;
}) {
  const current = metricIdOf(config) ?? '';
  return (
    <select className="sb-select" value={current} onChange={(e) => onConfig(withMetric(config, slot.key, e.target.value))}>
      <option value="">Choose a granted metric…</option>
      {grants.map((g) => (
        <option key={g.id} value={g.id}>{g.name}</option>
      ))}
      {current && !grants.some((g) => g.id === current) ? <option value={current}>{current} (not granted)</option> : null}
    </select>
  );
}

/** Choose the app's OWN records vs a granted dataset (writes `config.source`). */
function SourceChoice({ config, grants, onGoContext, onConfig }: { config: PatternConfig; grants: GrantItem[]; onGoContext?: () => void; onConfig: (c: PatternConfig) => void }) {
  const records = sourceIsRecords(config);
  const current = datasetIdOf(config) ?? '';
  return (
    <div>
      <div className="sc-seg" style={{ marginBottom: 8 }}>
        <button type="button" className={records ? 'is-on' : ''} onClick={() => onConfig(withRecordsSource(config))}>
          This app’s records
        </button>
        <button type="button" className={!records ? 'is-on' : ''} onClick={() => onConfig(withDatasetSource(config, current))}>
          A granted dataset
        </button>
      </div>
      {records ? (
        <p className="hint">Items come from this app’s own governed record log (no dataset needed).</p>
      ) : grants.length === 0 && !current ? (
        <NoDatasetsGranted onGoContext={onGoContext} />
      ) : (
        <select className="sb-select" value={current} onChange={(e) => onConfig(withDatasetSource(config, e.target.value))}>
          <option value="">Choose a granted dataset…</option>
          {grants.map((g) => (<option key={g.id} value={g.id}>{g.name}</option>))}
          {current && !grants.some((g) => g.id === current) ? <option value={current}>{current} (not granted)</option> : null}
        </select>
      )}
    </div>
  );
}

function SingleFieldSelect({
  slot,
  config,
  columns,
  optional,
  onConfig,
}: {
  slot: Extract<ComposeSlot, { kind: 'single-field' }>;
  config: PatternConfig;
  columns: string[];
  optional?: boolean;
  onConfig: (c: PatternConfig) => void;
}) {
  const value = String((config as Record<string, unknown>)[slot.key] ?? '');
  return (
    <select className="sb-select" value={value} onChange={(e) => onConfig(withSingleField(config, slot.key, e.target.value))}>
      <option value="">{optional ? '(none)' : 'Choose a field…'}</option>
      {columns.map((c) => (
        <option key={c} value={c}>{c}</option>
      ))}
      {value && !columns.includes(value) ? <option value={value}>{value} (not in schema)</option> : null}
    </select>
  );
}

function MultiFieldPicker({
  slot,
  config,
  columns,
  onConfig,
}: {
  slot: Extract<ComposeSlot, { kind: 'multi-field' }>;
  config: PatternConfig;
  columns: string[];
  onConfig: (c: PatternConfig) => void;
}) {
  // records-table's filter slot maps to a `filters` array, not a plain string[]; special-case it.
  const isFilter = slot.key === 'filterFields';
  const selected = isFilter ? filterFieldsOf(config) : ((config as Record<string, unknown>)[slot.key] as string[] | undefined) ?? [];
  const toggle = (field: string) => {
    const next = selected.includes(field) ? selected.filter((f) => f !== field) : [...selected, field];
    onConfig(isFilter ? withFilterFields(config, next) : withMultiField(config, slot.key, next));
  };
  return (
    <div className="sc-fieldgrid">
      {columns.map((c) => (
        <label key={c} className="sc-check">
          <input type="checkbox" checked={selected.includes(c)} onChange={() => toggle(c)} />
          <span>{c}</span>
        </label>
      ))}
      {isFilter && selected.length > 0 ? (
        <div className="sc-filter-controls">
          {selected.map((f) => (
            <label key={f} className="sc-field sc-field-inline">
              <span className="muted">{f}</span>
              <select
                className="sb-select"
                value={(filterControlOf(config, f))}
                onChange={(e) => onConfig(withFilterControl(config, f, e.target.value as (typeof CONTROL_OPTIONS)[number]))}
              >
                {CONTROL_OPTIONS.map((ctl) => (
                  <option key={ctl} value={ctl}>{ctl}</option>
                ))}
              </select>
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function filterControlOf(config: PatternConfig, field: string): (typeof CONTROL_OPTIONS)[number] {
  const filters = (config as { filters?: { field: string; control: (typeof CONTROL_OPTIONS)[number] }[] }).filters ?? [];
  return filters.find((f) => f.field === field)?.control ?? 'search';
}

function ColumnsPicker({
  slot,
  config,
  columns,
  onConfig,
}: {
  slot: Extract<ComposeSlot, { kind: 'columns' }>;
  config: PatternConfig;
  columns: string[];
  onConfig: (c: PatternConfig) => void;
}) {
  const cols = ((config as Record<string, unknown>)[slot.key] as { field: string; format?: string }[] | undefined) ?? [];
  const selectedFields = cols.map((c) => c.field);
  const toggle = (field: string) => {
    const next = selectedFields.includes(field) ? selectedFields.filter((f) => f !== field) : [...selectedFields, field];
    onConfig(withColumns(config, slot.key, next));
  };
  return (
    <div>
      <div className="sc-fieldgrid">
        {columns.map((c) => (
          <label key={c} className="sc-check">
            <input type="checkbox" checked={selectedFields.includes(c)} onChange={() => toggle(c)} />
            <span>{c}</span>
          </label>
        ))}
      </div>
      {cols.length > 0 ? (
        <div className="sc-formatrow">
          {cols.map((c) => (
            <label key={c.field} className="sc-field sc-field-inline">
              <span className="muted">{c.field}</span>
              <select
                className="sb-select"
                value={c.format ?? ''}
                onChange={(e) => onConfig(withColumnFormat(config, slot.key, c.field, e.target.value as (typeof FORMAT_OPTIONS)[number] | ''))}
              >
                <option value="">plain</option>
                {FORMAT_OPTIONS.map((f) => (
                  <option key={f} value={f}>{f}</option>
                ))}
              </select>
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------ form fields builder ----
// A tiny selection-only builder for `form`/`intake` fields: name, label, type, required. This is
// data the app COLLECTS (not existing dataset columns), so a short text name is legitimate here —
// it is a NEW field the user is defining, not a reference to a governed schema.

const FIELD_TYPES = ['text', 'number', 'date', 'boolean'] as const;

function FormFieldsBuilder({ config, onConfig }: { config: PatternConfig; onConfig: (c: PatternConfig) => void }) {
  const fields = ((config as { fields?: { name: string; label: string; type: string; required?: boolean }[] }).fields) ?? [];
  const set = (next: typeof fields) => onConfig({ ...(config as Record<string, unknown>), fields: next } as PatternConfig);
  return (
    <div className="sc-slot">
      <div className="sc-slot-label">Fields to collect</div>
      {fields.map((f, i) => (
        <div key={i} className="row sc-formfield" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 }}>
          <input className="sb-input" placeholder="field_name" value={f.name} onChange={(e) => set(fields.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} style={{ width: 130 }} />
          <input className="sb-input" placeholder="Label" value={f.label} onChange={(e) => set(fields.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} style={{ width: 150 }} />
          <select className="sb-select" value={f.type} onChange={(e) => set(fields.map((x, j) => (j === i ? { ...x, type: e.target.value } : x)))}>
            {FIELD_TYPES.map((t) => (<option key={t} value={t}>{t}</option>))}
          </select>
          <label className="sc-check"><input type="checkbox" checked={!!f.required} onChange={(e) => set(fields.map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)))} /><span>required</span></label>
          <button type="button" className="sc-mini sc-mini-danger" aria-label="Remove field" title="Remove field" onClick={() => set(fields.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
      <button type="button" className="btn ghost sm" style={{ marginTop: 8 }} onClick={() => set([...fields, { name: '', label: '', type: 'text' }])}>+ Add field</button>
    </div>
  );
}

// ================================================================ 4c editors ====

/** Schema-column list for a dataset id (empty until it loads). */
function columnsOf(schemas: Record<string, SchemaState>, id?: string): string[] {
  const s = id ? schemas[id] : undefined;
  return s?.status === 'ready' ? s.columns : [];
}

/** A calm, reusable item card (a bordered tile) with a header row + reorder/remove controls. */
function ItemCard({
  title,
  onUp,
  onDown,
  onRemove,
  children,
}: {
  title: string;
  onUp?: () => void;
  onDown?: () => void;
  onRemove?: () => void;
  children: ReactNode;
}) {
  return (
    <div className="sc-item">
      <div className="sc-item-head">
        <span className="sc-item-title">{title}</span>
        <span className="sc-item-ctrls">
          {onUp ? <button type="button" className="sc-mini" aria-label={`Move ${title} up`} title="Move up" onClick={onUp}>↑</button> : null}
          {onDown ? <button type="button" className="sc-mini" aria-label={`Move ${title} down`} title="Move down" onClick={onDown}>↓</button> : null}
          {onRemove ? <button type="button" className="sc-mini sc-mini-danger" aria-label={`Remove ${title}`} title="Remove" onClick={onRemove}>×</button> : null}
        </span>
      </div>
      <div className="sc-item-body">{children}</div>
    </div>
  );
}

/** A checkbox grid of dataset columns → a `{field,format?}[]` TableColumn list (with format selects). */
function TableColumnsPicker({ columns, value, onChange }: { columns: string[]; value: TableColumn[]; onChange: (cols: TableColumn[]) => void }) {
  const selected = value.map((c) => c.field);
  const toggle = (f: string) => {
    const next = selected.includes(f) ? value.filter((c) => c.field !== f) : [...value, { field: f }];
    onChange(next);
  };
  const setFmt = (field: string, format: string) =>
    onChange(value.map((c) => (c.field === field ? (format ? { ...c, format: format as TableColumn['format'] } : { field: c.field, ...(c.label ? { label: c.label } : {}) }) : c)));
  if (columns.length === 0) return <p className="hint">Pick a dataset to choose its columns.</p>;
  return (
    <div>
      <div className="sc-fieldgrid">
        {columns.map((c) => (
          <label key={c} className="sc-check">
            <input type="checkbox" checked={selected.includes(c)} onChange={() => toggle(c)} />
            <span>{c}</span>
          </label>
        ))}
      </div>
      {value.length > 0 ? (
        <div className="sc-formatrow">
          {value.map((c) => (
            <label key={c.field} className="sc-field sc-field-inline">
              <span className="muted">{c.field}</span>
              <select className="sb-select" value={c.format ?? ''} onChange={(e) => setFmt(c.field, e.target.value)}>
                <option value="">plain</option>
                {FORMAT_OPTIONS.map((f) => (<option key={f} value={f}>{f}</option>))}
              </select>
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ KPI card editor ----

/** ONE KPI card editor: a label + a source toggle (metric | dataset aggregate | function). Shared by
 *  `kpi-overview` and a landing `kpi` block. `functionIds` are the declared Advanced functions. */
function KpiCardEditor({
  card,
  app,
  schemas,
  functionIds,
  onChange,
}: {
  card: KpiCard;
  app: ComposerApp;
  schemas: Record<string, SchemaState>;
  functionIds: string[];
  onChange: (c: KpiCard) => void;
}) {
  const src = cardSource(card);
  const cols = columnsOf(schemas, card.dataset?.datasetId);
  return (
    <div className="sc-item-body">
      <input className="sb-input" placeholder="Card label, e.g. Revenue" value={card.label} onChange={(e) => onChange(setCardLabel(card, e.target.value))} />
      <div className="sc-seg">
        {(['metric', 'dataset', 'function'] as const).map((k) => (
          <button key={k} type="button" className={src === k ? 'is-on' : ''} onClick={() => onChange(setCardSourceKind(card, k))}>
            {k === 'metric' ? 'Metric' : k === 'dataset' ? 'Aggregate' : 'Function'}
          </button>
        ))}
      </div>
      {src === 'metric' ? (
        <select className="sb-select" value={card.metric?.metricId ?? ''} onChange={(e) => onChange(setCardMetric(card, e.target.value))}>
          <option value="">Choose a granted metric…</option>
          {app.grantedMetrics.map((m) => (<option key={m.id} value={m.id}>{m.name}</option>))}
        </select>
      ) : src === 'function' ? (
        <select className="sb-select" value={card.function?.functionId ?? ''} onChange={(e) => onChange(setCardFunction(card, e.target.value))}>
          <option value="">Choose a declared function…</option>
          {functionIds.map((id) => (<option key={id} value={id}>{id}</option>))}
        </select>
      ) : (
        <div className="sc-inline">
          <label className="sc-field">
            <span className="comp-label">Dataset</span>
            <select className="sb-select" value={card.dataset?.datasetId ?? ''} onChange={(e) => onChange(setCardDataset(card, e.target.value))}>
              <option value="">Choose…</option>
              {app.grantedData.map((g) => (<option key={g.id} value={g.id}>{g.name}</option>))}
            </select>
          </label>
          <label className="sc-field">
            <span className="comp-label">Aggregate</span>
            <select className="sb-select" value={card.dataset?.agg ?? 'count'} onChange={(e) => onChange(setCardAgg(card, e.target.value as 'count' | 'sum' | 'avg'))}>
              <option value="count">count</option>
              <option value="sum">sum</option>
              <option value="avg">avg</option>
            </select>
          </label>
          {card.dataset && card.dataset.agg !== 'count' ? (
            <label className="sc-field">
              <span className="comp-label">Of field</span>
              <select className="sb-select" value={card.dataset.field ?? ''} onChange={(e) => onChange(setCardField(card, e.target.value))}>
                <option value="">Choose a field…</option>
                {cols.map((c) => (<option key={c} value={c}>{c}</option>))}
                {card.dataset.field && !cols.includes(card.dataset.field) ? <option value={card.dataset.field}>{card.dataset.field} (not in schema)</option> : null}
              </select>
            </label>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** A list of KPI cards (add / reorder / remove) — reused by `kpi-overview` + a landing kpi block. */
function KpiCardList({
  cards,
  app,
  schemas,
  functionIds,
  onChange,
}: {
  cards: KpiCard[];
  app: ComposerApp;
  schemas: Record<string, SchemaState>;
  functionIds: string[];
  onChange: (cards: KpiCard[]) => void;
}) {
  return (
    <div>
      {cards.length === 0 ? <p className="hint">No cards yet — add one below.</p> : null}
      {cards.map((card, i) => (
        <ItemCard
          key={i}
          title={card.label || `Card ${i + 1}`}
          onUp={i > 0 ? () => onChange(kpiCards.move(cards, i, -1)) : undefined}
          onDown={i < cards.length - 1 ? () => onChange(kpiCards.move(cards, i, 1)) : undefined}
          onRemove={() => onChange(kpiCards.remove(cards, i))}
        >
          <KpiCardEditor card={card} app={app} schemas={schemas} functionIds={functionIds} onChange={(c) => onChange(kpiCards.update(cards, i, c))} />
        </ItemCard>
      ))}
      <div className="sc-add-row">
        <button type="button" className="btn ghost sm" onClick={() => onChange(kpiCards.add(cards, newMetricCard()))}>+ Add card</button>
      </div>
    </div>
  );
}

function KpiCardsEditor({ config, app, schemas, functionIds, onConfig }: { config: KpiOverviewConfig; app: ComposerApp; schemas: Record<string, SchemaState>; functionIds: string[]; onConfig: (c: PatternConfig) => void }) {
  return (
    <div className="sc-config" style={{ marginTop: 6 }}>
      <div className="sc-slot">
        <div className="sc-slot-label">KPI cards</div>
        <div className="hint sc-slot-help">Each card shows one headline number — a metric, a dataset aggregate, or a computed function (declared in Advanced).</div>
        <KpiCardList cards={config.cards} app={app} schemas={schemas} functionIds={functionIds} onChange={(cards) => onConfig({ ...config, cards })} />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- landing editor ----

function LandingEditor({ config, app, schemas, functionIds, onConfig }: { config: LandingConfig; app: ComposerApp; schemas: Record<string, SchemaState>; functionIds: string[]; onConfig: (c: PatternConfig) => void }) {
  const blocks = config.blocks;
  const set = (next: LandingBlock[]) => onConfig({ ...config, blocks: next });
  return (
    <div className="sc-config" style={{ marginTop: 6 }}>
      <div className="sc-slot">
        <div className="sc-slot-label">Page blocks</div>
        <div className="hint sc-slot-help">Compose a home page from prose, KPI cards and a featured table — in any order.</div>
        {blocks.length === 0 ? <p className="hint">No blocks yet — add one below.</p> : null}
        {blocks.map((block, i) => (
          <ItemCard
            key={i}
            title={block.kind === 'markdown' ? 'Text' : block.kind === 'kpi' ? 'KPIs' : 'Table'}
            onUp={i > 0 ? () => set(landingBlocks.move(blocks, i, -1)) : undefined}
            onDown={i < blocks.length - 1 ? () => set(landingBlocks.move(blocks, i, 1)) : undefined}
            onRemove={() => set(landingBlocks.remove(blocks, i))}
          >
            {block.kind === 'markdown' ? (
              <textarea className="sc-code" rows={4} placeholder="# Welcome&#10;Markdown supported." value={block.content} onChange={(e) => set(landingBlocks.update(blocks, i, setMarkdownContent(block, e.target.value)))} />
            ) : block.kind === 'kpi' ? (
              <KpiCardList cards={block.cards} app={app} schemas={schemas} functionIds={functionIds} onChange={(cards) => set(landingBlocks.update(blocks, i, setKpiBlockCards(block, cards)))} />
            ) : (
              <div>
                <label className="sc-field" style={{ marginBottom: 8 }}>
                  <span className="comp-label">Dataset</span>
                  <select className="sb-select" value={block.source.datasetId} onChange={(e) => set(landingBlocks.update(blocks, i, setTableBlockDataset(block, e.target.value)))}>
                    <option value="">Choose a granted dataset…</option>
                    {app.grantedData.map((g) => (<option key={g.id} value={g.id}>{g.name}</option>))}
                  </select>
                </label>
                <div className="comp-label">Columns</div>
                <TableColumnsPicker columns={columnsOf(schemas, block.source.datasetId)} value={block.columns} onChange={(cols) => set(landingBlocks.update(blocks, i, setTableBlockColumns(block, cols)))} />
              </div>
            )}
          </ItemCard>
        ))}
        <div className="sc-add-row">
          <button type="button" className="btn ghost sm" onClick={() => set(landingBlocks.add(blocks, newMarkdownBlock()))}>+ Text</button>
          <button type="button" className="btn ghost sm" onClick={() => set(landingBlocks.add(blocks, newKpiBlock()))}>+ KPIs</button>
          <button type="button" className="btn ghost sm" onClick={() => set(landingBlocks.add(blocks, newTableBlock()))}>+ Table</button>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ wizard editor ----

function WizardEditor({ config, onConfig }: { config: IntakeWizardConfig; onConfig: (c: PatternConfig) => void }) {
  const steps = config.steps;
  const set = (next: typeof steps) => onConfig({ ...config, steps: next });
  return (
    <div className="sc-config" style={{ marginTop: 6 }}>
      <div className="sc-slot">
        <div className="sc-slot-label">Steps</div>
        <div className="hint sc-slot-help">A multi-step form that saves ONE governed record. No dataset needed — you define the fields to collect.</div>
        {steps.length === 0 ? <p className="hint">No steps yet — add one below.</p> : null}
        {steps.map((step, i) => (
          <ItemCard
            key={i}
            title={step.title || `Step ${i + 1}`}
            onUp={i > 0 ? () => set(wizardSteps.move(steps, i, -1)) : undefined}
            onDown={i < steps.length - 1 ? () => set(wizardSteps.move(steps, i, 1)) : undefined}
            onRemove={() => set(wizardSteps.remove(steps, i))}
          >
            <input className="sb-input" placeholder="Step title" value={step.title} onChange={(e) => set(wizardSteps.update(steps, i, setStepTitle(step, e.target.value)))} />
            <FieldBuilder fields={step.fields} onChange={(fields) => set(wizardSteps.update(steps, i, { ...step, fields }))} />
          </ItemCard>
        ))}
        <div className="sc-add-row">
          <button type="button" className="btn ghost sm" onClick={() => set(wizardSteps.add(steps, newWizardStep()))}>+ Add step</button>
        </div>
      </div>
      <label className="sc-field" style={{ maxWidth: 220 }}>
        <span className="comp-label">Submit button</span>
        <input className="sb-input" placeholder="Save" value={config.submitLabel} onChange={(e) => onConfig({ ...config, submitLabel: e.target.value })} />
      </label>
    </div>
  );
}

/** A generic field-list builder (name/label/type/required) — used by wizard steps + assignment extras. */
function FieldBuilder({ fields, onChange }: { fields: FormField[]; onChange: (fields: FormField[]) => void }) {
  return (
    <div>
      {fields.map((f, i) => (
        <div key={i} className="row sc-formfield" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 }}>
          <input className="sb-input" placeholder="field_name" value={f.name} onChange={(e) => onChange(formFields.update(fields, i, setFieldAttr(f, 'name', e.target.value)))} style={{ width: 130 }} />
          <input className="sb-input" placeholder="Label" value={f.label} onChange={(e) => onChange(formFields.update(fields, i, setFieldAttr(f, 'label', e.target.value)))} style={{ width: 150 }} />
          <select className="sb-select" value={f.type} onChange={(e) => onChange(formFields.update(fields, i, setFieldAttr(f, 'type', e.target.value as FieldType)))}>
            {FIELD_TYPES.map((t) => (<option key={t} value={t}>{t}</option>))}
          </select>
          <label className="sc-check"><input type="checkbox" checked={!!f.required} onChange={(e) => onChange(formFields.update(fields, i, setFieldAttr(f, 'required', e.target.checked)))} /><span>required</span></label>
          <button type="button" className="sc-mini sc-mini-danger" aria-label="Remove field" title="Remove field" onClick={() => onChange(formFields.remove(fields, i))}>×</button>
        </div>
      ))}
      <button type="button" className="btn ghost sm" style={{ marginTop: 8 }} onClick={() => onChange(formFields.add(fields, newFormField()))}>+ Add field</button>
    </div>
  );
}

// ------------------------------------------------------------------ assignment editor ----

function AssignmentEditor({ config, app, schemas, onConfig }: { config: AssignmentConfig; app: ComposerApp; schemas: Record<string, SchemaState>; onConfig: (c: PatternConfig) => void }) {
  const itemCols = columnsOf(schemas, config.source.datasetId);
  const assigneeCols = columnsOf(schemas, config.assignTo.datasetId);
  const extras = config.extraFields ?? [];
  return (
    <div className="sc-config" style={{ marginTop: 6 }}>
      <div className="sc-slot">
        <div className="sc-slot-label">Item to assign</div>
        <label className="sc-field" style={{ marginBottom: 8 }}>
          <span className="comp-label">Dataset</span>
          <select className="sb-select" value={config.source.datasetId} onChange={(e) => onConfig({ ...config, source: { datasetId: e.target.value }, itemLabelField: '' })}>
            <option value="">Choose a granted dataset…</option>
            {app.grantedData.map((g) => (<option key={g.id} value={g.id}>{g.name}</option>))}
          </select>
        </label>
        <label className="sc-field">
          <span className="comp-label">Item label field</span>
          <select className="sb-select" value={config.itemLabelField} onChange={(e) => onConfig({ ...config, itemLabelField: e.target.value })}>
            <option value="">Choose a field…</option>
            {itemCols.map((c) => (<option key={c} value={c}>{c}</option>))}
          </select>
        </label>
      </div>
      <div className="sc-slot">
        <div className="sc-slot-label">Assignee</div>
        <label className="sc-field" style={{ marginBottom: 8 }}>
          <span className="comp-label">Dataset</span>
          <select className="sb-select" value={config.assignTo.datasetId} onChange={(e) => onConfig({ ...config, assignTo: { datasetId: e.target.value, optionLabelField: '' } })}>
            <option value="">Choose a granted dataset…</option>
            {app.grantedData.map((g) => (<option key={g.id} value={g.id}>{g.name}</option>))}
          </select>
        </label>
        <label className="sc-field">
          <span className="comp-label">Option label field</span>
          <select className="sb-select" value={config.assignTo.optionLabelField} onChange={(e) => onConfig({ ...config, assignTo: { ...config.assignTo, optionLabelField: e.target.value } })}>
            <option value="">Choose a field…</option>
            {assigneeCols.map((c) => (<option key={c} value={c}>{c}</option>))}
          </select>
        </label>
      </div>
      <div className="sc-slot">
        <div className="sc-slot-label">Extra fields<span className="muted"> (optional)</span></div>
        <div className="hint sc-slot-help">Any extra data to capture with the assignment (e.g. a note or due date).</div>
        <FieldBuilder fields={extras} onChange={(fields) => onConfig({ ...config, ...(fields.length > 0 ? { extraFields: fields } : { extraFields: undefined }) })} />
      </div>
    </div>
  );
}

// ------------------------------------------------------------ custom block editor ----

/** The SANDBOXED custom-block editor (builder-gated). Three code fields (html/css/js) + an optional
 *  read-only data source. The SAFETY is stated explicitly: it renders in a null-origin frame with NO
 *  OS access. This is the ONLY place free-form code is allowed. */
function CustomBlockEditor({
  index,
  body,
  app,
  schemas,
  located,
  onCustom,
}: {
  index: number;
  body: CustomBody;
  app: ComposerApp;
  schemas: Record<string, SchemaState>;
  located: LocatedIssue[];
  onCustom: (c: CustomBody) => void;
}) {
  const patch = (p: Partial<CustomBody>) => onCustom({ ...body, ...p });
  const dsCols = columnsOf(schemas, body.data?.datasetId);
  void dsCols; void schemas;
  return (
    <div className="sc-config" style={{ marginTop: 8 }}>
      <div className="sc-safety">
        <span aria-hidden="true">🔒</span>
        <span>Runs in a <strong>sandboxed frame with no OS access</strong> (a unique null origin — no session, no parent DOM, no API). Any data below is fetched as you and injected READ-ONLY as <code>window.__DATA__</code>; the block cannot call back.</span>
      </div>

      <CodeField label="HTML" value={body.html} max={CUSTOM_HTML_MAX} rows={7} slot="html" index={index} located={located} onChange={(v) => patch({ html: v })} />
      <CodeField label="CSS" value={body.css ?? ''} max={CUSTOM_CSS_MAX} rows={5} slot="css" index={index} located={located} onChange={(v) => patch({ css: v || undefined })} />
      <CodeField label="JavaScript" value={body.js ?? ''} max={CUSTOM_JS_MAX} rows={6} slot="js" index={index} located={located} onChange={(v) => patch({ js: v || undefined })} />

      <div className="sc-slot">
        <div className="sc-slot-label">Read-only data<span className="muted"> (optional)</span></div>
        <div className="hint sc-slot-help">Inject a granted dataset as <code>window.__DATA__</code> for the block to read.</div>
        <div className="sc-inline">
          <label className="sc-field">
            <span className="comp-label">Dataset</span>
            <select
              className="sb-select"
              value={body.data?.datasetId ?? ''}
              onChange={(e) => patch({ data: e.target.value ? { datasetId: e.target.value, ...(body.data?.as ? { as: body.data.as } : {}) } : undefined })}
            >
              <option value="">None</option>
              {app.grantedData.map((g) => (<option key={g.id} value={g.id}>{g.name}</option>))}
            </select>
          </label>
          {body.data ? (
            <label className="sc-field">
              <span className="comp-label">Expose as</span>
              <input className="sb-input" placeholder="e.g. orders" value={body.data.as ?? ''} onChange={(e) => patch({ data: { datasetId: body.data!.datasetId, ...(e.target.value ? { as: e.target.value } : {}) } })} />
            </label>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** A labelled monospace code field with a live char count + cap, surfacing its own slot issues. */
function CodeField({
  label,
  value,
  max,
  rows,
  slot,
  index,
  located,
  onChange,
}: {
  label: string;
  value: string;
  max: number;
  rows: number;
  slot: string;
  index: number;
  located: LocatedIssue[];
  onChange: (v: string) => void;
}) {
  const over = value.length > max;
  const issues = issuesForSlot(located, index, slot);
  return (
    <div className="sc-slot">
      <div className="sc-slot-label">{label}</div>
      <textarea className="sc-code" rows={rows} value={value} spellCheck={false} onChange={(e) => onChange(e.target.value)} />
      <div className="sc-count" style={over ? { color: '#c0392b' } : undefined}>{value.length.toLocaleString()} / {max.toLocaleString()}</div>
      {issues.map((l, i) => (<IssueLine key={i} issue={l} />))}
    </div>
  );
}

// ------------------------------------------------------------ advanced settings ----

/** The builder-gated Advanced disclosure: app theme CSS + the app-wide governed `functions[]`.
 *  Collapsed by default; its contents govern the WHOLE app (not one tab). */
function AdvancedSettings({
  state,
  schemas,
  located,
  grantedData,
  onThemeCss,
  onFunctions,
}: {
  state: ComposeState;
  schemas: Record<string, SchemaState>;
  located: LocatedIssue[];
  grantedData: GrantItem[];
  onThemeCss: (css: string) => void;
  onFunctions: (fns: AppFunction[]) => void;
}) {
  const css = state.themeCss ?? '';
  const over = css.length > THEME_CSS_MAX;
  const themeIssues = located.filter((l) => l.target.scope === 'app' && l.target.field === 'theme');
  return (
    <details className="sc-adv">
      <summary>Advanced settings</summary>
      <div className="sc-adv-body">
        {/* Theme CSS. */}
        <div className="sc-slot">
          <div className="sc-slot-label">Theme CSS</div>
          <div className="hint sc-slot-help">Custom CSS applied SCOPED under this app’s root — it cannot leak into the OS chrome. The live preview reflects it.</div>
          <textarea className="sc-code" rows={6} value={css} spellCheck={false} placeholder=".app-root { --accent: #b8860b; }" onChange={(e) => onThemeCss(e.target.value)} />
          <div className="sc-count" style={over ? { color: '#c0392b' } : undefined}>{css.length.toLocaleString()} / {THEME_CSS_MAX.toLocaleString()}</div>
          {themeIssues.map((l, i) => (<IssueLine key={i} issue={l} />))}
        </div>

        {/* Governed functions. */}
        <FunctionsEditor functions={state.functions} schemas={schemas} located={located} grantedData={grantedData} onChange={onFunctions} />
      </div>
    </details>
  );
}

/** The governed `functions[]` editor: add aggregate/expression functions a KPI card can reference. */
function FunctionsEditor({
  functions,
  schemas,
  located,
  grantedData,
  onChange,
}: {
  functions: AppFunction[];
  schemas: Record<string, SchemaState>;
  located: LocatedIssue[];
  grantedData: GrantItem[];
  onChange: (fns: AppFunction[]) => void;
}) {
  return (
    <div className="sc-slot">
      <div className="sc-slot-label">Computed values (functions)</div>
      <div className="hint sc-slot-help">Safe, governed calculations a KPI card can show — an aggregate over a granted dataset, or a small formula over other functions. No code runs; expressions are validated live.</div>
      {functions.length === 0 ? <p className="hint">None yet — add one below.</p> : null}
      {functions.map((fn, i) => (
        <ItemCard
          key={fn.id}
          title={fn.name || fn.id}
          onUp={i > 0 ? () => onChange(appFunctions.move(functions, i, -1)) : undefined}
          onDown={i < functions.length - 1 ? () => onChange(appFunctions.move(functions, i, 1)) : undefined}
          onRemove={() => onChange(appFunctions.remove(functions, i))}
        >
          <FunctionEditor fn={fn} schemas={schemas} functionIds={functions.filter((f) => f.id !== fn.id).map((f) => f.id)} located={issuesForFunction(located, i)} grantedData={grantedData} onChange={(next) => onChange(appFunctions.update(functions, i, next))} />
        </ItemCard>
      ))}
      <div className="sc-add-row">
        <button type="button" className="btn ghost sm" onClick={() => onChange(appFunctions.add(functions, newAggregateFunction()))}>+ Aggregate</button>
        <button type="button" className="btn ghost sm" onClick={() => onChange(appFunctions.add(functions, newExpressionFunction()))}>+ Expression</button>
      </div>
    </div>
  );
}

const AGG_OP_OPTIONS = ['count', 'sum', 'avg', 'min', 'max'] as const;

function FunctionEditor({
  fn,
  schemas,
  functionIds,
  located,
  grantedData,
  onChange,
}: {
  fn: AppFunction;
  schemas: Record<string, SchemaState>;
  functionIds: string[];
  located: LocatedIssue[];
  grantedData: GrantItem[];
  onChange: (fn: AppFunction) => void;
}) {
  const cols = fn.kind === 'aggregate' ? columnsOf(schemas, fn.source.datasetId) : [];
  // Live-validate an expression's syntax as the user types (the same parser the server uses).
  const exprState = useMemo(() => {
    if (fn.kind !== 'expression' || fn.expr.trim() === '') return null;
    const r = parseFunctions([fn]);
    return r.ok ? { ok: true as const } : { ok: false as const, msg: r.issues[0]?.reason ?? 'invalid' };
  }, [fn]);
  return (
    <div className="sc-item-body">
      <div className="sc-inline">
        <label className="sc-field" style={{ flex: '1 1 140px' }}>
          <span className="comp-label">Name</span>
          <input className="sb-input" placeholder="e.g. Open orders" value={fn.name} onChange={(e) => onChange(setFunctionHeader(fn, 'name', e.target.value))} />
        </label>
        <label className="sc-field">
          <span className="comp-label">Kind</span>
          <div className="sc-seg">
            <button type="button" className={fn.kind === 'aggregate' ? 'is-on' : ''} onClick={() => onChange(setFunctionKind(fn, 'aggregate'))}>Aggregate</button>
            <button type="button" className={fn.kind === 'expression' ? 'is-on' : ''} onClick={() => onChange(setFunctionKind(fn, 'expression'))}>Expression</button>
          </div>
        </label>
      </div>
      <input className="sb-input" placeholder="Description (what this computes)" value={fn.description} onChange={(e) => onChange(setFunctionHeader(fn, 'description', e.target.value))} />

      {fn.kind === 'aggregate' ? (
        <div className="sc-inline">
          <label className="sc-field">
            <span className="comp-label">Dataset</span>
            <select className="sb-select" value={fn.source.datasetId} onChange={(e) => onChange(setAggDataset(fn, e.target.value))}>
              <option value="">Choose…</option>
              {grantedData.map((g) => (<option key={g.id} value={g.id}>{g.name}</option>))}
            </select>
          </label>
          <label className="sc-field">
            <span className="comp-label">Operation</span>
            <select className="sb-select" value={fn.op} onChange={(e) => onChange(setAggOp(fn, e.target.value as AggOp))}>
              {AGG_OP_OPTIONS.map((o) => (<option key={o} value={o}>{o}</option>))}
            </select>
          </label>
          {fn.op !== 'count' ? (
            <label className="sc-field">
              <span className="comp-label">Of field</span>
              <select className="sb-select" value={fn.field ?? ''} onChange={(e) => onChange(setAggField(fn, e.target.value))}>
                <option value="">Choose a field…</option>
                {cols.map((c) => (<option key={c} value={c}>{c}</option>))}
                {fn.field && !cols.includes(fn.field) ? <option value={fn.field}>{fn.field} (not in schema)</option> : null}
              </select>
            </label>
          ) : null}
        </div>
      ) : (
        <div className="sc-slot">
          <span className="comp-label">Formula</span>
          <input className="sc-code" style={{ padding: '6px 8px' }} placeholder="e.g. fn.total / fn.count" value={fn.expr} spellCheck={false} onChange={(e) => onChange(setExpr(fn, e.target.value))} />
          <div className="hint sc-slot-help" style={{ marginTop: 4 }}>Reference other functions as <code>fn.&lt;id&gt;</code>. Supports + − × ÷, comparisons, and ? : — no code.</div>
          {exprState && !exprState.ok ? <div className="error sc-issue">{exprState.msg}.</div> : null}
          {exprState && exprState.ok ? <div className="sc-issue" style={{ color: 'var(--ok, #2e7d32)' }}>Valid expression.</div> : null}
        </div>
      )}
      {located.map((l, i) => (<IssueLine key={i} issue={l} />))}
    </div>
  );
}

// ------------------------------------------------------------- story multiselect ----

function StoryMultiselect({ all, value, onChange }: { all: Story[]; value: StoryRef[]; onChange: (s: StoryRef[]) => void }) {
  const isOn = (s: Story) => value.some((v) => v.epicId === s.epicId && v.storyId === s.storyId);
  const toggle = (s: Story) => {
    onChange(isOn(s) ? value.filter((v) => !(v.epicId === s.epicId && v.storyId === s.storyId)) : [...value, { epicId: s.epicId, storyId: s.storyId }]);
  };
  return (
    <div className="sc-fieldgrid" style={{ marginTop: 6 }}>
      {all.map((s) => (
        <label key={`${s.epicId}:${s.storyId}`} className="sc-check">
          <input type="checkbox" checked={isOn(s)} onChange={() => toggle(s)} />
          <span>{s.label}</span>
        </label>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- legibility panel ----

function HowItWorks({ description }: { description: ReturnType<typeof describeApp> }) {
  return (
    <div className="grant-block" style={{ marginTop: 12 }}>
      <div className="comp-label">How this app works</div>
      <ul className="sc-how">
        {description.tabs.map((t, i) => (
          <li key={i}>
            <strong>{t.label}</strong> <span className={`badge ${t.kind === 'action' ? 'warn' : 'muted'} sc-io-badge`}>{t.kind}</span>
            <div className="hint">{t.what}</div>
            {(t.reads.length > 0 || t.writes.length > 0) ? (
              <div className="muted sc-how-io">
                {t.reads.length > 0 ? <>reads {t.reads.map((r) => r.id).join(', ')}. </> : null}
                {t.writes.length > 0 ? <>writes {t.writes.map((w) => w.label).join(', ')}. </> : null}
                {t.serves.length > 0 ? <>serves {t.serves.length} stor{t.serves.length === 1 ? 'y' : 'ies'}.</> : null}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------- build assistant ----
// The conversational Build assistant panel. It (1) EXPLAINS what's being built — automatically the
// first time a spec is loaded, and again whenever asked ("what does this app do?") — using the PURE
// `describeApp` (no round-trip, no invented behaviour); and (2) REFINES the app by APPLYING edits
// directly: an instruction goes to POST /api/apps/[id]/spec/assist, which returns the FULL validated
// updated spec + a plain-language reply; we load the spec into the composer (onApply) so the live
// preview updates, and the user Saves when happy. An un-satisfiable edit changes nothing.

type ChatMsg = { role: 'user' | 'assistant'; content: string };

/** A short plain-language summary of the current app for the chat — derived from `describeApp`. */
function summarizeSpec(spec: AppSpec): string {
  const d = describeApp(spec);
  if (d.tabs.length === 0) return `**${d.name}** has no tabs yet. Tell me what to add — for example, "add a table of orders".`;
  const lines = d.tabs.map((t) => `- **${t.label}** — ${t.what}`);
  const head = `**${d.name}** has ${d.tabs.length} tab${d.tabs.length === 1 ? '' : 's'}:`;
  return `${head}\n${lines.join('\n')}\n\nAsk me to change anything — e.g. "make the first tab a board by status", or "add a KPI tab for total revenue".`;
}

/** True when the message is really "what does this app do?" (answer locally, no model call). */
function isExplainQuestion(text: string): boolean {
  const t = text.trim().toLowerCase();
  return /what (does|is) (this|the) app|what does it do|explain (this|the) app|summar(y|ize|ise)|what('| a)?s (built|here)/.test(t);
}

function BuildAssistantChat({
  appId,
  currentSpec,
  specLoadedSignal,
  busy,
  onApply,
}: {
  appId: string;
  /** The composer's live composed spec (null while a required field is still unfinished). */
  currentSpec: AppSpec | null;
  /** Bumped whenever a fresh spec is loaded (generate / blank / reset) — re-summarize on change. */
  specLoadedSignal: number;
  /** True while the composer is auto-generating — hold the first summary until it settles, so we
   *  summarize the FINAL app once, not the throwaway default starter first. */
  busy: boolean;
  /** Apply the assistant's returned spec into the composer as the working draft. */
  onApply: (spec: AppSpec) => void;
}) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const specRef = useRef(currentSpec);
  specRef.current = currentSpec;

  const scrollDown = useCallback(() => {
    requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }));
  }, []);

  // Explain what's being built — automatically the FIRST time a spec is available, and again each
  // time a fresh spec is loaded (generate / blank / reset). Keyed by `specLoadedSignal` so a manual
  // reload re-explains; the initial explain fires as soon as `currentSpec` becomes non-null.
  const lastSignal = useRef<number | null>(null);
  useEffect(() => {
    if (busy || !currentSpec) return; // hold the first summary until auto-generate settles
    if (lastSignal.current === specLoadedSignal) return;
    const first = lastSignal.current === null;
    lastSignal.current = specLoadedSignal;
    const summary = summarizeSpec(currentSpec);
    setMessages((m) => [...m, { role: 'assistant', content: first ? summary : `Here’s your updated app.\n\n${summary}` }]);
    scrollDown();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSpec, specLoadedSignal, busy]);

  const send = useCallback(async () => {
    const content = input.trim();
    if (!content || loading) return;
    setError('');
    setInput('');
    setMessages((m) => [...m, { role: 'user', content }]);
    scrollDown();

    // "What does this app do?" is answered locally from the live spec — no model round-trip.
    if (isExplainQuestion(content)) {
      const reply = specRef.current ? summarizeSpec(specRef.current) : 'Finish the highlighted fields and I can describe your app.';
      setMessages((m) => [...m, { role: 'assistant', content: reply }]);
      scrollDown();
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`/api/apps/${appId}/spec/assist`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ instruction: content, currentSpec: specRef.current ?? undefined }),
      });
      const d = (await res.json().catch(() => ({}))) as { ok?: boolean; spec?: AppSpec; reply?: string; error?: string };
      if (!res.ok) {
        setError(d.error || `The assistant is unavailable right now (error ${res.status}).`);
        return;
      }
      if (d.ok && d.spec) onApply(d.spec);
      setMessages((m) => [...m, { role: 'assistant', content: d.reply || (d.ok ? 'Done — review the preview and Save.' : 'I left your app unchanged.') }]);
    } catch (e) {
      setError((e as Error).message || 'Could not reach the assistant.');
    } finally {
      setLoading(false);
      scrollDown();
    }
  }, [appId, input, loading, onApply, scrollDown]);

  return (
    <div className="chat claude sc-assistant-chat">
      <div className="comp-label" style={{ marginBottom: 6 }}>Build assistant</div>
      <div className="chat-log" style={{ minHeight: 160, maxHeight: 320 }} ref={scrollRef}>
        {messages.length === 0 ? (
          <div className="chat-empty">
            I’ll explain what’s being built and refine it as you ask. Try “what does this app do?”, or
            “add a KPI tab for total revenue”.
          </div>
        ) : (
          messages.map((m, i) => (
            <div key={i} className={`bubble ${m.role}`}>
              <div className="bubble-role">{m.role === 'user' ? 'You' : 'build assistant'}</div>
              <div className="bubble-body">{m.role === 'assistant' ? <Markdown>{m.content}</Markdown> : m.content}</div>
            </div>
          ))
        )}
        {loading ? (
          <div className="bubble assistant">
            <div className="bubble-role row" style={{ gap: 8, alignItems: 'center' }}>
              <span>build assistant</span>
              <span className="spin" style={{ width: 12, height: 12 }} />
            </div>
            <div className="bubble-body"><span className="muted" style={{ fontSize: 12 }}>Updating your app…</span></div>
          </div>
        ) : null}
      </div>
      {error ? <div className="error" style={{ marginTop: 8 }}>{error}</div> : null}
      <form onSubmit={(e) => { e.preventDefault(); void send(); }} style={{ marginTop: 10 }}>
        <textarea
          rows={2}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Describe a change — e.g. “make the Orders tab a board by status”…"
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } }}
        />
        <div className="row" style={{ marginTop: 8, justifyContent: 'space-between', alignItems: 'center' }}>
          <div className="hint" style={{ marginTop: 0 }}>Edits apply to the preview immediately. Save &amp; publish when you’re happy.</div>
          <button className="btn" type="submit" disabled={loading || !input.trim()}>Send</button>
        </div>
      </form>
    </div>
  );
}

// -------------------------------------------------------------------- issue line ----

function IssueLine({ issue }: { issue: LocatedIssue }) {
  return (
    <div className={issue.level === 'error' ? 'error sc-issue' : 'sc-issue sc-issue-warn'}>
      <span>{issue.issue.reason}.</span> <span className="muted">{issue.issue.fix}.</span>
    </div>
  );
}

// ------------------------------------------------------------------- save error map ----

/** Map a non-OK save response to a plain sentence a business user can act on. A governed 403 /
 *  "Forbidden" / write-envelope denial becomes a permission sentence; anything else keeps the
 *  server's own message (already user-facing) with a safe fallback — never a raw stack. */
export function friendlySaveError(status: number, serverError?: string): string {
  const raw = (serverError ?? '').toLowerCase();
  const isPerm = status === 403 || /forbidden|not permitted|permission|write.?envelope|not allowed/.test(raw);
  if (isPerm) return 'You don’t have permission to publish this app — ask a Builder to publish it for you.';
  return serverError && serverError.trim() !== '' ? serverError : 'Save failed — please try again.';
}

// -------------------------------------------------------------- preview error boundary ----

/** A calm boundary around the LIVE preview: a spec that structurally parses can still THROW at
 *  render time (an unservable config, a renderer edge case). Without this, that throw white-screens
 *  the whole composer. Here it degrades to a legible "Preview couldn't load" note; the config editor
 *  and Save stay usable. Resets when `resetKey` changes (the next edit), so a fixed spec re-renders. */
class PreviewBoundary extends Component<{ resetKey: string; children: ReactNode }, { error: Error | null }> {
  constructor(props: { resetKey: string; children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }
  render() {
    if (this.state.error) {
      return (
        <p className="hint" style={{ padding: 12 }}>
          Preview couldn’t load — {this.state.error.message || 'this configuration can’t be rendered yet'}. Fix the highlighted fields and it’ll refresh.
        </p>
      );
    }
    return this.props.children;
  }
}
