/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * OS-client SDK — the primitive a governed app uses to call back into the
 * Sovereign OS over the SAME OPA-checked, RLS/DLS-filtered routes the OS UI uses.
 *
 * Usage (inside the OS preview, same-origin, ambient session):
 *   import { createOsClient } from '@core/app-sdk/index';
 *   const os = createOsClient();
 *   const me = await os.whoami();
 *   const ds = await os.datasets.list();
 *
 * Usage (standalone deployed app calling a remote OS):
 *   const os = createOsClient({ baseUrl: 'https://os.example.com' });
 *
 * Dependency-free (native fetch), tree-shakeable named exports.
 */
export {
  createOsClient,
  joinUrl,
  withQuery,
  normalizeGridResult,
  normalizeMetricResult,
  type OsClient,
} from '@core/app-sdk/client';
export { OsError, NotAuthenticated, Forbidden, UnsupportedQuery } from '@core/app-sdk/errors';
export type {
  OsClientOptions,
  WhoAmI,
  OsContext,
  ContextItem,
  KnowledgeHit,
  DatasetQuery,
  MetricQuery,
  QueryResult,
  AppRecord,
  RecordResult,
} from '@core/app-sdk/types';
