/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       adapters/postgres
 * FEATURE:    The one job queue: pg-boss (MIT, pinned 12.38.2) in its own schema
 * USER STORY: As an operator I want every background job (reconciles, Docling, scans, scheduled
 *             runs) on one durable queue in the database we already back up, not on timers that
 *             die with a pod.
 * ARCHITECTURE:
 *   - `new PgBoss({ connectionString, schema })` exactly as docs/api/constructor.md documents it.
 *     pg-boss installs and migrates its own schema (`pgboss`) at `start()`; the OS never writes
 *     to it and does not wrap pg-boss's API.
 *   - Design 10 F8: queues per reconciler, `singletonKey` coalescing, `send(…, { db })` as the
 *     outbox, `schedule()` with `tz`. The behaviours are proven in `pgboss.it.ts`.
 *   - The caller owns `start()` / `stop()` and must listen for `error` (pg-boss's documented
 *     contract); this module only fixes the schema name.
 */
import { PgBoss } from 'pg-boss';

export const PGBOSS_SCHEMA = 'pgboss';

export function createBoss(databaseUrl: string): PgBoss {
  const connectionString = databaseUrl.trim();
  if (!connectionString) throw new Error('createBoss: no database URL');
  return new PgBoss({ connectionString, schema: PGBOSS_SCHEMA });
}
