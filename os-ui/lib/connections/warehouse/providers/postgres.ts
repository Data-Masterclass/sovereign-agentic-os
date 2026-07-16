/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * PostgreSQL provider — FULLY implemented (Phase 1c, operational databases). Trino
 * native `postgresql` JDBC connector, read-only federation of ONE database.
 *
 * KEY RULE — no secret material is ever emitted into the props. The login PASSWORD is
 * referenced through an env var (`connection-password=${ENV:POSTGRESQL_PASSWORD}`)
 * that the deploy layer wires from a vault secret; the password itself NEVER appears
 * in the rendered `.properties`. This mirrors Snowflake's `${ENV:...}` discipline.
 * `${ENV:VAR}` is a first-class Trino secrets mechanism (security/secrets docs).
 *
 * ENGINE SPECIFICS (verified against Trino 476 postgresql connector docs):
 *   - `connector.name=postgresql`; `connection-url=jdbc:postgresql://host:port/database`.
 *   - A PostgreSQL SCHEMA maps 1:1 to a Trino schema (multi-schema database).
 *   - PostgreSQL LOWER-CASES unquoted identifiers and quotes with `"`. We enable
 *     `case-insensitive-name-matching` so a discovered lower-case schema still matches.
 *   - json/jsonb → Trino json; uuid → uuid; ARRAY → array (default). hstore →
 *     map(varchar,varchar). These carry into the OS lakehouse honestly (see importTypeRules).
 *   - Pushdown: equality/IN push down; RANGE predicates on varchar/char do NOT push
 *     down by default (case-collation correctness) — a cost note, surfaced in `notes`.
 */

import {
  type PostgresConfig,
  type WarehouseSource,
  type TrinoCatalogProps,
  WarehouseError,
} from '../types.ts';
import type { WarehouseProvider } from '../provider.ts';
import { showTablesQuery } from '../discovery-query.ts';

/** The Trino env var the deploy layer mounts the password into (never inlined). */
const PASSWORD_ENV = 'POSTGRESQL_PASSWORD';

/**
 * Normalize a `host` (or `host:port`) plus an optional `port` into a validated
 * `host[:port]` authority. Pure + total: throws `WarehouseError` on empty/malformed
 * input rather than folding unvalidated user input into the JDBC URL. A port embedded
 * in `host` takes precedence over a separate `port`; anything that is not a bare
 * host-label[:digits] is rejected.
 */
export function jdbcAuthority(host: string, port: string | undefined, dflt: number): string {
  let raw = (host ?? '').trim();
  if (!raw) throw new WarehouseError('postgresql: missing host');
  // Strip an accidental scheme (jdbc:.../https://) and any trailing path so a pasted
  // URL collapses to its authority.
  raw = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^jdbc:[a-z]+:\/\//i, '');
  raw = raw.split('/')[0];
  let h = raw;
  let p = (port ?? '').trim();
  const colon = raw.lastIndexOf(':');
  if (colon > 0 && /^\d+$/.test(raw.slice(colon + 1))) {
    h = raw.slice(0, colon);
    p = raw.slice(colon + 1);
  }
  if (!/^[a-z0-9][a-z0-9.-]*$/i.test(h)) {
    throw new WarehouseError(`postgresql: invalid host '${host}'`);
  }
  if (p && !/^\d{1,5}$/.test(p)) {
    throw new WarehouseError(`postgresql: invalid port '${p}'`);
  }
  return `${h}:${p || dflt}`;
}

/** A database/identifier we can safely fold into the JDBC URL (no path/query injection). */
function safeDbName(name: string): string {
  const s = (name ?? '').trim();
  if (!s || !/^[A-Za-z0-9_$-]+$/.test(s)) {
    throw new WarehouseError(`postgresql: invalid database name '${name ?? ''}'`);
  }
  return s;
}

/**
 * PostgreSQL → Trino native `postgresql` JDBC connector.
 *
 * Emits the JDBC URL (`jdbc:postgresql://host:port/database`), the login user, the
 * password via `${ENV:POSTGRESQL_PASSWORD}` (never inlined), and
 * `case-insensitive-name-matching=true` so PostgreSQL's lower-cased identifiers match.
 */
function postgresProps(cfg: PostgresConfig): TrinoCatalogProps {
  const authority = jdbcAuthority(cfg.host, cfg.port, 5432);
  const database = safeDbName(cfg.database);
  const username = (cfg.username ?? '').trim();
  if (!username) throw new WarehouseError('postgresql: missing username');

  return {
    'connector.name': 'postgresql',
    'connection-url': `jdbc:postgresql://${authority}/${database}`,
    'connection-user': username,
    // Password supplied by the deploy layer as an env var, sourced from a vault secret.
    // The password is NEVER written into these props.
    'connection-password': `\${ENV:${PASSWORD_ENV}}`,
    // PostgreSQL lower-cases unquoted identifiers; match case-insensitively so a
    // schema created as `Sales` (stored `sales`) still resolves through Trino.
    'case-insensitive-name-matching': 'true',
  };
}

export const postgresProvider: WarehouseProvider = {
  platform: 'postgresql',
  label: 'PostgreSQL',
  trinoConnector: 'postgresql',
  nativeInImage: true,
  capabilities: { federate: true, import: true },
  catalogProps: (source) => postgresProps(source as PostgresConfig),
  // A PostgreSQL SCHEMA is the Trino schema; `SHOW TABLES FROM <catalog>.<schema>`
  // lists it (information_schema-backed). The shared builder validates the schema id.
  discoverTables: (source, schema) => showTablesQuery(source, schema),
  // PostgreSQL LOWER-CASES unquoted identifiers and quotes with `"`. Discovery matches
  // case-insensitively (case-insensitive-name-matching=true in the props).
  identifierRules: { quote: '"', unquotedCase: 'lower' },
  discoveryMode: 'show',
  // json/jsonb carry into the OS lakehouse as json; uuid → varchar (Iceberg has no
  // native uuid); hstore → json (map serialized); arrays → json (Trino's default
  // postgresql.array-mapping is DISABLED unless enabled, so a typed array arrives as
  // json/varchar — cast honestly). Scalars (numeric, timestamp, bytea) pass through.
  importTypeRules: [
    { match: /^(jsonb?|json)$/, castTo: 'json', note: 'PostgreSQL json/jsonb carried through as Iceberg json' },
    { match: /^uuid$/, castTo: 'varchar', note: 'PostgreSQL uuid cast to varchar (Iceberg has no native uuid type)' },
    { match: /^hstore$/, castTo: 'json', note: 'PostgreSQL hstore cast to Iceberg json (key/value map serialized)' },
    { match: /(\[\]|^_|array)/, castTo: 'json', note: 'PostgreSQL array cast to Iceberg json (Trino postgresql.array-mapping is off by default; not a typed Iceberg list)' },
  ],
  notes: [
    'A PostgreSQL SCHEMA maps 1:1 to a Trino schema — the catalog federates the schemas of ONE database (set at connect time in the JDBC URL). Cross-database queries need a second catalog.',
    'Identifiers are LOWER-CASED when unquoted (a table typed `Orders` is stored `orders`). `case-insensitive-name-matching=true` is set so discovery still matches.',
    'PUSHDOWN: equality/IN predicates push down, but RANGE predicates (<, >, BETWEEN) on varchar/char do NOT push down by default (correctness under case-insensitive collation) — such filters run in Trino, scanning more rows. Filter on indexed numeric/date columns where possible.',
    'Use a LEAST-PRIVILEGE, read-only role (e.g. a role with only USAGE + SELECT). The password is vault-referenced via ${ENV:POSTGRESQL_PASSWORD}, never inlined.',
  ],
  credentialFields: [
    { key: 'host', label: 'Host', kind: 'text', required: true, help: 'PostgreSQL host or host:port, e.g. db.internal or db.internal:5432.' },
    { key: 'port', label: 'Port', kind: 'text', required: false, help: 'TCP port (default 5432). Optional if included in Host.' },
    { key: 'database', label: 'Database', kind: 'text', required: true, help: 'The single database to federate; its schemas become Trino schemas.' },
    { key: 'username', label: 'Username', kind: 'text', required: true, help: 'Login user (least-privilege, read-only recommended).' },
    {
      // Collected as a password but NEVER lands in the catalog props; stored as a vault
      // secret and mounted via ${ENV:POSTGRESQL_PASSWORD}.
      key: 'postgresql-password',
      label: 'Password',
      kind: 'password',
      required: true,
      help: 'Login password. Stored as a secret; never inlined into props (referenced via ${ENV:POSTGRESQL_PASSWORD}).',
    },
  ],
  // The password is the only secret; secretKeys[0] ↔ envVars[0] positionally.
  secretMaterial: { secretKeys: ['postgresql-password'], envVars: [PASSWORD_ENV] },
  testProbe: {
    kind: 'sql',
    query: (source) => `SHOW SCHEMAS FROM ${source.catalog}`,
  },
  openMetadata: {
    connectorType: 'Postgres',
    configKeys: ['hostPort', 'database', 'username', 'schemaFilterPattern'],
  },
  // Prop rendering is verified purely; the real DB reachability + credential acceptance
  // can only be confirmed against a live PostgreSQL server by the operator.
  liveVerificationRequired: [
    'PostgreSQL reachability from the Trino pod (host:port, network policy) on a live server',
    'login role acceptance + least-privilege read (USAGE + SELECT) on the target schemas',
  ],
};
