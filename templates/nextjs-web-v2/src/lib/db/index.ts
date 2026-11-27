/**
 * FEATURE:    The app's own Postgres database (the one module that talks to it).
 * USER STORY: As the author of this app I store my app's own records in my own database, without ever handling a
 *             password or a connection URL.
 * ARCHITECTURE: The platform gives the app a database and role of its own (docs/rules/own-database.md) and sets the
 *               standard libpq variables PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD and PGSSLMODE; `pg` reads them
 *               itself, so this module composes no URL and reads no credential. This is the ONLY file allowed to
 *               import `pg` (the platform policy refuses it anywhere else). Governed shared data (datasets, metrics,
 *               knowledge, files, records) still comes only through `src/lib/os`. Queries are parameterised: pass
 *               values as `params`, never inside the SQL text.
 */
import pg from 'pg';

export type DbEnv = Record<string, string | undefined>;

/** Is the app's database configured in this environment? (false locally without PG* variables, or before the
 *  platform created the database). */
export function dbConfigured(env: DbEnv = process.env): boolean {
  return Boolean(env.PGHOST && env.PGDATABASE && env.PGUSER);
}

let pool: pg.Pool | null = null;

/** The one connection pool of this process, created on first use from the PG* variables. */
export function db(env: DbEnv = process.env): pg.Pool {
  if (!dbConfigured(env)) {
    throw new Error('The app database is not configured here: create it in the App Builder (Code and runs, Database).');
  }
  pool ??= new pg.Pool({ max: 5, idleTimeoutMillis: 30_000 });
  return pool;
}

/** Run one parameterised statement and return its rows. */
export async function query<T extends pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
  const res = await db().query<T>(text, params);
  return res.rows;
}
