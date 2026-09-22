/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Internal cross-domain Marketplace — public module surface.
 * See ./README.md for the model (import = a governed grant), the adapters, and
 * the offline-mock / live dual pattern.
 */

export * from './types';
export { importModesFor, isModeAllowed, enforcementTarget, defaultAccessPolicy, importNote } from './import-policy';
export { compileRls, applyRls, rowMatches, rlsEngineLabel } from './rls';
export { importersOf, planDeprecation, canHardRemove, importerLineage } from './lineage';
export {
  listingAdapter,
  publishAdapter,
  importAdapter,
  rateListing,
  myImports,
  onApprovalDecided,
} from './adapters';
export { listAudit } from './store';
