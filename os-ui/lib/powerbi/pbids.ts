/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Power BI Data Source (.pbids) file builder.
 *
 * A .pbids file is a small JSON file that tells Power BI Desktop which server to connect
 * to and what credentials to use. When Power BI opens it, it drops the user directly into
 * the "Get Data → PostgreSQL" dialog pre-filled with the connection fields — they only
 * need to enter the password (which we NEVER embed here).
 *
 * Spec: https://learn.microsoft.com/en-us/power-bi/connect-data/desktop-data-sources#using-pbids-files-to-get-data
 *
 * Per-user RLS:
 *   Power BI connects as the `bi_<domain>` SQL user. Cube's `checkSqlAuth` maps that
 *   username back to the domain's `securityContext` (sub/domains/role/scope), which
 *   Cube injects into every Trino query it runs. OPA enforces the domain boundary in
 *   Trino — no row outside the domain can leak through this path.
 *
 * Password omission:
 *   The .pbids format has an `authentication` object. We set `mode: "UsernamePassword"`
 *   with the `username` pre-filled but NO `password` key. When Power BI opens the file it
 *   prompts for credentials — the user enters the shared SQL password they retrieved from
 *   the vault/k8s Secret. The password is NEVER written here, in logs, or in the network
 *   response headers. This is intentional and auditable.
 *
 * This module is pure + dependency-free so it runs in tests unchanged.
 */

import { biUserForDomain } from './principal.ts';

/**
 * A minimal typed shape for the .pbids JSON.
 * `version` must be "0.1", `connections` is an array (we always emit exactly one entry).
 */
export type PbidsFile = {
  version: '0.1';
  connections: PbidsConnection[];
};

/**
 * One connection entry inside a .pbids file. The `details.protocol` value "postgresql"
 * maps to the Power BI PostgreSQL connector, which is what Cube's Postgres-wire SQL API
 * speaks. `mode` = "DirectQuery" prevents Power BI from caching data into the .pbix —
 * RLS only applies if Power BI re-queries on every page refresh (i.e. DirectQuery mode).
 * Import mode would snapshot the data once and bypass per-user filtering thereafter.
 */
export type PbidsConnection = {
  details: {
    protocol: 'postgresql';
    address: {
      server: string;
      database: string;
    };
  };
  options: {
    /** DirectQuery: RLS is enforced on every query. Never Import — that snapshots data. */
    mode: 'DirectQuery';
  };
  mode: 'DirectQuery';
};

/**
 * Build the .pbids file content for a domain's governed Cube SQL API connection.
 *
 * @param domain   - The OS domain slug (e.g. "sales"). Must be non-empty/valid.
 * @param host     - The Cube SQL API host (e.g. "cube-sql.example.com" or the ingress name).
 * @param port     - The Cube SQL API Postgres-wire port (default 15432).
 * @returns        - A PbidsFile object, ready to be serialised with JSON.stringify.
 *
 * INVARIANT: no password is included, ever. Power BI will prompt for one.
 * INVARIANT: mode is always DirectQuery so RLS re-runs on every query.
 */
export function buildPbids(domain: string, host: string, port: number): PbidsFile {
  const user = biUserForDomain(domain); // throws on invalid domain
  const server = `${host}:${port}`;
  // Cube SQL API ignores the database field for routing, but Power BI requires it.
  // Using the BI username keeps it self-describing and consistent with connection-info.
  const database = user;

  return {
    version: '0.1',
    connections: [
      {
        details: {
          protocol: 'postgresql',
          address: { server, database },
        },
        options: { mode: 'DirectQuery' },
        mode: 'DirectQuery',
      },
    ],
  };
}

/**
 * Serialise a PbidsFile to the UTF-8 JSON string that Power BI expects.
 * Indented for readability — Power BI accepts both compact and pretty-printed.
 */
export function pbidsToString(pbids: PbidsFile): string {
  return JSON.stringify(pbids, null, 2);
}

/**
 * Build the suggested download filename for a domain's .pbids file.
 * Example: "sovereign-os-bi_sales.pbids"
 */
export function pbidsFilename(domain: string): string {
  const user = biUserForDomain(domain);
  return `sovereign-os-${user}.pbids`;
}
