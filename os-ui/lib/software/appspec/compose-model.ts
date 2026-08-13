/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * The PURE editor model for the Build-stage COMPOSE UI (AppSpec Phase 4a).
 *
 * The composer's whole job is: pick a cookbook PATTERN per tab → map GOVERNED data by SELECTING
 * (never typing field names or code) → assemble a valid `AppSpec` and hand it to the SAME
 * `setAppSpec` server door the MCP tool uses. This module is the DOM-free heart of that: an
 * editor STATE shape, the reducers that add/remove/reorder/rename tabs and set a tab's pattern +
 * config, and `composeSpec(state)` which folds the state into the exact `AppSpec` (v2) object
 * `parseAppSpec` + `validateAppSpec` accept.
 *
 * LOW VARIANCE by construction: a tab holds a `PatternId` + its typed `PatternConfig` (the same
 * closed grammar the renderer consumes). The React layer only ever SELECTS values into these
 * configs — it can't invent a field name or write code — so what the user builds is exactly what
 * the trusted renderer serves. Everything here is a pure function of the state → trivially tested.
 */

import type { AppSpec, Tab, StoryRef, CustomBody } from './schema.ts';
import type { PatternConfig, PatternId } from './patterns.ts';
import type { AppFunction } from './functions-schema.ts';
import { defaultConfigFor } from './compose-fields.ts';

/** One tab under construction: a stable local id, its label/icon, the chosen pattern + its config,
 *  optional role gate, and the stories it serves. A tab is EITHER a pattern body (a `PatternId` +
 *  its live `config`) OR a sandboxed `custom` body (html/css/js + optional read-only data) — the 4c
 *  Advanced editor. `config` is the LIVE pattern config the controls edit in place; both are written
 *  straight into the spec by `composeSpec`. */
export type ComposeTab = {
  /** A stable EDITOR-local id (used as the tab's spec id too — it is a valid grammar token). */
  id: string;
  label: string;
  icon?: string;
  roleGate?: Tab['roleGate'];
  pattern: PatternId;
  config: PatternConfig;
  /** When set, this tab renders a sandboxed custom block INSTEAD of the pattern (Advanced, 4c). */
  custom?: CustomBody;
  stories: StoryRef[];
};

/** The whole composer state: the app's name/description/theme, its ordered tabs, and the app-wide
 *  governed backend DSL functions (3.5d) a KPI card can reference (Advanced editor, 4c). */
export type ComposeState = {
  name: string;
  description: string;
  themeCss?: string;
  tabs: ComposeTab[];
  functions: AppFunction[];
};

/** A short, collision-resistant tab id (a valid grammar token — lowercase alnum + dashes). */
export function newTabId(seed = 'tab'): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${seed}-${rand}`;
}

/** The initial state a fresh spec app opens with: named from the app, one records-table tab so the
 *  user starts from something real rather than a blank canvas. `firstDatasetId` (a granted dataset)
 *  seeds that tab's source; when there is none the source is left empty for the user to pick. */
export function initialState(input: {
  name: string;
  description?: string;
  themeCss?: string;
  firstDatasetId?: string;
}): ComposeState {
  return {
    name: input.name,
    description: input.description ?? '',
    ...(input.themeCss ? { themeCss: input.themeCss } : {}),
    tabs: [makeTab('records-table', { datasetId: input.firstDatasetId })],
    functions: [],
  };
}

/** Hydrate the editor state FROM an existing saved spec (so a spec app re-opens where it left off).
 *  Pattern tabs carry their live config; a `custom` block tab is preserved with its html/css/js (the
 *  4c Advanced editor edits it in place) — a hidden `records-table` config keeps the tab valid if the
 *  user later switches it back to a pattern. App-wide `functions[]` round-trip untouched. */
export function stateFromSpec(spec: AppSpec): ComposeState {
  const tabs: ComposeTab[] = spec.tabs.map((t): ComposeTab => {
    const base = {
      id: t.id,
      label: t.label,
      ...(t.icon ? { icon: t.icon } : {}),
      ...(t.roleGate ? { roleGate: t.roleGate } : {}),
      stories: t.stories ?? [],
    };
    if (t.body.kind === 'custom') {
      return { ...base, pattern: 'records-table', config: defaultConfigFor('records-table', {}), custom: t.body };
    }
    return { ...base, pattern: t.body.pattern, config: t.body.config };
  });
  return {
    name: spec.name,
    description: spec.description,
    ...(spec.theme?.css ? { themeCss: spec.theme.css } : {}),
    tabs: tabs.length > 0 ? tabs : [makeTab('records-table', {})],
    functions: spec.functions ?? [],
  };
}

/** Build a fresh ComposeTab for a pattern with its DEFAULT config (a granted dataset seeds it). */
export function makeTab(pattern: PatternId, opts: { datasetId?: string; label?: string }): ComposeTab {
  return {
    id: newTabId(),
    label: opts.label ?? defaultLabelFor(pattern),
    pattern,
    config: defaultConfigFor(pattern, { datasetId: opts.datasetId }),
    stories: [],
  };
}

/** A friendly default tab label per pattern (the user renames freely). */
export function defaultLabelFor(pattern: PatternId): string {
  const map: Partial<Record<PatternId, string>> = {
    'records-table': 'Records',
    detail: 'Detail',
    'status-board': 'Board',
    'master-detail': 'Browse',
    'kpi-overview': 'Overview',
    'chart-explorer': 'Chart',
    'card-gallery': 'Gallery',
    timeline: 'Timeline',
    calendar: 'Calendar',
    landing: 'Home',
    form: 'New',
    'intake-wizard': 'Intake',
    assignment: 'Assign',
    'approval-queue': 'Approvals',
    'task-checklist': 'Tasks',
  };
  return map[pattern] ?? 'Tab';
}

// ---------------------------------------------------------------- pure reducers ----
// Every reducer returns a NEW state (never mutates), so the React layer can setState(reduce(...))
// and undo/redo/testing stay trivial.

/** Add a tab (with default config) and return the new state. */
export function addTab(state: ComposeState, pattern: PatternId, opts: { datasetId?: string } = {}): ComposeState {
  return { ...state, tabs: [...state.tabs, makeTab(pattern, opts)] };
}

/** Remove the tab at `index` (a no-op when the index is out of range or it is the last tab —
 *  an app must keep at least one tab to stay renderable). */
export function removeTab(state: ComposeState, index: number): ComposeState {
  if (index < 0 || index >= state.tabs.length) return state;
  if (state.tabs.length <= 1) return state; // never drop the last tab
  return { ...state, tabs: state.tabs.filter((_, i) => i !== index) };
}

/** Move the tab at `index` by `delta` (-1 up / +1 down), clamped. Returns a new state. */
export function moveTab(state: ComposeState, index: number, delta: number): ComposeState {
  const to = index + delta;
  if (index < 0 || index >= state.tabs.length || to < 0 || to >= state.tabs.length) return state;
  const tabs = [...state.tabs];
  const [moved] = tabs.splice(index, 1);
  tabs.splice(to, 0, moved);
  return { ...state, tabs };
}

/** Rename the tab at `index`. Empty input is ignored (a tab must keep a label). */
export function renameTab(state: ComposeState, index: number, label: string): ComposeState {
  if (index < 0 || index >= state.tabs.length) return state;
  const trimmed = label;
  const tabs = state.tabs.map((t, i) => (i === index ? { ...t, label: trimmed } : t));
  return { ...state, tabs };
}

/** Switch the tab at `index` to a new pattern, resetting its config to that pattern's default
 *  (carrying over the current dataset source when the new pattern also uses one, so a pattern
 *  swap keeps the user's data choice where it still applies). Returns a new state. */
export function setTabPattern(
  state: ComposeState,
  index: number,
  pattern: PatternId,
  carryDatasetId?: string,
): ComposeState {
  if (index < 0 || index >= state.tabs.length) return state;
  const tabs = state.tabs.map((t, i) =>
    i === index
      ? { ...t, pattern, config: defaultConfigFor(pattern, { datasetId: carryDatasetId }) }
      : t,
  );
  return { ...state, tabs };
}

/** Replace the tab at `index`'s config with a new (already-assembled) pattern config. */
export function setTabConfig(state: ComposeState, index: number, config: PatternConfig): ComposeState {
  if (index < 0 || index >= state.tabs.length) return state;
  const tabs = state.tabs.map((t, i) => (i === index ? { ...t, config } : t));
  return { ...state, tabs };
}

/** Set the stories a tab serves (the tab↔story multiselect). */
export function setTabStories(state: ComposeState, index: number, stories: StoryRef[]): ComposeState {
  if (index < 0 || index >= state.tabs.length) return state;
  const tabs = state.tabs.map((t, i) => (i === index ? { ...t, stories } : t));
  return { ...state, tabs };
}

/** Set the tab's advisory role gate (or clear it when `roleGate` is undefined). */
export function setTabRoleGate(state: ComposeState, index: number, roleGate: Tab['roleGate']): ComposeState {
  if (index < 0 || index >= state.tabs.length) return state;
  const tabs = state.tabs.map((t, i) =>
    i === index ? (roleGate ? { ...t, roleGate } : stripRoleGate(t)) : t,
  );
  return { ...state, tabs };
}

function stripRoleGate(t: ComposeTab): ComposeTab {
  const { roleGate: _drop, ...rest } = t;
  void _drop;
  return rest;
}

/** Make the tab at `index` a SANDBOXED custom block (Advanced, builder-gated). Keeps the tab's
 *  pattern/config hidden so the user can switch back. Returns a new state. */
export function setTabCustom(state: ComposeState, index: number, custom: CustomBody): ComposeState {
  if (index < 0 || index >= state.tabs.length) return state;
  const tabs = state.tabs.map((t, i) => (i === index ? { ...t, custom } : t));
  return { ...state, tabs };
}

/** Turn the tab at `index` back into its pattern body (drops the custom block). Returns a new state. */
export function clearTabCustom(state: ComposeState, index: number): ComposeState {
  if (index < 0 || index >= state.tabs.length) return state;
  const tabs = state.tabs.map((t, i) => (i === index ? stripCustom(t) : t));
  return { ...state, tabs };
}

function stripCustom(t: ComposeTab): ComposeTab {
  const { custom: _drop, ...rest } = t;
  void _drop;
  return rest;
}

/** Set the app-wide theme CSS (empty string clears it). Returns a new state. */
export function setThemeCss(state: ComposeState, css: string): ComposeState {
  const trimmed = css;
  if (trimmed.trim() === '') {
    const { themeCss: _drop, ...rest } = state;
    void _drop;
    return { ...rest, functions: state.functions };
  }
  return { ...state, themeCss: trimmed };
}

/** Replace the app-wide governed DSL `functions[]` (the Advanced function editor writes this). */
export function setFunctions(state: ComposeState, functions: AppFunction[]): ComposeState {
  return { ...state, functions };
}

// ------------------------------------------------------------------- compose → spec ----

/**
 * Fold the editor state into an `AppSpec` (v2). PURE — no validation here (the caller runs the
 * result through `parseAppSpec` + `validateAppSpec`); this only shapes the object so those two are
 * the single gate. Empty theme CSS is omitted; a tab's optional icon/roleGate/stories are only
 * emitted when set, so the produced spec is byte-minimal and stable.
 */
export function composeSpec(state: ComposeState): AppSpec {
  const tabs: Tab[] = state.tabs.map((t) => ({
    id: t.id,
    label: t.label,
    ...(t.icon ? { icon: t.icon } : {}),
    ...(t.roleGate ? { roleGate: t.roleGate } : {}),
    ...(t.stories.length > 0 ? { stories: t.stories } : {}),
    body: t.custom ? t.custom : { kind: 'pattern' as const, pattern: t.pattern, config: t.config },
  }));
  const css = state.themeCss?.trim();
  return {
    version: 2,
    name: state.name,
    description: state.description,
    ...(css ? { theme: { css: state.themeCss! } } : {}),
    tabs,
    ...(state.functions.length > 0 ? { functions: state.functions } : {}),
  };
}
