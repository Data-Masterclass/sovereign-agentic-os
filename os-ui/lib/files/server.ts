/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { makeRequirePrincipal } from '@/lib/core/route-server';
import { ensureHydrated } from '@/lib/files/store';

/**
 * Server boundary for the Files tab routes. Thin wrapper over the shared
 * boundary (`lib/core/route-server.ts`) bound to the Files store's own
 * `ensureHydrated()`, so a restarted os-ui serves the persisted files.
 * Idempotent + graceful when OpenSearch is off.
 */
export const requirePrincipal = makeRequirePrincipal(ensureHydrated);
export { errorResponse } from '@/lib/core/route-server';
