/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
/**
 * Artifact lifecycle model — the core multi-tenant abstraction shared by every
 * authoring surface (datasets, dbt transformations, metrics, dashboards, agents,
 * knowledge docs). PURE TYPES + helpers only (no secrets, no server imports) so
 * both client components and server routes can import it.
 *
 * Lifecycle:  Personal ──(admin promote)──▶ Shared ──(admin promote)──▶ Certified
 *
 *   • Personal  — owner-only, scoped to its domain.
 *   • Shared    — visible to everyone in the owning domain.
 *   • Certified — published cross-domain into the Marketplace; NOT shown in the
 *                 normal tabs. Other users "add" a Certified artifact, which
 *                 drops a copy (origin='certified-copy') into their own
 *                 workspace, rendered with a "Certified" badge.
 */

export type ArtifactType =
  | 'dataset'
  | 'transformation'
  | 'metric'
  | 'dashboard'
  | 'agent'
  | 'knowledge'
  | 'connection'
  | 'file'
  // A Hermes-created skill (agentskills.io) surfaces as a reviewable artifact —
  // owner/domain/visibility, NOT auto-certified (Hermes integration plan §6).
  | 'skill';

export type Visibility = 'Personal' | 'Shared' | 'Certified';

export type ArtifactOrigin = 'authored' | 'certified-copy';

export type Artifact = {
  id: string;
  type: ArtifactType;
  name: string;
  description: string;
  owner: string; // user id
  domain: string; // tenant scope
  visibility: Visibility;
  origin: ArtifactOrigin;
  /** When origin='certified-copy', the Certified catalog artifact this came from. */
  sourceId?: string;
  /** Free-form, type-specific payload (sql, cube schema, langgraph spec, …). */
  spec?: Record<string, unknown>;
  tags: string[];
  createdAt: string;
  updatedAt: string;
};

export const ARTIFACT_TYPES: ArtifactType[] = [
  'dataset',
  'transformation',
  'metric',
  'dashboard',
  'agent',
  'knowledge',
  'connection',
  'file',
  'skill',
];

export const VISIBILITIES: Visibility[] = ['Personal', 'Shared', 'Certified'];

export const TYPE_LABELS: Record<ArtifactType, string> = {
  dataset: 'Dataset',
  transformation: 'dbt Transformation',
  metric: 'Metric',
  dashboard: 'Dashboard',
  agent: 'Agent',
  knowledge: 'Knowledge Doc',
  connection: 'Connection',
  file: 'File',
  skill: 'Skill',
};

/** The next lifecycle stage an admin can promote to, or null if already top. */
export function nextVisibility(v: Visibility): Visibility | null {
  if (v === 'Personal') return 'Shared';
  if (v === 'Shared') return 'Certified';
  return null;
}

export function promoteLabel(v: Visibility): string | null {
  if (v === 'Personal') return 'Promote to Shared';
  if (v === 'Shared') return 'Certify → Marketplace';
  return null;
}

/** CSS modifier class for the visibility badge (defined in globals.css). */
export function badgeClass(v: Visibility): string {
  return `badge vis-${v.toLowerCase()}`;
}
