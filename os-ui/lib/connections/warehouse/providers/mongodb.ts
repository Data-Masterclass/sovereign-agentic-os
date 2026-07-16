/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * MongoDB provider — FULLY implemented (Phase 1c, operational databases). Trino native
 * `mongodb` connector, read-only federation of a schemaless document store.
 *
 * KEY RULE — no secret material is ever emitted into the props. Unlike the JDBC
 * connectors, MongoDB has NO separate password property: credentials live inside the
 * `mongodb.connection-url` (`mongodb://user:pass@host/...`). To keep them out of the
 * rendered props we reference the WHOLE URL via `${ENV:MONGODB_CONNECTION_URL}` — the
 * deploy layer mounts the full connection string (with credentials) from a vault
 * secret; NONE of it appears in the `.properties`. `${ENV:VAR}` is a first-class Trino
 * secrets mechanism (security/secrets docs).
 *
 * ENGINE SPECIFICS (verified against Trino 476 mongodb connector docs):
 *   - `connector.name=mongodb`; `mongodb.connection-url=mongodb://...` or
 *     `mongodb+srv://...`.
 *   - SCHEMALESS: the connector INFERS a schema per collection into a `_schema`
 *     collection (`mongodb.schema-collection`, default `_schema`) by sampling documents.
 *     The inference "can be incorrect" and needs the write-scoped user to persist it —
 *     an honest note. A MongoDB database is a Trino schema; a collection is a table.
 *   - `_id`/ObjectId → varchar (via cast); Object → row; Array → array (or row if
 *     heterogeneous); Date → timestamp(3); Decimal128 → decimal. On import, nested
 *     Object/Array cast to json honestly.
 *   - `mongodb.case-insensitive-name-matching` (default false) — enabled for robust
 *     database/collection matching. TLS via `mongodb.tls.enabled` (operator-configured).
 */

import {
  type MongoConfig,
  type TrinoCatalogProps,
  WarehouseError,
} from '../types.ts';
import type { WarehouseProvider } from '../provider.ts';
import { showTablesQuery } from '../discovery-query.ts';

/** The Trino env var the deploy layer mounts the FULL connection URL into (never inlined). */
const CONNECTION_URL_ENV = 'MONGODB_CONNECTION_URL';

/**
 * Validate the MongoDB `host` (or `host:port` / SRV host) + optional port. Pure + total:
 * throws `WarehouseError` on empty/malformed input. This is METADATA ONLY — the actual
 * connection URL (with credentials) is vaulted and referenced via `${ENV:...}`; the host
 * is validated so the install guide / OM config and a helpful error stay honest.
 */
export function validateMongoHost(cfg: MongoConfig): string {
  let raw = (cfg.host ?? '').trim();
  if (!raw) throw new WarehouseError('mongodb: missing host');
  raw = raw.replace(/^mongodb(\+srv)?:\/\//i, '').replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  // Drop any accidental credentials@ prefix or trailing path/query — host only.
  const at = raw.indexOf('@');
  if (at >= 0) raw = raw.slice(at + 1);
  raw = raw.split('/')[0].split('?')[0];
  let h = raw;
  let p = (cfg.port ?? '').trim();
  const colon = raw.lastIndexOf(':');
  if (colon > 0 && /^\d+$/.test(raw.slice(colon + 1))) {
    h = raw.slice(0, colon);
    p = raw.slice(colon + 1);
  }
  if (!/^[a-z0-9][a-z0-9.-]*$/i.test(h)) {
    throw new WarehouseError(`mongodb: invalid host '${cfg.host}'`);
  }
  if (p && !/^\d{1,5}$/.test(p)) {
    throw new WarehouseError(`mongodb: invalid port '${p}'`);
  }
  // SRV seed-list URIs must NOT carry a port (the DNS record supplies it).
  if (cfg.srv && p) {
    throw new WarehouseError('mongodb: a mongodb+srv host must not include a port (the SRV DNS record supplies it)');
  }
  return cfg.srv ? h : `${h}:${p || 27017}`;
}

/**
 * MongoDB → Trino native `mongodb` connector.
 *
 * Emits ONLY the connector name, the vault-referenced connection URL
 * (`${ENV:MONGODB_CONNECTION_URL}`), the schema-inference collection, and
 * case-insensitive name matching. Credentials are NEVER inlined — the whole URL is the
 * secret. The host config is validated (honest error / OM metadata) but not emitted.
 */
function mongoProps(cfg: MongoConfig): TrinoCatalogProps {
  // Validate the host so a malformed config fails the same way the JDBC providers do,
  // even though the emitted URL is the vaulted env var (not this host).
  validateMongoHost(cfg);

  return {
    'connector.name': 'mongodb',
    // The FULL connection URL (incl. credentials) is supplied by the deploy layer as an
    // env var, sourced from a vault secret. It is NEVER written into these props.
    'mongodb.connection-url': `\${ENV:${CONNECTION_URL_ENV}}`,
    // The connector infers a schema per collection into this collection (default _schema).
    'mongodb.schema-collection': '_schema',
    // Robust database/collection name matching across case variants.
    'mongodb.case-insensitive-name-matching': 'true',
  };
}

export const mongoProvider: WarehouseProvider = {
  platform: 'mongodb',
  label: 'MongoDB',
  trinoConnector: 'mongodb',
  nativeInImage: true,
  capabilities: { federate: true, import: true },
  catalogProps: (source) => mongoProps(source as MongoConfig),
  // A MongoDB DATABASE is the Trino schema and a COLLECTION is a table, but they only
  // list AFTER the connector has inferred a schema for them into `_schema`. The listing
  // query is the same cheap `SHOW TABLES FROM <catalog>.<schema>`; discovery honestly
  // depends on inferred/registered collections (see notes + discoveryMode).
  discoverTables: (source, schema) => showTablesQuery(source, schema),
  // MongoDB is SCHEMALESS: names are stored as written and matched case-insensitively
  // (mongodb.case-insensitive-name-matching=true). No engine quote char applies to a
  // document store; Trino double-quotes when it must.
  identifierRules: { quote: '"', unquotedCase: 'preserve' },
  // `show`, but honestly: a collection only lists once its schema is inferred into
  // `_schema`. Empty/newly-added collections may need a first sample or a manual
  // `_schema` entry before they appear — surfaced in notes.
  discoveryMode: 'show',
  // Nested Mongo shapes have no faithful flat-Iceberg equivalent → cast to json on
  // import. ObjectId → varchar (its hex string). Date/Decimal128 pass through (Trino
  // maps them to timestamp/decimal faithfully).
  importTypeRules: [
    // ObjectId is matched FIRST — otherwise `^object` below would swallow `objectid`.
    { match: /^objectid$/, castTo: 'varchar', note: 'MongoDB ObjectId cast to varchar (24-char hex; use objectid_timestamp() before import to keep the embedded time)' },
    { match: /^(object|row|document)/, castTo: 'json', note: 'MongoDB embedded document cast to Iceberg json (nested fields serialized)' },
    { match: /^array/, castTo: 'json', note: 'MongoDB array cast to Iceberg json (heterogeneous arrays have no typed Iceberg list)' },
  ],
  notes: [
    'SCHEMALESS: the connector INFERS a schema per collection into a `_schema` collection by sampling documents. The initial guess can be WRONG for heterogeneous collections; correct it by editing `_schema`. A database is a Trino schema; a collection is a table.',
    'The connection user needs WRITE access to the `_schema` collection so inferred schemas persist (Trino\'s documented requirement) — even though all data reads are read-only. Scope the user to that one write + read on the target databases.',
    'DISCOVERY honestly depends on inference: a brand-new or empty collection may not list until it is sampled or given a manual `_schema` entry. This is not a failure — it is how a schemaless store is catalogued.',
    'Credentials live INSIDE the connection URL (Mongo has no separate password property), so the WHOLE URL is the vaulted secret, referenced via ${ENV:MONGODB_CONNECTION_URL}; nothing is inlined. Use `mongodb+srv://` for Atlas/replica-set DNS; enable TLS on the URL (`?tls=true`).',
  ],
  credentialFields: [
    { key: 'host', label: 'Host', kind: 'text', required: true, help: 'MongoDB host or host:port (or SRV host for mongodb+srv), e.g. mongo.internal:27017. Metadata only — the full URL is the secret.' },
    { key: 'port', label: 'Port', kind: 'text', required: false, help: 'TCP port (default 27017). Omit for mongodb+srv (the SRV DNS record supplies it).' },
    {
      // The FULL connection URL (with user:pass) is the secret — NEVER lands in props.
      // Stored as a vault secret and mounted via ${ENV:MONGODB_CONNECTION_URL}.
      key: 'mongodb-connection-url',
      label: 'Connection URL (with credentials)',
      kind: 'password',
      required: true,
      help: 'Full mongodb:// or mongodb+srv:// URL including user:password. Stored as a secret; never inlined into props (referenced via ${ENV:MONGODB_CONNECTION_URL}).',
    },
  ],
  // The full connection URL is the only secret; secretKeys[0] ↔ envVars[0] positionally.
  secretMaterial: { secretKeys: ['mongodb-connection-url'], envVars: [CONNECTION_URL_ENV] },
  testProbe: {
    kind: 'sql',
    query: (source) => `SHOW SCHEMAS FROM ${source.catalog}`,
  },
  openMetadata: {
    connectorType: 'MongoDB',
    configKeys: ['hostPort', 'databaseName', 'schemaFilterPattern'],
  },
  liveVerificationRequired: [
    'MongoDB reachability from the Trino pod (host:port or SRV DNS, TLS, network policy) on a live deployment',
    'connection-URL credential acceptance + write access to the `_schema` collection (Trino requires it to persist inferred schemas)',
    'schema-inference quality per collection: whether the sampled types are correct or need manual `_schema` correction',
  ],
};
