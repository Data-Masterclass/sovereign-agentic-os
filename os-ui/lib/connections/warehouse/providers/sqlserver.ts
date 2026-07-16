/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Microsoft SQL Server provider — FULLY implemented (Phase 1c, operational databases).
 * Trino native `sqlserver` JDBC connector, read-only federation of ONE database.
 *
 * KEY RULE — no secret material is ever emitted into the props. The login PASSWORD is
 * referenced through `connection-password=${ENV:SQLSERVER_PASSWORD}` that the deploy
 * layer wires from a vault secret; the password NEVER appears in the rendered props.
 *
 * ENGINE SPECIFICS (verified against Trino 476 sqlserver connector docs):
 *   - `connector.name=sqlserver`;
 *     `connection-url=jdbc:sqlserver://host:port;databaseName=<db>`.
 *   - The catalog is pinned to ONE database; SQL Server's database.schema.table folds to
 *     Trino's catalog.schema.table with the database fixed at connect time.
 *   - SQL Server identifiers quote with `[ ]` (or `"`); case-sensitivity is COLLATION-
 *     driven (default installs are case-INSENSITIVE). We enable
 *     `case-insensitive-name-matching` so discovery matches under either collation.
 *   - bit → boolean; datetime2(n) → timestamp(n); datetimeoffset(n) → timestamp(n) with
 *     time zone; uniqueidentifier → varchar; money/smallmoney/xml/image have no faithful
 *     Iceberg equivalent → cast to varchar (honest). nvarchar → varchar; varbinary →
 *     varbinary.
 *   - Pushdown: equality/IN on varchar/nvarchar push down ONLY under case-sensitive
 *     collation; join/limit/top-N/aggregate push down. Snapshot isolation is used by
 *     default (`sqlserver.snapshot-isolation.disabled` can turn it off) — a note.
 */

import {
  type SqlServerConfig,
  type TrinoCatalogProps,
  WarehouseError,
} from '../types.ts';
import type { WarehouseProvider } from '../provider.ts';
import { showTablesQuery } from '../discovery-query.ts';
import { jdbcAuthority } from './postgres.ts';

/** The Trino env var the deploy layer mounts the password into (never inlined). */
const PASSWORD_ENV = 'SQLSERVER_PASSWORD';

/** A database name we can safely fold into `databaseName=` (no `;`/query injection). */
function safeDbName(name: string): string {
  const s = (name ?? '').trim();
  if (!s || !/^[A-Za-z0-9_$-]+$/.test(s)) {
    throw new WarehouseError(`sqlserver: invalid database name '${name ?? ''}'`);
  }
  return s;
}

/**
 * SQL Server → Trino native `sqlserver` JDBC connector.
 *
 * Emits the JDBC URL (`jdbc:sqlserver://host:port;databaseName=<db>`), the login user,
 * the password via `${ENV:SQLSERVER_PASSWORD}` (never inlined), and
 * `case-insensitive-name-matching=true` for collation-robust identifier matching.
 */
function sqlServerProps(cfg: SqlServerConfig): TrinoCatalogProps {
  let authority: string;
  try {
    authority = jdbcAuthority(cfg.host, cfg.port, 1433);
  } catch {
    throw new WarehouseError(`sqlserver: invalid host '${cfg.host ?? ''}'`);
  }
  const database = safeDbName(cfg.database);
  const username = (cfg.username ?? '').trim();
  if (!username) throw new WarehouseError('sqlserver: missing username');

  return {
    'connector.name': 'sqlserver',
    // The database is pinned in the URL; `encrypt` is left to the JDBC driver default
    // (we never force `encrypt=false` — that would downgrade TLS).
    'connection-url': `jdbc:sqlserver://${authority};databaseName=${database}`,
    'connection-user': username,
    // Password supplied by the deploy layer as an env var, sourced from a vault secret.
    // NEVER written into these props.
    'connection-password': `\${ENV:${PASSWORD_ENV}}`,
    // SQL Server case-sensitivity is collation-driven (default installs are
    // case-insensitive); match case-insensitively so discovery is robust either way.
    'case-insensitive-name-matching': 'true',
  };
}

export const sqlServerProvider: WarehouseProvider = {
  platform: 'sqlserver',
  label: 'Microsoft SQL Server',
  trinoConnector: 'sqlserver',
  nativeInImage: true,
  capabilities: { federate: true, import: true },
  catalogProps: (source) => sqlServerProps(source as SqlServerConfig),
  // A SQL Server SCHEMA (within the pinned database) is the Trino schema;
  // `SHOW TABLES FROM <catalog>.<schema>` lists it.
  discoverTables: (source, schema) => showTablesQuery(source, schema),
  // SQL Server quotes identifiers with `[ ]` (bracket) — captured here; case-sensitivity
  // is collation-driven (default case-INSENSITIVE), matched case-insensitively.
  identifierRules: { quote: '[', unquotedCase: 'preserve' },
  discoveryMode: 'show',
  // SQL Server types with no faithful Iceberg equivalent are cast HONESTLY on import:
  // uniqueidentifier/money/smallmoney/xml → varchar. Scalars (bit→boolean,
  // datetime2→timestamp, datetimeoffset→timestamp w/ tz, nvarchar→varchar,
  // varbinary→varbinary) pass through — Trino maps them faithfully.
  importTypeRules: [
    { match: /^uniqueidentifier$/, castTo: 'varchar', note: 'SQL Server uniqueidentifier cast to varchar (GUID text; Iceberg has no native uuid)' },
    { match: /^(money|smallmoney)$/, castTo: 'varchar', note: 'SQL Server money/smallmoney cast to varchar (fixed-scale currency; import then re-cast to decimal if needed)' },
    { match: /^xml$/, castTo: 'varchar', note: 'SQL Server xml cast to varchar (document text; Iceberg has no native xml)' },
    { match: /^image$/, castTo: 'varbinary', note: 'SQL Server image cast to varbinary (deprecated LOB; prefer varbinary(max))' },
  ],
  notes: [
    'The catalog pins ONE database (`databaseName=`); SQL Server\'s database.schema.table folds to Trino\'s catalog.schema.table. A second database needs a second catalog.',
    'Identifiers quote with `[ ]`; case-sensitivity is COLLATION-driven (default installs are case-INSENSITIVE). `case-insensitive-name-matching=true` is set so discovery matches under either collation.',
    'PUSHDOWN: predicates on varchar/nvarchar push down ONLY when the column uses a CASE-SENSITIVE collation; otherwise they run in Trino. Join/limit/top-N/aggregate push down. TLS: `encrypt` is left to the JDBC driver default — never forced to `false`.',
    'Reads use SNAPSHOT ISOLATION by default (consistent, non-blocking); requires ALLOW_SNAPSHOT_ISOLATION on the database. Use a LEAST-PRIVILEGE read-only login; the password is vault-referenced via ${ENV:SQLSERVER_PASSWORD}, never inlined.',
  ],
  credentialFields: [
    { key: 'host', label: 'Host', kind: 'text', required: true, help: 'SQL Server host or host:port, e.g. sql.internal or sql.internal:1433.' },
    { key: 'port', label: 'Port', kind: 'text', required: false, help: 'TCP port (default 1433). Optional if included in Host.' },
    { key: 'database', label: 'Database', kind: 'text', required: true, help: 'The single database the catalog pins to (databaseName=).' },
    { key: 'username', label: 'Username', kind: 'text', required: true, help: 'Login user (least-privilege, read-only recommended).' },
    {
      key: 'sqlserver-password',
      label: 'Password',
      kind: 'password',
      required: true,
      help: 'Login password. Stored as a secret; never inlined into props (referenced via ${ENV:SQLSERVER_PASSWORD}).',
    },
  ],
  secretMaterial: { secretKeys: ['sqlserver-password'], envVars: [PASSWORD_ENV] },
  testProbe: {
    kind: 'sql',
    query: (source) => `SHOW SCHEMAS FROM ${source.catalog}`,
  },
  openMetadata: {
    connectorType: 'Mssql',
    configKeys: ['hostPort', 'database', 'username', 'schemaFilterPattern'],
  },
  liveVerificationRequired: [
    'SQL Server reachability from the Trino pod (host:port, network policy, TLS) on a live server',
    'login acceptance + least-privilege read (db_datareader) on the pinned database',
    'ALLOW_SNAPSHOT_ISOLATION enabled on the database (Trino uses snapshot isolation by default)',
  ],
};
