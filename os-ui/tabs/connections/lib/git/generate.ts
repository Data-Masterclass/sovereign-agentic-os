/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        connections
 * FEATURE:    WP-50 — the PURE generator of a domain's `connections/**` subtree
 * USER STORY: As an engineer who clones my domain's repository I want every federated (warehouse)
 *             connection as a Trino catalog file I can mount in a plain Trino, and the OS-only facts
 *             beside it in `os.yaml`, so the repository runs without the OS (design 11 A10).
 * ARCHITECTURE:
 *   - N (native): `connections/<catalog>/catalog.properties` — Trino's own catalog format
 *     (https://trino.io/docs/476/installation/deployment.html#catalog-properties). The props are the
 *     provider's own render (`catalogRegistration`), so there is ONE renderer for what the UI shows,
 *     what git holds and what Trino loads. Secrets appear only as Trino's `${ENV:VAR}` references
 *     (https://trino.io/docs/476/security/secrets.html); `assertNoLiteralSecrets` refuses anything
 *     else BEFORE a byte reaches git.
 *   - O (OS layer): `connections/<catalog>/os.yaml` — id, name, owner, scope, platform and the
 *     secret by REFERENCE (vault secret name + the env var names). Trino never reads it; the eject
 *     test deletes it first.
 *   - Generated READMEs (design 12 rule 3), deterministic: no timestamps, sorted keys.
 *   - Only live `warehouse` connections are catalogs. Every other connection kind (SaaS APIs,
 *     drives, MCP servers) is not a Trino catalog; its native form is a dlt source (WP-18), so it is
 *     not emitted here.
 *   - A connection whose config cannot render is a THROWN error naming the catalog — never a
 *     silent skip, so a broken record cannot quietly vanish from git.
 */
import yaml from 'js-yaml';
import { CONNECTIONS_DIR, CONNECTION_CATALOG_FILE, connectionCatalogPath, connectionDir, connectionOsPath, prefixOf } from '@core/infra/repo-layout';
import { catalogRegistration } from '@tabs/connections/lib/warehouse/registration';
import { toWarehouseSource } from '@tabs/connections/lib/warehouse/connection';
import type { WarehouseConnectionConfig } from '@tabs/connections/lib/schema';

/** The subtree this writer owns (reserved at boot so the dbt whole-tree commit keeps it). */
export const CONNECTIONS_PREFIX = prefixOf(CONNECTIONS_DIR);

/** The fields of a stored connection the generator reads — never a secret value. */
export type SnapshotConnection = {
  id: string;
  name: string;
  template: string;
  owner: string;
  domain: string;
  visibility: string;
  archived?: boolean;
  secretRef: { name: string; key: string };
  warehouse?: WarehouseConnectionConfig;
};

/** Keys whose value is a credential: only a Trino `${ENV:VAR}` reference may stand there. */
const SECRET_KEY = /(password|secret|token|private-key|credentials?(-key|-file)?$|access-key|secret-key|mongodb\.connection-url)/i;
const ENV_REF = /^\$\{ENV:[A-Za-z_][A-Za-z0-9_]*\}$/;
/** `scheme://user:pass@host` inside any value. */
const URL_CREDENTIALS = /:\/\/[^/@\s:]+:[^/@\s]+@/;

/**
 * Refuse a catalog that would put a credential into git. A secret key must hold exactly one
 * `${ENV:VAR}` reference; no value may embed `user:password@` (a JDBC or Mongo URL).
 */
export function assertNoLiteralSecrets(props: Record<string, string>): void {
  for (const [k, v] of Object.entries(props)) {
    const val = String(v ?? '');
    if (SECRET_KEY.test(k) && !ENV_REF.test(val)) {
      throw new Error(`refused: property '${k}' holds a literal secret; it must be a \${ENV:VAR} reference`);
    }
    if (!ENV_REF.test(val) && URL_CREDENTIALS.test(val)) {
      throw new Error(`refused: property '${k}' carries credentials inside a URL; reference the URL via \${ENV:VAR}`);
    }
  }
}

/** One `key=value` per line, sorted, after a `#` header (java.util.Properties comment syntax). */
export function renderCatalogProperties(props: Record<string, string>, catalog: string, header: string[] = []): string {
  for (const [k, v] of Object.entries(props)) {
    if (/[\s=:#!\\]/.test(k) || /[\r\n\\]/.test(String(v))) {
      throw new Error(`catalog '${catalog}': property '${k}' cannot be written as a plain properties line`);
    }
  }
  const body = Object.keys(props).sort().map((k) => `${k}=${props[k]}`);
  return [...header.map((h) => `# ${h}`), ...body, ''].join('\n');
}

/** Parse the plain properties lines this module writes (and any hand edit of the same shape). */
export function parseCatalogProperties(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) throw new Error(`not a properties line: '${line}'`);
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

function isCatalogConnection(c: SnapshotConnection, domain: string): boolean {
  return c.domain === domain && !c.archived && c.template === 'warehouse' && Boolean(c.warehouse?.catalog);
}

function connectionReadme(c: SnapshotConnection, catalog: string): string {
  return [
    `# ${catalog}`,
    '',
    `A Trino catalog for the connection "${c.name}" (${c.warehouse!.platform}). Owner: ${c.owner}.`,
    '',
    '## Run it without the OS',
    '',
    '```sh',
    `docker run -v "$PWD/${CONNECTION_CATALOG_FILE}:/etc/trino/catalog/${catalog}.properties:ro" \\`,
    '  -e <each ENV var named in the file>=<its value> trinodb/trino',
    `trino --execute 'SHOW SCHEMAS FROM ${catalog}'`,
    '```',
    '',
    '`os.yaml` is the OS layer (owner, scope, secret reference). Trino does not read it.',
    '',
    'Docs: https://trino.io/docs/current/installation/deployment.html#catalog-properties · https://trino.io/docs/current/security/secrets.html',
    '',
  ].join('\n');
}

function rootReadme(domain: string, catalogs: string[]): string {
  return [
    '# connections',
    '',
    `Trino catalogs of the domain \`${domain}\`: one folder per catalog, each with Trino's own \`${CONNECTION_CATALOG_FILE}\`.`,
    'Credentials are never stored here: the files reference them as `${ENV:VAR}`.',
    '',
    ...(catalogs.length ? catalogs.map((c) => `- \`${c}/\``) : ['(none yet)']),
    '',
  ].join('\n');
}

/** Generate `domain`'s complete `connections/**` subtree from its stored connections. */
export function generateConnectionFiles(domain: string, connections: SnapshotConnection[]): Map<string, string> {
  const files = new Map<string, string>();
  const live = connections.filter((c) => isCatalogConnection(c, domain)).sort((a, b) => a.warehouse!.catalog.localeCompare(b.warehouse!.catalog));
  const seen = new Set<string>();
  for (const c of live) {
    const wh = c.warehouse!;
    const catalog = wh.catalog;
    if (seen.has(catalog)) throw new Error(`catalog '${catalog}' is defined by two connections in '${domain}'`);
    seen.add(catalog);
    let reg;
    try {
      reg = catalogRegistration(toWarehouseSource({ platform: wh.platform, catalog, config: wh.config }));
    } catch (e) {
      throw new Error(`connection ${c.id} (catalog '${catalog}') cannot render: ${(e as Error).message}`);
    }
    assertNoLiteralSecrets(reg.props);
    connectionDir(catalog); // validates the segment
    files.set(
      connectionCatalogPath(catalog),
      renderCatalogProperties(reg.props, catalog, [
        `Trino catalog '${catalog}'. Generated by Sovereign OS from connection ${c.id}; edit the connection, not this file.`,
        `Mount at /etc/trino/catalog/${catalog}.properties. Secrets are \${ENV:VAR} references only.`,
      ]),
    );
    files.set(
      connectionOsPath(catalog),
      yaml.dump(
        {
          id: c.id,
          name: c.name,
          owner: c.owner,
          domain: c.domain,
          scope: c.visibility,
          platform: wh.platform,
          secret: { ref: { name: c.secretRef.name }, env: reg.envVars },
        },
        { sortKeys: false, lineWidth: -1 },
      ),
    );
    files.set(`${connectionDir(catalog)}/README.md`, connectionReadme(c, catalog));
  }
  // No catalog → no subtree at all, so a domain without warehouse connections gets no commit.
  if (seen.size) files.set(`${CONNECTIONS_DIR}/README.md`, rootReadme(domain, [...seen]));
  return files;
}
