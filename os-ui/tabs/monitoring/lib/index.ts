/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Monitoring — the read/observe plane. Barrel for the OPA-scoped aggregation +
 * trace/lineage correlation spine and its five read-only adapters. See
 * `lib/monitoring/README.md` for the architecture + the validation gate.
 */
export * from '@tabs/monitoring/lib/types';
export { buildOverview, collectAll } from '@tabs/monitoring/lib/aggregate';
export { correlate } from '@tabs/monitoring/lib/correlate';
export { scopeForUser, canSee, filterScope, assertInScope } from '@tabs/monitoring/lib/scope';
export { fetchTrace } from '@tabs/monitoring/lib/adapters/run-trace';
