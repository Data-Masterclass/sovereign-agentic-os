/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Microsoft Fabric / OneLake provider — EXPERIMENTAL (Phase 1b, ships LAST, flag-gated).
 *
 * There is NO standalone Fabric metastore endpoint that Trino natively speaks. The
 * realistic path is the Trino native `delta-lake` connector reading OneLake Delta
 * table paths DIRECTLY over ABFS
 *   abfss://<workspace>@onelake.dfs.fabric.microsoft.com/<item>.<itemtype>/Tables/<t>
 * with Azure Entra (Azure AD) service-principal OAuth on the native Azure filesystem.
 *
 * HONESTY (do not read past this):
 *   - OneLake exposes NO catalog-style metastore. Without a Hive/Glue/Unity metastore,
 *     the delta-lake connector has no first-class SHOW SCHEMAS discovery here. The
 *     honest default is KNOWN-LOCATIONS federation: the operator points the catalog at
 *     an explicit OneLake ABFS root (`<lakehouse>.lakehouse/Tables`) and registers the
 *     Delta table locations they know. Full auto-discovery cannot be claimed.
 *   - Every Microsoft-documented OneLake reader (Databricks, Synapse, the `deltalake`
 *     lib) is a first-party MS engine or Spark. Trino-over-OneLake is NOT a documented
 *     Microsoft or Trino path. The Azure-filesystem OAuth wiring below is the standard
 *     Trino ADLS Gen2 wiring aimed at the OneLake host — it is UNVERIFIED against a
 *     live Fabric workspace (see UNVERIFIED markers).
 *
 * KEY RULE (mirrors Glue/Snowflake) — no secret material is ever emitted into the
 * props. The service-principal client id / secret / tenant id are referenced through
 * env vars (`${ENV:AZURE_CLIENT_ID}` etc.) that the deploy layer wires from a vault
 * secret; none of that material ever appears in the rendered `.properties`.
 */

import {
  type FabricConfig,
  type TrinoCatalogProps,
  WarehouseError,
} from '../types.ts';
import type { WarehouseProvider } from '../provider.ts';

/**
 * Extract the OneLake ABFS host from a config. Accepts either `onelakeEndpoint` or
 * the legacy `oneLakeUri` alias, in any of the documented forms:
 *   - a bare host              → `onelake.dfs.fabric.microsoft.com`
 *   - an abfss URI             → `abfss://<ws>@onelake.dfs.fabric.microsoft.com/...`
 *   - an https URI             → `https://onelake.dfs.fabric.microsoft.com/...`
 * and normalizes to the host `<something>.dfs.fabric.microsoft.com`.
 *
 * Pure + total: throws `WarehouseError` on empty / malformed input rather than folding
 * unvalidated user input into the props.
 */
function onelakeHost(cfg: FabricConfig): string {
  const raw = (cfg.onelakeEndpoint ?? cfg.oneLakeUri ?? '').trim();
  if (!raw) {
    throw new WarehouseError('fabric: missing OneLake endpoint (onelakeEndpoint)');
  }
  // Strip scheme (abfs/abfss/https), an optional `<workspace>@` authority prefix, and
  // any path so both a bare host and a full ABFS URI collapse to the same host.
  let host = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const at = host.indexOf('@');
  if (at >= 0) host = host.slice(at + 1);
  host = host.split('/')[0].toLowerCase();
  // OneLake is always served from the fabric.microsoft.com DFS endpoint. Require that
  // suffix so we never point the Azure filesystem at an arbitrary host.
  if (!/^[a-z0-9][a-z0-9.-]*\.dfs\.fabric\.microsoft\.com$/.test(host)) {
    throw new WarehouseError(
      `fabric: invalid OneLake endpoint host '${raw}' ` +
        `(expected <account>.dfs.fabric.microsoft.com, e.g. onelake.dfs.fabric.microsoft.com)`,
    );
  }
  return host;
}

/**
 * Microsoft Fabric / OneLake → Trino native `delta-lake` connector over ABFS.
 *
 * Emits the delta-lake connector wired to the NATIVE Azure filesystem with Entra
 * service-principal OAuth. The service-principal credentials are referenced via
 * `${ENV:AZURE_*}` — never inlined. There is no metastore key: OneLake has none, so
 * this is a known-locations federation (see module header) and the operator supplies
 * the OneLake ABFS table roots out of band.
 */
function fabricProps(cfg: FabricConfig): TrinoCatalogProps {
  // A workspace is required to even name an ABFS location; validate it up front so we
  // fail the same way the other providers do rather than emitting a useless catalog.
  const workspaceId = (cfg.workspaceId ?? '').trim();
  if (!workspaceId) {
    throw new WarehouseError('fabric: missing workspaceId');
  }
  const host = onelakeHost(cfg);

  const props: TrinoCatalogProps = {
    'connector.name': 'delta-lake',

    // --- Native Azure (ADLS Gen2 / ABFS) filesystem + Entra OAuth ------------------
    // The `fs.azure.*` / `azure.*` keys and their values are the REAL, documented
    // Trino native-Azure filesystem keys (verified against trino.io object-storage
    // docs). What is UNVERIFIED is aiming them at OneLake: Trino does not document,
    // test, or guarantee `onelake.dfs.fabric.microsoft.com` as a target, and
    // `azure.endpoint` normally expects a `core.windows.net`-style storage host — the
    // OneLake host has a different suffix and a workspace/lakehouse path model. Treat
    // OneLake wiring as best-effort until confirmed on a live tenant.
    //
    // NOTE: the enable key is `fs.azure.enabled` (NOT `fs.native-azure.enabled` — that
    // `native-` form is the S3 filesystem's key; Azure does not follow it).
    'fs.azure.enabled': 'true',
    'azure.auth-type': 'OAUTH',
    // UNVERIFIED(trino-476): OneLake ABFS auth is not a documented first-class Trino path — confirm against a live Fabric workspace
    // The DFS host OneLake serves the workspace from (always *.fabric.microsoft.com);
    // Trino's `azure.endpoint` defaults to core.windows.net, so this override is the
    // unverified part, not the key itself.
    'azure.endpoint': host,
    // Entra service-principal creds come from env vars the deploy layer mounts from a
    // vault secret — NEVER inlined here.
    'azure.oauth.tenant-id': '${ENV:AZURE_TENANT_ID}',
    'azure.oauth.client-id': '${ENV:AZURE_CLIENT_ID}',
    'azure.oauth.secret': '${ENV:AZURE_CLIENT_SECRET}',
    // Entra token authority. The tenant is substituted at runtime from the same env
    // var — Trino resolves `${ENV:...}` inside the value, so no tenant is inlined.
    // UNVERIFIED(trino-476): required-ness and exact form for a OneLake service
    // principal are unconfirmed against a live Fabric tenant.
    'azure.oauth.endpoint':
      'https://login.microsoftonline.com/${ENV:AZURE_TENANT_ID}/oauth2/v2.0/token',
  };

  // Optional explicit tenant id in the config is metadata only (the SP's tenant is
  // supplied via the env var). We deliberately do NOT inline it as a credential.

  return props;
}

export const fabricProvider: WarehouseProvider = {
  platform: 'fabric',
  label: 'Microsoft Fabric / OneLake (experimental)',
  trinoConnector: 'delta-lake',
  nativeInImage: true,
  capabilities: { federate: true, import: true },
  catalogProps: (source) => fabricProps(source as FabricConfig),
  // NO `discoverTables` — deliberately omitted. OneLake exposes no metastore for a
  // generic table listing (mirrors `testProbe.kind==='none'`), so there is no honest
  // SHOW TABLES to render. The store surfaces "not discoverable — OneLake exposes no
  // metastore; provide explicit Delta table locations" instead of a query that would
  // lie about what can be enumerated.
  // EXPERIMENTAL + honest: no metastore, so discovery HONESTLY degrades to the
  // operator's configured OneLake Delta table locations — there is no auto-enumeration.
  discoveryMode: 'none',
  // OneLake Delta is ABFS-pathed; Trino/ADLS addressing quotes with double-quotes and
  // preserves case (workspace/lakehouse item names are case-preserving).
  identifierRules: { quote: '"', unquotedCase: 'preserve' },
  // Delta nested types cast to json on import (same discipline as Databricks/Delta);
  // import works from operator-supplied OneLake locations since discovery is `none`.
  importTypeRules: [
    { match: /^(struct|row)/, castTo: 'json', note: 'Delta STRUCT cast to Iceberg json' },
    { match: /^array/, castTo: 'json', note: 'Delta ARRAY cast to Iceberg json' },
    { match: /^map/, castTo: 'json', note: 'Delta MAP cast to Iceberg json' },
  ],
  notes: [
    'EXPERIMENTAL — ship LAST, behind EXTERNAL_CONNECTORS_ENABLED. Trino-over-OneLake is not a documented Trino or Microsoft path; the azure.* / azure.oauth.* keys are UNVERIFIED against a live Fabric tenant.',
    'NO metastore: discovery does NOT auto-enumerate. The operator configures explicit OneLake Delta table locations (abfss://<workspace>@onelake.dfs.fabric.microsoft.com/<lakehouse>.lakehouse/Tables/<t>) and import reads those directly.',
    'Addressing is workspace → lakehouse → Tables/<table> over ABFS; auth is an Entra service principal (client id/secret/tenant) referenced via ${ENV:AZURE_*}, never inlined.',
  ],
  credentialFields: [
    {
      key: 'workspaceId',
      label: 'Fabric workspace (GUID or name)',
      kind: 'text',
      required: true,
      help: 'Fabric workspace whose lakehouse is federated. Used to build the OneLake ABFS table locations (abfss://<workspace>@onelake.dfs.fabric.microsoft.com/...).',
    },
    {
      key: 'onelakeEndpoint',
      label: 'OneLake endpoint',
      kind: 'text',
      required: true,
      help: 'OneLake DFS host, e.g. onelake.dfs.fabric.microsoft.com (a full abfss:// URI is also accepted and normalized to its host).',
    },
    {
      key: 'tenantId',
      label: 'Entra tenant id',
      kind: 'text',
      required: true,
      help: 'Azure AD / Entra tenant the service principal belongs to. Supplied to Trino via ${ENV:AZURE_TENANT_ID}.',
    },
    {
      key: 'fabric-sp-client-id',
      label: 'Service-principal client id',
      kind: 'text',
      required: true,
      help: 'App registration (client) id of the Entra service principal granted access to the workspace. Supplied via ${ENV:AZURE_CLIENT_ID}.',
    },
    {
      // Collected as a password but NEVER lands in the catalog props; stored as a vault
      // secret and mounted via ${ENV:AZURE_CLIENT_SECRET}.
      key: 'fabric-sp-secret',
      label: 'Service-principal client secret',
      kind: 'password',
      required: true,
      help: 'Client secret for the Entra service principal. Stored as a secret; never inlined into props (referenced via ${ENV:AZURE_CLIENT_SECRET}).',
    },
  ],
  // The SP client secret is the only vaulted secret; the client id / secret / tenant id
  // are all mounted as env vars the delta-lake OAuth props reference.
  secretMaterial: {
    secretKeys: ['fabric-sp-secret'],
    envVars: ['AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET', 'AZURE_TENANT_ID'],
  },
  // Honest: OneLake exposes no native metastore for a generic SHOW SCHEMAS probe, and
  // the delta-lake connector reads explicit table locations. A blanket reachability
  // query would lie about what was verified.
  testProbe: {
    kind: 'none',
    reason:
      'OneLake exposes no native metastore for a generic SHOW SCHEMAS probe; ' +
      'reachability is verified per configured Delta table location on a live tenant.',
  },
  openMetadata: {
    connectorType: 'DeltaLake',
    configKeys: ['configSource', 'connection', 'schemaFilterPattern'],
  },
  // Brutally honest: this whole path is unverified against a real Fabric tenant.
  liveVerificationRequired: [
    'OneLake ABFS auth on the Trino native Azure filesystem: not a documented first-class Trino path (trino-476) — the azure.* / azure.oauth.* keys are UNVERIFIED against a live Fabric workspace',
    'no clean metastore: OneLake has none, so schema/table discovery likely requires explicit OneLake Delta table locations (known-locations federation), not catalog auto-discovery',
    'full catalog discovery cannot be confirmed without a live Fabric workspace (I cannot create a Fabric tenant)',
    'RECOMMENDATION: ship LAST, behind EXTERNAL_CONNECTORS_ENABLED, labeled experimental',
  ],
};
