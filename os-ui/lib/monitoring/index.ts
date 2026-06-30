/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Monitoring — the read/observe plane. Barrel for the OPA-scoped aggregation +
 * trace/lineage correlation spine and its five read-only adapters. See
 * `lib/monitoring/README.md` for the architecture + the validation gate.
 */
export * from './types';
export { buildOverview, collectAll } from './aggregate';
export { correlate } from './correlate';
export { scopeForUser, canSee, filterScope, assertInScope } from './scope';
export { fetchTrace } from './adapters/run-trace';
