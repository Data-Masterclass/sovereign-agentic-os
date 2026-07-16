/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * MySQL / MariaDB provider — FULLY implemented (Phase 1c, operational databases).
 * Trino native `mysql` JDBC connector, read-only federation.
 *
 * KEY RULE — no secret material is ever emitted into the props. The login PASSWORD is
 * referenced through `connection-password=${ENV:MYSQL_PASSWORD}` that the deploy layer
 * wires from a vault secret; the password NEVER appears in the rendered `.properties`.
 *
 * ENGINE SPECIFICS (verified against Trino 476 mysql connector docs):
 *   - `connector.name=mysql`; `connection-url=jdbc:mysql://host:port` (NO database in
 *     the URL — the connector exposes a schema for every MySQL DATABASE on the server).
 *   - MySQL identifier case-sensitivity is OS-dependent (`lower_case_table_names`): on
 *     Linux, database/table names are CASE-SENSITIVE; on Windows/macOS folded to lower.
 *     We enable `case-insensitive-name-matching` so discovery is robust across both.
 *   - json → Trino json; enum → varchar; bit → boolean; datetime → timestamp;
 *     timestamp → timestamp with time zone; blob/binary → varbinary. MySQL has no
 *     array/struct types, so nothing needs a json cast beyond `json` itself.
 *   - Pushdown: equality/IN + aggregate/join push down; predicates on char/varchar do
 *     NOT push down (correctness) — a cost note in `notes`.
 */

import {
  type MySqlConfig,
  type TrinoCatalogProps,
  WarehouseError,
} from '../types.ts';
import type { WarehouseProvider } from '../provider.ts';
import { showTablesQuery } from '../discovery-query.ts';
import { jdbcAuthority } from './postgres.ts';

/** The Trino env var the deploy layer mounts the password into (never inlined). */
const PASSWORD_ENV = 'MYSQL_PASSWORD';

/**
 * MySQL → Trino native `mysql` JDBC connector.
 *
 * Emits the JDBC URL (`jdbc:mysql://host:port`, no database — every MySQL database is a
 * Trino schema), the login user, the password via `${ENV:MYSQL_PASSWORD}` (never
 * inlined), and `case-insensitive-name-matching=true` for OS-portable identifier matching.
 */
function mysqlProps(cfg: MySqlConfig): TrinoCatalogProps {
  // Reuse the shared JDBC authority validator (host[:port], default 3306). It throws
  // WarehouseError with a `postgresql:` prefix on bad input; re-label for MySQL below.
  let authority: string;
  try {
    authority = jdbcAuthority(cfg.host, cfg.port, 3306);
  } catch {
    throw new WarehouseError(`mysql: invalid host '${cfg.host ?? ''}'`);
  }
  const username = (cfg.username ?? '').trim();
  if (!username) throw new WarehouseError('mysql: missing username');

  return {
    'connector.name': 'mysql',
    'connection-url': `jdbc:mysql://${authority}`,
    'connection-user': username,
    // Password supplied by the deploy layer as an env var, sourced from a vault secret.
    // NEVER written into these props.
    'connection-password': `\${ENV:${PASSWORD_ENV}}`,
    // MySQL identifier casing is OS-dependent (lower_case_table_names); match
    // case-insensitively so discovery is robust across Linux/Windows/macOS servers.
    'case-insensitive-name-matching': 'true',
  };
}

export const mysqlProvider: WarehouseProvider = {
  platform: 'mysql',
  label: 'MySQL / MariaDB',
  trinoConnector: 'mysql',
  nativeInImage: true,
  capabilities: { federate: true, import: true },
  catalogProps: (source) => mysqlProps(source as MySqlConfig),
  // A MySQL DATABASE is the Trino schema; `SHOW TABLES FROM <catalog>.<schema>` lists it.
  discoverTables: (source, schema) => showTablesQuery(source, schema),
  // MySQL identifier casing is OS-dependent; quote is backtick at the engine. We match
  // case-insensitively (case-insensitive-name-matching=true), so treat as lower.
  identifierRules: { quote: '`', unquotedCase: 'lower' },
  discoveryMode: 'show',
  // MySQL has no array/struct types; only json needs an explicit carry. enum/set arrive
  // as varchar already. Scalars (bit→boolean, datetime→timestamp, blob→varbinary) pass
  // through — Trino maps them faithfully.
  importTypeRules: [
    { match: /^json$/, castTo: 'json', note: 'MySQL json carried through as Iceberg json' },
    { match: /^set/, castTo: 'varchar', note: 'MySQL SET cast to varchar (comma-joined members; Iceberg has no set type)' },
  ],
  notes: [
    'A MySQL DATABASE maps to a Trino schema — the whole server\'s databases are exposed as schemas (no database is pinned in the JDBC URL).',
    'Identifier CASE-SENSITIVITY is OS-dependent (`lower_case_table_names`): case-sensitive on Linux, folded to lower on Windows/macOS. `case-insensitive-name-matching=true` is set so discovery is robust either way.',
    'PUSHDOWN: equality/IN, aggregate, join and limit push down; predicates on char/varchar columns do NOT push down (correctness) — such filters run in Trino. Prefer filters on numeric/date/indexed columns.',
    'Use a LEAST-PRIVILEGE, read-only user (SELECT-only). The password is vault-referenced via ${ENV:MYSQL_PASSWORD}, never inlined. Also covers MariaDB (wire-compatible).',
  ],
  credentialFields: [
    { key: 'host', label: 'Host', kind: 'text', required: true, help: 'MySQL host or host:port, e.g. mysql.internal or mysql.internal:3306.' },
    { key: 'port', label: 'Port', kind: 'text', required: false, help: 'TCP port (default 3306). Optional if included in Host.' },
    { key: 'username', label: 'Username', kind: 'text', required: true, help: 'Login user (least-privilege, SELECT-only recommended).' },
    {
      key: 'mysql-password',
      label: 'Password',
      kind: 'password',
      required: true,
      help: 'Login password. Stored as a secret; never inlined into props (referenced via ${ENV:MYSQL_PASSWORD}).',
    },
  ],
  secretMaterial: { secretKeys: ['mysql-password'], envVars: [PASSWORD_ENV] },
  testProbe: {
    kind: 'sql',
    query: (source) => `SHOW SCHEMAS FROM ${source.catalog}`,
  },
  openMetadata: {
    connectorType: 'Mysql',
    configKeys: ['hostPort', 'username', 'databaseSchema', 'schemaFilterPattern'],
  },
  liveVerificationRequired: [
    'MySQL/MariaDB reachability from the Trino pod (host:port, network policy) on a live server',
    'login user acceptance + least-privilege read (SELECT) on the target databases',
  ],
};
