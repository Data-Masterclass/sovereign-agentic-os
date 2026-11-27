/**
 * FEATURE:    PLATFORM-OWNED. Closes the app's own database to every other role (isolation layer 2).
 * USER STORY: As the owner of this app I want no other app to be able to connect to my database, even if the cluster's
 *             access rules were ever loosened.
 * ARCHITECTURE: Run by the platform once per database, before the first migration, from this app's release image with
 *               the fixed command `node /app/migrate/isolate.mjs`, as the app's own role (the database owner). Reads only
 *               the standard PG* variables (pg reads them itself) and runs
 *               `REVOKE CONNECT, TEMPORARY ON DATABASE <PGDATABASE> FROM PUBLIC`. The name is checked against the
 *               platform's naming rule before it is quoted. Never edit: the gate refuses a changed migrate/ directory.
 */
import process from 'node:process';
import pg from 'pg';

const name = process.env.PGDATABASE ?? '';
if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) {
  process.stderr.write(`isolate: PGDATABASE is not an app database name: '${name}'\n`);
  process.exit(2);
}
const client = new pg.Client();
await client.connect();
try {
  await client.query(`REVOKE CONNECT, TEMPORARY ON DATABASE "${name}" FROM PUBLIC`);
  process.stdout.write(`isolate: ${name} is closed to PUBLIC\n`);
} finally {
  await client.end();
}
