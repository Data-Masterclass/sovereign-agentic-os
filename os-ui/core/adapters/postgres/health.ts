/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Postgres health() — status and version from the server itself (design 00 §6).
 * USER STORY: As an operator I want the Platform page to show the Postgres version that is running.
 * ARCHITECTURE: one short-lived connection, `SHOW server_version` (the bare number, e.g. 17.6) —
 *   the same value `SELECT version()` starts with. The connection string is the one os-ui
 *   already holds (AGENT_RUNS_DATABASE_URL); without it the reading is `invalid`, never a guess.
 */
import { config } from '@core/kernel/config';
import type { ComponentHealth, Fetched } from '../_contract';
import { failed } from '../health/http';

export async function postgresHealth(connectionString = config.agentRunsDatabaseUrl, timeoutMs = 3_000): Promise<Fetched<ComponentHealth>> {
  if (!connectionString) return failed('invalid', 'os-ui has no Postgres connection string (AGENT_RUNS_DATABASE_URL)');
  const { Client } = await import('pg');
  const client = new Client({ connectionString, connectionTimeoutMillis: timeoutMs, query_timeout: timeoutMs });
  try {
    await client.connect();
    const r = await client.query<{ server_version: string }>('SHOW server_version');
    const version = r.rows[0]?.server_version?.split(' ')[0];
    if (!version) return failed('invalid', 'SHOW server_version returned nothing');
    return { ok: true, at: new Date().toISOString(), value: { version, status: 'ready', detail: 'accepting connections' } };
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === '28P01' || code === '28000') return failed('unauthorized', `postgres refused the login (${code})`);
    if (/timeout/i.test((e as Error).message)) return failed('timeout', (e as Error).message);
    return failed('unreachable', `postgres: ${code ?? (e as Error).message}`);
  } finally {
    // Closing a connection that never opened rejects; the reading above already says why.
    await client.end().catch((e: Error) => console.warn(`[health] postgres: closing the probe connection failed: ${e.message}`));
  }
}
