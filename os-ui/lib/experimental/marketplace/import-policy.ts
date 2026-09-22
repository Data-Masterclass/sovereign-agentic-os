/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Per-type import policy — the decision spine of the marketplace.
 *
 * PURE logic (no imports beyond local types) so it is unit-testable without a
 * cluster. Encodes the golden-path import table: which import modes each product
 * type allows, the default, where the resulting grant is enforced (the
 * policy-compiler target), and whether an import is auto-granted (`open`) or
 * held for a Governance approval (`approval`).
 */

import type {
  ProductType,
  ImportMode,
  EnforcementTarget,
  AccessPolicy,
} from './types';

/** Allowed import modes per product type (first entry = the default). */
const MODES: Record<ProductType, ImportMode[]> = {
  // Data-like products: read-in-place via a governed grant; fork to adapt.
  dataset: ['read-grant', 'fork'],
  transformation: ['read-grant', 'fork'],
  metric: ['read-grant'],
  knowledge: ['read-grant', 'fork'],
  file: ['read-grant'],
  dashboard: ['read-grant', 'fork'],
  // Each needs its own instance / creds / copy.
  app: ['deploy-instance'],
  connection: ['template'],
  agent: ['fork'],
  // A Hermes skill is a portable, reviewable artifact — fork-to-own on install.
  skill: ['fork'],
};

export function importModesFor(type: ProductType): {
  default: ImportMode;
  options: ImportMode[];
} {
  const options = MODES[type] ?? ['read-grant'];
  return { default: options[0], options };
}

/** Is `mode` a legal way to import a product of `type`? */
export function isModeAllowed(type: ProductType, mode: ImportMode): boolean {
  return (MODES[type] ?? []).includes(mode);
}

/**
 * Where the grant for (type, mode) is enforced — i.e. which policy-compiler
 * output gate carries the RLS. Read-in-place types map to the engine that runs
 * them; forks/instances/templates produce a new owned artifact instead.
 */
export function enforcementTarget(type: ProductType, mode: ImportMode): EnforcementTarget {
  if (mode === 'fork') return 'copy';
  if (mode === 'deploy-instance') return 'instance';
  if (mode === 'template') return 'template';
  // read-grant: pick the runtime engine that enforces the RLS for this type.
  switch (type) {
    case 'metric':
    case 'dashboard':
      return 'cube-rls'; // Cube securityContext (R3 identity propagation).
    case 'knowledge':
    case 'file':
      return 'opensearch-dls'; // OpenSearch Document-Level Security.
    default:
      return 'opa-trino'; // Trino + OPA rowFilter for data products.
  }
}

/**
 * Default access policy for a (type, mode). `read-grant` data-like imports are
 * `open` (auto-grant, RLS still scopes the rows); modes that share an owner's
 * live credentials or compute (a fully-shared connection, a shared app instance)
 * default to `approval`. A certifying owner can override per listing.
 */
export function defaultAccessPolicy(type: ProductType, mode: ImportMode): AccessPolicy {
  if (mode === 'template') return 'approval'; // creating from a shared template touches the owner's connector config
  if (mode === 'deploy-instance') return 'approval'; // provisioning compute on the owner's behalf
  return 'open';
}

/** A short human note shown in the import dialog, per resolved mode. */
export function importNote(type: ProductType, mode: ImportMode): string {
  switch (mode) {
    case 'read-grant':
      return 'You will query this in place under your own identity; row-level security scopes you to your entitled rows. The owner stays the source of truth.';
    case 'fork':
      return 'A governed, editable copy is created in your domain. It may drift from the source over time.';
    case 'deploy-instance':
      return 'Your own instance is provisioned (your Supabase / connections). The owner is not affected.';
    case 'template':
      return 'A new connection is created from the template. Bring your own credentials — they go to the secrets store, never the browser.';
  }
}
