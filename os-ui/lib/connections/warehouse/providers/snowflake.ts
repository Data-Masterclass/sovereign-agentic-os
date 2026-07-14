/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Snowflake provider — FULLY implemented (Phase 1b). Trino native `snowflake`
 * JDBC connector, RSA key-pair auth (NO password auth).
 *
 * KEY RULE — no secret material is ever emitted into the props. The RSA private
 * key is referenced through an env var (`connection-private-key=${ENV:SNOWFLAKE_PRIVATE_KEY}`)
 * that the deploy layer wires from a vault secret; the PEM itself NEVER appears in
 * the rendered `.properties`. This mirrors Glue's "no static keys" discipline —
 * there Trino gets identity from IRSA, here from a mounted env var.
 */

import {
  type SnowflakeConfig,
  type TrinoCatalogProps,
  WarehouseError,
} from '../types.ts';
import type { WarehouseProvider } from '../provider.ts';

/**
 * Derive the Snowflake JDBC host from `accountUrl`. Accepts EITHER a bare account
 * locator (`ORG-ACCOUNT`) OR a full URL (`https://ORG-ACCOUNT.snowflakecomputing.com`)
 * and normalizes both to `<account>.snowflakecomputing.com`.
 *
 * Pure + total: throws `WarehouseError` on empty / malformed input rather than
 * emitting a nonsense connection URL.
 */
function snowflakeHost(accountUrl: string): string {
  let raw = (accountUrl ?? '').trim();
  if (!raw) {
    throw new WarehouseError("snowflake: missing account (accountUrl)");
  }
  // Strip an explicit scheme and any path/query if a full URL was supplied.
  raw = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  raw = raw.split('/')[0];
  // Normalize away the domain suffix so a bare locator and a full URL collapse to
  // the same account, then re-append the canonical suffix exactly once.
  const suffix = '.snowflakecomputing.com';
  const account = raw.toLowerCase().endsWith(suffix)
    ? raw.slice(0, -suffix.length)
    : raw;
  // A Snowflake account locator is host-label safe: alphanumerics, hyphen, dot
  // (org-qualified names use `.`; legacy locators use `-`). Reject anything else so
  // we never fold user input into the JDBC URL unvalidated.
  if (!/^[a-z0-9][a-z0-9.-]*$/i.test(account)) {
    throw new WarehouseError(
      `snowflake: invalid account locator '${accountUrl}'`,
    );
  }
  return `${account}${suffix}`;
}

/**
 * Snowflake → Trino native `snowflake` JDBC connector, RSA key-pair auth.
 *
 * Emits the JDBC connection URL derived from the account, the database / warehouse
 * / (optional) role, and the username. The private key is referenced via
 * `${ENV:SNOWFLAKE_PRIVATE_KEY}` — the PEM material is NEVER inlined here.
 */
function snowflakeProps(cfg: SnowflakeConfig): TrinoCatalogProps {
  if (!cfg.database) {
    throw new WarehouseError('snowflake: missing database');
  }
  const host = snowflakeHost(cfg.accountUrl);

  const props: TrinoCatalogProps = {
    'connector.name': 'snowflake',
    'connection-url': `jdbc:snowflake://${host}`,
    // Key-pair auth: the private key is supplied by the deploy layer as an env var,
    // sourced from a vault secret. The PEM is NEVER written into these props.
    'connection-private-key': '${ENV:SNOWFLAKE_PRIVATE_KEY}',
    'snowflake.database': cfg.database,
    'snowflake.warehouse': cfg.warehouse,
  };
  if (cfg.username) props['connection-user'] = cfg.username;
  if (cfg.role) props['snowflake.role'] = cfg.role;

  return props;
}

export const snowflakeProvider: WarehouseProvider = {
  platform: 'snowflake',
  label: 'Snowflake',
  trinoConnector: 'snowflake',
  nativeInImage: true,
  capabilities: { federate: true, import: true },
  catalogProps: (source) => snowflakeProps(source as SnowflakeConfig),
  credentialFields: [
    {
      key: 'accountUrl',
      label: 'Account / host',
      kind: 'text',
      required: true,
      help: 'Snowflake account locator (ORG-ACCOUNT) or full host URL (https://ORG-ACCOUNT.snowflakecomputing.com).',
    },
    {
      key: 'database',
      label: 'Database',
      kind: 'text',
      required: true,
      help: 'Snowflake database to federate.',
    },
    {
      key: 'warehouse',
      label: 'Warehouse',
      kind: 'text',
      required: true,
      help: 'Virtual warehouse that runs the queries (resumes on use; consumes credits).',
    },
    {
      key: 'username',
      label: 'Username',
      kind: 'text',
      required: true,
      help: 'Snowflake login the RSA key-pair belongs to.',
    },
    {
      key: 'role',
      label: 'Role',
      kind: 'text',
      required: false,
      help: 'Role to assume for queries (least-privilege, read-only). Optional.',
    },
    {
      // The private key is collected as a PEM but NEVER lands in the catalog props;
      // it is stored as a vault secret and mounted via ${ENV:SNOWFLAKE_PRIVATE_KEY}.
      key: 'snowflake-private-key',
      label: 'RSA private key (PEM)',
      kind: 'pem',
      required: true,
      help: 'Unencrypted PKCS#8 RSA private key whose public key is registered on the Snowflake user. Stored as a secret; never inlined into props.',
    },
  ],
  // The RSA private key is the only secret; it is mounted as SNOWFLAKE_PRIVATE_KEY
  // and referenced by ${ENV:SNOWFLAKE_PRIVATE_KEY} in the rendered props.
  secretMaterial: {
    secretKeys: ['snowflake-private-key'],
    envVars: ['SNOWFLAKE_PRIVATE_KEY'],
  },
  testProbe: {
    kind: 'sql',
    query: (source) => `SHOW SCHEMAS FROM ${source.catalog}`,
  },
  openMetadata: {
    connectorType: 'Snowflake',
    configKeys: ['account', 'database', 'warehouse', 'username'],
  },
  // Rendering is verified purely; these steps need a real Snowflake account + the
  // operator's network wiring, which cannot be created here.
  liveVerificationRequired: [
    'RSA key-pair acceptance by the customer Snowflake account (public key registered on the user)',
    'warehouse resume + credit consumption when the first query runs',
    'network policy allowlisting the Trino egress IP for the account',
  ],
};
