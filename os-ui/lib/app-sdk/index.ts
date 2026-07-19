/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * OS-client SDK — the primitive a governed app uses to call back into the
 * Sovereign OS over the SAME OPA-checked, RLS/DLS-filtered routes the OS UI uses.
 *
 * Usage (inside the OS preview, same-origin, ambient session):
 *   import { createOsClient } from '@/lib/app-sdk';
 *   const os = createOsClient();
 *   const me = await os.whoami();
 *   const ds = await os.datasets.list();
 *
 * Usage (standalone deployed app calling a remote OS):
 *   const os = createOsClient({ baseUrl: 'https://os.example.com' });
 *
 * Dependency-free (native fetch), tree-shakeable named exports.
 */
export { createOsClient, joinUrl, withQuery, type OsClient } from './client.ts';
export { OsError, NotAuthenticated, Forbidden, UnsupportedQuery } from './errors.ts';
export type {
  OsClientOptions,
  WhoAmI,
  OsContext,
  ContextItem,
  KnowledgeHit,
  DatasetQuery,
  MetricQuery,
} from './types.ts';
