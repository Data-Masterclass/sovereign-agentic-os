/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Per-connector installation guides — PURE + client-safe (no secrets, no server
 * imports). One record per Supported Connector the Connections gallery renders:
 * the warehouse platforms (glue / snowflake / bigquery / databricks-delta / fabric /
 * postgresql / mysql / sqlserver / mongodb) and the user-facing templates
 * (gdrive / onedrive / notion-mcp / airflow / om-catalog).
 *
 * Each guide answers three questions honestly:
 *   • Prerequisites — what the USER must already have (their own cloud creds / apps).
 *   • Steps         — the numbered path to a working connection.
 *   • whatTheOsDoes — what the OS does once connected (Trino catalog / governed tools).
 *
 * The content is sourced from docs/external-warehouse-connectors.md, each warehouse
 * provider's `liveVerificationRequired`, docs/powerbi-consumption.md, and the
 * Drive/OneDrive OAuth wiring (lib/oauth/providers.ts + the platform OAuth-apps page).
 * We name exactly what needs the user's own cloud credentials — no hand-waving.
 *
 * <InstallationGuide> renders `body(guide)` through the shared <Markdown> component,
 * so keep the prose to portable GFM markdown.
 */

export type InstallGuide = {
  /** The connector this guide is for (matches a gallery card key). */
  key: string;
  /** Card/modal title. */
  title: string;
  /** One-line summary shown under the title. */
  summary: string;
  /** What the user must already have before they start. */
  prerequisites: string[];
  /** The numbered path to a working connection. */
  steps: string[];
  /** What the OS does once the connection is live. */
  whatTheOsDoes: string;
  /** Optional honesty note (experimental / unverified paths). */
  caveat?: string;
};

// ---- Warehouse platforms ----------------------------------------------------

const GLUE: InstallGuide = {
  key: 'glue',
  title: 'AWS Glue / Athena',
  summary: 'Federate an AWS Glue Data Catalog (Iceberg or Hive tables on S3) as one governed Trino catalog — keyless via IRSA.',
  prerequisites: [
    'A Glue Data Catalog in a known AWS **region**, holding Iceberg or Hive tables.',
    'An **IAM role** the Trino pod can assume via IRSA (pod-annotated ServiceAccount) with `glue:Get*` on the catalog and `s3:GetObject`/`s3:ListBucket` on the table data. **No static access keys** — the pod\'s role is the credential.',
    'Network reachability from the Trino pod to Glue + S3 (same VPC / VPC endpoints).',
    'For a cross-account catalog: the owning **AWS account id** (Glue catalog id).',
  ],
  steps: [
    'On the Glue card, click **Connect**. The wizard opens pre-set to AWS Glue / Athena.',
    'Name the connection and choose a Trino **catalog name** (e.g. `glue_sales`).',
    'Enter the **AWS region** (and, for cross-account, the Glue catalog id). There is no secret to paste — auth is IRSA.',
    'Create the connection, then on its card click **Register catalog** (mounts the Trino catalog; a rolling restart runs), then **Test** (`SHOW SCHEMAS`), then **Browse**.',
  ],
  whatTheOsDoes:
    'Registers **one governed Trino catalog** (`iceberg` for Iceberg tables, `hive` for Hive), so every table is queryable live as `catalog.schema.table` under the OS\'s OPA row/column policy — no bytes copied. To keep a governed, owned copy, **import** a table (CTAS) into the OS Iceberg lakehouse from the Data tab.',
  caveat: 'Glue reachability and IAM-role assumption are only confirmed against your real AWS account when you Register + Test.',
};

const SNOWFLAKE: InstallGuide = {
  key: 'snowflake',
  title: 'Snowflake',
  summary: 'Federate a Snowflake database through the native Trino JDBC connector with RSA key-pair auth (no passwords).',
  prerequisites: [
    'A Snowflake **account** (locator `ORG-ACCOUNT` or host URL), a **database**, and a **warehouse** to run queries.',
    'A least-privilege, **read-only role** for the connection (recommended).',
    'An **RSA key-pair**: an unencrypted PKCS#8 private key (PEM) whose public key is registered on the Snowflake login user. Only the private key is collected — it goes to Secrets Manager and is **never** inlined into Trino config.',
    'A network policy that allowlists the Trino egress IP for the account.',
  ],
  steps: [
    'On the Snowflake card, click **Connect**.',
    'Name the connection; pick a Trino **catalog name**.',
    'Enter the **account/host**, **database**, **warehouse**, **username**, optional **role**, and paste the **RSA private key (PEM)**.',
    'Create the connection, then on its card **Register** → **Test** (`SHOW SCHEMAS`) → **Browse**.',
  ],
  whatTheOsDoes:
    'Registers a governed Trino catalog over the Snowflake JDBC connector. Queries run on your Snowflake **warehouse** (resumes on use, consumes credits) and are re-governed at the OS\'s OPA. Import any table into the OS lakehouse from the Data tab.',
  caveat: 'RSA key-pair acceptance, warehouse credit consumption, and network allowlisting are verified against your live account at Register/Test time.',
};

const BIGQUERY: InstallGuide = {
  key: 'bigquery',
  title: 'Google BigQuery',
  summary: 'Federate BigQuery datasets through the native Trino BigQuery connector — service-account JSON or GKE Workload Identity.',
  prerequisites: [
    'A **GCP project** that owns the datasets (and, if billing differs, a **parent/billing project**).',
    'Credentials via **one** of: a **service-account JSON key** (roles `bigquery.dataViewer` + `bigquery.jobUser`), mounted as a file and never inlined; **or** GKE **Workload Identity** binding the Trino pod\'s ServiceAccount to a GCP service account (leave the JSON blank).',
    'Awareness that federated scans bill **bytes-scanned** against the billing project.',
  ],
  steps: [
    'On the BigQuery card, click **Connect**.',
    'Name the connection; pick a Trino **catalog name**.',
    'Enter the **GCP project id** (and billing project if different). Paste the **service-account JSON**, or leave it blank to use Workload Identity.',
    'Create the connection, then on its card **Register** → **Test** (`SHOW SCHEMAS`) → **Browse**.',
  ],
  whatTheOsDoes:
    'Registers a governed Trino catalog over the BigQuery connector, so datasets are queryable live under OPA. Import a table into the OS lakehouse (CTAS) from the Data tab when you need an owned copy.',
  caveat: 'Service-account key validity (or the Workload-Identity binding) and per-query billing are confirmed against your real project at Register/Test time.',
};

const DATABRICKS: InstallGuide = {
  key: 'databricks-delta',
  title: 'Databricks / Delta Lake',
  summary: 'Federate Delta tables through the native Trino delta_lake connector. Prefer the Thrift/Glue storage mode over Unity.',
  prerequisites: [
    'A Databricks **workspace host** and a **personal access token (PAT)** (or OAuth token) with read grants. The token goes to Secrets Manager and is **never** inlined.',
    '**Recommended (reliable):** a **Thrift Hive Metastore URI** (`thrift://host:9083`) and/or a **storage root** (`s3://…` or `abfss://…`) so the connector reads Delta files directly with the pod\'s cloud identity.',
    '**Unity Catalog mode is experimental/unverified** on OSS Trino 476 — `hive.metastore=unity` is a Starburst-style feature, not documented for open-source Trino. Use it only if it is a hard requirement, and confirm against your image.',
  ],
  steps: [
    'On the Databricks card, click **Connect**.',
    'Name the connection; pick a Trino **catalog name**.',
    'Enter the **workspace host** and **access token (PAT)**. For the reliable path, add a **Thrift metastore URI** and/or **storage root** (leave Unity Catalog blank).',
    'Create the connection, then on its card **Register** → **Test** (`SHOW SCHEMAS`) → **Browse**.',
  ],
  whatTheOsDoes:
    'Registers a governed Trino catalog over the `delta_lake` connector, re-governed at the OS\'s OPA. Import a Delta table into the OS lakehouse from the Data tab when you want an owned copy.',
  caveat: 'Unity-as-metastore keys are UNVERIFIED against OSS Trino 476 — prefer the Thrift/Glue storage mode. PAT scope and storage-credential vending are confirmed against your live workspace.',
};

const FABRIC: InstallGuide = {
  key: 'fabric',
  title: 'Microsoft Fabric / OneLake (experimental)',
  summary: 'Read OneLake Delta tables via the Trino delta_lake connector over ABFS with an Entra service principal. Experimental.',
  prerequisites: [
    'A Fabric **workspace** (GUID or name) and its **OneLake endpoint** (`onelake.dfs.fabric.microsoft.com`).',
    'An **Entra (Azure AD) service principal** — an app registration with a **client id**, **client secret**, and **tenant id** — granted access to the workspace. The secret goes to Secrets Manager and is **never** inlined.',
    'Explicit **OneLake Delta table locations** you want to federate: OneLake exposes no metastore, so there is no automatic `SHOW SCHEMAS` discovery.',
  ],
  steps: [
    'On the Microsoft Fabric card, click **Connect**.',
    'Name the connection; pick a Trino **catalog name**.',
    'Enter the **workspace**, **OneLake endpoint**, **tenant id**, service-principal **client id**, and **client secret**.',
    'Create the connection, then on its card **Register**, and provide the explicit Delta table locations. (Generic `SHOW SCHEMAS` is not available for OneLake.)',
  ],
  whatTheOsDoes:
    'Registers a `delta_lake` Trino catalog reading OneLake Delta table paths directly over ABFS with Entra OAuth — a known-locations federation, re-governed at OPA.',
  caveat: 'EXPERIMENTAL: Trino-over-OneLake is not a documented first-class Trino path. The Azure OAuth wiring is UNVERIFIED against a live Fabric tenant; ship last and expect known-locations federation, not auto-discovery.',
};

const POSTGRESQL: InstallGuide = {
  key: 'postgresql',
  title: 'PostgreSQL',
  summary: 'Federate one PostgreSQL database through the native Trino postgresql JDBC connector, read-only. The password is vaulted, never inlined.',
  prerequisites: [
    'A reachable PostgreSQL **host** (or host:port) and the **database** to federate — its schemas become Trino schemas.',
    'A **least-privilege, read-only login** (a role with USAGE + SELECT on the target schemas is enough). The **password** goes to Secrets Manager and is **never** on the record.',
    'Network reachability from the Trino pod to the PostgreSQL port (default 5432).',
    'Builder/Admin rights (this is a service-credential connector, not personal OAuth).',
  ],
  steps: [
    'On the PostgreSQL card, click **Connect**.',
    'Name the connection; pick a Trino **catalog name** (e.g. `pg_orders`).',
    'Enter the **host** (and port if not in the host), **database**, **username**, and **password**.',
    'Create the connection, then on its card **Register** → **Test** (`SHOW SCHEMAS`) → **Browse**. Import a table (CTAS) into the OS lakehouse from the Data tab when you want an owned copy.',
  ],
  whatTheOsDoes:
    'Registers **one governed Trino catalog** over the `postgresql` connector, so every table is queryable live as `catalog.schema.table` under the OS\'s OPA policy — no bytes copied. The password is stored once in Secrets Manager and mounted to Trino via `${ENV:...}`; it never appears in the rendered catalog config.',
  caveat: 'Range predicates on text columns do not push down (they run in Trino). PostgreSQL reachability and the read-only login are only confirmed against your live server at Register/Test time.',
};

const MYSQL: InstallGuide = {
  key: 'mysql',
  title: 'MySQL / MariaDB',
  summary: 'Federate a MySQL/MariaDB server through the native Trino mysql JDBC connector, read-only. Each database becomes a Trino schema; the password is vaulted.',
  prerequisites: [
    'A reachable MySQL/MariaDB **host** (or host:port). Every database on the server is exposed as a Trino schema.',
    'A **least-privilege, read-only user** (SELECT only). The **password** goes to Secrets Manager and is **never** on the record.',
    'Network reachability from the Trino pod to the MySQL port (default 3306).',
    'Builder/Admin rights (service-credential connector, not personal OAuth).',
  ],
  steps: [
    'On the MySQL card, click **Connect**.',
    'Name the connection; pick a Trino **catalog name** (e.g. `mysql_shop`).',
    'Enter the **host** (and port if not in the host), **username**, and **password**.',
    'Create the connection, then on its card **Register** → **Test** (`SHOW SCHEMAS`) → **Browse**. Import a table (CTAS) into the OS lakehouse from the Data tab for an owned copy.',
  ],
  whatTheOsDoes:
    'Registers **one governed Trino catalog** over the `mysql` connector; each MySQL database is a Trino schema, queryable live under OPA. The password is stored in Secrets Manager and mounted via `${ENV:...}`; it never appears in the rendered config.',
  caveat: 'MySQL identifier case-sensitivity is OS-dependent; the OS sets case-insensitive matching so discovery is robust. Predicates on text columns do not push down. Reachability and the read-only user are confirmed against your live server at Register/Test time.',
};

const SQLSERVER: InstallGuide = {
  key: 'sqlserver',
  title: 'Microsoft SQL Server',
  summary: 'Federate one SQL Server database through the native Trino sqlserver JDBC connector, read-only. The password is vaulted, never inlined.',
  prerequisites: [
    'A reachable SQL Server **host** (or host:port) and the **database** to pin the catalog to.',
    'A **least-privilege, read-only login** (`db_datareader` on the database). The **password** goes to Secrets Manager and is **never** on the record.',
    '`ALLOW_SNAPSHOT_ISOLATION` enabled on the database (Trino reads use snapshot isolation by default for consistent, non-blocking reads).',
    'Network reachability from the Trino pod to the SQL Server port (default 1433). Builder/Admin rights.',
  ],
  steps: [
    'On the SQL Server card, click **Connect**.',
    'Name the connection; pick a Trino **catalog name** (e.g. `mssql_erp`).',
    'Enter the **host** (and port if not in the host), **database**, **username**, and **password**.',
    'Create the connection, then on its card **Register** → **Test** (`SHOW SCHEMAS`) → **Browse**. Import a table (CTAS) into the OS lakehouse from the Data tab for an owned copy.',
  ],
  whatTheOsDoes:
    'Registers **one governed Trino catalog** over the `sqlserver` connector, pinned to the chosen database, queryable live as `catalog.schema.table` under OPA. The password is stored in Secrets Manager and mounted via `${ENV:...}`; TLS `encrypt` is left to the JDBC driver default (never forced off).',
  caveat: 'Text-column predicates push down only under case-sensitive collation; otherwise they run in Trino. money/uniqueidentifier/xml are cast to text on import. Reachability, the read-only login, and snapshot isolation are confirmed against your live server at Register/Test time.',
};

const MONGODB: InstallGuide = {
  key: 'mongodb',
  title: 'MongoDB',
  summary: 'Federate a MongoDB deployment through the native Trino mongodb connector, read-only. The whole connection URL (with credentials) is the vaulted secret.',
  prerequisites: [
    'A reachable MongoDB **host** (or host:port), or an Atlas/replica-set **SRV** host for `mongodb+srv://`.',
    'A **connection user** with read on the target databases AND write on the `_schema` collection — Trino persists inferred schemas there (a documented MongoDB-connector requirement).',
    'The **full connection URL** (`mongodb://user:pass@host/...` or `mongodb+srv://...`, ideally with `?tls=true`). It goes to Secrets Manager whole and is **never** on the record.',
    'Network reachability from the Trino pod (default 27017, or SRV DNS). Builder/Admin rights.',
  ],
  steps: [
    'On the MongoDB card, click **Connect**.',
    'Name the connection; pick a Trino **catalog name** (e.g. `mongo_events`).',
    'Enter the **host** (metadata) and paste the **full connection URL with credentials** — stored once in Secrets Manager.',
    'Create the connection, then on its card **Register** → **Test** (`SHOW SCHEMAS`) → **Browse**. Import a collection (CTAS) into the OS lakehouse from the Data tab for an owned copy.',
  ],
  whatTheOsDoes:
    'Registers **one governed Trino catalog** over the `mongodb` connector; each database is a Trino schema and each collection a table, queryable live under OPA. The connector **infers a schema per collection** into a `_schema` collection. The whole connection URL (with credentials) is stored in Secrets Manager and mounted via `${ENV:...}`; it never appears in the rendered config.',
  caveat: 'MongoDB is schemaless: schema inference can be imperfect and a brand-new/empty collection may not list until sampled or given a manual `_schema` entry — this is how a document store is catalogued, not a failure. Reachability, credentials, and `_schema` write access are confirmed against your live deployment at Register/Test time.',
};

// ---- User-facing templates --------------------------------------------------

const GDRIVE: InstallGuide = {
  key: 'gdrive',
  title: 'Google Drive (personal)',
  summary: 'Connect your own Google Drive read-only via OAuth. Only a token reference is stored — never the token.',
  prerequisites: [
    'An **administrator-registered Google OAuth app** (Google Cloud OAuth client) for this deployment. Until an admin configures it, the Connect button is disabled.',
    'The admin must register the **exact redirect URI** the OS uses on the Google OAuth client — see the platform **OAuth apps** page for the precise value to paste.',
    'Your own Google account with the Drive files you want to reach.',
  ],
  steps: [
    'On the Google Drive card, click **Connect** to open the wizard.',
    'Name the connection (e.g. "My Google Drive") and create it.',
    'On its card, click **Connect Google Drive** — you\'re sent to Google\'s consent screen to authorize your **own** account (read-only `drive.readonly`).',
    'After consent you return connected. Optionally click **Index → Files** to make it a governed Files source.',
  ],
  whatTheOsDoes:
    'Completes OAuth **server-side** and stores only a token **reference** in Secrets Manager — the token never touches the browser or the record. Exposes read-only Drive tools (list/search/read) held under policy; writes stay blocked.',
};

const ONEDRIVE: InstallGuide = {
  key: 'onedrive',
  title: 'OneDrive (personal)',
  summary: 'Connect your own OneDrive read-only via Microsoft OAuth. Only a token reference is stored.',
  prerequisites: [
    'An **administrator-registered Microsoft OAuth app** (Azure AD app registration) with `Files.Read` + `offline_access`. Until an admin configures it, the Connect button is disabled.',
    'The admin must register the **exact redirect URI** the OS uses on the Azure app — see the platform **OAuth apps** page for the precise value to paste.',
    'Your own Microsoft 365 / personal account with the OneDrive files you want to reach.',
  ],
  steps: [
    'On the OneDrive card, click **Connect** to open the wizard.',
    'Name the connection (e.g. "My OneDrive") and create it.',
    'On its card, click **Connect OneDrive** — you\'re sent to Microsoft\'s consent screen to authorize your **own** account (read-only `Files.Read`).',
    'After consent you return connected. Optionally click **Index → Files** to make it a governed Files source.',
  ],
  whatTheOsDoes:
    'Completes OAuth **server-side** via Microsoft Graph and stores only a token **reference** in Secrets Manager. Exposes read-only Drive tools held under policy; writes stay blocked.',
};

const NOTION: InstallGuide = {
  key: 'notion-mcp',
  title: 'Notion (personal · hosted MCP)',
  summary: 'Connect your own Notion workspace through Notion\'s hosted MCP (OAuth 2.1 · PKCE). Only a token reference is stored.',
  prerequisites: [
    'Your own Notion account with access to the workspace you want to connect.',
    'No admin app registration needed — Notion\'s hosted MCP uses **dynamic client registration (DCR) + PKCE**, so the connect flow provisions itself.',
    'Rights in the target workspace to authorize an integration.',
  ],
  steps: [
    'On the Notion card, click **Connect** to open the wizard.',
    'Name the connection and create it.',
    'On its card, click **Connect Notion** — sign in to Notion and authorize your **own** workspace (OAuth 2.1 · PKCE).',
    'Click **Verify · list tools** to run a real MCP `tools/list` and prove the connection is live.',
  ],
  whatTheOsDoes:
    'Authorizes via Notion\'s **hosted MCP** and stores only a token **reference** — never the token. Exposes governed Notion tools: reads (`search`, `get_page`) held under policy; `create_page` defaults to Write-approval; delete stays blocked.',
};

const AIRFLOW: InstallGuide = {
  key: 'airflow',
  title: 'Apache Airflow (REST API)',
  summary: 'Connect a customer Airflow via its REST API. Reads auto-allow; triggering a DAG is held for approval.',
  prerequisites: [
    'The Airflow **base URL** (e.g. `https://airflow.example.com`), reachable from the OS — the host must be on the **egress allowlist** (request it under Outbound access).',
    'A credential for the Airflow REST API: a **Basic-auth** username + password, or a **Bearer token**. The secret goes to Secrets Manager and is **never** on the record.',
    'Builder/Admin rights (this is a service-credential connector, not personal OAuth).',
  ],
  steps: [
    'On the Airflow card, click **Connect**.',
    'Enter the connection **name** and the Airflow **base URL**.',
    'Provide the **credential** (Basic password or Bearer token) — it is stored once in Secrets Manager.',
    'Create the connection, then **Test** reachability on its card; tune the per-tool capability profile.',
  ],
  whatTheOsDoes:
    'Registers a governed outbound API connection. `list_dags` and `get_dag_run` (reads) auto-allow; `trigger_dag` is a real side effect held at **Write-approval** until a Builder trusts it. All calls are OPA-checked and audit-traced.',
};

const GITHUB: InstallGuide = {
  key: 'github',
  title: 'GitHub (REST + GraphQL)',
  summary: 'Connect a GitHub account/org via a personal access token. Reads auto-allow; opening issues/PRs is held for approval; deletes are blocked.',
  prerequisites: [
    'A GitHub **personal access token (PAT)** — a fine-grained token scoped to the exact repos, with **read** grants where the agent only reads (Contents, Issues, Pull requests: Read) and Write only if you will approve writes. It goes to Secrets Manager and is **never** on the record.',
    'The API host `api.github.com` on the **egress allowlist** (GitHub Enterprise Server: add your GHE host and set it as the base URL).',
    'Builder/Admin rights (service-credential connector, not personal OAuth).',
  ],
  steps: [
    'On the GitHub card, click **Connect**.',
    'Enter the connection **name**; leave the base URL as `https://api.github.com` (or your GHE host).',
    'Provide the **PAT** — stored once in Secrets Manager.',
    'Create the connection, then **Test** on its card (a real `GET /user` round-trip). Tune the per-tool capability profile.',
  ],
  whatTheOsDoes:
    'Registers a governed outbound GitHub connection. Reads (list/get repos, issues, PRs, commits, code search) auto-allow, paginated with a `truncated` flag. Writes (`create_issue`, `add_issue_comment`, `create_pull_request`) are held at **Write-approval** and **deduped on title** so an approved retry can’t double-open. `delete_repo` / `delete_branch` stay **Blocked**. All calls respect GitHub’s secondary rate limits (honest `retry-after`), are OPA-checked, and audit-traced.',
  caveat: 'GitHub has no idempotency key for issue/PR creation, so the OS dedupes on the open item’s title (+ head/base for PRs). Token validity and repo scope are only confirmed against your live account at Test time.',
};

const SUPABASE: InstallGuide = {
  key: 'supabase',
  title: 'Supabase (Management API + Postgres)',
  summary: 'Connect a Supabase organization via a management access token for project ops, and federate the project Postgres separately as a read-only warehouse catalog.',
  prerequisites: [
    'A Supabase **management access token** (`sbp_…`) from your account. It goes to Secrets Manager and is **never** on the record. Service-role keys are never used here.',
    'The API host `api.supabase.com` on the **egress allowlist**.',
    'Builder/Admin rights (service-credential connector).',
    'For querying your data: a **read-only Postgres role** on the project database — you will register the project Postgres as a separate **PostgreSQL warehouse** catalog (see the PostgreSQL guide).',
  ],
  steps: [
    'On the Supabase card, click **Connect**.',
    'Enter the connection **name**; the base URL is `https://api.supabase.com`.',
    'Provide the **management access token** (`sbp_…`) — stored once in Secrets Manager.',
    'Create the connection, then **Test** on its card (a real `GET /v1/projects` round-trip).',
    'To query your tables as data, ALSO register the **project Postgres** as a PostgreSQL warehouse catalog with a **read-only role** — follow the **PostgreSQL** guide. The OS reads your data through that governed Trino catalog, not through this connection.',
  ],
  whatTheOsDoes:
    'Registers a governed Supabase **Management API** connection. Reads (`list_projects`, `list_tables`, `list_migrations`, `get_advisors`, `get_logs`, `get_project_url`) auto-allow. `execute_sql` is held at **Write-approval** and refuses DDL; `apply_migration` and `deploy_edge_function` are **Blocked** by default (DDL/deploys need an Admin override). Service-role keys are never surfaced in any result. Actual data lives in the project Postgres, federated separately as a read-only warehouse catalog.',
  caveat: 'This connection manages the PROJECT (schema/ops), not bulk data — query your tables through the federated Postgres catalog. `execute_sql` runs against the project DB and is DDL-refused; treat it as a governed admin escape hatch, not a data pipe. Token scope is confirmed against your live org at Test time.',
};

const ATLASSIAN: InstallGuide = {
  key: 'atlassian',
  title: 'Atlassian (Jira + Confluence)',
  summary: 'Connect a Jira + Confluence Cloud site via an API token or OAuth. Reads auto-allow; creating issues/pages and transitions are held for approval; deletes are blocked.',
  prerequisites: [
    'Your Atlassian Cloud **site** (e.g. `https://your-site.atlassian.net`) on the **egress allowlist** (plus `api.atlassian.com` / `auth.atlassian.com` for OAuth).',
    'A **credential**: an **API token** (with the account email, sent as Basic auth) or an **OAuth 3LO** access token. It goes to Secrets Manager and is **never** on the record.',
    'Least-privilege project/space grants for the account behind the token. Builder/Admin rights.',
  ],
  steps: [
    'On the Atlassian card, click **Connect**.',
    'Enter the connection **name** and your **site URL** (`https://your-site.atlassian.net`). For API-token auth, provide the **account email** as the username.',
    'Provide the **API token** (or OAuth access token) — stored once in Secrets Manager.',
    'Create the connection, then **Test** on its card (a real `GET /rest/api/3/myself` round-trip). Tune the per-tool capability profile.',
  ],
  whatTheOsDoes:
    'Registers a governed outbound Atlassian connection spanning **Jira** (`/rest/api/3/…`) and **Confluence** (`/wiki/rest/api/…`). Reads (`jira_search_issues`, `jira_get_issue`, `jira_list_projects`, `confluence_search`, `confluence_get_page`) auto-allow, paginated (`startAt`/`maxResults`) with a `truncated` flag. Writes (`jira_create_issue`, `jira_add_comment`, `jira_transition_issue`, `confluence_create_page`) are held at **Write-approval**; bodies are sent as **ADF**. `jira_delete_issue` / `confluence_delete_page` stay **Blocked**. Rate limits (`429` + `Retry-After`) are respected.',
  caveat: 'Jira and Confluence bodies use the Atlassian Document Format (ADF); the OS wraps plain text into ADF. Site reachability, token scope, and project/space access are only confirmed against your live site at Test time.',
};

const SLACK: InstallGuide = {
  key: 'slack',
  title: 'Slack (Web API)',
  summary: 'Connect a Slack workspace via a bot token. Reads auto-allow; posting a message is held for approval; deletes are blocked.',
  prerequisites: [
    'A **Slack app** in your workspace (create one at api.slack.com/apps — this is YOUR step). Add the OAuth **bot scopes** the tools need: `channels:read` + `groups:read` (list channels), `users:read` (list users), `channels:history` + `groups:history` (read messages), and `chat:write` (post). Install the app to the workspace and copy the **Bot User OAuth Token** (`xoxb-…`).',
    'The bot must be **invited to the channels** it should read or post in (`/invite @your-bot`).',
    'The API host `slack.com` on the **egress allowlist**.',
    'Builder/Admin rights (service-credential connector, not personal OAuth).',
  ],
  steps: [
    'On the Slack card, click **Connect**.',
    'Enter the connection **name**; leave the base URL as `https://slack.com/api`.',
    'Provide the **Bot User OAuth Token** (`xoxb-…`) — stored once in Secrets Manager.',
    'Create the connection, then **Test** on its card (a real `auth.test` round-trip). Tune the per-tool capability profile.',
  ],
  whatTheOsDoes:
    'Registers a governed outbound Slack connection. Reads (`list_channels`, `list_users`, `conversations_history`) auto-allow, cursor-paginated with a `truncated` flag. `post_message` is held at **Write-approval** — a message is a real side effect and is **never** auto-posted. `delete_message` stays **Blocked**. Slack signals errors in the response body (not the HTTP status), so an API error surfaces honestly; `ratelimited` responses respect `Retry-After`. All calls are OPA-checked and audit-traced; the bot token never leaves the server.',
  caveat: 'Slack returns HTTP 200 even on API errors — the OS reads the `ok:false` body and never fabricates a result. Token validity and the bot’s channel membership are only confirmed against your live workspace at Test time.',
};

const GMAIL: InstallGuide = {
  key: 'gmail',
  title: 'Gmail (Google API)',
  summary: 'Connect a Gmail mailbox via a Google OAuth 2.0 access token. Reads auto-allow; sending or drafting mail is held for approval; deletes are blocked.',
  prerequisites: [
    'A **Google Cloud OAuth 2.0 client** you create (console.cloud.google.com — this is YOUR step), with the Gmail API enabled and the least-privilege scopes: `gmail.readonly` for reads, plus `gmail.compose`/`gmail.send` only if you will approve sends.',
    'A **user OAuth access token** obtained through your OAuth client (e.g. the OAuth Playground or your own consent flow). Paste the **access token**; it goes to Secrets Manager and is **never** on the record.',
    'The hosts `gmail.googleapis.com` and `oauth2.googleapis.com` on the **egress allowlist**.',
    'Builder/Admin rights (service-credential connector).',
  ],
  steps: [
    'On the Gmail card, click **Connect**.',
    'Enter the connection **name**; the base URL is `https://gmail.googleapis.com`.',
    'Provide the **OAuth access token** — stored once in Secrets Manager.',
    'Create the connection, then **Test** on its card (a real `users/me/profile` round-trip). Tune the per-tool capability profile.',
  ],
  whatTheOsDoes:
    'Registers a governed outbound Gmail connection. Reads (`list_messages`, `get_message`, `list_labels`) auto-allow. `send_message` and `create_draft` are held at **Write-approval** — an email is a real side effect and is **NEVER** auto-sent. `trash_message` / `delete_message` stay **Blocked**. All calls are OPA-checked and audit-traced; the token never leaves the server.',
  caveat: 'A pasted OAuth access token is short-lived (Google tokens typically expire in ~1 hour) — automatic **refresh-token rotation** is a documented follow-up; until then, refresh the token and re-Test when it expires. Registering the Google OAuth app and minting the token are YOUR steps; the OS only consumes the credential.',
};

const GCAL: InstallGuide = {
  key: 'gcal',
  title: 'Google Calendar (Google API)',
  summary: 'Connect a Google Calendar via a Google OAuth 2.0 access token. Reads auto-allow; creating or updating events is held for approval; deletes are blocked.',
  prerequisites: [
    'A **Google Cloud OAuth 2.0 client** you create (this is YOUR step), with the Calendar API enabled and the least-privilege scopes: `calendar.readonly` for reads, plus `calendar.events` only if you will approve writes.',
    'A **user OAuth access token** from your OAuth client. Paste the **access token**; it goes to Secrets Manager and is **never** on the record.',
    'The hosts `www.googleapis.com` and `oauth2.googleapis.com` on the **egress allowlist**.',
    'Builder/Admin rights (service-credential connector).',
  ],
  steps: [
    'On the Google Calendar card, click **Connect**.',
    'Enter the connection **name**; the base URL is `https://www.googleapis.com/calendar/v3`.',
    'Provide the **OAuth access token** — stored once in Secrets Manager.',
    'Create the connection, then **Test** on its card (a real `users/me/calendarList` round-trip). Tune the per-tool capability profile.',
  ],
  whatTheOsDoes:
    'Registers a governed outbound Google Calendar connection. Reads (`list_calendars`, `list_events`, `get_event`) auto-allow. `create_event` and `update_event` are held at **Write-approval**. `delete_event` stays **Blocked**. All calls are OPA-checked and audit-traced; the token never leaves the server.',
  caveat: 'The pasted OAuth access token is short-lived; automatic refresh-token rotation is a documented follow-up. Registering the Google OAuth app and minting the token are YOUR steps.',
};

const OUTLOOK: InstallGuide = {
  key: 'outlook',
  title: 'Outlook (Microsoft Graph)',
  summary: 'Connect an Outlook mailbox via a Microsoft OAuth 2.0 access token over Microsoft Graph. Reads auto-allow; sending or drafting mail is held for approval; deletes are blocked.',
  prerequisites: [
    'An **Azure app registration** you create (portal.azure.com — this is YOUR step), with delegated Microsoft Graph permissions: `Mail.Read` for reads, plus `Mail.Send`/`Mail.ReadWrite` only if you will approve sends.',
    'A **user OAuth access token** minted through your app registration. Paste the **access token**; it goes to Secrets Manager and is **never** on the record.',
    'The hosts `graph.microsoft.com` and `login.microsoftonline.com` on the **egress allowlist**.',
    'Builder/Admin rights (service-credential connector).',
  ],
  steps: [
    'On the Outlook card, click **Connect**.',
    'Enter the connection **name**; the base URL is `https://graph.microsoft.com/v1.0`.',
    'Provide the **OAuth access token** — stored once in Secrets Manager.',
    'Create the connection, then **Test** on its card (a real `GET /me` round-trip). Tune the per-tool capability profile.',
  ],
  whatTheOsDoes:
    'Registers a governed outbound Outlook connection over Microsoft Graph. Reads (`list_messages`, `get_message`) auto-allow. `send_mail` and `create_draft` are held at **Write-approval** — an email is **NEVER** auto-sent. `delete_message` stays **Blocked**. All calls are OPA-checked and audit-traced; the token never leaves the server.',
  caveat: 'The pasted Microsoft OAuth access token is short-lived; automatic refresh-token rotation is a documented follow-up. Registering the Azure app and minting the token are YOUR steps.',
};

const TEAMS: InstallGuide = {
  key: 'teams',
  title: 'Microsoft Teams (Microsoft Graph)',
  summary: 'Connect Microsoft Teams via a Microsoft OAuth 2.0 access token over Microsoft Graph. Reads auto-allow; posting a channel message is held for approval; deletes are blocked.',
  prerequisites: [
    'An **Azure app registration** you create (this is YOUR step), with delegated Microsoft Graph permissions: `Team.ReadBasic.All` + `Channel.ReadBasic.All` + `ChannelMessage.Read.All` for reads, plus `ChannelMessage.Send` only if you will approve posts.',
    'A **user OAuth access token** minted through your app registration. Paste the **access token**; it goes to Secrets Manager and is **never** on the record.',
    'The hosts `graph.microsoft.com` and `login.microsoftonline.com` on the **egress allowlist**.',
    'Builder/Admin rights (service-credential connector).',
  ],
  steps: [
    'On the Microsoft Teams card, click **Connect**.',
    'Enter the connection **name**; the base URL is `https://graph.microsoft.com/v1.0`.',
    'Provide the **OAuth access token** — stored once in Secrets Manager.',
    'Create the connection, then **Test** on its card (a real `GET /me` round-trip). Tune the per-tool capability profile.',
  ],
  whatTheOsDoes:
    'Registers a governed outbound Teams connection over Microsoft Graph. Reads (`list_teams`, `list_channels`, `list_channel_messages`) auto-allow. `post_channel_message` is held at **Write-approval** — a message is **never** auto-posted. `delete_channel_message` stays **Blocked**. All calls are OPA-checked and audit-traced; the token never leaves the server.',
  caveat: 'The pasted Microsoft OAuth access token is short-lived; automatic refresh-token rotation is a documented follow-up. Registering the Azure app and minting the token are YOUR steps.',
};

const ENTRA: InstallGuide = {
  key: 'entra',
  title: 'Microsoft Entra ID (Azure AD · Microsoft Graph)',
  summary: 'Connect Microsoft Entra ID (Azure AD) read-only via a Microsoft OAuth 2.0 access token over Microsoft Graph, for identity/directory governance. Every tool is a read — there is no write tool.',
  prerequisites: [
    'An **Azure app registration** you create (portal.azure.com — this is YOUR step), with delegated Microsoft Graph read permissions: `User.Read.All`, `Group.Read.All`, and `RoleManagement.Read.Directory` (all read-only).',
    'A **user OAuth access token** minted through your app registration. Paste the **access token**; it goes to Secrets Manager and is **never** on the record.',
    'The hosts `graph.microsoft.com` and `login.microsoftonline.com` on the **egress allowlist** (already allowlisted for the Microsoft connectors).',
    'Builder/Admin rights (service-credential connector).',
  ],
  steps: [
    'On the Microsoft Entra ID card, click **Connect**.',
    'Enter the connection **name**; the base URL is `https://graph.microsoft.com/v1.0`.',
    'Provide the **OAuth access token** — stored once in Secrets Manager.',
    'Create the connection, then **Test** on its card (a real `GET /me` round-trip). Browse users, groups, and directory-role assignments.',
  ],
  whatTheOsDoes:
    'Registers a governed, **read-only** Entra connection over Microsoft Graph. `list_users`, `get_user`, `list_groups`, and `list_role_assignments` auto-allow; there is **no** write tool — a directory mutation is out of scope for this connector. All calls are OPA-checked and audit-traced; the token never leaves the server.',
  caveat: 'The pasted Microsoft OAuth access token is short-lived; automatic refresh-token rotation is a documented follow-up. Registering the Azure app and minting the token are YOUR steps. Directory `$search` (used by `list_users` with a query) needs the app to be consented for advanced queries.',
};

const PURVIEW: InstallGuide = {
  key: 'purview',
  title: 'Microsoft Purview (data governance · catalog)',
  summary: 'Connect a Microsoft Purview account read-only via a Microsoft OAuth 2.0 access token over the account\'s Atlas/Purview REST API, for catalog + lineage governance. Every tool is a read — there is no write tool.',
  prerequisites: [
    'A **Microsoft Purview account** and its endpoint `https://<account>.purview.azure.com`, reachable from the OS — host on the **egress allowlist**.',
    'An **Azure app registration** / service principal you grant the **Purview Data Reader** role, and a **user/app OAuth access token** for the Purview audience. Paste the **access token**; it goes to Secrets Manager and is **never** on the record.',
    'Builder/Admin rights (service-credential connector).',
  ],
  steps: [
    'On the Microsoft Purview card, click **Connect**.',
    'Enter the connection **name** and your **account endpoint** `https://<account>.purview.azure.com`.',
    'Provide the **OAuth access token** — stored once in Secrets Manager.',
    'Create the connection, then **Test** on its card (a real classification-typedefs read). Search assets, read an entity, list classifications, and read lineage.',
  ],
  whatTheOsDoes:
    'Registers a governed, **read-only** Purview connection over the Atlas REST API. `search_assets`, `get_asset`, `list_classifications`, and `get_lineage` auto-allow; there is **no** write tool. All calls are OPA-checked and audit-traced; the token never leaves the server.',
  caveat: 'The pasted OAuth access token is short-lived; automatic refresh-token rotation is a documented follow-up. Account reachability, the Data Reader role, and the exact Atlas route shapes are only confirmed against your live Purview account at Test time.',
};

const AI_FOUNDRY: InstallGuide = {
  key: 'ai-foundry',
  title: 'Azure AI Foundry (Azure AI / ML)',
  summary: 'Connect an Azure ML workspace read-only via a Microsoft OAuth 2.0 access token over the workspace/region data-plane, for ML metadata (models + deployments). Every tool is a read — there is no write tool.',
  prerequisites: [
    'An **Azure ML workspace** and its regional data-plane endpoint `https://<region>.api.azureml.ms`, reachable from the OS — host on the **egress allowlist**.',
    'An **Azure app registration** / service principal you grant the **AzureML Data Scientist (or Reader)** role, and a **user/app OAuth access token** for the `https://ml.azure.com` audience. Paste the **access token**; it goes to Secrets Manager and is **never** on the record.',
    'Builder/Admin rights (service-credential connector).',
  ],
  steps: [
    'On the Azure AI Foundry card, click **Connect**.',
    'Enter the connection **name** and your workspace **endpoint** `https://<region>.api.azureml.ms`.',
    'Provide the **OAuth access token** — stored once in Secrets Manager.',
    'Create the connection, then **Test** on its card (a real model-registry read). List models, list deployments, and read one deployment.',
  ],
  whatTheOsDoes:
    'Registers a governed, **read-only** Azure AI Foundry connection over the Azure ML data-plane. `list_models`, `list_deployments`, and `get_deployment` auto-allow; there is **no** write tool — deploying or deleting a model is out of scope. All calls are OPA-checked and audit-traced; the token never leaves the server.',
  caveat: 'The pasted OAuth access token is short-lived; automatic refresh-token rotation is a documented follow-up. The Azure ML data-plane list routes are workspace-scoped and only verified against a **live workspace** at Test time — the client tolerates the API\'s `value:[]` vs bare-array shapes and degrades to an honest ✗ (never fabricates rows) if a route differs.',
};

const SAGEMAKER: InstallGuide = {
  key: 'sagemaker',
  title: 'AWS SageMaker (ML · SigV4)',
  summary: 'Connect AWS SageMaker read-only via AWS Signature Version 4, for ML metadata (models, endpoints, training jobs). Every tool is a read — there is no write tool.',
  prerequisites: [
    'An **AWS IAM user or role** with a **read-only** SageMaker policy (e.g. `AmazonSageMakerReadOnly`: `sagemaker:List*` / `sagemaker:Describe*`). Least privilege — no write/delete permissions.',
    'That principal\'s **access key id + secret access key**. Paste them; they are stored **together in Secrets Manager** and are **never** on the record, in a response, or in a log/trace.',
    'The region endpoint `https://api.sagemaker.<region>.amazonaws.com` (the region is derived from this host) — `amazonaws.com` on the **egress allowlist**.',
    'Builder/Admin rights (service-credential connector).',
  ],
  steps: [
    'On the AWS SageMaker card, click **Connect**.',
    'Enter the connection **name** and the region **endpoint** `https://api.sagemaker.<region>.amazonaws.com`.',
    'Provide the **access key id + secret access key** (as `accessKeyId:secretAccessKey`) — stored once in Secrets Manager.',
    'Create the connection, then **Test** on its card (a real SigV4-signed `ListModels` round-trip). List models / endpoints / training jobs and describe an endpoint.',
  ],
  whatTheOsDoes:
    'Registers a governed, **read-only** SageMaker connection. Each call is signed with **AWS Signature Version 4** (implemented in-repo, dependency-free, and unit-tested against AWS\'s published signing vector) using the vaulted keys — the secret access key is used **only** to derive the signing key and is never returned or logged. `list_models`, `list_endpoints`, `list_training_jobs`, and `describe_endpoint` auto-allow; there is **no** write tool. All calls are OPA-checked and audit-traced.',
  caveat: 'The SigV4 signer is verified against the AWS `get-vanilla` test vector; live reachability, the IAM read-only policy, and the exact region endpoint are only confirmed against your real AWS account at Test time. Temporary credentials with an `X-Amz-Security-Token` (STS/role assumption) are a documented follow-up — this connector uses long-lived IAM keys.',
};

const GCP_IDENTITY: InstallGuide = {
  key: 'gcp-identity',
  title: 'Google Cloud (identity · IAM governance)',
  summary: 'Connect Google Cloud read-only via a service-account JSON key for identity/resource governance over Cloud Resource Manager + IAM. Every tool is a read — there is no write tool.',
  prerequisites: [
    'A **GCP service account** you create (console.cloud.google.com → IAM & Admin → Service Accounts — this is YOUR step) granted a **read-only** role: the predefined **`roles/viewer`** (or the narrower `roles/resourcemanager.projectViewer` + `roles/iam.securityReviewer`). Least privilege — no editor/owner.',
    'A **JSON key** for that service account (Keys → Add key → JSON). Paste the **entire JSON** (it contains the private key); it goes to Secrets Manager and is **never** on the record, in a response, or in a log/trace.',
    'The hosts `oauth2.googleapis.com`, `cloudresourcemanager.googleapis.com`, and `iam.googleapis.com` on the **egress allowlist**.',
    'Builder/Admin rights (service-credential connector).',
  ],
  steps: [
    'On the Google Cloud card, click **Connect**.',
    'Enter the connection **name**; the base is `https://cloudresourcemanager.googleapis.com/v1`.',
    'Paste the **service-account JSON key** — stored once in Secrets Manager.',
    'Create the connection, then **Test** on its card (a real JWT-bearer token exchange + a projects read). List projects, read a project’s IAM policy, and list its service accounts.',
  ],
  whatTheOsDoes:
    'Registers a governed, **read-only** Google Cloud connection. The service-account JSON signs a JWT assertion (RS256, implemented in-repo dependency-free) which the OS exchanges at `oauth2.googleapis.com` for a short-lived **`cloud-platform.read-only`** access token; that bearer calls Cloud Resource Manager + IAM. `list_projects`, `get_iam_policy`, and `list_service_accounts` auto-allow; there is **no** write tool. All calls are OPA-checked and audit-traced; the key never leaves the server.',
  caveat: 'The service-account key is a long-lived credential — grant it the **narrowest read-only** role and rotate it. Live reachability, the exact read-only role, and the API routes are only confirmed against your real GCP org at Test time. Workload-Identity-Federation (keyless) is a documented follow-up — this connector uses a JSON key.',
};

const GCP_DIRECTORY: InstallGuide = {
  key: 'gcp-directory',
  title: 'Google Workspace (directory governance · Admin SDK)',
  summary: 'Connect Google Workspace read-only via the Admin SDK Directory API for directory governance (users, groups, org units, admin roles, domains). Uses a service account with **domain-wide delegation**. Every tool is a read — there is no write tool. This is the Workspace-directory peer of the Google Cloud (IAM) connector.',
  prerequisites: [
    'A **GCP service account** you create (console.cloud.google.com → IAM & Admin → Service Accounts — YOUR step) with **domain-wide delegation ENABLED** on it. The SA needs no project role for this — its power comes only from the delegation you authorize below.',
    'A **JSON key** for that service account (Keys → Add key → JSON). You will paste the **entire JSON PLUS two extra fields** you add by hand: `"subject"` — the email of a **Workspace admin** the SA impersonates (it reads THAT admin\'s directory) — and optionally `"customer"` (defaults to `my_customer`). The whole blob goes to Secrets Manager and is **never** on the record, in a response, or in a log/trace (the `subject`/`customer` are non-secret routing that ride in the same blob only because this connector needs them server-side).',
    'In the **Workspace Admin console** (admin.google.com → Security → API controls → Domain-wide delegation), authorize the SA\'s **client ID** for exactly the scope **`https://www.googleapis.com/auth/admin.directory.readonly`** — least privilege, read-only. Without this authorization the token exchange is rejected.',
    'The hosts `oauth2.googleapis.com` and `admin.googleapis.com` on the **egress allowlist**.',
    'Builder/Admin rights (service-credential connector).',
  ],
  steps: [
    'On the Google Workspace card, click **Connect**.',
    'Enter the connection **name**; the base is `https://admin.googleapis.com/admin/directory/v1`.',
    'Paste the **extended service-account JSON** — the SA key JSON with your added `"subject"` (impersonated admin email) and optional `"customer"` — stored once in Secrets Manager.',
    'Create the connection, then **Test** on its card (a real domain-wide-delegation JWT-bearer exchange + a users read). List users / groups / org units / admin roles / verified domains.',
  ],
  whatTheOsDoes:
    'Registers a governed, **read-only** Google Workspace directory connection. The service-account JSON signs a JWT assertion (RS256, implemented in-repo dependency-free) whose **`sub` claim is the impersonated Workspace admin** (domain-wide delegation) and whose scope is **`admin.directory.readonly`**; the OS exchanges it at `oauth2.googleapis.com` for a short-lived bearer that calls the Admin SDK Directory API. `list_users`, `list_groups`, `list_org_units`, `list_roles`, and `list_domains` auto-allow; there is **no** write tool. All calls are OPA-checked and audit-traced; the key never leaves the server.',
  caveat: 'Domain-wide delegation lets the SA impersonate the `subject` admin across the readonly scope — grant it **only** the `admin.directory.readonly` scope and rotate the key. Live reachability, the delegation authorization, and the admin `subject` are only confirmed against your real Workspace at Test time. Workload-Identity-Federation (keyless) is a documented follow-up — this connector uses a JSON key.',
};

const SNOWFLAKE_GOVERNANCE: InstallGuide = {
  key: 'snowflake-governance',
  title: 'Snowflake (ACCOUNT_USAGE governance)',
  summary: 'Connect Snowflake read-only via an RSA key-pair JWT over the SQL REST API to read SNOWFLAKE.ACCOUNT_USAGE (users, roles, grants, login/access history). Every tool is a read — there is no write tool. This is the GOVERNANCE peer of the data-warehouse Snowflake connector.',
  prerequisites: [
    'A Snowflake **account identifier** (`ORG-ACCOUNT`) and a **login name** for a user whose **default role is read-only** and has been granted **`IMPORTED PRIVILEGES` on the `SNOWFLAKE` database** (so it can read `ACCOUNT_USAGE`). Least privilege — no ACCOUNTADMIN.',
    'An **RSA key-pair**: register the **public** key on the Snowflake user (`ALTER USER … SET RSA_PUBLIC_KEY=…`); paste the **unencrypted PKCS#8 private key (PEM)**. It goes to Secrets Manager and is **never** on the record, in a response, or in a log/trace.',
    'The host `<account>.snowflakecomputing.com` on the **egress allowlist** (`snowflakecomputing.com` covers it via the subdomain rule).',
    'Builder/Admin rights (service-credential connector).',
  ],
  steps: [
    'On the Snowflake (ACCOUNT_USAGE governance) card, click **Connect**.',
    'Enter the connection **name** and the account **endpoint** `https://<account>.snowflakecomputing.com`.',
    'Provide the credential as `account:user:<PEM>` (account + user route the JWT; the PEM is the secret) — stored once in Secrets Manager.',
    'Create the connection, then **Test** on its card (a real key-pair-JWT `SELECT CURRENT_ACCOUNT()`). List users / roles / grants and read login/access history.',
  ],
  whatTheOsDoes:
    'Registers a governed, **read-only** Snowflake governance connection over the SQL REST API. The RSA private key signs a **key-pair JWT** (RS256, implemented in-repo dependency-free; `iss` = `<ACCOUNT>.<USER>.SHA256:<fp>`) used as the Bearer — the key is used **only** to sign and is never returned or logged. `list_users`, `list_roles`, `grants_to_users`, `grants_to_roles`, `login_history`, and `access_history` auto-allow (each is a bounded SELECT built server-side; no user SQL); there is **no** write tool. All calls are OPA-checked and audit-traced.',
  caveat: '`SNOWFLAKE.ACCOUNT_USAGE` views have up to **~2 hours of latency** — they are for governance/audit, not real-time state. Every query runs on a **virtual warehouse and consumes credits** (prefer an XS auto-suspend warehouse). The JWT signer is verified against a deterministic vector; live reachability, the `IMPORTED PRIVILEGES` grant, and the registered public key are only confirmed against your real account at Test time.',
};

const OM_CATALOG: InstallGuide = {
  key: 'om-catalog',
  title: 'OpenMetadata catalog (external · read-only)',
  summary: 'Connect an external OpenMetadata instance read-only for discovery and lineage. No writes in Phase 1.',
  prerequisites: [
    'The OpenMetadata **base URL** (e.g. `https://openmetadata.example.com`), reachable from the OS — host on the **egress allowlist**.',
    'An OpenMetadata **bot JWT with read scope**. The JWT goes to Secrets Manager and is **never** on the record.',
    'This connector is gated behind a deployment flag (`OPENMETADATA_CONNECT_ENABLED`); if you don\'t see the card, ask an admin to enable it.',
  ],
  steps: [
    'On the OpenMetadata card, click **Connect**.',
    'Enter the connection **name** and the OM **base URL**.',
    'Paste the **bot JWT** (read scope) — stored once in Secrets Manager.',
    'Create the connection, then **Test** on its card and browse OM domains / data products / tables / lineage.',
  ],
  whatTheOsDoes:
    'Registers a **read/discover-only** connection to the external catalog. Exposes read tools (list domains / data products / tables, search, lineage) under policy — there is **no** write tool in Phase 1; scoped writes are a later phase.',
};

// ---- Registry ---------------------------------------------------------------

const GUIDES: InstallGuide[] = [
  GLUE, SNOWFLAKE, BIGQUERY, DATABRICKS, FABRIC,
  POSTGRESQL, MYSQL, SQLSERVER, MONGODB,
  GDRIVE, ONEDRIVE, NOTION, AIRFLOW, OM_CATALOG,
  GITHUB, SUPABASE, ATLASSIAN,
  SLACK, GMAIL, GCAL, OUTLOOK, TEAMS,
  ENTRA, PURVIEW, AI_FOUNDRY, SAGEMAKER,
  GCP_IDENTITY, GCP_DIRECTORY, SNOWFLAKE_GOVERNANCE,
];

const GUIDE_BY_KEY: Record<string, InstallGuide> = Object.fromEntries(GUIDES.map((g) => [g.key, g]));

/**
 * Resolve a guide for a Supported Connector card. Warehouse cards pass the provider
 * `platform` (glue / snowflake / bigquery / databricks-delta / fabric); template
 * cards pass the template key (gdrive / onedrive / notion-mcp / airflow / om-catalog).
 * Returns `undefined` when no guide is authored for that key.
 */
export function installGuideFor(key: string): InstallGuide | undefined {
  return GUIDE_BY_KEY[key];
}

/** Render a guide as portable GFM markdown for the shared <Markdown> renderer. */
export function guideMarkdown(g: InstallGuide): string {
  const prereqs = g.prerequisites.map((p) => `- ${p}`).join('\n');
  const steps = g.steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
  const caveat = g.caveat ? `\n\n> **Honest note.** ${g.caveat}` : '';
  return [
    `_${g.summary}_`,
    `### Prerequisites`,
    prereqs,
    `### Steps`,
    steps,
    `### What the OS does`,
    g.whatTheOsDoes + caveat,
  ].join('\n\n');
}
