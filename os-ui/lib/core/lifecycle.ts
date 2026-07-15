/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Lifecycle copy + gating — the single source of truth for what the OS SAYS when
 * you archive, restore or (physically) delete an artifact. It is pure and
 * DOM-free on purpose so the wording and the type-to-confirm gate can be unit
 * tested (see lifecycle.test.ts) while the React <ConfirmDialog>/<LifecycleActions>
 * components render it identically across every tab.
 *
 * Delete is REAL: it purges the backing resource (Iceberg tables, MinIO objects,
 * k8s apps, Forgejo repos, Superset dashboards, Cube models, vault secrets,
 * OpenSearch vectors). The copy names that consequence per artifact kind so the
 * user knows exactly what disappears — and shared/certified artifacts, which
 * affect other people, additionally require typing the name to confirm.
 */

/** Every artifact surface the lifecycle controls appear on. */
export type ArtifactKind =
  | 'dataset'
  | 'file'
  | 'app'
  | 'agent'
  | 'dashboard'
  | 'metric'
  | 'connection'
  | 'knowledge'
  | 'bigbet'
  | 'pillar'
  | 'model';

/** Visibility tier — Shared/Certified artifacts affect others, so delete is gated harder. */
export type Visibility = 'personal' | 'shared' | 'certified' | string;

/** The physical thing a delete tears down, per kind — named so the warning is concrete. */
const BACKING: Record<ArtifactKind, string> = {
  dataset: 'drops its Iceberg tables',
  file: 'deletes the stored file',
  app: 'tears down the running app and its repo',
  agent: 'removes its repo and schedule',
  dashboard: 'deletes the Superset dashboard',
  metric: 'removes it from the semantic layer',
  connection: 'purges its stored credential',
  knowledge: 'removes it from the search index',
  bigbet: 'deletes the bet and its plan',
  pillar: 'deletes the strategic pillar and its targets',
  model: 'tears down its serving endpoint and registry entry',
};

/** Human noun for a kind, for prose ("this dataset", "this app"). */
const NOUN: Record<ArtifactKind, string> = {
  dataset: 'dataset',
  file: 'file',
  app: 'app',
  agent: 'agent',
  dashboard: 'dashboard',
  metric: 'metric',
  connection: 'connection',
  knowledge: 'knowledge item',
  bigbet: 'big bet',
  pillar: 'strategic pillar',
  model: 'model',
};

export type ConfirmCopy = {
  title: string;
  body: string;
  confirmLabel: string;
  danger: boolean;
  /** When set, the confirm button stays disabled until the user types this exactly. */
  confirmPhrase?: string;
};

/** Shared/Certified artifacts affect other people — deleting them requires typing the name. */
export function affectsOthers(visibility: Visibility): boolean {
  return visibility === 'shared' || visibility === 'certified';
}

/** The LIGHT archive confirm — reversible, low-stakes. */
export function archiveCopy(name: string): ConfirmCopy {
  return {
    title: `Archive “${name}”?`,
    body: `It'll be hidden from lists but you can restore it anytime.`,
    confirmLabel: 'Archive',
    danger: false,
  };
}

/** The STRONG delete confirm — permanent, physical, and named per kind. */
export function deleteCopy(kind: ArtifactKind, name: string, visibility: Visibility): ConfirmCopy {
  const shared = affectsOthers(visibility);
  const body =
    `This permanently deletes ${NOUN[kind]} “${name}” and ${BACKING[kind]}. ` +
    `This cannot be undone.` +
    (shared ? ` Others rely on this shared artifact — type its name to confirm.` : '');
  return {
    title: `Delete “${name}”?`,
    body,
    confirmLabel: 'Delete permanently',
    danger: true,
    confirmPhrase: shared ? name : undefined,
  };
}

/** Restore-from-version confirm — changes current state, so it asks first (light). */
export function restoreVersionCopy(name: string, version: number): ConfirmCopy {
  return {
    title: `Restore version ${version}?`,
    body: `This makes version ${version} the current state of “${name}”. Your current state is snapshotted first, so this is reversible.`,
    confirmLabel: 'Restore this version',
    danger: false,
  };
}

/** Whether a typed value satisfies a confirmPhrase gate (trimmed, case-sensitive to the name). */
export function phraseSatisfied(confirmPhrase: string | undefined, typed: string): boolean {
  if (!confirmPhrase) return true;
  return typed.trim() === confirmPhrase.trim();
}
