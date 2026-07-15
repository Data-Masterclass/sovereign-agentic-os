/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Per-connector installation guides — PURE + client-safe (no secrets, no server
 * imports). One record per Supported Connector the Connections gallery renders:
 * the warehouse platforms (glue / snowflake / bigquery / databricks-delta / fabric)
 * and the user-facing templates (gdrive / onedrive / notion-mcp / airflow / om-catalog).
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
  GDRIVE, ONEDRIVE, NOTION, AIRFLOW, OM_CATALOG,
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
