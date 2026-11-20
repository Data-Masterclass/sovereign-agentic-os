/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       adapters/postgres
 * FEATURE:    Test support for the real-Postgres integration tests (`*.it.ts`)
 * USER STORY: As an engineer I want the governance schema, the audit chain and pg-boss proven
 *             against the same postgres:17 image that runs live, never against a mock, so a green
 *             test means the real database behaves the way the OS relies on.
 * ARCHITECTURE:
 *   - `OS_PG_TEST_URL` is a superuser URL to a throwaway `postgres:17` (CI service container, or
 *     `docker run postgres:17@sha256:5c855ad7…` locally). Unset → the test FAILS with how to run
 *     it. It never skips: a skipped proof reads as a passed one.
 *   - Each test file gets its own fresh database (`CREATE DATABASE wp07_<suffix>`) and drops it at
 *     the end, so files can run in parallel and in any order.
 */
import pg from 'pg';

export function adminUrl(): string {
  const url = process.env.OS_PG_TEST_URL?.trim();
  if (!url) {
    throw new Error(
      'OS_PG_TEST_URL is not set. These tests need a real postgres:17. Run e.g.\n' +
        '  docker run -d --name pg17 -e POSTGRES_PASSWORD=pw -p 55432:5432 postgres:17@sha256:5c855ad7b85e68e48a62f34662853f38b57c1c1d80f3a927ab58034fd6d31c5e\n' +
        '  OS_PG_TEST_URL=postgres://postgres:pw@127.0.0.1:55432/postgres node --test …',
    );
  }
  return url;
}

/** The same server URL pointed at another database (and optionally another login). */
export function urlFor(database: string, login?: { user: string; password: string }): string {
  const u = new URL(adminUrl());
  u.pathname = `/${database}`;
  if (login) {
    u.username = login.user;
    u.password = login.password;
  }
  return u.toString();
}

/** Connect as the admin, retrying while the container finishes its init restart. */
export async function adminClient(database = new URL(adminUrl()).pathname.slice(1) || 'postgres'): Promise<pg.Client> {
  let lastErr: unknown;
  for (let i = 0; i < 30; i++) {
    const c = new pg.Client({ connectionString: urlFor(database) });
    try {
      await c.connect();
      return c;
    } catch (err) {
      lastErr = err;
      await c.end().catch(() => undefined);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw lastErr;
}

/** A fresh, empty database for one test file. Returns its name and a drop function. */
export async function freshDatabase(prefix: string): Promise<{ name: string; url: string; drop: () => Promise<void> }> {
  const name = `${prefix}_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = await adminClient();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  return {
    name,
    url: urlFor(name),
    drop: async () => {
      const c = await adminClient();
      try {
        await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await c.end();
      }
    },
  };
}
