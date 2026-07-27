/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/core/auth';
import type { McpTool, JsonSchema } from './server';
import {
  P, fail, str, strArr, NO_ARGS, idArg, resolveQueryable,
  type Principal,
} from './discovery-common';

// --- Governed read/list lib functions (the EXACT same the UI + /api call) ------
import { listDatasets, getDataset } from '@/lib/data/store';
import { listWorkflows, getWorkflow } from '@/lib/knowledge/store';
import { listFiles, searchFiles, getFile } from '@/lib/files/store';
import { listMetrics } from '@/lib/metrics/store';
import { listDashboards, getDashboard } from '@/lib/dashboards/store';
import { normalizePanel, panelMetrics } from '@/lib/dashboards/model';
import { listBets, getSolution } from '@/lib/bigbets/store';
import { buildBetView } from '@/lib/bigbets/server';
import { getSystem } from '@/lib/agents/store';
import {
  listAppsForUser,
  getAppForUser,
  listAppFilesForViewer,
  readAppFileForViewer,
  templateFiles,
  refreshActionsStage,
} from '@/lib/software/apps';
import { forgejoReachable, getSnapshot } from '@/lib/software/server';
import { getReviewCard, listReviewCards, PREVIEW_PENDING_NOTE } from '@/lib/software/review';
import {
  listConnectionsForUser,
  getConnectionForUser,
  createConnection,
  testConnection,
  callConnectionTool,
  warehouseRegistration,
  registerWarehouseCatalog,
  discoverWarehouse,
  importWarehouseTable,
  CONNECTION_TEMPLATES,
  isPersonalConnectable,
  type ConnectionTemplateKey,
  type WarehouseCreateInput,
  type AirflowCreateInput,
} from '@/lib/connections';
import type { AirflowAuthType } from '@/lib/connections/schema';
import {
  resolveOmCatalog,
  omListDomains,
  omListDataProducts,
  omListTables,
  omSearch,
  omLineage,
  previewOmSyncForConnection,
  previewDqSyncForConnection,
} from '@/lib/connections/openmetadata';
import { previewCatalogIngest } from '@/lib/connections/openmetadata-ingest';
import { WAREHOUSE_PROVIDERS } from '@/lib/connections/warehouse/registry';
import { WAREHOUSE_PLATFORMS, type WarehousePlatform } from '@/lib/connections/warehouse/types';
import { promoteThroughSeam } from '@/lib/governance/ladder';
import { enqueue } from '@/lib/governance/approvals';
import { scaffoldCubeYaml, cubeViewName } from '@/lib/data/metrics';
import { cubeDeliverable } from '@/lib/data/cube-models';
import { loadGuide, isGuidePath, GUIDE_PATHS, type GuidePath } from '@/lib/tabs/guides';
import { config } from '@/lib/core/config';
import { queryRun } from '@/lib/infra/governed';
import { versionTarget } from '@/lib/data/store-fqn';
import { builtLayerFqn } from '@/lib/data/store';
import type { Layer } from '@/lib/data';
import { LAYERS } from '@/lib/data';
import {
  assembleProfile,
  parseDescribe,
  previewSql,
  statsSql,
  topValuesSql,
  type ProfileColumn,
} from '@/lib/data/profile';
import { getMetric } from '@/lib/metrics/store';
import { exploreMetric } from '@/lib/metrics/build/explore-server';
import type { Granularity } from '@/lib/metrics/explorer';
import { claimsFromUser, delegate } from '@/lib/data/identity';
import { listModelsForUser, type ModelViewer } from '@/lib/science';
import { CHURN, DEFAULT_FEATURES } from '@/lib/science/churn';

// ================================ CONNECTIONS =================================
// Connections becomes a real MCP tab. create/test are creator (the lib re-gates
// SHARED service-credential templates to Builder/Admin); promote is Builder+.
// ONE source of truth: the keys create_connection accepts are derived from the
// SAME CONNECTION_TEMPLATES registry the lib validates against (templateByKey).
const connectionTemplateKeys: ConnectionTemplateKey[] = CONNECTION_TEMPLATES.map((t) => t.key);

export const connectionTools: McpTool[] = [
  {
    name: 'list_connection_templates',
    tab: 'connections',
    minRole: 'creator',
    description:
      'List what CAN be connected — the connection template catalog (also called: integration, data source, Google, Microsoft, AWS, Snowflake, Databricks): each template’s key, label, what it connects (Drive / Database / API / MCP / SaaS), whether it is PERSONAL (per-user OAuth — any user may connect their own account) or SHARED (service credentials — creating it needs a Builder/Admin), the endpoint hint, the fields create_connection needs, and the safe preset capability profile (reads on · writes opt-in · deletes blocked). Purpose: step 0 of the Connections golden path — know the catalog before you connect. Before: whoami. After: list_connections (reuse first!), then create_connection with a template key from here. Governance: read-only and identical for every role; this reads the SAME template registry create_connection validates against, so a key listed here is always accepted there (one source of truth).',
    inputSchema: NO_ARGS,
    call: async () => ({
      templates: CONNECTION_TEMPLATES
        // The `warehouse` template appears ONLY when the operator enabled external
        // connectors — otherwise it is hidden exactly like it is in the UI picker.
        .filter((t) => t.key !== 'warehouse' || config.externalConnectorsEnabled)
        // Same for the external `om-catalog` template — hidden until an operator
        // enables OPENMETADATA_CONNECT_ENABLED (Phase 1 default OFF).
        .filter((t) => t.key !== 'om-catalog' || config.openmetadataConnectEnabled)
        .map((t) => {
          const personal = isPersonalConnectable(t);
          return {
            key: t.key,
            label: t.label,
            connects: t.type,
            connector: t.connector,
            auth: t.auth,
            personal,
            minRoleToCreate: personal ? 'creator' : 'builder',
            endpointHint: t.endpointHint,
            requiredFields: ['name', 'template'],
            optionalFields: [
              'endpoint (defaults to the endpointHint)',
              `credential (the ${t.secretKey} — stored server-side, fingerprinted, never returned)`,
              'domain (one of YOUR domains; defaults to your first)',
            ],
            tools: t.tools.map((x) => ({ name: x.name, write: x.write, mode: x.mode })),
          };
        }),
      // The external-warehouse platforms + each provider's credential fields, so a
      // tools-only client can build the `warehouse` block for create_connection. Only
      // present when enabled; the field split (secret vs record) is provider-driven.
      warehouse: config.externalConnectorsEnabled
        ? {
            enabled: true,
            note: 'Create a warehouse connection with template="warehouse" and a warehouse block {platform, catalog, fields}. Fields render from the provider below; secret-keyed fields go to Secrets Manager, the rest onto the record. Live registration is an operator GitOps step (values.trino.externalCatalogs + rolling restart).',
            platforms: WAREHOUSE_PLATFORMS.flatMap((p) => {
              const pr = WAREHOUSE_PROVIDERS[p];
              if (!pr) return []; // platform registered in types but provider not yet wired
              return [{
                platform: pr.platform,
                label: pr.label,
                capabilities: pr.capabilities,
                fields: pr.credentialFields.map((f) => ({
                  key: f.key,
                  label: f.label,
                  required: f.required,
                  secret: pr.secretMaterial.secretKeys.includes(f.key),
                })),
                liveVerificationRequired: pr.liveVerificationRequired,
              }];
            }),
          }
        : { enabled: false as const },
      note: 'PERSONAL (per-user OAuth) templates are connectable by any user; SHARED (service-credential) templates require a Builder/Admin — create_connection re-gates this in the lib.',
    }),
  },
  {
    name: 'list_connections',
    tab: 'connections',
    minRole: 'creator',
    description:
      'List the connections you can see (also called: integration, data source, Google, Microsoft, AWS, Snowflake, Databricks) — personal + shared. Path: step 1 (reuse!) of the Connections golden path (guide: sovereign-os://guide/path/connections). Before: whoami. After: get_connection, or create_connection only if nothing fits. Governance: read-only, DLS-scoped — you never see another user’s personal connection.',
    inputSchema: NO_ARGS,
    call: async (user) => listConnectionsForUser(user),
  },
  {
    name: 'get_connection',
    tab: 'connections',
    minRole: 'creator',
    description:
      'Read one connection (also called: integration, data source, Google, Microsoft, AWS, Snowflake, Databricks) you can see — template, endpoint, tier, sync state — NEVER the raw credential. Path: DISCOVERY for the Connections golden path. Before: list_connections. After: test_connection, or consume it from an app via use_connection BY REFERENCE. Governance: read-only; unseeable id → not_found.',
    inputSchema: idArg('connId', 'Connection id from list_connections.'),
    call: async (user, args) => {
      const id = str(args.connId).trim();
      if (!id) fail('get_connection needs a `connId`', 400);
      return getConnectionForUser(id, user);
    },
  },
  {
    name: 'create_connection',
    tab: 'connections',
    minRole: 'creator',
    description:
      'Create a PERSONAL connection (also called: integration, data source, Google, Microsoft, AWS, Snowflake, Databricks) via per-user OAuth. Path: step 2 of the Connections golden path. Before: list_connections (reuse first). After: test_connection, then Builder promote_connection to share. Governance: any user may connect a personal account; SHARED (service-credential) templates require a Builder/Admin (the lib re-gates). The credential is stored server-side—the model never sees it.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Human name for the connection.' },
        template: { type: 'string', enum: connectionTemplateKeys, description: 'Connection template (adapter family).' },
        endpoint: { type: 'string', description: 'Endpoint/URL (defaults to the template hint).' },
        credential: { type: 'string', description: 'Secret/token — stored server-side, fingerprinted, never returned.' },
        domain: { type: 'string', description: 'One of YOUR domains; defaults to your first.' },
        warehouse: {
          type: 'object',
          description: 'For template="warehouse" ONLY (external connectors must be enabled): the federation config. Secret-keyed fields go to Secrets Manager, the rest onto the record.',
          properties: {
            platform: { type: 'string', enum: [...WAREHOUSE_PLATFORMS], description: 'Warehouse platform (from list_connection_templates.warehouse.platforms).' },
            catalog: { type: 'string', description: 'Trino catalog name to mount as, e.g. glue_sales ([a-z_][a-z0-9_]*).' },
            fields: { type: 'object', description: 'Flat field map keyed by the provider credential-field keys (e.g. {region:"eu-central-1"}).' },
          },
          required: ['platform', 'catalog', 'fields'],
        },
        omService: {
          type: 'string',
          description: 'For template="om-catalog" ONLY (OpenMetadata connections must be enabled): the optional default OM Service name. The endpoint is the OM base URL; credential is the bot JWT.',
        },
        airflow: {
          type: 'object',
          description: 'For template="airflow" ONLY: the non-secret REST config. The endpoint is the Airflow base URL; credential is the Bearer token (or the Basic-auth password).',
          properties: {
            authType: { type: 'string', enum: ['basic', 'bearer'], description: 'How to authenticate (default bearer).' },
            username: { type: 'string', description: 'Basic-auth username (non-secret); omit for bearer.' },
            dagAllowlist: { type: 'array', items: { type: 'string' }, description: 'Optional DAG ids trigger_dag is bounded to (empty = any DAG).' },
          },
        },
      },
      required: ['name', 'template'],
      examples: [
        { name: 'Ops MCP', template: 'generic-mcp', endpoint: 'https://mcp.example.com/sse', credential: 'secret_xxx' },
        { name: 'Glue sales', template: 'warehouse', warehouse: { platform: 'glue', catalog: 'glue_sales', fields: { region: 'eu-central-1' } } },
      ],
    },
    call: async (user, args) => {
      const name = str(args.name).trim();
      if (!name) fail('create_connection needs a `name`', 400);
      const template = str(args.template) as ConnectionTemplateKey;
      if (!connectionTemplateKeys.includes(template)) fail('create_connection needs a valid `template`', 400);
      let warehouse: WarehouseCreateInput | undefined;
      if (template === 'warehouse') {
        const w = (args.warehouse ?? {}) as Record<string, unknown>;
        const platform = str(w.platform) as WarehousePlatform;
        if (!WAREHOUSE_PLATFORMS.includes(platform)) fail('warehouse connection needs a valid `warehouse.platform`', 400);
        const catalog = str(w.catalog).trim();
        const rawFields = (w.fields && typeof w.fields === 'object') ? (w.fields as Record<string, unknown>) : {};
        const fields: Record<string, string> = {};
        for (const [k, v] of Object.entries(rawFields)) fields[k] = str(v);
        warehouse = { platform, catalog, fields };
      }
      let airflow: AirflowCreateInput | undefined;
      if (template === 'airflow') {
        const a = (args.airflow ?? {}) as Record<string, unknown>;
        const authType = (str(a.authType) === 'basic' ? 'basic' : 'bearer') as AirflowAuthType;
        airflow = { authType, username: str(a.username) || undefined, dagAllowlist: strArr(a.dagAllowlist) };
      }
      return createConnection(user, {
        name,
        template,
        endpoint: str(args.endpoint),
        credential: str(args.credential),
        domain: str(args.domain) || undefined,
        warehouse,
        omService: template === 'om-catalog' ? str(args.omService) || undefined : undefined,
        airflow,
      });
    },
  },
  {
    name: 'test_connection',
    tab: 'connections',
    minRole: 'creator',
    description:
      'Test a connection you can see — returns live | offline + a detail string. Path: step 3 of the Connections golden path. Before: create_connection. After: Builder promote_connection, or consume it from an app. Governance: read-only probe under your identity; unseeable id → not_found.',
    inputSchema: idArg('connId', 'Connection id to test.'),
    call: async (user, args) => {
      const id = str(args.connId).trim();
      if (!id) fail('test_connection needs a `connId`', 400);
      return testConnection(id, user);
    },
  },
  {
    name: 'promote_connection',
    tab: 'connections',
    minRole: 'domain_admin',
    description:
      'Promote a Personal connection → a SHARED domain data source (Domain admin+ only — the creator/builder lockdown). Path: step 4 of the Connections golden path. Before: create_connection + test_connection. After: apps in the domain consume it via use_connection BY REFERENCE. Governance: Domain admin/Admin; re-promoting an already-shared connection returns a conflict.',
    inputSchema: idArg('connId', 'Personal connection id you own to promote.'),
    call: async (user, args) => {
      const id = str(args.connId).trim();
      if (!id) fail('promote_connection needs a `connId`', 400);
      // Route the flip through the ONE effect seam (never promoteConnection directly).
      const r = await promoteThroughSeam('connection', id, user);
      return getConnectionForUser(id, user).then((c) => ({ id: c.id, name: c.name, visibility: c.visibility, applied: r.applied, live: r.live }));
    },
  },
];

// External-warehouse tools — registered ONLY when the operator enabled external
// connectors. `warehouse_registration` returns the GitOps values snippet an operator
// applies to register the catalog in Trino (read-only-rootfs → no runtime catalog
// creation); `import_warehouse_table` materializes one federated table into the OS
// Iceberg lakehouse via the SAME governed CTAS path promote/materialize uses.
