/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Connections golden path — the pure, client-safe model.
 *
 * A Connection is a governed bridge to a system outside (or inside) the platform
 * — an API, MCP server, Database or SaaS. Whatever the type, it is
 * `credentials + endpoint metadata + a set of governed tools`, never a raw pipe.
 *
 * This module is PURE TYPES + presets only (no secrets, no server imports), so
 * both the client capability-editor and the server routes import it. The secret
 * itself never lives here (or in any record) — only a reference. The in-process
 * capability-profile MIRROR + the offline OPA gate live in `lib/agent-governed.ts`
 * (the governed spine), exactly as the spec asks ("compile the profile into the
 * connection's OPA policy; ALSO honor it in the offline mirror").
 */

import type { Visibility } from '@/lib/core/artifact-model';
import type { WarehousePlatform } from '@/lib/connections/warehouse/types';

export type ConnectionType = 'API' | 'MCP' | 'Database' | 'SaaS' | 'Drive';

/**
 * The NON-SECRET external-warehouse config carried on a warehouse Connection record.
 * The platform + the Trino catalog name + the platform-specific non-secret config
 * (region / accountUrl / projectId …). Secret material (keys, PEMs, SA-JSON) is
 * NEVER here — it lives only in Secrets Manager (secretRef), exactly like every
 * other connection credential. `config` mirrors the provider's `credentialFields`
 * minus the secret ones.
 */
export type WarehouseConnectionConfig = {
  platform: WarehousePlatform;
  /** The Trino catalog name this source mounts as (e.g. `glue_sales`). */
  catalog: string;
  /** Non-secret platform config keyed by the provider's credentialField keys. */
  config: Record<string, string>;
};

/** How an Airflow REST connection authenticates. Both are vaulted (the password /
 *  token is the secret); `basic` additionally carries a non-secret username. */
export type AirflowAuthType = 'basic' | 'bearer';

/**
 * The NON-SECRET config carried on an `airflow` Connection record. The base URL is
 * the connection `endpoint`; the password/token is the vaulted secret (secretRef,
 * NEVER here). `authType` picks Basic vs Bearer; `username` is only meaningful for
 * Basic (non-secret). `dagAllowlist` optionally bounds which DAGs may be triggered.
 */
export type AirflowConnectionConfig = {
  authType: AirflowAuthType;
  /** Basic-auth username (non-secret). Empty for Bearer. */
  username?: string;
  /** Optional allowlist of DAG ids a builder permits `trigger_dag` on. */
  dagAllowlist?: string[];
};

/** How an Atlassian connection authenticates: an API token (Basic, with the account
 *  email) or an OAuth 3LO access token (Bearer). Both are vaulted; the email is the
 *  only non-secret bit Basic additionally needs. */
export type AtlassianAuthKind = 'basic' | 'bearer';

/**
 * The NON-SECRET config carried on an `atlassian` Connection record. The site base
 * URL is the connection `endpoint`; the API token / OAuth bearer is the vaulted
 * secret (secretRef, NEVER here). `authKind` picks Basic (API token) vs Bearer
 * (OAuth 3LO); `email` is only meaningful for Basic (non-secret).
 */
export type AtlassianConnectionConfig = {
  authKind: AtlassianAuthKind;
  /** Basic-auth account email (non-secret). Empty for Bearer. */
  email?: string;
};

/** The adapter family that implements a connection type (see lib/connection-adapters). */
export type ConnectorKind = 'drive' | 'database' | 'api' | 'mcp' | 'saas';

/** How the connection authenticates: per-user OAuth (personal) or service creds (shared). */
export type AuthKind = 'oauth' | 'service';

/**
 * Per-operation capability mode (least-privilege by default). Default for a blank
 * connection: reads on, writes off. Write-back is opt-in and per-tool.
 */
export type CapabilityMode = 'Off' | 'Read' | 'Write-approval' | 'Write-bounded' | 'Blocked';

export const CAPABILITY_MODES: CapabilityMode[] = [
  'Off',
  'Read',
  'Write-approval',
  'Write-bounded',
  'Blocked',
];

export const MODE_HELP: Record<CapabilityMode, string> = {
  Off: 'Not exposed at all (default for anything not needed).',
  Read: 'Read-only; safe, auto-allowed.',
  'Write-approval': 'Side-effecting; each call held for human approval (Governance tab).',
  'Write-bounded': 'Allowed only within explicit limits encoded as policy (amounts, scope).',
  Blocked: 'Explicitly forbidden (e.g. delete); needs an Admin override to enable.',
};

/** Per-tool limits compiled into the connection's OPA policy. */
export type CapabilityLimits = {
  /** Which objects/fields/records — e.g. "Sales domain accounts". */
  dataScope?: string;
  /** Rate / quota cap (calls per minute). */
  rateLimitPerMin?: number;
  /** Cost cap in USD for the tool. */
  costCapUsd?: number;
  /** Argument constraint for bounded writes — e.g. update amount ≤ maxAmount (€). */
  maxAmount?: number;
  /** Free-form note describing any further argument constraints. */
  argConstraints?: string;
};

export type ConnectionTool = {
  name: string;
  description: string;
  /** write tools side-effect the external system; read tools are side-effect-free. */
  write: boolean;
  mode: CapabilityMode;
  limits?: CapabilityLimits;
};

/** A tool is exposed (visible to an agent) only when enabled and in-scope. */
export function isExposed(t: { mode: CapabilityMode }): boolean {
  return t.mode === 'Read' || t.mode === 'Write-approval' || t.mode === 'Write-bounded';
}

export type ConnectionGrant = {
  /** The agent identity (LiteLLM key / Ory principal) this connection is granted to. */
  agent: string;
  /** A grant can only FURTHER RESTRICT, never broaden. */
  scope: 'read-only' | 'full';
  /** The exact tool names the agent may call (intersection with the profile). */
  tools: string[];
  grantedBy: string;
  at: string;
};

export type SecretRef = { name: string; key: string };

/** Per-connection health/status (auth & reachability). */
export type ConnectionHealth = 'healthy' | 'needs-reconnect' | 'untested';

/** How the connection is also used as a DATA SOURCE (in addition to an agent tool). */
export type DataUsage = 'bronze' | 'files' | null;

export type Connection = {
  id: string;
  name: string;
  type: ConnectionType;
  /** The adapter family that backs this connection. */
  connector: ConnectorKind;
  /** Per-user OAuth (personal) or service credentials (shared). */
  auth: AuthKind;
  template: ConnectionTemplateKey;
  /** Endpoint metadata (URL / MCP server) — never the secret. */
  endpoint: string;
  /** OPA/LiteLLM principal the connection's governed tools run as. */
  principal: string;
  owner: string;
  domain: string;
  visibility: Visibility;
  /** 'live' when the endpoint was reachable at test time; 'offline' otherwise. */
  mode: 'live' | 'offline' | 'untested';
  /** Reference into Secrets Manager — NEVER the secret value. */
  secretRef: SecretRef;
  /** Whether a credential was written to Secrets Manager for this connection. */
  secretSet: boolean;
  /** A non-reversible fingerprint of the stored secret (for display/audit only). */
  secretFingerprint: string;
  /** Egress guardrail status for an external endpoint. */
  egress: { external: boolean; host: string; allowed: boolean };
  /** The capability profile — the per-tool modes + limits. */
  tools: ConnectionTool[];
  /** Per-agent grants (restrict-only). */
  grants: ConnectionGrant[];
  /** Auth/reachability health (silent refresh; Reconnect on hard failure). */
  health: ConnectionHealth;
  /** Whether the connection is also registered as a data source, and where. */
  dataUsage: DataUsage;
  /** For a `warehouse` template only: the non-secret federation config (platform,
   *  catalog, region/account/…). Absent on every other connection type. */
  warehouse?: WarehouseConnectionConfig;
  /** For an `om-catalog` template only: the OM build version last detected + the
   *  optional default OM Service name. Non-secret; the bot JWT lives in the vault.
   *  Version is recorded so the client picks stable API shapes (and, in Phase 2,
   *  refuses writes on an unknown version — Phase 1 never writes). */
  om?: { service?: string; version?: string };
  /** For an `airflow` template only: the non-secret REST config (auth type, basic
   *  username, optional trigger allowlist). The password/token lives in the vault. */
  airflow?: AirflowConnectionConfig;
  /** For an `atlassian` template only: the non-secret auth config (Basic vs Bearer +
   *  the account email for Basic). The API token / OAuth bearer lives in the vault. */
  atlassian?: AtlassianConnectionConfig;
  /** Soft-archived: hidden from the working lists, reversible, retained (the vault
   *  secret + OAuth token are KEPT). Absent/false = live. */
  archived?: boolean;
  createdAt: string;
  updatedAt: string;
};

// ----------------------------------------------------------- Capability presets --

export type ConnectionTemplateKey =
  | 'gdrive'
  | 'onedrive'
  | 'notion-mcp'
  | 'salesforce-api'
  | 'generic-mcp'
  | 'generic-api'
  | 'database'
  // External-warehouse federation (AWS Glue / Snowflake / BigQuery / Databricks /
  // Fabric). ONE template, the platform is picked inside it and its credential
  // fields render generically from the provider registry. Gated OFF behind
  // EXTERNAL_CONNECTORS_ENABLED — it is NOT user-facing until an operator enables it.
  | 'warehouse'
  // External OpenMetadata catalog (read/discover only). ONE template: base URL +
  // a vaulted bot JWT + an optional default OM Service name. Gated OFF behind
  // OPENMETADATA_CONNECT_ENABLED — inert until an operator connects an OM. Every
  // tool is read-only by construction (Phase 1 never writes to OM).
  | 'om-catalog'
  // Apache Airflow REST API (v2 `/api/v2/...`, older `/api/v1/...`). A governed
  // outbound connection to a customer's Airflow so OS agents can trigger + monitor
  // DAGs. Read tools (list DAGs, get a run) auto-allow; `trigger_dag` is a real
  // side effect held for approval by default. User-facing (a plain API connector).
  | 'airflow'
  // GitHub REST + GraphQL over api.github.com — a governed outbound connection with
  // a service PAT. Reads (repos/issues/PRs/commits/code search) auto-allow; writes
  // (open issue/comment/PR) are Write-approval; delete-repo/branch stay Blocked.
  | 'github'
  // Supabase Management API over api.supabase.com — a governed outbound connection
  // with a service PAT (sbp_…). Reads (projects/tables/migrations/advisors/logs)
  // auto-allow; execute_sql is Write-approval; apply_migration/DDL stay Blocked.
  // (The project's Postgres as DATA is federated via the `postgresql` warehouse.)
  | 'supabase'
  // Atlassian Jira + Confluence Cloud over *.atlassian.net (+ api.atlassian.com).
  // Reads (search/get issue/page, list projects) auto-allow; writes (create issue/
  // comment/transition, create page) are Write-approval; deletes stay Blocked.
  | 'atlassian'
  // Slack Web API over slack.com/api — a governed outbound connection with a bot
  // token (xoxb-…). Reads (list channels/users, read messages) auto-allow;
  // post_message is Write-approval (never auto-post); delete_message stays Blocked.
  | 'slack'
  // Gmail API over gmail.googleapis.com — Google OAuth 2.0 access token. Reads
  // (list/get messages, list labels) auto-allow; send_message/create_draft are
  // Write-approval (NEVER auto-send); trash/delete stay Blocked.
  | 'gmail'
  // Google Calendar API over www.googleapis.com/calendar/v3 — Google OAuth 2.0.
  // Reads (list calendars/events, get event) auto-allow; create/update event are
  // Write-approval; delete_event stays Blocked.
  | 'gcal'
  // Outlook mail over Microsoft Graph — Microsoft OAuth 2.0. Reads (list/get
  // messages) auto-allow; send_mail/create_draft are Write-approval; delete Blocked.
  | 'outlook'
  // Microsoft Teams over Microsoft Graph — Microsoft OAuth 2.0. Reads (list teams/
  // channels/messages) auto-allow; post_channel_message is Write-approval; delete Blocked.
  | 'teams'
  // Cloud key-services wave — governance / identity / ML metadata (mostly READ).
  // Microsoft Entra ID (Azure AD) over Microsoft Graph — Microsoft OAuth 2.0.
  // Read-only identity/directory governance (list/get users, list groups, list
  // directory-role assignments). No writes.
  | 'entra'
  // Microsoft Purview data governance/catalog over the account's Atlas/Purview URL
  // — Microsoft OAuth 2.0. Read-only (search assets, get asset, list
  // classifications, get lineage). No writes.
  | 'purview'
  // Azure AI Foundry / Azure AI over the workspace/region base — Microsoft OAuth 2.0.
  // Read-only (list models, list/get deployments). No writes.
  | 'ai-foundry'
  // AWS SageMaker over api.sagemaker.<region>.amazonaws.com — AWS SigV4 (access key
  // id + secret access key vaulted; region a non-secret config). Read-only (list
  // models/endpoints/training jobs, describe endpoint). No writes.
  | 'sagemaker'
  // Google Cloud identity/resource governance over Cloud Resource Manager + IAM — a
  // service-account JSON key signs a JWT assertion exchanged for an OAuth2 bearer
  // (scope cloud-platform.read-only). Read-only (list projects, get IAM policy, list
  // service accounts). The Google peer of entra (identity). No writes.
  | 'gcp-identity'
  // Snowflake SNOWFLAKE.ACCOUNT_USAGE governance over the SQL REST API — RSA key-pair
  // JWT (account + user non-secret; PEM vaulted). Read-only (users, roles, grants,
  // login/access history). The Snowflake peer of entra/purview; distinct from the
  // data-warehouse snowflake connector. No writes.
  | 'snowflake-governance';

export type ConnectionTemplate = {
  key: ConnectionTemplateKey;
  label: string;
  type: ConnectionType;
  /** The adapter family that backs this template. */
  connector: ConnectorKind;
  /** Per-user OAuth (personal-connectable by ANY user) or service creds (Builder/Admin). */
  auth: AuthKind;
  /** Example endpoint placeholder shown in the UI. */
  endpointHint: string;
  /** Secrets Manager key the credential is stored under. */
  secretKey: string;
  /**
   * The SAFE PRESET capability profile (an Open Decision in the spec: ship a
   * sensible default profile per connector type so Builders start safe). Reads
   * on; writes opt-in per the worked examples; deletes Blocked.
   */
  tools: ConnectionTool[];
};

/** Read tools that pull a data source into Bronze / Files (the "sync" usage). */
const DRIVE_TOOLS: ConnectionTool[] = [
  { name: 'list_files', description: 'List files in the selected folder/drive (read).', write: false, mode: 'Read' },
  { name: 'search_files', description: 'Search the drive (read).', write: false, mode: 'Read' },
  { name: 'read_file', description: 'Read one file (read).', write: false, mode: 'Read' },
  { name: 'upload_file', description: 'Upload a file (write).', write: true, mode: 'Off' },
  { name: 'delete_file', description: 'Delete a file (write).', write: true, mode: 'Blocked' },
];

export const CONNECTION_TEMPLATES: ConnectionTemplate[] = [
  {
    key: 'gdrive',
    label: 'Google Drive (personal)',
    type: 'Drive',
    connector: 'drive',
    auth: 'oauth',
    endpointHint: 'https://www.googleapis.com/drive/v3',
    secretKey: 'oauth-token',
    tools: DRIVE_TOOLS.map((t) => ({ ...t })),
  },
  {
    key: 'onedrive',
    label: 'OneDrive (personal)',
    type: 'Drive',
    connector: 'drive',
    auth: 'oauth',
    endpointHint: 'https://graph.microsoft.com/v1.0/me/drive',
    secretKey: 'oauth-token',
    tools: DRIVE_TOOLS.map((t) => ({ ...t })),
  },
  {
    key: 'notion-mcp',
    label: 'Notion (personal · hosted MCP)',
    type: 'MCP',
    connector: 'mcp',
    // Per-user connect: the user signs in to Notion and authorizes their own
    // workspace via Notion's hosted MCP OAuth 2.1 (dynamic client registration +
    // PKCE). We store only the user's token reference — never a raw secret.
    auth: 'oauth',
    endpointHint: 'https://mcp.notion.com/mcp',
    secretKey: 'mcp-token',
    tools: [
      { name: 'notion_search', description: 'Search pages and databases (read).', write: false, mode: 'Read' },
      { name: 'notion_get_page', description: 'Fetch one page by id (read).', write: false, mode: 'Read' },
      {
        name: 'notion_create_page',
        description: 'Create a page (write).',
        write: true,
        mode: 'Write-approval',
        limits: { dataScope: 'one workspace', rateLimitPerMin: 10 },
      },
      { name: 'notion_delete_page', description: 'Delete a page (write).', write: true, mode: 'Blocked' },
    ],
  },
  {
    key: 'salesforce-api',
    label: 'Salesforce (REST API)',
    type: 'API',
    connector: 'api',
    auth: 'service',
    endpointHint: 'https://yourorg.my.salesforce.com',
    secretKey: 'oauth-token',
    tools: [
      { name: 'read_account', description: 'Read an account (read).', write: false, mode: 'Read', limits: { dataScope: 'Sales domain accounts' } },
      { name: 'read_opportunity', description: 'Read an opportunity (read).', write: false, mode: 'Read', limits: { dataScope: 'Sales domain opportunities' } },
      {
        name: 'update_opportunity_amount',
        description: 'Update an opportunity amount (write).',
        write: true,
        mode: 'Write-bounded',
        limits: { maxAmount: 50000, dataScope: 'Sales domain opportunities', rateLimitPerMin: 5, costCapUsd: 1 },
      },
      { name: 'mass_update', description: 'Bulk update many records (write).', write: true, mode: 'Off' },
      { name: 'delete_record', description: 'Delete a record (write).', write: true, mode: 'Blocked' },
    ],
  },
  {
    key: 'generic-mcp',
    label: 'Generic MCP server',
    type: 'MCP',
    connector: 'mcp',
    auth: 'service',
    endpointHint: 'https://mcp.example.com/sse',
    secretKey: 'mcp-token',
    tools: [
      { name: 'search', description: 'Search (read).', write: false, mode: 'Read' },
      { name: 'fetch', description: 'Fetch a resource (read).', write: false, mode: 'Read' },
      { name: 'create', description: 'Create a resource (write).', write: true, mode: 'Off' },
      { name: 'delete', description: 'Delete a resource (write).', write: true, mode: 'Blocked' },
    ],
  },
  {
    key: 'generic-api',
    label: 'Generic REST / GraphQL API',
    type: 'API',
    connector: 'api',
    auth: 'service',
    endpointHint: 'https://api.example.com',
    secretKey: 'bearer-token',
    tools: [
      { name: 'get', description: 'GET a resource (read).', write: false, mode: 'Read' },
      { name: 'list', description: 'List resources (read).', write: false, mode: 'Read' },
      { name: 'post', description: 'POST/create a resource (write).', write: true, mode: 'Off' },
      { name: 'delete', description: 'DELETE a resource (write).', write: true, mode: 'Blocked' },
    ],
  },
  {
    key: 'database',
    label: 'PostgreSQL database',
    type: 'Database',
    connector: 'database',
    auth: 'service',
    endpointHint: 'postgres://db.example.com:5432/app',
    secretKey: 'db-password',
    tools: [
      { name: 'query', description: 'Governed read query (read).', write: false, mode: 'Read', limits: { dataScope: 'allowlisted tables' } },
      { name: 'write_row', description: 'Insert/update a row (write).', write: true, mode: 'Off' },
      { name: 'drop_table', description: 'Drop a table (write).', write: true, mode: 'Blocked' },
    ],
  },
  {
    // External-warehouse federation. A single template whose PLATFORM is chosen at
    // create time; the per-platform credential fields render from the provider
    // registry (lib/connections/warehouse), never hardcoded here. Federation is
    // READ-ONLY by construction — the external source is mounted as a governed Trino
    // catalog and queried live; "import as product" (CTAS) is a separate, explicit
    // materialize step. So the preset exposes ONLY read tools; writes stay Blocked.
    key: 'warehouse',
    label: 'External data warehouse (federated catalog)',
    type: 'Database',
    connector: 'database',
    auth: 'service',
    endpointHint: 'trino-catalog (registered via GitOps values, not a URL)',
    secretKey: 'warehouse-secret',
    tools: [
      { name: 'list_schemas', description: 'List schemas in the federated catalog (read).', write: false, mode: 'Read' },
      { name: 'list_tables', description: 'List tables in a schema (read).', write: false, mode: 'Read' },
      { name: 'query', description: 'Governed live read over the federated catalog (read).', write: false, mode: 'Read', limits: { dataScope: 'the federated external catalog' } },
      { name: 'import_table', description: 'Materialize one external table into the OS Iceberg lakehouse via CTAS (write).', write: true, mode: 'Off' },
    ],
  },
  {
    // External OpenMetadata catalog — modelled as a first-class Connection. READ /
    // DISCOVER ONLY: the preset exposes ONLY read tools; there is NO write tool at
    // all (Phase 1 never POSTs/PUTs/PATCHes OM — the scoped write path is Phase 2).
    // The secret is the OM bot JWT (vaulted secretRef, never on the record); the
    // endpoint is the OM base URL; the optional default OM Service is a non-secret
    // config on the record. Gated OFF behind OPENMETADATA_CONNECT_ENABLED.
    key: 'om-catalog',
    label: 'OpenMetadata catalog (external · read-only)',
    type: 'API',
    connector: 'api',
    auth: 'service',
    endpointHint: 'https://openmetadata.example.com',
    secretKey: 'om-bot-jwt',
    tools: [
      { name: 'list_domains', description: 'List OM domains (read).', write: false, mode: 'Read' },
      { name: 'list_data_products', description: 'List OM data products (read).', write: false, mode: 'Read' },
      { name: 'list_tables', description: 'List OM tables with description/owners/tags (read).', write: false, mode: 'Read' },
      { name: 'search_catalog', description: 'Search the OM catalog (read).', write: false, mode: 'Read' },
      { name: 'get_om_lineage', description: 'Read lineage for an OM entity by FQN (read).', write: false, mode: 'Read' },
    ],
  },
  {
    // Apache Airflow REST API — a governed outbound connection to a customer's
    // Airflow. The endpoint is the Airflow base URL; the secret is the Bearer token
    // (or the Basic-auth password), vaulted. Auth type + Basic username + an optional
    // trigger allowlist are non-secret config on the record. The preset is safe:
    // the two READS auto-allow; `trigger_dag` is a real side effect so it defaults
    // to Write-approval (a builder can drop it to Write-bounded once trusted).
    key: 'airflow',
    label: 'Apache Airflow (REST API)',
    type: 'API',
    connector: 'api',
    auth: 'service',
    endpointHint: 'https://airflow.example.com',
    secretKey: 'airflow-secret',
    tools: [
      // Observe (Read — side-effect-free, auto-allowed).
      { name: 'list_dags', description: 'List DAGs in the Airflow instance (read).', write: false, mode: 'Read' },
      { name: 'get_dag_run', description: 'Read one DAG run by dag id + run id (read).', write: false, mode: 'Read' },
      { name: 'list_dag_runs', description: 'List a DAG’s run history, optionally filtered by state (read).', write: false, mode: 'Read' },
      { name: 'get_task_instances', description: 'Task-level status of one run — which tasks ran/failed (read).', write: false, mode: 'Read' },
      { name: 'get_task_logs', description: 'Fetch a task attempt’s log text, truncated for output (read).', write: false, mode: 'Read' },
      // Retrieve (Read). XCom holds SMALL return values/pointers, not datasets — large
      // outputs land in a warehouse the OS reads via its warehouse connectors.
      { name: 'get_xcom', description: 'Read a task’s XCom entry (small return value / pointer) (read).', write: false, mode: 'Read' },
      // Data-aware scheduling (Read). v2 "assets" ↔ v1 "datasets".
      { name: 'list_datasets', description: 'List data-driven assets/datasets (read).', write: false, mode: 'Read' },
      { name: 'get_dataset_events', description: 'List asset/dataset update events (read).', write: false, mode: 'Read' },
      // Control (Write-approval — real side effects, held for Governance; honor allowlist).
      {
        name: 'trigger_dag',
        description: 'Trigger a DAG run (write — a real side effect).',
        write: true,
        mode: 'Write-approval',
        limits: { dataScope: 'DAGs on this Airflow instance', rateLimitPerMin: 10 },
      },
      {
        name: 'pause_dag',
        description: 'Pause a DAG so it stops scheduling (write — a real side effect).',
        write: true,
        mode: 'Write-approval',
        limits: { dataScope: 'DAGs on this Airflow instance', rateLimitPerMin: 10 },
      },
      {
        name: 'unpause_dag',
        description: 'Unpause a DAG so it resumes scheduling (write — a real side effect).',
        write: true,
        mode: 'Write-approval',
        limits: { dataScope: 'DAGs on this Airflow instance', rateLimitPerMin: 10 },
      },
      {
        name: 'clear_task',
        description: 'Clear (retry/rerun) task instances of a run (write — a real side effect).',
        write: true,
        mode: 'Write-approval',
        limits: { dataScope: 'DAGs on this Airflow instance', rateLimitPerMin: 10 },
      },
    ],
  },
  {
    // GitHub REST + GraphQL over api.github.com. Service PAT (read scope where
    // possible). Reads auto-allow; the three writes default to Write-approval with a
    // rate cap; delete-repo/branch are Blocked (need an Admin override to enable).
    key: 'github',
    label: 'GitHub (REST + GraphQL)',
    type: 'API',
    connector: 'api',
    auth: 'service',
    endpointHint: 'https://api.github.com',
    secretKey: 'github-token',
    tools: [
      // Reads (side-effect-free, auto-allowed).
      { name: 'list_repos', description: 'List repositories the token can see (read).', write: false, mode: 'Read' },
      { name: 'get_repo', description: 'Read one repository by owner/repo (read).', write: false, mode: 'Read' },
      { name: 'list_issues', description: 'List issues in a repo, optionally by state (read).', write: false, mode: 'Read' },
      { name: 'get_issue', description: 'Read one issue by repo + number (read).', write: false, mode: 'Read' },
      { name: 'search_code', description: 'Search code across visible repos (read).', write: false, mode: 'Read' },
      { name: 'list_pull_requests', description: 'List pull requests in a repo (read).', write: false, mode: 'Read' },
      { name: 'get_pull_request', description: 'Read one pull request by repo + number (read).', write: false, mode: 'Read' },
      { name: 'list_commits', description: 'List commits in a repo (read).', write: false, mode: 'Read' },
      // Writes (Write-approval — real side effects on GitHub; deduped on title).
      {
        name: 'create_issue',
        description: 'Open an issue (write — deduped on title to avoid a double-open).',
        write: true,
        mode: 'Write-approval',
        limits: { dataScope: 'repositories on this connection', rateLimitPerMin: 10 },
      },
      {
        name: 'add_issue_comment',
        description: 'Comment on an issue or PR (write — a real side effect).',
        write: true,
        mode: 'Write-approval',
        limits: { dataScope: 'repositories on this connection', rateLimitPerMin: 10 },
      },
      {
        name: 'create_pull_request',
        description: 'Open a pull request (write — deduped on title+head+base).',
        write: true,
        mode: 'Write-approval',
        limits: { dataScope: 'repositories on this connection', rateLimitPerMin: 10 },
      },
      // Destructive — Blocked by default (needs an Admin override to enable).
      { name: 'delete_repo', description: 'Delete a repository (write — destructive).', write: true, mode: 'Blocked' },
      { name: 'delete_branch', description: 'Delete a branch (write — destructive).', write: true, mode: 'Blocked' },
    ],
  },
  {
    // Supabase Management API. Service PAT (sbp_…). Reads auto-allow; execute_sql is
    // Write-approval and DDL-refused in the client; apply_migration / deploy_edge_function
    // are Blocked by default (DDL/deploys need an Admin override). Data lives in the
    // project Postgres, federated separately via the `postgresql` warehouse.
    key: 'supabase',
    label: 'Supabase (Management API)',
    type: 'API',
    connector: 'api',
    auth: 'service',
    endpointHint: 'https://api.supabase.com',
    secretKey: 'supabase-access-token',
    tools: [
      // Reads (side-effect-free, auto-allowed) — metadata/ops only, never the data or keys.
      { name: 'list_projects', description: 'List projects in the organization (read).', write: false, mode: 'Read' },
      { name: 'list_tables', description: 'List tables in a project database — metadata (read).', write: false, mode: 'Read' },
      { name: 'list_migrations', description: 'List applied migrations for a project (read).', write: false, mode: 'Read' },
      { name: 'get_advisors', description: 'Read security/performance advisors for a project (read).', write: false, mode: 'Read' },
      { name: 'get_logs', description: 'Read recent project logs (read).', write: false, mode: 'Read' },
      { name: 'get_project_url', description: 'Get a project’s API URL — never its keys (read).', write: false, mode: 'Read' },
      // Write — a governed admin escape hatch, DDL-refused in the client.
      {
        name: 'execute_sql',
        description: 'Run one SQL statement on the project DB (write — DDL refused; held for approval).',
        write: true,
        mode: 'Write-approval',
        limits: { dataScope: 'one project database', rateLimitPerMin: 5 },
      },
      // Schema-changing / deploys — Blocked by default (Admin override to enable).
      { name: 'apply_migration', description: 'Apply a DDL migration (write — schema change).', write: true, mode: 'Blocked' },
      { name: 'deploy_edge_function', description: 'Deploy an edge function (write — deploy).', write: true, mode: 'Blocked' },
    ],
  },
  {
    // Atlassian Jira + Confluence Cloud. Token (Basic w/ email) or OAuth 3LO. Reads
    // auto-allow; writes are Write-approval (ADF bodies); deletes are Blocked. Tools
    // are prefixed per product (jira_* / confluence_*) to avoid collisions.
    key: 'atlassian',
    label: 'Atlassian (Jira + Confluence)',
    type: 'API',
    connector: 'api',
    auth: 'service',
    endpointHint: 'https://your-site.atlassian.net',
    secretKey: 'atlassian-token',
    tools: [
      // Reads (side-effect-free, auto-allowed).
      { name: 'jira_search_issues', description: 'Search Jira issues via JQL (read).', write: false, mode: 'Read' },
      { name: 'jira_get_issue', description: 'Read one Jira issue by key (read).', write: false, mode: 'Read' },
      { name: 'jira_list_projects', description: 'List Jira projects (read).', write: false, mode: 'Read' },
      { name: 'confluence_search', description: 'Search Confluence content via CQL (read).', write: false, mode: 'Read' },
      { name: 'confluence_get_page', description: 'Read one Confluence page by id (read).', write: false, mode: 'Read' },
      // Writes (Write-approval — real side effects; ADF bodies).
      {
        name: 'jira_create_issue',
        description: 'Create a Jira issue (write — a real side effect).',
        write: true,
        mode: 'Write-approval',
        limits: { dataScope: 'projects on this site', rateLimitPerMin: 10 },
      },
      {
        name: 'jira_add_comment',
        description: 'Comment on a Jira issue (write — a real side effect).',
        write: true,
        mode: 'Write-approval',
        limits: { dataScope: 'projects on this site', rateLimitPerMin: 10 },
      },
      {
        name: 'jira_transition_issue',
        description: 'Transition a Jira issue’s status (write — a real side effect).',
        write: true,
        mode: 'Write-approval',
        limits: { dataScope: 'projects on this site', rateLimitPerMin: 10 },
      },
      {
        name: 'confluence_create_page',
        description: 'Create a Confluence page (write — a real side effect).',
        write: true,
        mode: 'Write-approval',
        limits: { dataScope: 'spaces on this site', rateLimitPerMin: 10 },
      },
      // Destructive — Blocked by default (Admin override to enable).
      { name: 'jira_delete_issue', description: 'Delete a Jira issue (write — destructive).', write: true, mode: 'Blocked' },
      { name: 'confluence_delete_page', description: 'Delete a Confluence page (write — destructive).', write: true, mode: 'Blocked' },
    ],
  },
  {
    // Slack Web API. Bot token (xoxb-…) with read scopes for reads and chat:write
    // for the one write. Reads auto-allow; post_message is a real side effect held
    // at Write-approval (never auto-post); delete_message stays Blocked.
    key: 'slack',
    label: 'Slack (Web API)',
    type: 'SaaS',
    connector: 'saas',
    auth: 'service',
    endpointHint: 'https://slack.com/api',
    secretKey: 'slack-bot-token',
    tools: [
      // Reads (side-effect-free, auto-allowed).
      { name: 'list_channels', description: 'List channels the bot can see (read).', write: false, mode: 'Read' },
      { name: 'list_users', description: 'List workspace users (read).', write: false, mode: 'Read' },
      { name: 'conversations_history', description: 'Read recent messages in a channel (read).', write: false, mode: 'Read' },
      // Write (Write-approval — a real message; never auto-post).
      {
        name: 'post_message',
        description: 'Post a message to a channel (write — a real side effect; never auto-posted).',
        write: true,
        mode: 'Write-approval',
        limits: { dataScope: 'channels the bot is in', rateLimitPerMin: 10 },
      },
      // Destructive — Blocked by default (Admin override to enable).
      { name: 'delete_message', description: 'Delete a message (write — destructive).', write: true, mode: 'Blocked' },
    ],
  },
  {
    // Gmail API. Google OAuth 2.0 access token (user-provided; the OS consumes it).
    // Reads auto-allow; send_message/create_draft are Write-approval (NEVER
    // auto-send an email); trash/delete stay Blocked.
    key: 'gmail',
    label: 'Gmail (Google API)',
    type: 'SaaS',
    connector: 'saas',
    auth: 'service',
    endpointHint: 'https://gmail.googleapis.com',
    secretKey: 'gmail-oauth-token',
    tools: [
      // Reads (side-effect-free, auto-allowed).
      { name: 'list_messages', description: 'List/search messages (read).', write: false, mode: 'Read' },
      { name: 'get_message', description: 'Read one message by id (read).', write: false, mode: 'Read' },
      { name: 'list_labels', description: 'List mailbox labels (read).', write: false, mode: 'Read' },
      // Writes (Write-approval — real side effects; NEVER auto-send).
      {
        name: 'send_message',
        description: 'Send an email (write — a real side effect; never auto-sent).',
        write: true,
        mode: 'Write-approval',
        limits: { dataScope: 'the connected mailbox', rateLimitPerMin: 5 },
      },
      {
        name: 'create_draft',
        description: 'Create a draft email — does not send (write).',
        write: true,
        mode: 'Write-approval',
        limits: { dataScope: 'the connected mailbox', rateLimitPerMin: 10 },
      },
      // Destructive — Blocked by default (Admin override to enable).
      { name: 'trash_message', description: 'Move a message to trash (write — destructive).', write: true, mode: 'Blocked' },
      { name: 'delete_message', description: 'Permanently delete a message (write — destructive).', write: true, mode: 'Blocked' },
    ],
  },
  {
    // Google Calendar API. Google OAuth 2.0 access token. Reads auto-allow;
    // create/update event are Write-approval; delete_event stays Blocked.
    key: 'gcal',
    label: 'Google Calendar (Google API)',
    type: 'SaaS',
    connector: 'saas',
    auth: 'service',
    endpointHint: 'https://www.googleapis.com/calendar/v3',
    secretKey: 'gcal-oauth-token',
    tools: [
      // Reads (side-effect-free, auto-allowed).
      { name: 'list_calendars', description: 'List the calendars on the account (read).', write: false, mode: 'Read' },
      { name: 'list_events', description: 'List events in a calendar (read).', write: false, mode: 'Read' },
      { name: 'get_event', description: 'Read one event by id (read).', write: false, mode: 'Read' },
      // Writes (Write-approval — real side effects).
      {
        name: 'create_event',
        description: 'Create a calendar event (write — a real side effect).',
        write: true,
        mode: 'Write-approval',
        limits: { dataScope: 'the connected calendars', rateLimitPerMin: 10 },
      },
      {
        name: 'update_event',
        description: 'Update a calendar event (write — a real side effect).',
        write: true,
        mode: 'Write-approval',
        limits: { dataScope: 'the connected calendars', rateLimitPerMin: 10 },
      },
      // Destructive — Blocked by default (Admin override to enable).
      { name: 'delete_event', description: 'Delete a calendar event (write — destructive).', write: true, mode: 'Blocked' },
    ],
  },
  {
    // Outlook mail over Microsoft Graph. Microsoft OAuth 2.0 access token. Reads
    // auto-allow; send_mail/create_draft are Write-approval; delete stays Blocked.
    key: 'outlook',
    label: 'Outlook (Microsoft Graph)',
    type: 'SaaS',
    connector: 'saas',
    auth: 'service',
    endpointHint: 'https://graph.microsoft.com/v1.0',
    secretKey: 'outlook-oauth-token',
    tools: [
      // Reads (side-effect-free, auto-allowed).
      { name: 'list_messages', description: 'List/search mail messages (read).', write: false, mode: 'Read' },
      { name: 'get_message', description: 'Read one mail message by id (read).', write: false, mode: 'Read' },
      // Writes (Write-approval — real side effects; NEVER auto-send).
      {
        name: 'send_mail',
        description: 'Send an email (write — a real side effect; never auto-sent).',
        write: true,
        mode: 'Write-approval',
        limits: { dataScope: 'the connected mailbox', rateLimitPerMin: 5 },
      },
      {
        name: 'create_draft',
        description: 'Create a draft mail — does not send (write).',
        write: true,
        mode: 'Write-approval',
        limits: { dataScope: 'the connected mailbox', rateLimitPerMin: 10 },
      },
      // Destructive — Blocked by default (Admin override to enable).
      { name: 'delete_message', description: 'Delete a mail message (write — destructive).', write: true, mode: 'Blocked' },
    ],
  },
  {
    // Microsoft Teams over Microsoft Graph. Microsoft OAuth 2.0 access token. Reads
    // auto-allow; post_channel_message is Write-approval; delete stays Blocked.
    key: 'teams',
    label: 'Microsoft Teams (Microsoft Graph)',
    type: 'SaaS',
    connector: 'saas',
    auth: 'service',
    endpointHint: 'https://graph.microsoft.com/v1.0',
    secretKey: 'teams-oauth-token',
    tools: [
      // Reads (side-effect-free, auto-allowed).
      { name: 'list_teams', description: 'List the teams the user is a member of (read).', write: false, mode: 'Read' },
      { name: 'list_channels', description: 'List channels in a team (read).', write: false, mode: 'Read' },
      { name: 'list_channel_messages', description: 'Read recent messages in a channel (read).', write: false, mode: 'Read' },
      // Write (Write-approval — a real message; never auto-post).
      {
        name: 'post_channel_message',
        description: 'Post a message to a team channel (write — a real side effect; never auto-posted).',
        write: true,
        mode: 'Write-approval',
        limits: { dataScope: 'channels on the connected teams', rateLimitPerMin: 10 },
      },
      // Destructive — Blocked by default (Admin override to enable).
      { name: 'delete_channel_message', description: 'Delete a channel message (write — destructive).', write: true, mode: 'Blocked' },
    ],
  },
  {
    // Microsoft Entra ID (Azure AD) over Microsoft Graph. Microsoft OAuth 2.0 access
    // token. READ-ONLY identity/directory governance — every tool is a read; there
    // is no write tool at all (a directory mutation is out of scope for this
    // connector).
    key: 'entra',
    label: 'Microsoft Entra ID (Azure AD · Microsoft Graph)',
    type: 'SaaS',
    connector: 'saas',
    auth: 'service',
    endpointHint: 'https://graph.microsoft.com/v1.0',
    secretKey: 'entra-oauth-token',
    tools: [
      // Reads (side-effect-free, auto-allowed). No writes on this connector.
      { name: 'list_users', description: 'List directory users, optionally $search (read).', write: false, mode: 'Read' },
      { name: 'get_user', description: 'Read one directory user by id / userPrincipalName (read).', write: false, mode: 'Read' },
      { name: 'list_groups', description: 'List directory groups (read).', write: false, mode: 'Read' },
      { name: 'list_role_assignments', description: 'List directory-role assignments — who holds which directory role (read).', write: false, mode: 'Read' },
    ],
  },
  {
    // Microsoft Purview data governance/catalog over the account's Atlas/Purview URL
    // (`https://<account>.purview.azure.com`). Microsoft OAuth 2.0 access token.
    // READ-ONLY catalog + lineage governance — no write tool.
    key: 'purview',
    label: 'Microsoft Purview (data governance · catalog)',
    type: 'SaaS',
    connector: 'saas',
    auth: 'service',
    endpointHint: 'https://<account>.purview.azure.com',
    secretKey: 'purview-oauth-token',
    tools: [
      // Reads (side-effect-free, auto-allowed). No writes on this connector.
      { name: 'search_assets', description: 'Search the Purview catalog for assets (read).', write: false, mode: 'Read' },
      { name: 'get_asset', description: 'Read one catalog asset (entity) by guid (read).', write: false, mode: 'Read' },
      { name: 'list_classifications', description: 'List the classification definitions in the catalog (read).', write: false, mode: 'Read' },
      { name: 'get_lineage', description: 'Read the lineage graph for an asset by guid (read).', write: false, mode: 'Read' },
    ],
  },
  {
    // Azure AI Foundry / Azure AI over the workspace/region base
    // (`https://<region>.api.azureml.ms`). Microsoft OAuth 2.0 access token.
    // READ-ONLY ML metadata — list models/deployments, get a deployment. No write tool.
    key: 'ai-foundry',
    label: 'Azure AI Foundry (Azure AI / ML)',
    type: 'SaaS',
    connector: 'saas',
    auth: 'service',
    endpointHint: 'https://<region>.api.azureml.ms',
    secretKey: 'ai-foundry-oauth-token',
    tools: [
      // Reads (side-effect-free, auto-allowed). No writes on this connector.
      { name: 'list_models', description: 'List registered models in the workspace (read).', write: false, mode: 'Read' },
      { name: 'list_deployments', description: 'List online/model deployments in the workspace (read).', write: false, mode: 'Read' },
      { name: 'get_deployment', description: 'Read one deployment by name (read).', write: false, mode: 'Read' },
    ],
  },
  {
    // AWS SageMaker over api.sagemaker.<region>.amazonaws.com. AWS SigV4 (the access
    // key id + secret access key are the vaulted credential; region derives from the
    // endpoint host). READ-ONLY ML metadata. No write tool. Credentials NEVER leave
    // the vault — the record only holds the endpoint + a secretRef.
    key: 'sagemaker',
    label: 'AWS SageMaker (ML · SigV4)',
    type: 'SaaS',
    connector: 'saas',
    auth: 'service',
    endpointHint: 'https://api.sagemaker.eu-central-1.amazonaws.com',
    secretKey: 'sagemaker-aws-credentials',
    tools: [
      // Reads (side-effect-free, auto-allowed). No writes on this connector.
      { name: 'list_models', description: 'List SageMaker models (read).', write: false, mode: 'Read' },
      { name: 'list_endpoints', description: 'List SageMaker inference endpoints (read).', write: false, mode: 'Read' },
      { name: 'list_training_jobs', description: 'List SageMaker training jobs (read).', write: false, mode: 'Read' },
      { name: 'describe_endpoint', description: 'Describe one SageMaker endpoint by name (read).', write: false, mode: 'Read' },
    ],
  },
  {
    // Google Cloud identity/resource governance over Cloud Resource Manager + IAM.
    // The credential is a GCP service-account JSON key: it signs a JWT assertion the
    // OS exchanges at oauth2.googleapis.com for a short-lived read-only OAuth2 bearer
    // (scope cloud-platform.read-only). READ-ONLY governance — no write tool. The SA
    // JSON (with its private key) is vaulted; the record holds only a secretRef.
    key: 'gcp-identity',
    label: 'Google Cloud (identity · IAM governance)',
    type: 'SaaS',
    connector: 'saas',
    auth: 'service',
    endpointHint: 'https://cloudresourcemanager.googleapis.com/v1',
    secretKey: 'gcp-service-account-json',
    tools: [
      // Reads (side-effect-free, auto-allowed). No writes on this connector.
      { name: 'list_projects', description: 'List GCP projects the service account can see (read).', write: false, mode: 'Read' },
      { name: 'get_iam_policy', description: 'Read a project’s IAM policy — who holds which role (read).', write: false, mode: 'Read' },
      { name: 'list_service_accounts', description: 'List a project’s service accounts (read).', write: false, mode: 'Read' },
    ],
  },
  {
    // Snowflake SNOWFLAKE.ACCOUNT_USAGE governance over the SQL REST API. RSA key-pair
    // JWT auth (account + user are non-secret routing; the PEM is the vaulted secret).
    // READ-ONLY security governance — users/roles/grants/history. No write tool. NOTE:
    // ACCOUNT_USAGE views have up to ~2h latency and querying consumes warehouse credits.
    key: 'snowflake-governance',
    label: 'Snowflake (ACCOUNT_USAGE governance)',
    type: 'SaaS',
    connector: 'saas',
    auth: 'service',
    endpointHint: 'https://<account>.snowflakecomputing.com',
    secretKey: 'snowflake-gov-keypair',
    tools: [
      // Reads (side-effect-free, auto-allowed). No writes on this connector.
      { name: 'list_users', description: 'List ACCOUNT_USAGE.USERS — the account’s users (read).', write: false, mode: 'Read' },
      { name: 'list_roles', description: 'List ACCOUNT_USAGE.ROLES — the account’s roles (read).', write: false, mode: 'Read' },
      { name: 'grants_to_users', description: 'Read ACCOUNT_USAGE.GRANTS_TO_USERS — roles granted to users (read).', write: false, mode: 'Read' },
      { name: 'grants_to_roles', description: 'Read ACCOUNT_USAGE.GRANTS_TO_ROLES — the privilege/role graph (read).', write: false, mode: 'Read' },
      { name: 'login_history', description: 'Read ACCOUNT_USAGE.LOGIN_HISTORY — recent logins (read; ~2h latency).', write: false, mode: 'Read' },
      { name: 'access_history', description: 'Read ACCOUNT_USAGE.ACCESS_HISTORY — recent object access (read; ~2h latency).', write: false, mode: 'Read' },
    ],
  },
];

/**
 * The connectors a user may actually CONNECT from the Connections tab today — the
 * three that are genuinely wired end-to-end: Google Drive + OneDrive (personal
 * OAuth), and Notion via its hosted MCP OAuth. Every other template below is kept
 * ONLY as an internal building block for other working features (Marketplace
 * import, the connections gate, adapter tests) and is deliberately NOT offered in
 * the create picker — a user can never stand up a non-working mock connection.
 */
export const USER_FACING_TEMPLATE_KEYS: ConnectionTemplateKey[] = ['gdrive', 'onedrive', 'notion-mcp', 'airflow', 'github', 'supabase', 'atlassian', 'slack', 'gmail', 'gcal', 'outlook', 'teams', 'entra', 'purview', 'ai-foundry', 'sagemaker', 'gcp-identity', 'snowflake-governance'];

export function isUserFacingTemplate(key: string): boolean {
  return (USER_FACING_TEMPLATE_KEYS as string[]).includes(key);
}

/** The templates offered in the Connections tab (the three working connectors). */
export function userFacingTemplates(): ConnectionTemplate[] {
  return CONNECTION_TEMPLATES.filter((t) => isUserFacingTemplate(t.key));
}

/** Templates a NON-Builder (any participant) may create — personal OAuth only. */
export function isPersonalConnectable(tpl: ConnectionTemplate): boolean {
  return tpl.auth === 'oauth';
}

export function templateByKey(key: string): ConnectionTemplate | undefined {
  return CONNECTION_TEMPLATES.find((t) => t.key === key);
}

export const CONNECTION_TYPES: ConnectionType[] = ['Drive', 'Database', 'API', 'MCP', 'SaaS'];
