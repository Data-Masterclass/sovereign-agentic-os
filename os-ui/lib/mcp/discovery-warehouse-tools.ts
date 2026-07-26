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

export const warehouseTools: McpTool[] = [
  {
    name: 'warehouse_registration',
    tab: 'connections',
    minRole: 'creator',
    description:
      'Get the GitOps registration for a WAREHOUSE connection you can see — the Trino catalog `.properties`, the secret env vars it references, the OpenMetadata connector hint, and the exact `values.trino.externalCatalogs` YAML entry an operator pastes. Purpose: registration is a values edit + rolling restart (the Trino pod mounts its catalog dir read-only, so no runtime catalog creation) — this returns what to apply. Before: create_connection (template="warehouse"). After: an operator applies the snippet + wires the secret + rolling-restarts Trino, then test_connection. Governance: read-only; unseeable id → not_found. Secrets are referenced via ${ENV:...}, never emitted.',
    inputSchema: idArg('connId', 'Warehouse connection id from list_connections.'),
    call: async (user, args) => {
      const id = str(args.connId).trim();
      if (!id) fail('warehouse_registration needs a `connId`', 400);
      return warehouseRegistration(id, user);
    },
  },
  {
    name: 'discover_warehouse_tables',
    tab: 'connections',
    minRole: 'creator',
    description:
      'DISCOVER a registered warehouse catalog’s schemas — and, given a `schema`, its tables — through the SAME governed query path test_connection probes (SHOW SCHEMAS / SHOW TABLES run AS your domain, so Trino→OPA governs the reads). Purpose: browse what is federated before import_warehouse_table, without guessing names. Before: create_connection (warehouse) + register the catalog so it is queryable. After: import_warehouse_table with a real schema.table. Governance: read-only; unseeable id → not_found. Honest: a catalog that is not registered/queryable yet, or a platform with no metastore (Fabric/OneLake), returns ok:false + a reason — never an invented listing.',
    inputSchema: {
      type: 'object',
      properties: {
        connId: { type: 'string', description: 'Warehouse connection id from list_connections.' },
        schema: { type: 'string', description: 'Optional schema to list tables from (omit for schemas only).' },
      },
      required: ['connId'],
      examples: [{ connId: 'conn_ab12cd' }, { connId: 'conn_ab12cd', schema: 'sales' }],
    },
    call: async (user, args) => {
      const id = str(args.connId).trim();
      if (!id) fail('discover_warehouse_tables needs a `connId`', 400);
      return discoverWarehouse(id, user, { schema: str(args.schema) || undefined });
    },
  },
  {
    name: 'register_warehouse_catalog',
    tab: 'connections',
    minRole: 'builder',
    description:
      'ONE-CLICK REGISTER a warehouse connection as a LIVE Trino catalog — no YAML paste, no manual helm. Merges the connection’s catalog `.properties` into the live trino-catalog ConfigMap, materializes its vaulted secret(s) into a trino-ext-<catalog> Secret + wires the Trino env (keyless platforms like Glue/BigQuery-WI emit NO secret), and rolls the Trino Deployment (Recreate re-reads the mount). Before: create_connection (warehouse). After: test_connection / discover_warehouse_tables once the pod restarts. Governance: Builder/Admin with edit rights on the connection; audit-logged. Honest: a step the API server rejects returns ok:false with the real reason — never a silent partial. Secrets are read server-side and never returned.',
    inputSchema: idArg('connId', 'Warehouse connection id you can edit.'),
    call: async (user, args) => {
      const id = str(args.connId).trim();
      if (!id) fail('register_warehouse_catalog needs a `connId`', 400);
      return registerWarehouseCatalog(id, user);
    },
  },
  {
    name: 'import_warehouse_table',
    tab: 'connections',
    minRole: 'creator',
    description:
      'IMPORT one federated external table into the OS Iceberg lakehouse as an owned data product — a governed CTAS (CREATE TABLE iceberg.<domain>.<name> AS SELECT * FROM <catalog>.<schema>.<table>) run through the SAME promote/materialize path (Trino→OPA as you). This is distinct from marketplace import_product (a listing GRANT): here you materialize a live external table. Before: create_connection (warehouse) + register the catalog + test_connection so the catalog is queryable. After: the imported table is a normal sovereign dataset. Governance: requires edit rights on the connection; the query-tool re-validates the CTAS allowlist + target-schema/role gate before Trino runs it.',
    inputSchema: {
      type: 'object',
      properties: {
        connId: { type: 'string', description: 'Warehouse connection id from list_connections.' },
        schema: { type: 'string', description: 'Source schema in the external catalog.' },
        table: { type: 'string', description: 'Source table to import.' },
        name: { type: 'string', description: 'Target table name (defaults to the source table name).' },
        targetDomain: { type: 'string', description: 'One of YOUR domains to land it in (defaults to the connection domain).' },
      },
      required: ['connId', 'schema', 'table'],
      examples: [{ connId: 'conn_ab12cd', schema: 'sales', table: 'orders' }],
    },
    call: async (user, args) => {
      const id = str(args.connId).trim();
      if (!id) fail('import_warehouse_table needs a `connId`', 400);
      const schema = str(args.schema).trim();
      const table = str(args.table).trim();
      if (!schema || !table) fail('import_warehouse_table needs a `schema` and a `table`', 400);
      return importWarehouseTable(id, user, { schema, table, name: str(args.name) || undefined, targetDomain: str(args.targetDomain) || undefined });
    },
  },
];

