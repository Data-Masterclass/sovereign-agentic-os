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

// ================================= AIRFLOW =====================================
// Governed outbound tools over a customer's Apache Airflow modelled as an `airflow`
// connection. list_dags / get_dag_run are Read (auto-allow); trigger_dag is a real
// side effect held for approval by default (its CapabilityMode is Write-approval).
// Every tool routes through the SAME governed callConnectionTool as the UI + the
// /api tool door — so the capability gate, the DAG allowlist bound, the vaulted
// secret injection (never returned/logged) and the Langfuse audit ALL apply, and a
// held trigger is enqueued into the Governance queue rather than firing.
export const airflowTools: McpTool[] = [
  {
    name: 'list_dags',
    tab: 'connections',
    minRole: 'creator',
    description:
      'List the DAGs in a customer Apache Airflow (airflow connection). Read-only monitoring — the credential is injected server-side and never returned. Before: list_connections (find an airflow connection). After: trigger_dag to start a run, or get_dag_run to monitor one. Governance: read-only, auto-allowed; an unseeable connId → not_found; an unreachable Airflow → { ok:false, reason }.',
    inputSchema: idArg('connId', 'The airflow connection id from list_connections.'),
    call: async (user, args) => {
      const id = str(args.connId).trim();
      if (!id) fail('list_dags needs a `connId`', 400);
      return callConnectionTool(id, user, { tool: 'list_dags', args: {} });
    },
  },
  {
    name: 'get_dag_run',
    tab: 'connections',
    minRole: 'creator',
    description:
      'Read one DAG run (state, logical date) in a customer Apache Airflow (airflow connection) by dag id + run id. Read-only monitoring. Before: list_dags / trigger_dag (take the returned dagRunId). Governance: read-only, auto-allowed; unseeable connId → not_found; unreachable Airflow or unknown run → { ok:false, reason }.',
    inputSchema: {
      type: 'object',
      properties: {
        connId: { type: 'string', description: 'The airflow connection id from list_connections.' },
        dagId: { type: 'string', description: 'The DAG id, e.g. "example_etl".' },
        runId: { type: 'string', description: 'The DAG run id returned by trigger_dag.' },
      },
      required: ['connId', 'dagId', 'runId'],
      examples: [{ connId: 'conn_ab12cd', dagId: 'example_etl', runId: 'manual__2026-01-01T00:00:00+00:00' }],
    },
    call: async (user, args) => {
      const id = str(args.connId).trim();
      if (!id) fail('get_dag_run needs a `connId`', 400);
      const dagId = str(args.dagId).trim();
      const runId = str(args.runId).trim();
      if (!dagId || !runId) fail('get_dag_run needs a `dagId` and a `runId`', 400);
      return callConnectionTool(id, user, { tool: 'get_dag_run', args: { dagId, runId } });
    },
  },
  {
    name: 'trigger_dag',
    tab: 'connections',
    minRole: 'creator',
    description:
      'Trigger a DAG run in a customer Apache Airflow (airflow connection). This is a real WRITE side effect — by default its CapabilityMode is Write-approval, so the call is HELD for human approval in the Governance tab (a Builder can drop it to Write-bounded once trusted). The response decision is "requires_approval" until approved; only then does Airflow receive the POST. `conf` is passed through to the run. Before: list_dags (pick a dagId). After: get_dag_run to monitor. Governance: written through the same capability gate + DAG allowlist as the UI; the token is never sent to the model. Honest: an unreachable Airflow → { ok:false, reason }.',
    inputSchema: {
      type: 'object',
      properties: {
        connId: { type: 'string', description: 'The airflow connection id from list_connections.' },
        dagId: { type: 'string', description: 'The DAG id to trigger, e.g. "example_etl".' },
        conf: { type: 'object', description: 'Optional run configuration passed to the DAG (Airflow `conf`).' },
        logicalDate: { type: 'string', description: 'Optional ISO-8601 logical date for the run.' },
      },
      required: ['connId', 'dagId'],
      examples: [{ connId: 'conn_ab12cd', dagId: 'example_etl' }, { connId: 'conn_ab12cd', dagId: 'example_etl', conf: { rows: 100 } }],
    },
    call: async (user, args) => {
      const id = str(args.connId).trim();
      if (!id) fail('trigger_dag needs a `connId`', 400);
      const dagId = str(args.dagId).trim();
      if (!dagId) fail('trigger_dag needs a `dagId`', 400);
      const toolArgs: Record<string, unknown> = { dagId };
      if (args.conf && typeof args.conf === 'object') toolArgs.conf = args.conf;
      if (str(args.logicalDate).trim()) toolArgs.logicalDate = str(args.logicalDate).trim();
      return callConnectionTool(id, user, { tool: 'trigger_dag', args: toolArgs });
    },
  },
  // ---- Reads (auto-allowed) — deeper monitoring of runs, tasks, XCom + assets. ----
  {
    name: 'list_dag_runs',
    tab: 'connections',
    minRole: 'creator',
    description:
      'List a DAG’s run history in a customer Apache Airflow (airflow connection), optionally filtered by run state. Read-only monitoring — the credential is injected server-side and never returned. Before: list_dags (pick a dagId). After: get_dag_run / get_task_instances to drill into a run. Governance: read-only, auto-allowed; an unseeable connId → not_found; an unreachable Airflow → { ok:false, reason }.',
    inputSchema: {
      type: 'object',
      properties: {
        connId: { type: 'string', description: 'The airflow connection id from list_connections.' },
        dagId: { type: 'string', description: 'The DAG id, e.g. "example_etl".' },
        limit: { type: 'number', description: 'Optional max runs to return (most recent first).' },
        state: { type: 'string', description: 'Optional run-state filter, e.g. "success", "failed", "running".' },
      },
      required: ['connId', 'dagId'],
      examples: [{ connId: 'conn_ab12cd', dagId: 'example_etl' }, { connId: 'conn_ab12cd', dagId: 'example_etl', state: 'failed', limit: 5 }],
    },
    call: async (user, args) => {
      const id = str(args.connId).trim();
      if (!id) fail('list_dag_runs needs a `connId`', 400);
      const dagId = str(args.dagId).trim();
      if (!dagId) fail('list_dag_runs needs a `dagId`', 400);
      const toolArgs: Record<string, unknown> = { dagId };
      if (args.limit !== undefined) toolArgs.limit = Number(args.limit);
      if (str(args.state).trim()) toolArgs.state = str(args.state).trim();
      return callConnectionTool(id, user, { tool: 'list_dag_runs', args: toolArgs });
    },
  },
  {
    name: 'get_task_instances',
    tab: 'connections',
    minRole: 'creator',
    description:
      'Read the task-level status of one DAG run in a customer Apache Airflow (airflow connection) — which tasks ran, succeeded or failed. Read-only monitoring. Before: list_dag_runs / get_dag_run (take the returned dagRunId). After: get_task_logs to read a failed task’s log, or clear_task to retry it. Governance: read-only, auto-allowed; unseeable connId → not_found; unreachable Airflow or unknown run → { ok:false, reason }.',
    inputSchema: {
      type: 'object',
      properties: {
        connId: { type: 'string', description: 'The airflow connection id from list_connections.' },
        dagId: { type: 'string', description: 'The DAG id, e.g. "example_etl".' },
        runId: { type: 'string', description: 'The DAG run id (from trigger_dag / list_dag_runs).' },
      },
      required: ['connId', 'dagId', 'runId'],
      examples: [{ connId: 'conn_ab12cd', dagId: 'example_etl', runId: 'manual__2026-01-01T00:00:00+00:00' }],
    },
    call: async (user, args) => {
      const id = str(args.connId).trim();
      if (!id) fail('get_task_instances needs a `connId`', 400);
      const dagId = str(args.dagId).trim();
      const runId = str(args.runId).trim();
      if (!dagId || !runId) fail('get_task_instances needs a `dagId` and a `runId`', 400);
      return callConnectionTool(id, user, { tool: 'get_task_instances', args: { dagId, runId } });
    },
  },
  {
    name: 'get_task_logs',
    tab: 'connections',
    minRole: 'creator',
    description:
      'Fetch one task attempt’s log text (truncated for output) in a customer Apache Airflow (airflow connection). Read-only monitoring — the credential is injected server-side and never returned. Before: get_task_instances (find the failing taskId). Governance: read-only, auto-allowed; unseeable connId → not_found; unreachable Airflow or unknown task → { ok:false, reason }.',
    inputSchema: {
      type: 'object',
      properties: {
        connId: { type: 'string', description: 'The airflow connection id from list_connections.' },
        dagId: { type: 'string', description: 'The DAG id, e.g. "example_etl".' },
        runId: { type: 'string', description: 'The DAG run id (from list_dag_runs).' },
        taskId: { type: 'string', description: 'The task id inside the run (from get_task_instances).' },
        tryNumber: { type: 'number', description: 'Optional attempt number (defaults to the latest try).' },
      },
      required: ['connId', 'dagId', 'runId', 'taskId'],
      examples: [{ connId: 'conn_ab12cd', dagId: 'example_etl', runId: 'manual__2026-01-01T00:00:00+00:00', taskId: 'extract' }],
    },
    call: async (user, args) => {
      const id = str(args.connId).trim();
      if (!id) fail('get_task_logs needs a `connId`', 400);
      const dagId = str(args.dagId).trim();
      const runId = str(args.runId).trim();
      const taskId = str(args.taskId).trim();
      if (!dagId || !runId || !taskId) fail('get_task_logs needs a `dagId`, `runId` and `taskId`', 400);
      const toolArgs: Record<string, unknown> = { dagId, runId, taskId };
      if (args.tryNumber !== undefined) toolArgs.tryNumber = Number(args.tryNumber);
      return callConnectionTool(id, user, { tool: 'get_task_logs', args: toolArgs });
    },
  },
  {
    name: 'get_xcom',
    tab: 'connections',
    minRole: 'creator',
    description:
      'Read a task’s XCom entry (a small return value / pointer, not a dataset) in a customer Apache Airflow (airflow connection). Read-only monitoring. XCom holds SMALL values — large outputs land in a warehouse the OS reads via its warehouse connectors. Before: get_task_instances (find the taskId). Governance: read-only, auto-allowed; unseeable connId → not_found; unreachable Airflow or unknown key → { ok:false, reason }.',
    inputSchema: {
      type: 'object',
      properties: {
        connId: { type: 'string', description: 'The airflow connection id from list_connections.' },
        dagId: { type: 'string', description: 'The DAG id, e.g. "example_etl".' },
        runId: { type: 'string', description: 'The DAG run id (from list_dag_runs).' },
        taskId: { type: 'string', description: 'The task id inside the run (from get_task_instances).' },
        key: { type: 'string', description: 'Optional XCom key (defaults to the task’s return value).' },
      },
      required: ['connId', 'dagId', 'runId', 'taskId'],
      examples: [{ connId: 'conn_ab12cd', dagId: 'example_etl', runId: 'manual__2026-01-01T00:00:00+00:00', taskId: 'extract' }],
    },
    call: async (user, args) => {
      const id = str(args.connId).trim();
      if (!id) fail('get_xcom needs a `connId`', 400);
      const dagId = str(args.dagId).trim();
      const runId = str(args.runId).trim();
      const taskId = str(args.taskId).trim();
      if (!dagId || !runId || !taskId) fail('get_xcom needs a `dagId`, `runId` and `taskId`', 400);
      const toolArgs: Record<string, unknown> = { dagId, runId, taskId };
      if (str(args.key).trim()) toolArgs.key = str(args.key).trim();
      return callConnectionTool(id, user, { tool: 'get_xcom', args: toolArgs });
    },
  },
  {
    // NOTE the MCP-facing name is list_airflow_assets — the Data tab already owns
    // `list_datasets`, and dispatch takes the first name match, so a same-named
    // Airflow tool would be unreachable (and duplicated in tools/list). The
    // CONNECTION-level tool key stays `list_datasets` (the adapter contract).
    name: 'list_airflow_assets',
    tab: 'connections',
    minRole: 'creator',
    description:
      'List the data-driven assets/datasets in a customer Apache Airflow (airflow connection) — Airflow’s data-aware scheduling surface (v2 "assets" ↔ v1 "datasets"). Read-only monitoring — the credential is injected server-side and never returned. After: get_dataset_events to see which task last updated an asset. Governance: read-only, auto-allowed; unseeable connId → not_found; unreachable Airflow → { ok:false, reason }.',
    inputSchema: {
      type: 'object',
      properties: {
        connId: { type: 'string', description: 'The airflow connection id from list_connections.' },
        limit: { type: 'number', description: 'Optional max assets/datasets to return.' },
      },
      required: ['connId'],
      examples: [{ connId: 'conn_ab12cd' }],
    },
    call: async (user, args) => {
      const id = str(args.connId).trim();
      if (!id) fail('list_airflow_assets needs a `connId`', 400);
      const toolArgs: Record<string, unknown> = {};
      if (args.limit !== undefined) toolArgs.limit = Number(args.limit);
      return callConnectionTool(id, user, { tool: 'list_datasets', args: toolArgs });
    },
  },
  {
    name: 'get_dataset_events',
    tab: 'connections',
    minRole: 'creator',
    description:
      'List asset/dataset update events in a customer Apache Airflow (airflow connection) — which producing task updated which asset, and when. Read-only monitoring. Before: list_airflow_assets. Governance: read-only, auto-allowed; unseeable connId → not_found; unreachable Airflow → { ok:false, reason }.',
    inputSchema: {
      type: 'object',
      properties: {
        connId: { type: 'string', description: 'The airflow connection id from list_connections.' },
        limit: { type: 'number', description: 'Optional max events to return (most recent first).' },
      },
      required: ['connId'],
      examples: [{ connId: 'conn_ab12cd' }],
    },
    call: async (user, args) => {
      const id = str(args.connId).trim();
      if (!id) fail('get_dataset_events needs a `connId`', 400);
      const toolArgs: Record<string, unknown> = {};
      if (args.limit !== undefined) toolArgs.limit = Number(args.limit);
      return callConnectionTool(id, user, { tool: 'get_dataset_events', args: toolArgs });
    },
  },
  // ---- Control (Write-approval — real side effects, HELD for Governance; honor dagAllowlist). ----
  {
    name: 'pause_dag',
    tab: 'connections',
    minRole: 'creator',
    description:
      'Pause a DAG so it stops scheduling in a customer Apache Airflow (airflow connection). This is a real WRITE side effect — by default its CapabilityMode is Write-approval, so the call is HELD for human approval in the Governance tab (response decision "requires_approval" until approved). The connection’s `dagAllowlist` is honoured: a DAG not on the allowlist is refused. Before: list_dags (pick a dagId). Governance: written through the same capability gate + DAG allowlist as the UI; the token is never sent to the model. Honest: an unreachable Airflow → { ok:false, reason }.',
    inputSchema: {
      type: 'object',
      properties: {
        connId: { type: 'string', description: 'The airflow connection id from list_connections.' },
        dagId: { type: 'string', description: 'The DAG id to pause, e.g. "example_etl".' },
      },
      required: ['connId', 'dagId'],
      examples: [{ connId: 'conn_ab12cd', dagId: 'example_etl' }],
    },
    call: async (user, args) => {
      const id = str(args.connId).trim();
      if (!id) fail('pause_dag needs a `connId`', 400);
      const dagId = str(args.dagId).trim();
      if (!dagId) fail('pause_dag needs a `dagId`', 400);
      return callConnectionTool(id, user, { tool: 'pause_dag', args: { dagId } });
    },
  },
  {
    name: 'unpause_dag',
    tab: 'connections',
    minRole: 'creator',
    description:
      'Unpause a DAG so it resumes scheduling in a customer Apache Airflow (airflow connection). This is a real WRITE side effect — by default its CapabilityMode is Write-approval, so the call is HELD for human approval in the Governance tab (response decision "requires_approval" until approved). The connection’s `dagAllowlist` is honoured. Before: list_dags (pick a dagId). Governance: written through the same capability gate + DAG allowlist as the UI; the token is never sent to the model. Honest: an unreachable Airflow → { ok:false, reason }.',
    inputSchema: {
      type: 'object',
      properties: {
        connId: { type: 'string', description: 'The airflow connection id from list_connections.' },
        dagId: { type: 'string', description: 'The DAG id to unpause, e.g. "example_etl".' },
      },
      required: ['connId', 'dagId'],
      examples: [{ connId: 'conn_ab12cd', dagId: 'example_etl' }],
    },
    call: async (user, args) => {
      const id = str(args.connId).trim();
      if (!id) fail('unpause_dag needs a `connId`', 400);
      const dagId = str(args.dagId).trim();
      if (!dagId) fail('unpause_dag needs a `dagId`', 400);
      return callConnectionTool(id, user, { tool: 'unpause_dag', args: { dagId } });
    },
  },
  {
    name: 'clear_task',
    tab: 'connections',
    minRole: 'creator',
    description:
      'Clear (retry/rerun) task instances of a DAG run in a customer Apache Airflow (airflow connection). This is a real WRITE side effect — by default its CapabilityMode is Write-approval, so the call is HELD for human approval in the Governance tab (response decision "requires_approval" until approved). The connection’s `dagAllowlist` is honoured. Optionally scope to specific `taskIds` and/or only failed tasks. Before: get_task_instances (find the failed taskIds). Governance: written through the same capability gate + DAG allowlist as the UI; the token is never sent to the model. Honest: an unreachable Airflow → { ok:false, reason }.',
    inputSchema: {
      type: 'object',
      properties: {
        connId: { type: 'string', description: 'The airflow connection id from list_connections.' },
        dagId: { type: 'string', description: 'The DAG id, e.g. "example_etl".' },
        runId: { type: 'string', description: 'The DAG run id whose tasks to clear (from list_dag_runs).' },
        taskIds: { type: 'array', items: { type: 'string' }, description: 'Optional specific task ids to clear (default: all tasks in the run).' },
        onlyFailed: { type: 'boolean', description: 'Optional — clear only failed task instances.' },
      },
      required: ['connId', 'dagId', 'runId'],
      examples: [{ connId: 'conn_ab12cd', dagId: 'example_etl', runId: 'manual__2026-01-01T00:00:00+00:00', onlyFailed: true }],
    },
    call: async (user, args) => {
      const id = str(args.connId).trim();
      if (!id) fail('clear_task needs a `connId`', 400);
      const dagId = str(args.dagId).trim();
      const runId = str(args.runId).trim();
      if (!dagId || !runId) fail('clear_task needs a `dagId` and a `runId`', 400);
      const toolArgs: Record<string, unknown> = { dagId, runId };
      if (Array.isArray(args.taskIds)) toolArgs.taskIds = (args.taskIds as unknown[]).map(String);
      if (args.onlyFailed !== undefined) toolArgs.onlyFailed = Boolean(args.onlyFailed);
      return callConnectionTool(id, user, { tool: 'clear_task', args: toolArgs });
    },
  },
];

