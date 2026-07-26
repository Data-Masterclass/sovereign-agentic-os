/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { makeRequirePrincipal } from '@/lib/core/route-server';
import { ensureHydrated } from '@/lib/data/store';

/**
 * Server boundary for the Data tab routes. Thin wrapper over the shared
 * boundary (`lib/core/route-server.ts`) bound to the Data store's own
 * `ensureHydrated()`, so a restarted os-ui serves the persisted datasets (and
 * the Data/Metrics tabs are not wiped). Idempotent + graceful when OpenSearch
 * is off.
 */
export const requirePrincipal = makeRequirePrincipal(ensureHydrated);
export { errorResponse } from '@/lib/core/route-server';
