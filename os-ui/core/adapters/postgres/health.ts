/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Postgres health() for the Platform page — status and version from the server itself
 *             (design 00 §6).
 * USER STORY: As an operator I want the Platform page to show the Postgres version that is running.
 * ARCHITECTURE: one short-lived connection with the connection string os-ui holds
 *   (AGENT_RUNS_DATABASE_URL), read by this adapter's own `governanceHealth` (./pool.ts:
 *   `server_version`), errors mapped by its `pgFailure`. A distribution suffix ("17.6 (Debian …)")
 *   is cut to the release number. No connection string → `invalid`, never a guess.
 */
import pg from 'pg';
import { config } from '@core/kernel/config';
import type { ComponentHealth, Fetched } from '../_contract';
import { failed } from '../health/http';
import { governanceHealth, pgFailure } from './pool';

export async function postgresHealth(connectionString = config.agentRunsDatabaseUrl, timeoutMs = 3_000): Promise<Fetched<ComponentHealth>> {
  if (!connectionString) return failed('invalid', 'os-ui has no Postgres connection string (AGENT_RUNS_DATABASE_URL)');
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: timeoutMs, query_timeout: timeoutMs });
  try {
    await client.connect();
  } catch (err) {
    return pgFailure(err);
  }
  try {
    const h = await governanceHealth(client);
    if (!h.ok) return h;
    const version = h.value.version?.split(' ')[0] ?? null;
    return { ok: true, at: h.at, value: { version, status: 'ready', detail: 'accepting connections' } };
  } finally {
    // Closing can reject on a broken socket; the reading above already says what happened.
    await client.end().catch((e: Error) => console.warn(`[health] postgres: closing the probe connection failed: ${e.message}`));
  }
}
