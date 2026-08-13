/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * CHOOSE-CONTEXT model (Phase 4b) — the pure, client-safe descriptor of the SIX grantable
 * context types and how each one's "Create new" behaves, plus the copy that makes the
 * use-existing vs create-new modes unmistakable. Kept separate from the React component so
 * the UI and the unit tests share one source of truth (no default-string drift), mirroring
 * `lib/core/context-grants.ts`.
 *
 * The six types (DESIGN.md "Context & capabilities"): Data · Metrics · Files · Knowledge ·
 * Agents · Connections. Five ride the OS-wide core `ContextGrants` primitive; Agents ride
 * the separate `app.grants.agents` list (`lib/software/app-agent-grants.ts`).
 */

/** Every Choose-Context type, in stable display order. */
export type ChooseContextType =
  | 'data' | 'metrics' | 'files' | 'knowledge' | 'agents' | 'connections';

export const CHOOSE_CONTEXT_TYPES: ChooseContextType[] = [
  'data', 'metrics', 'files', 'knowledge', 'agents', 'connections',
];

/** How a type's "Create new" resolves. */
export type CreateNewMode =
  /** Create a fresh, possibly-empty artifact IN the App folder via context-provision, then grant. */
  | 'in-folder'
  /** Deep-link into another tab's own builder (it has its own creator), then grant on return. */
  | 'deep-link'
  /** No standalone create (the artifact is derived elsewhere) — point to the owning tab. */
  | 'derived';

export type ChooseContextTypeMeta = {
  type: ChooseContextType;
  label: string;
  /** One honest line under the type header — what granting THIS type gives the app. */
  blurb: string;
  createMode: CreateNewMode;
  /** The label on the create-new affordance. */
  createLabel: string;
  /** For deep-link/derived types: the OS tab a "Create new" points at. */
  createTab?: 'agents' | 'connections' | 'metrics';
  /** A short note explaining a deep-link / derived create (why it lives in another tab). */
  createNote?: string;
};

/** The six type descriptors — the single source of the section copy + create behaviour. */
export const CHOOSE_CONTEXT_META: Record<ChooseContextType, ChooseContextTypeMeta> = {
  data: {
    type: 'data', label: 'Data', createMode: 'in-folder',
    blurb: 'Governed datasets the app reads in place (OPA/DLS-scoped, run as the viewer — never a copy).',
    createLabel: 'Create new dataset',
  },
  metrics: {
    type: 'metrics', label: 'Metrics', createMode: 'derived', createTab: 'metrics',
    blurb: 'Governed metrics (a measure on a dataset) the app can slice.',
    createLabel: 'Define a metric in the Data tab',
    createNote: 'A metric is defined on a dataset in the Data tab — create the dataset here, then define its metric there.',
  },
  files: {
    type: 'files', label: 'Files', createMode: 'in-folder',
    blurb: 'Governed files the app can read (DLS-scoped).',
    createLabel: 'Create new file',
  },
  knowledge: {
    type: 'knowledge', label: 'Knowledge', createMode: 'in-folder',
    blurb: 'Governed knowledge the app can search (DLS-scoped).',
    createLabel: 'Create new knowledge',
  },
  agents: {
    type: 'agents', label: 'Agents', createMode: 'deep-link', createTab: 'agents',
    blurb: 'How intelligence enters the app — a governed, evaluated, role-gated agent it can run. The app never calls the raw LLM.',
    createLabel: 'Create new agent in the Agents tab',
    createNote: 'Agents are built + evaluated in the Agents tab (their own creator). Create one there, then grant it here.',
  },
  connections: {
    type: 'connections', label: 'Connections', createMode: 'deep-link', createTab: 'connections',
    blurb: 'Mediated external access — the app uses a connection only through a governed capability, never raw credentials.',
    createLabel: 'Create new connection in the Connections tab',
    createNote: 'Connections are created in the Connections tab (their own creator). Create one there, then grant it here.',
  },
};

/** The types whose "Create new" makes a fresh artifact in the App folder (vs deep-link/derived). */
export function isInFolderCreateType(type: ChooseContextType): boolean {
  return CHOOSE_CONTEXT_META[type].createMode === 'in-folder';
}

/** The "Already available to this app" count line for a type, given how many are granted. */
export function grantedSummary(count: number): string {
  if (count === 0) return 'Nothing granted yet';
  return `${count} already available to this app`;
}
