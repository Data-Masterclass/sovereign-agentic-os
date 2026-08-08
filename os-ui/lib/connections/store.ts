/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { config } from '@/lib/core/config';
import { osMirror } from '@/lib/infra/os-mirror';
import type { CurrentUser } from '@/lib/core/auth';
import { canPromote, roleAtLeast } from '@/lib/core/session';
import { canManageArtifact, type ArtifactScope } from '@/lib/governance/edit-scope';
import type { Visibility } from '@/lib/core/artifact-model';
import {
  type Connection,
  type ConnectionTool,
  type ConnectionTemplateKey,
  type CapabilityMode,
  type CapabilityLimits,
  type DataUsage,
  type WarehouseConnectionConfig,
  type AirflowConnectionConfig,
  type AirflowAuthType,
  type AtlassianConnectionConfig,
  type AtlassianAuthKind,
  type ODataConnectionConfig,
  type ODataAuthType,
  type WorkdayConnectionConfig,
  templateByKey,
  isPersonalConnectable,
} from '@/lib/connections/schema';
import { isOperationalTemplate } from '@/lib/connections/operational-platform';
import {
  type AirflowConn,
  airflowHealth,
  listDags as afListDags,
  getDagRun as afGetDagRun,
  triggerDag as afTriggerDag,
  listDagRuns as afListDagRuns,
  getTaskInstances as afGetTaskInstances,
  getTaskLogs as afGetTaskLogs,
  getXcom as afGetXcom,
  listDatasets as afListDatasets,
  getDatasetEvents as afGetDatasetEvents,
  setDagPaused as afSetDagPaused,
  clearTask as afClearTask,
  airflowDagAllowed,
} from '@/lib/connections/airflow';
import {
  githubConnFrom,
  githubHealth,
  listRepos as ghListRepos,
  getRepo as ghGetRepo,
  listIssues as ghListIssues,
  getIssue as ghGetIssue,
  searchCode as ghSearchCode,
  listPulls as ghListPulls,
  getPull as ghGetPull,
  listCommits as ghListCommits,
  createIssue as ghCreateIssue,
  addIssueComment as ghAddIssueComment,
  createPullRequest as ghCreatePullRequest,
} from '@/lib/connections/github';
import {
  supabaseConnFrom,
  supabaseHealth,
  listProjects as sbListProjects,
  listTables as sbListTables,
  listMigrations as sbListMigrations,
  getAdvisors as sbGetAdvisors,
  getLogs as sbGetLogs,
  getProjectUrl as sbGetProjectUrl,
  executeSql as sbExecuteSql,
} from '@/lib/connections/supabase';
import {
  atlassianConnFrom,
  atlassianHealth,
  jiraSearchIssues as atlJiraSearchIssues,
  jiraGetIssue as atlJiraGetIssue,
  jiraListProjects as atlJiraListProjects,
  confluenceSearch as atlConfluenceSearch,
  confluenceGetPage as atlConfluenceGetPage,
  jiraCreateIssue as atlJiraCreateIssue,
  jiraAddComment as atlJiraAddComment,
  jiraTransitionIssue as atlJiraTransitionIssue,
  confluenceCreatePage as atlConfluenceCreatePage,
} from '@/lib/connections/atlassian';
import {
  notionConnFrom,
  notionSearch as apiNotionSearch,
  notionGetPage as apiNotionGetPage,
  notionCreatePage as apiNotionCreatePage,
} from '@/lib/connections/notion';
import {
  slackConnFrom,
  slackHealth,
  listChannels as slkListChannels,
  listUsers as slkListUsers,
  conversationsHistory as slkConversationsHistory,
  postMessage as slkPostMessage,
} from '@/lib/connections/slack';
import {
  googleMailConnFrom,
  gmailHealth,
  gmailListMessages,
  gmailGetMessage,
  gmailListLabels,
  gmailSendMessage,
  gmailCreateDraft,
} from '@/lib/connections/gmail';
import {
  gcalConnFrom,
  gcalHealth,
  gcalListCalendars,
  gcalListEvents,
  gcalGetEvent,
  gcalCreateEvent,
  gcalUpdateEvent,
} from '@/lib/connections/gcal';
import {
  graphConnFrom,
  outlookHealth,
  outlookListMessages,
  outlookGetMessage,
  outlookSendMail,
  outlookCreateDraft,
} from '@/lib/connections/outlook';
import {
  teamsConnFrom,
  teamsHealth,
  teamsListTeams,
  teamsListChannels,
  teamsListChannelMessages,
  teamsPostChannelMessage,
} from '@/lib/connections/teams';
import {
  entraConnFrom,
  entraHealth,
  entraListUsers,
  entraGetUser,
  entraListGroups,
  entraListRoleAssignments,
} from '@/lib/connections/entra';
import {
  purviewConnFrom,
  purviewHealth,
  purviewSearchAssets,
  purviewGetAsset,
  purviewListClassifications,
  purviewGetLineage,
} from '@/lib/connections/purview';
import {
  aiFoundryConnFrom,
  aiFoundryHealth,
  aiFoundryListModels,
  aiFoundryListDeployments,
  aiFoundryGetDeployment,
} from '@/lib/connections/ai-foundry';
import {
  sagemakerConnFrom,
  sagemakerHealth,
  sagemakerListModels,
  sagemakerListEndpoints,
  sagemakerListTrainingJobs,
  sagemakerDescribeEndpoint,
} from '@/lib/connections/sagemaker';
import {
  gcpIdentityConnFrom,
  gcpIdentityHealth,
  gcpListProjects,
  gcpGetIamPolicy,
  gcpListServiceAccounts,
} from '@/lib/connections/gcp-identity';
import {
  gcpDirectoryConnFrom,
  gcpDirectoryHealth,
  gcpDirListUsers,
  gcpDirListGroups,
  gcpDirListOrgUnits,
  gcpDirListRoles,
  gcpDirListDomains,
} from '@/lib/connections/gcp-directory';
import {
  snowflakeGovConnFrom,
  snowflakeGovHealth,
  snowflakeGovListUsers,
  snowflakeGovListRoles,
  snowflakeGovGrantsToUsers,
  snowflakeGovGrantsToRoles,
  snowflakeGovLoginHistory,
  snowflakeGovAccessHistory,
} from '@/lib/connections/snowflake-governance';
import type { WarehousePlatform } from '@/lib/connections/warehouse/types';
import { splitWarehouseFields, toWarehouseSource } from '@/lib/connections/warehouse/connection';
import { providerFor } from '@/lib/connections/warehouse/registry';
import { buildImportCtas } from '@/lib/connections/warehouse/import';
import { catalogRegistration, type CatalogRegistration } from '@/lib/connections/warehouse/registration';
import { applyLiveRegistration, type RegK8s, type RegisterK8sOutcome, type SecretValues } from '@/lib/connections/warehouse/k8s-registration';
import { executeRun, queryRun, type ExecuteIdentity } from '@/lib/infra/governed';
// Data-tab registry seam for the warehouse IMPORT (P0 A2): an import must create a
// real governed Dataset row pointing at the materialized table, not just a table.
import { createDataset, buildVersion, deleteDataset } from '@/lib/data';
import { personalSchema, slug } from '@/lib/data/store-fqn';
import { stageArtifact } from '@/lib/data/panels';
import { putSecret, secretFingerprint, getSecretServerSide, isEgressAllowed, deleteSecret, hasSecret } from '@/lib/infra/secrets';
import { type ArtifactVersion, versionLog } from '@/lib/core/versioning';
import {
  type PhysicalDeleteReport,
  purgeConnectionSecrets,
} from '@/lib/connections/connections-physical-delete';
import {
  registerConnectionProfile,
  unregisterConnectionProfile,
  restrictConnectionForAgent,
  authorizeConnectionCall,
  exposedConnectionTools,
  trace,
  type ConnToolPolicy,
} from '@/lib/infra/agent-governed';
import { enqueue } from '@/lib/governance/approvals';
import {
  isSalesforceActionTool,
  decideActionTool,
  actionToolLimits,
  exposedActionTools,
  executeSalesforceAction,
  operationalActionsActive,
} from '@/lib/connections/salesforce-tools';
import { allActiveExposures } from '@/lib/connections/exposures';
import { allActiveAdoptions } from '@/lib/connections/action-adoptions';
import { executeODataTool } from '@/lib/connections/odata/client';
import { executeWorkdayTool } from '@/lib/connections/workday-raas';
import { adapterFor } from '@/lib/connections/connection-adapters';
import {
  buildPreview,
  matchStandingPolicy,
  rememberPolicy,
  resolveAutonomous,
  effectivePreset,
} from '@/lib/governance/governance';
import { registerBronzeSource, indexToFiles } from '@/lib/data/data-handoff';
import { logEgress } from '@/lib/connections/egress-requests';
import { providerForTemplate, providerConfig, type OAuthProvider } from '@/lib/oauth/providers';
import { storeTokens, readTokens, resolveAccessToken } from '@/lib/oauth/connection-token';
import { probeDrive } from '@/lib/oauth/client';
import { isExpired, type TokenSet } from '@/lib/oauth/token-set';
import {
  refreshNotionToken,
  listNotionMcpTools,
  serializeClientReg,
  parseClientReg,
  type FetchFn,
  type NotionClientReg,
  type McpToolInfo,
} from '@/lib/oauth/notion-mcp';
// The GOVERNED folder registry (Wave-2 parity) — a moved-into folder is upserted as an
// explicit row so it persists even when empty. Reused, never forked (mirrors Data/Metrics).
import { createFolder, type FolderScope, type Principal as FolderPrincipal } from '@/lib/folders/index';
import { normaliseFolderPath } from '@/lib/core/folders';

/**
 * Connections registry — the home of record for every MANUALLY-credentialed
 * Connection a Builder/Admin creates (the create side the agent layer consumes).
 * Mirrors `lib/apps.ts`/`lib/artifacts.ts`: an authoritative in-process cache (so
 * the teaching flow works with NO cluster) + a best-effort OpenSearch
 * write-through ("os-connections") for durability. The scoping + role gates +
 * the capability gate below are the security boundary regardless of backing store.
 *
 * THE ONE RULE: the secret never lives in a record. `createConnection` writes the
 * credential to Secrets Manager (`lib/secrets.ts`) and keeps only a `secretRef`.
 * Every governed tool call funnels through the SAME authorize→trace spine as the
 * agent layer (`lib/agent-governed.ts`), so the capability profile (compiled into
 * the connection's OPA policy + mirrored offline) decides allow/deny/approval.
 *
 * LIVE vs STUBBED locally:
 *   • Secret storage — REAL ref/never-the-value contract, in-process vault.
 *   • Egress allowlist — REAL guardrail check (mirror of egressProxy.allowlist).
 *   • Capability gate (modes, bounded limits, restrict-on-grant) — REAL, offline.
 *   • The external call itself (Notion/Salesforce) — seed-backed mock offline;
 *     a real deploy injects the secret server-side and routes via the egress proxy.
 */

type ConnCacheState = { cache: Map<string, Connection> | null };
const CONN_STATE_KEY = Symbol.for('soa.connections.cache');
function connState(): ConnCacheState {
  const g = globalThis as unknown as Record<symbol, ConnCacheState | undefined>;
  if (!g[CONN_STATE_KEY]) g[CONN_STATE_KEY] = { cache: null };
  return g[CONN_STATE_KEY]!;
}

function now(): string {
  return new Date().toISOString();
}
function id(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-4)}`;
}
function slugify(s: string): string {
  return (
    s.toLowerCase().trim().replace(/[^a-z0-9-_ ]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').slice(0, 40) || 'conn'
  );
}

/**
 * Ensure a connection slug is UNIQUE across the registry (C5). The slug drives the OPA
 * `principal` (`conn-<slug>`) and the vault `secretName` (`connection-<slug>`), so a
 * collision means credential clobber + policy cross-talk + cross-delete of the other's
 * secret. When `base` is already the slug of ANOTHER connection, append this record's id
 * suffix (stable + unique per record) so the derived principal/secret name are unique.
 */
function uniqueSlug(base: string, connId: string, map: Map<string, Connection>): string {
  // Compare against the principals actually in use — that is exactly what a collision means.
  const principals = new Set<string>([...map.values()].map((c) => c.principal));
  if (!principals.has(`conn-${base}`)) return base;
  const suffix = connId.replace(/^conn_/, '');
  return slugify(`${base}-${suffix}`);
}
function withStatus(err: Error, status: number): Error {
  (err as Error & { status?: number }).status = status;
  return err;
}

// ---------------------------------------------------------------- OpenSearch ---
// Shared durable-mirror core (probe → bootstrap-on-404 → hydrate/write-through):
// lib/os-mirror.ts. A missing index is CREATED, never mistaken for a dead mirror.

const mirror = osMirror({ index: 'os-connections' });

// Durable, per-connection version history (the reused OS helper). The capability
// profile (tools) is snapshotted before a meaningful edit so any prior profile is
// restorable — the same discipline the other artifact stores use.
const versions = versionLog('connection');
function snapshotState(c: Connection): { tools: ConnectionTool[] } {
  return { tools: c.tools };
}

function writeThrough(c: Connection): void {
  mirror.writeThrough(c.id, c);
}

/** Compile the capability profile into the offline OPA mirror for a connection. */
function compileProfile(c: Connection): void {
  const policies: ConnToolPolicy[] = c.tools.map((t) => ({
    name: t.name,
    mode: t.mode,
    write: t.write,
    maxAmount: t.limits?.maxAmount,
    dataScope: t.limits?.dataScope,
  }));
  registerConnectionProfile(c.principal, policies);
}

async function getCache(): Promise<Map<string, Connection>> {
  const s = connState();
  if (s.cache) return s.cache;
  const map = new Map<string, Connection>();
  const [docs] = await Promise.all([mirror.hydrate(500), versions.ensureHydrated()]);
  for (const c of (docs ?? []) as Connection[]) { // null → mirror down → in-memory only
    map.set(c.id, c);
    compileProfile(c); // re-hydrate the OPA mirror after a restart
  }
  s.cache = map;
  return map;
}

/**
 * SYNCHRONOUS accessor to the in-process cache — the already-warm Map or an empty one.
 * The folder LIFECYCLE (`lib/folders/folder-lifecycle.ts`) + its `ArtifactAdapter` seam
 * are strictly SYNCHRONOUS, so the connection folder/rename ops (and the adapter that
 * wraps them) must be sync too — mirroring how the Data/Bigbets stores read their sync
 * in-process Map. The cache is warmed by the first `getCache()` (every session's
 * connections list hits it), so by the time a cascade runs it is populated; an unwarmed
 * cache honestly yields NO members rather than blocking on I/O (same as Bigbets when
 * un-hydrated). Never triggers hydration itself — a pure read of `connState().cache`. */
function syncCache(): Map<string, Connection> {
  return connState().cache ?? new Map<string, Connection>();
}

/**
 * Cross-domain governance move (admin-only, gated in lib/platform-admin/domain-move.ts).
 * Scoping reads the connection's `domain` field (its `principal` is a slug, not
 * domain-derived), so we set the field and write through. `sel.id` moves one;
 * `sel.onlyUnassigned` sweeps only empty-domain records. Returns the ids moved.
 */
export async function moveConnectionsDomain(sel: { id?: string; onlyUnassigned?: boolean }, target: string): Promise<string[]> {
  const map = await getCache();
  const moved: string[] = [];
  // M4: a move that touches a warehouse/operational connection must trigger an exposure
  // recompile — the OPA `data.governance.tables` entries are keyed by the connection's
  // domain, so silently rewriting c.domain leaves the old-domain grants in the bundle and
  // the action intersection re-keys under the stale domain. Track whether any moved
  // connection backs exposures so we recompile once at the end (best-effort).
  let touchedExposureBacking = false;
  for (const c of map.values()) {
    if (sel.id !== undefined && c.id !== sel.id) continue;
    if (sel.onlyUnassigned && c.domain) continue;
    if (c.domain === target) continue;
    if (c.template === 'warehouse' || isOperationalTemplate(c.template)) touchedExposureBacking = true;
    c.domain = target;
    writeThrough(c);
    moved.push(c.id);
  }
  if (touchedExposureBacking) await recompileExposuresAfterMove();
  return moved;
}

/**
 * Recompile the OPA exposure bundle after a domain MOVE affecting a warehouse/operational
 * connection (M4). A plain recompile re-derives every active exposure's grants from the
 * connection's CURRENT domain, replacing the stale-domain entries. Dynamically imported to
 * avoid the static import cycle (exposure-policy imports back into this store).
 * Best-effort — a recompile failure never rolls back the authorised move.
 */
async function recompileExposuresAfterMove(): Promise<void> {
  try {
    const { recompileExposures } = await import('@/lib/connections/exposure-policy');
    await recompileExposures();
  } catch {
    /* best-effort: a recompile failure never blocks the move */
  }
}

// ------------------------------------------------------------------- Scoping ---

function visibleToUser(c: Connection, user: CurrentUser): boolean {
  // STRICT DOMAIN ISOLATION: EVERY tier narrows to the caller's live (active) domain.
  // auth.ts narrows user.domains to [active] when a domain is chosen; "All Domains"
  // keeps every membership; a domainless connection always shows. Matches the
  // data/files/metrics/pillars pattern.
  const inScope = !c.domain || user.domains.includes(c.domain);
  if (c.visibility === 'Personal') return c.owner === user.id && inScope;
  if (c.visibility === 'Shared') return inScope;
  // Certified (this tab's "Company" tier): the owning domain only — a certified
  // connection homed in domain A must NOT show while acting in domain B. Cross-domain
  // discovery is the dedicated Marketplace catalog's job, not this list's.
  return inScope;
}

/** The edit-scope arg for a connection. A Personal connection is owner-only —
 *  no admin/domain_admin reaches another user's private connection. */
function manageArg(c: Connection): { owner: string; domain: string; scope: ArtifactScope } {
  const scope: ArtifactScope = c.visibility === 'Personal' ? 'personal' : c.visibility === 'Certified' ? 'certified' : 'shared';
  return { owner: c.owner, domain: c.domain, scope };
}

export async function listConnectionsForUser(
  user: CurrentUser,
  opts: { includeArchived?: boolean } = {},
): Promise<Connection[]> {
  const map = await getCache();
  return [...map.values()]
    .filter((c) => visibleToUser(c, user))
    .filter((c) => opts.includeArchived || !c.archived) // archived soft-hidden by default
    .sort((x, y) => y.updatedAt.localeCompare(x.updatedAt));
}

/**
 * SYNCHRONOUS visible-connections list for the folder-lifecycle cascade (the shared
 * `ArtifactAdapter.itemsUnderFolder` is sync). Same visibility gate as
 * {@link listConnectionsForUser}, ALWAYS including archived (the restore/delete cascade
 * must find members the archive step already hid). Reads the already-warm cache via
 * {@link syncCache} — an unwarmed cache honestly yields none (mirrors Bigbets). */
export function listConnectionsSync(user: CurrentUser): Connection[] {
  return [...syncCache().values()].filter((c) => visibleToUser(c, user));
}

export async function getConnectionForUser(connId: string, user: CurrentUser): Promise<Connection> {
  const map = await getCache();
  const c = map.get(connId);
  if (!c || !visibleToUser(c, user)) throw withStatus(new Error('Connection not found'), 404);
  return c;
}

/**
 * SERVER-SIDE, NON-user-scoped by-id lookup — for the policy compiler, which recompiles
 * the WHOLE governed registry (exposures) irrespective of any one caller's visibility,
 * exactly as the dataset governance compile runs over every governed dataset. Hydrates
 * the cache so a fresh pod resolves persisted connections. Returns null when absent.
 */
export async function getConnectionById(connId: string): Promise<Connection | null> {
  const map = await getCache();
  return map.get(connId) ?? null;
}

/**
 * SERVER-SIDE list of every non-archived warehouse connection — for the catalog-refresh
 * sweep (the optional `connections.catalogRefresh` CronJob), which re-snapshots each
 * warehouse's catalog on a cadence. Not user-scoped: the sweep runs as a service.
 */
export async function listWarehouseConnections(): Promise<Connection[]> {
  const map = await getCache();
  return [...map.values()].filter((c) => c.template === 'warehouse' && c.warehouse && !c.archived);
}

/**
 * Every connection the `connections.catalogRefresh` sweep can re-snapshot (m5): warehouse
 * connections PLUS operational api-batch sources (Salesforce/Kajabi/OData/Workday), whose
 * ENTITY catalog rides the same snapshot machinery via the operational registry. Excludes
 * archived. Warehouse-only callers keep using {@link listWarehouseConnections}.
 */
export async function listSnapshotableConnections(): Promise<Connection[]> {
  const map = await getCache();
  return [...map.values()].filter((c) =>
    !c.archived && ((c.template === 'warehouse' && c.warehouse) || isOperationalTemplate(c.template)),
  );
}

function assertBuilderOrAdmin(user: CurrentUser): void {
  if (!roleAtLeast(user.role, 'builder')) {
    throw withStatus(new Error('Creating connections requires a Builder or Administrator'), 403);
  }
}

// -------------------------------------------------------------------- Create ---

/** The warehouse-federation block on the create input (only for the `warehouse` template). */
export type WarehouseCreateInput = {
  platform: WarehousePlatform;
  /** The Trino catalog name to mount as (e.g. `glue_sales`). */
  catalog: string;
  /** Flat field map keyed by the provider's credentialField keys (secret + non-secret). */
  fields: Record<string, string>;
};

/** The non-secret Airflow config on the create input (only for the `airflow` template). */
export type AirflowCreateInput = {
  authType: AirflowAuthType;
  /** Basic-auth username (non-secret); empty for Bearer. */
  username?: string;
  /** Optional allowlist of DAG ids `trigger_dag` is bounded to. */
  dagAllowlist?: string[];
};

/** The non-secret Atlassian config on the create input (only for the `atlassian` template). */
export type AtlassianCreateInput = {
  /** 'basic' = API token (with the account email); 'bearer' = OAuth 3LO access token. */
  authKind: AtlassianAuthKind;
  /** Basic-auth account email (non-secret); empty for Bearer. */
  email?: string;
};

/** The non-secret OData config on the create input (only for `sap-odata` / `odata-v4`). */
export type ODataCreateInput = {
  /** 'basic' = communication user; 'oauth-cc' = OAuth2 client-credentials. */
  authType: ODataAuthType;
  /** OAuth-CC token endpoint (non-secret); empty for Basic. */
  tokenUrl?: string;
};

/** The non-secret Workday config on the create input (only for `workday-raas`). */
export type WorkdayCreateInput = {
  /** The admin-registered RaaS report catalog (each report is an entity). */
  reports?: { key?: string; path: string; label?: string; incrementalParam?: string }[];
};

/** Normalize a raw Workday report list from the wizard into the record's report catalog:
 *  a well-formed `path` is required; the key is slugified (falling back to the last path
 *  segment); rows are deduped by key. Pure. */
export function sanitizeWorkdayReports(
  raw: { key?: string; path: string; label?: string; incrementalParam?: string }[] | undefined,
): WorkdayConnectionConfig['reports'] {
  if (!Array.isArray(raw)) return [];
  const out: WorkdayConnectionConfig['reports'] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const path = String(r?.path ?? '').trim();
    if (!path) continue;
    const rawKey = String(r?.key ?? '').trim() || path.split(/[/?]/).filter(Boolean).pop() || 'report';
    const key = rawKey.replace(/[^A-Za-z0-9_]/g, '_').replace(/^([0-9])/, '_$1').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const label = String(r?.label ?? '').trim() || undefined;
    const incrementalParam = String(r?.incrementalParam ?? '').trim() || undefined;
    out.push({ key, path, ...(label ? { label } : {}), ...(incrementalParam ? { incrementalParam } : {}) });
  }
  return out;
}

export async function createConnection(
  user: CurrentUser,
  input: { name: string; template: ConnectionTemplateKey; endpoint: string; credential: string; domain?: string; openApiSpec?: unknown; warehouse?: WarehouseCreateInput; omService?: string; airflow?: AirflowCreateInput; atlassian?: AtlassianCreateInput; odata?: ODataCreateInput; workday?: WorkdayCreateInput },
): Promise<Connection> {
  const tpl = templateByKey(input.template);
  if (!tpl) throw withStatus(new Error('Unknown connection template'), 400);

  // External-warehouse connections are gated OFF by default — refuse to create one
  // unless the operator has turned on EXTERNAL_CONNECTORS_ENABLED. No behaviour
  // change for any other template when the flag is off.
  if (tpl.key === 'warehouse' && !config.externalConnectorsEnabled) {
    throw withStatus(new Error('External-warehouse connectors are not enabled on this deployment'), 403);
  }

  // External OpenMetadata connections are gated OFF by default too — refuse to
  // create one unless the operator has turned on OPENMETADATA_CONNECT_ENABLED.
  if (tpl.key === 'om-catalog' && !config.openmetadataConnectEnabled) {
    throw withStatus(new Error('External OpenMetadata connections are not enabled on this deployment'), 403);
  }

  // WHO CONNECTS (golden path): any user may connect a PERSONAL (per-user OAuth)
  // account; SHARED (service-credential) connections require a Builder/Admin.
  if (!isPersonalConnectable(tpl)) {
    assertBuilderOrAdmin(user);
  }

  const map = await getCache();
  const name = (input.name ?? '').trim() || tpl.label;
  // The record id is minted up-front so the slug can borrow its suffix to DE-DUPE (C5):
  // two same-named connections must NOT share a slug — that would collide their principal
  // (OPA cross-talk), their vault secret name (credential clobber), and cross-delete one
  // another's secret. If the base slug is already taken by another connection, append the
  // record-id suffix so the principal + secret name are provably unique.
  const connId = id('conn');
  const baseSlug = slugify(`${name}-${user.id}`);
  const slug = uniqueSlug(baseSlug, connId, map);
  const domain = input.domain && user.domains.includes(input.domain) ? input.domain : user.domains[0];
  const principal = `conn-${slug}`;
  const endpoint = (input.endpoint ?? '').trim() || tpl.endpointHint;
  const adapter = adapterFor(tpl.connector);

  // ---- WAREHOUSE branch: split the flat field map into non-secret record config +
  // vaulted secrets, store each secret under its own key, and stamp the record's
  // `warehouse` block. NEVER put a secret value on the record (the ONE rule holds).
  if (tpl.key === 'warehouse') {
    if (!input.warehouse) throw withStatus(new Error('A warehouse connection needs a platform + catalog + fields'), 400);
    const wh = input.warehouse;
    let split: { config: Record<string, string>; secrets: Record<string, string> };
    try {
      split = splitWarehouseFields({ platform: wh.platform, catalog: wh.catalog, fields: wh.fields });
    } catch (e) {
      throw withStatus(e as Error, (e as Error & { status?: number }).status ?? 400);
    }
    const secretName = `connection-${slug}`;
    // Store each secret field under its own key in the connection's vault secret.
    let anySecret = false;
    for (const [key, value] of Object.entries(split.secrets)) {
      putSecret(secretName, key, value);
      anySecret = true;
    }
    // A stable primary ref so the record has a secretRef even when a platform (Glue)
    // needs no secret material at all (IRSA) — points at the connection's secret name.
    const secretRef = { name: secretName, key: providerFor(wh.platform).secretMaterial.secretKeys[0] ?? 'warehouse-secret' };
    const warehouse: WarehouseConnectionConfig = { platform: wh.platform, catalog: wh.catalog, config: split.config };
    const tools = tpl.tools.map((tool) => ({ ...tool, limits: tool.limits ? { ...tool.limits } : undefined }));
    const tW = now();
    const cW: Connection = {
      id: connId,
      name,
      type: tpl.type,
      connector: tpl.connector,
      auth: tpl.auth,
      template: tpl.key,
      endpoint: `catalog:${wh.catalog}`,
      principal,
      owner: user.id,
      domain,
      visibility: 'Personal',
      mode: 'untested',
      secretRef,
      secretSet: anySecret,
      secretFingerprint: anySecret ? secretFingerprint(secretRef) : '',
      // Federation reaches an external metastore/object store — a real egress, but it
      // is the Trino POD that egresses (GitOps-configured), not this app. Mark it
      // non-external here so the app never claims to proxy the warehouse itself.
      egress: { external: false, host: wh.catalog, allowed: true },
      tools,
      grants: [],
      health: 'untested',
      dataUsage: null,
      warehouse,
      createdAt: tW,
      updatedAt: tW,
    };
    map.set(cW.id, cW);
    compileProfile(cW);
    writeThrough(cW);
    void trace({
      principal,
      tool: 'generate',
      input: { action: 'create_connection', name, type: tpl.type, warehouse: { platform: wh.platform, catalog: wh.catalog }, secretRef },
      output: { connectionId: cW.id, exposed: exposedConnectionTools(principal), secretKeys: Object.keys(split.secrets) },
      decision: 'allow',
    });
    return cW;
  }

  // Egress guardrail: an endpoint must be on the allowlist (Admin guardrail; or an
  // Admin-approved request) — checked BEFORE any credential use. Deny-by-default now
  // also covers INTERNAL / in-cluster / loopback targets (SSRF hardening): a
  // user-supplied `http://query-tool:8080` (or trino/opa/minio/kubernetes.default.svc)
  // is refused unless an operator explicitly allowlisted that host.
  const egress = isEgressAllowed(endpoint);
  if (!egress.allowed) {
    // Never echo a non-hostname-shaped value back: a credential pasted into the
    // endpoint field would otherwise leak into the UI and traces. Real hostnames
    // contain a dot; anything else is redacted with a targeted hint.
    const shown = egress.host.includes('.')
      ? egress.host
      : `${egress.host.slice(0, 4)}… (redacted — this doesn't look like a URL; did you paste a credential into the endpoint field?)`;
    throw withStatus(
      new Error(`Endpoint host "${shown}" is not on the egress allowlist — request access and an Administrator must approve it first`),
      403,
    );
  }

  // 1. AUTH (adapter): per-user OAuth mints a token (mock offline / live exchange);
  //    service creds use the value the Builder supplied. THE ONE RULE: the secret
  //    is written to Secrets Manager and the record keeps ONLY a ref.
  let secretValue = String(input.credential ?? '');
  if (tpl.auth === 'oauth') {
    const authRes = await adapter.auth({ template: tpl, endpoint, credentialPresent: false, authCode: 'mock-consent-grant' });
    if (!authRes.ok || !authRes.data?.secretValue) throw withStatus(new Error('OAuth did not complete'), 502);
    secretValue = authRes.data.secretValue;
  }
  const secretName = `connection-${slug}`;
  const secretRef = putSecret(secretName, tpl.secretKey, secretValue);
  const secretSet = Boolean(secretValue);

  // 2. TOOL-GENERATION (adapter): OpenAPI/MCP schema → governed tools, or the safe
  //    static preset. Live when a schema client is injected; offline preset in kind.
  const gen = await adapter.generateTools({ template: tpl, endpoint, credentialPresent: secretSet, openApiSpec: input.openApiSpec });
  const tools = (gen.ok && gen.data ? gen.data : tpl.tools).map((tool) => ({ ...tool, limits: tool.limits ? { ...tool.limits } : undefined }));

  const t = now();
  const c: Connection = {
    id: connId,
    name,
    type: tpl.type,
    connector: tpl.connector,
    auth: tpl.auth,
    template: tpl.key,
    endpoint,
    principal,
    owner: user.id,
    domain,
    visibility: 'Personal', // default Personal — owner only
    mode: 'untested',
    secretRef,
    secretSet,
    secretFingerprint: secretSet ? secretFingerprint(secretRef) : '',
    egress,
    tools,
    grants: [],
    health: 'untested',
    dataUsage: null,
    // For an om-catalog connection, stamp the optional default OM Service (non-secret).
    ...(tpl.key === 'om-catalog' ? { om: { service: (input.omService ?? '').trim() || undefined } } : {}),
    // For an airflow connection, stamp the non-secret REST config (auth type, Basic
    // username, optional trigger allowlist). The password/token stays in the vault.
    ...(tpl.key === 'airflow'
      ? {
          airflow: {
            authType: input.airflow?.authType ?? 'bearer',
            username: (input.airflow?.username ?? '').trim() || undefined,
            dagAllowlist: (input.airflow?.dagAllowlist ?? []).map((d) => d.trim()).filter(Boolean),
          } satisfies AirflowConnectionConfig,
        }
      : {}),
    // For an atlassian connection, stamp the non-secret auth config (Basic API-token
    // + account email, or OAuth bearer). The token stays in the vault.
    ...(tpl.key === 'atlassian'
      ? {
          atlassian: {
            authKind: input.atlassian?.authKind ?? 'basic',
            email: (input.atlassian?.email ?? '').trim() || undefined,
          } satisfies AtlassianConnectionConfig,
        }
      : {}),
    // For an OData connection (sap-odata / odata-v4), stamp the non-secret auth config
    // (Basic vs OAuth-CC + the OAuth-CC token URL). The credential stays in the vault.
    ...(tpl.key === 'sap-odata' || tpl.key === 'odata-v4'
      ? {
          odata: {
            authType: (input.odata?.authType ?? 'basic') as ODataAuthType,
            tokenUrl: (input.odata?.tokenUrl ?? '').trim() || undefined,
          } satisfies ODataConnectionConfig,
        }
      : {}),
    // For a Workday RaaS connection, stamp the admin-registered report catalog (each
    // report is an entity — no cheap global describe). The ISU credential stays vaulted.
    ...(tpl.key === 'workday-raas'
      ? {
          workday: {
            reports: sanitizeWorkdayReports(input.workday?.reports),
          } satisfies WorkdayConnectionConfig,
        }
      : {}),
    createdAt: t,
    updatedAt: t,
  };

  map.set(c.id, c);
  compileProfile(c); // 3. CAPABILITY → OPA: compile the profile into the bundle/mirror
  writeThrough(c);

  // Audit creation through the SAME Langfuse spine — note: NO secret in the trace.
  void trace({
    principal,
    tool: 'generate',
    input: { action: 'create_connection', name, type: tpl.type, auth: tpl.auth, endpoint, secretRef },
    output: { connectionId: c.id, exposed: exposedConnectionTools(principal), egress, toolsFrom: gen.mode },
    decision: 'allow',
  });

  return c;
}

// ----------------------------------------------------------- Capability editor --

/**
 * Update the per-tool capability profile (Builder/Admin). Enabling a Blocked tool
 * requires an Admin override. Re-compiles the profile into the OPA mirror.
 */
export async function updateCapabilities(
  connId: string,
  user: CurrentUser,
  updates: { name: string; mode?: CapabilityMode; limits?: CapabilityLimits }[],
): Promise<Connection> {
  const map = await getCache();
  const c = map.get(connId);
  if (!c) throw withStatus(new Error('Connection not found'), 404);
  // Fail-closed edit-scope: owner, domain_admin of the owning domain, or admin.
  if (!canManageArtifact(user, manageArg(c))) {
    throw withStatus(new Error('Not permitted to edit this connection'), 403);
  }
  if (!roleAtLeast(user.role, 'builder')) {
    throw withStatus(new Error('Editing capabilities requires a Builder or Administrator'), 403);
  }

  // Snapshot the PRIOR capability profile before overwriting it, so the edit is restorable.
  versions.record(c.id, user.id, snapshotState(c), 'edit capabilities');

  for (const u of updates) {
    const tool = c.tools.find((t) => t.name === u.name);
    if (!tool) continue;
    if (u.mode !== undefined) {
      // Enabling a Blocked tool is an Admin-only override.
      if (tool.mode === 'Blocked' && u.mode !== 'Blocked' && user.role !== 'admin') {
        throw withStatus(new Error(`Enabling the Blocked tool "${tool.name}" requires an Administrator override`), 403);
      }
      tool.mode = u.mode;
    }
    if (u.limits !== undefined) {
      tool.limits = { ...(tool.limits ?? {}), ...u.limits };
    }
  }

  c.updatedAt = now();
  map.set(c.id, c);
  compileProfile(c);
  writeThrough(c);
  void trace({
    principal: c.principal,
    tool: 'generate',
    input: { action: 'update_capabilities', by: user.id, updates },
    output: { exposed: exposedConnectionTools(c.principal) },
    decision: 'allow',
  });
  return c;
}

// ---------------------------------------------------------------------- Test ---

/**
 * Per-template health probe registry — mirrors `CONNECTION_EXECUTORS`. Each entry
 * is a function that performs the real round-trip for its template and returns an
 * honest `{ ok, mode, detail }`. Adding a new connector requires only one new entry
 * here (and in `CONNECTION_EXECUTORS`) — `testConnection` never needs editing.
 *
 * VERBATIM logic per template: same health client, same secret handling via
 * `getSecretServerSide` (inside each connector's `*ConnFrom` helper), same
 * never-fake-green semantics. The `c` reference is mutated in-place (mode/health/
 * updatedAt) and flushed by the caller.
 */
type HealthFn = (c: Connection) => Promise<{ ok: boolean; mode: 'live' | 'offline'; detail: string }>;

// AIRFLOW: the honest test is a real, unauthenticated health probe against the
// Airflow REST API (v2 /api/v2/monitor/health, falling back to v1 /api/v1/health).
// ANY HTTP response ⇒ Airflow is reachable (live); a network error/timeout ⇒
// offline. Never a stub — and the credential is never sent on the health probe.
//
// GITHUB: real GET /user with the vaulted PAT. A 2xx proves the token is live;
// a 401 is an honest ✗ (never a fake green). Token stays server-side only.
//
// SUPABASE: real GET /v1/projects with the vaulted management PAT (sbp_…).
// A 2xx proves the token is live; a 401 is an honest ✗. Token stays server-side.
//
// ATLASSIAN: real GET of the current user (Jira `/rest/api/3/myself`) with the
// vaulted token. A 2xx proves auth; a 401 is an honest ✗. Token stays server-side.
//
// SLACK: real GET auth.test with the vaulted bot token. ok:true proves auth; an
// invalid_auth body is an honest ✗. Never a stub; the token stays server-side.
//
// GMAIL: real GET users/me/profile with the vaulted OAuth access token. A 2xx
// proves the token is live; a 401 is an honest ✗. Token stays server-side.
//
// GOOGLE CALENDAR: real GET users/me/calendarList with the vaulted OAuth token.
//
// OUTLOOK: real GET /me over Microsoft Graph with the vaulted OAuth token.
//
// TEAMS: real GET /me over Microsoft Graph with the vaulted OAuth token.
//
// ENTRA: real GET /me over Microsoft Graph with the vaulted OAuth token.
//
// PURVIEW: real GET of the classification typedefs over the account's Atlas URL.
//
// AI FOUNDRY: real GET of the model registry over the workspace/region base.
//
// SAGEMAKER: real signed ListModels round-trip (SigV4) with the vaulted AWS keys.
//
// GCP IDENTITY: real JWT-bearer token exchange + a projects list (pageSize 1) with
// the vaulted service-account JSON key. 2xx ⇒ live; a rejected key is an honest ✗.
//
// SNOWFLAKE GOVERNANCE: real key-pair-JWT `SELECT CURRENT_ACCOUNT()` over the SQL
// REST API with the vaulted RSA key. 2xx ⇒ live; a rejected key is an honest ✗.
const CONNECTION_HEALTH: Partial<Record<ConnectionTemplateKey, HealthFn>> = {
  airflow: async (c) => {
    const h = await airflowHealth(airflowConnFor(c));
    c.mode = h.connected ? 'live' : 'offline';
    c.health = h.connected ? 'healthy' : 'needs-reconnect';
    return h.connected
      ? { ok: true, mode: 'live', detail: `Airflow at ${c.egress.host} is reachable${h.detail ? ` (${h.detail})` : ''}. The token is never sent on the health probe.` }
      : { ok: false, mode: 'offline', detail: `Airflow at ${c.egress.host} is unreachable (${h.reason ?? 'network error'}) — check the base URL + egress, then re-test.` };
  },
  // SALESFORCE: real client-credentials token grant + `SELECT Id FROM Organization
  // LIMIT 1` over the REST API. A rejected credential is an honest x — never a fake
  // green. The consumer secret never leaves the server (lib/connections/salesforce.ts).
  'salesforce-api': async (c) => {
    const { salesforceHealth } = await import('./salesforce.ts');
    const h = await salesforceHealth(c);
    c.mode = h.ok ? 'live' : 'offline';
    c.health = h.ok ? 'healthy' : 'needs-reconnect';
    return h.ok
      ? { ok: true, mode: 'live', detail: `Salesforce is reachable (${h.detail}) The credential never leaves the server.` }
      : { ok: false, mode: 'offline', detail: `Salesforce is unreachable or refused the credential (${h.detail}) — check the Connected App + egress, then re-test.` };
  },
  // KAJABI: real client-credentials token grant + `GET /v1/sites?page[size]=1` over
  // the public API. A rejected credential is an honest x — never a fake green. The
  // client secret never leaves the server (lib/connections/kajabi.ts).
  'kajabi-api': async (c) => {
    const { kajabiHealth } = await import('./kajabi.ts');
    const h = await kajabiHealth(c);
    c.mode = h.ok ? 'live' : 'offline';
    c.health = h.ok ? 'healthy' : 'needs-reconnect';
    return h.ok
      ? { ok: true, mode: 'live', detail: `Kajabi is reachable (${h.detail}) The credential never leaves the server.` }
      : { ok: false, mode: 'offline', detail: `Kajabi is unreachable or refused the credential (${h.detail}) — check the Public API key + egress, then re-test.` };
  },
  // SAP S/4HANA Cloud + generic OData V4: a real `$metadata` round-trip parsed to EDMX.
  // A refused credential / unreachable service is an honest x. The credential never
  // leaves the server (lib/connections/odata/client.ts).
  'sap-odata': async (c) => {
    const { odataHealth } = await import('./odata/client.ts');
    const h = await odataHealth(c);
    c.mode = h.ok ? 'live' : 'offline';
    c.health = h.ok ? 'healthy' : 'needs-reconnect';
    return h.ok
      ? { ok: true, mode: 'live', detail: `SAP OData is reachable (${h.detail}) The credential never leaves the server.` }
      : { ok: false, mode: 'offline', detail: `SAP OData is unreachable or refused the credential (${h.detail}) — cloud-reachable services only (on-prem behind SAP Cloud Connector is not supported in v1). Check the service root + egress, then re-test.` };
  },
  'odata-v4': async (c) => {
    const { odataHealth } = await import('./odata/client.ts');
    const h = await odataHealth(c);
    c.mode = h.ok ? 'live' : 'offline';
    c.health = h.ok ? 'healthy' : 'needs-reconnect';
    return h.ok
      ? { ok: true, mode: 'live', detail: `OData service is reachable (${h.detail}) The credential never leaves the server.` }
      : { ok: false, mode: 'offline', detail: `OData service is unreachable or refused the credential (${h.detail}) — check the service root + egress, then re-test.` };
  },
  // Workday RaaS: a real sample fetch of the FIRST configured report (or honest "no
  // reports configured"). The ISU credential never leaves the server (workday-raas.ts).
  'workday-raas': async (c) => {
    const { workdayHealth } = await import('./workday-raas.ts');
    const h = await workdayHealth(c);
    c.mode = h.ok ? 'live' : 'offline';
    c.health = h.ok ? 'healthy' : 'needs-reconnect';
    return h.ok
      ? { ok: true, mode: 'live', detail: `Workday RaaS is reachable (${h.detail}) The ISU credential never leaves the server.` }
      : { ok: false, mode: 'offline', detail: `Workday RaaS is unreachable or refused the credential (${h.detail}) — check the RaaS base URL, report URLs, ISU + egress, then re-test.` };
  },
  github: async (c) => {
    const h = await githubHealth(githubConnFrom(c));
    c.mode = h.connected ? 'live' : 'offline';
    c.health = h.connected ? 'healthy' : 'needs-reconnect';
    return h.connected
      ? { ok: true, mode: 'live', detail: `GitHub is reachable${h.detail ? ` (${h.detail})` : ''}. The token never leaves the server.` }
      : { ok: false, mode: 'offline', detail: `GitHub is unreachable (${h.reason ?? 'network error'}) — check the token + egress, then re-test.` };
  },
  supabase: async (c) => {
    const h = await supabaseHealth(supabaseConnFrom(c));
    c.mode = h.connected ? 'live' : 'offline';
    c.health = h.connected ? 'healthy' : 'needs-reconnect';
    return h.connected
      ? { ok: true, mode: 'live', detail: `Supabase Management API is reachable${h.detail ? ` (${h.detail})` : ''}. The token never leaves the server.` }
      : { ok: false, mode: 'offline', detail: `Supabase is unreachable (${h.reason ?? 'network error'}) — check the access token + egress, then re-test.` };
  },
  atlassian: async (c) => {
    const h = await atlassianHealth(atlassianConnFrom(c));
    c.mode = h.connected ? 'live' : 'offline';
    c.health = h.connected ? 'healthy' : 'needs-reconnect';
    return h.connected
      ? { ok: true, mode: 'live', detail: `Atlassian at ${c.egress.host} is reachable${h.detail ? ` (${h.detail})` : ''}. The token never leaves the server.` }
      : { ok: false, mode: 'offline', detail: `Atlassian at ${c.egress.host} is unreachable (${h.reason ?? 'network error'}) — check the site URL, token + egress, then re-test.` };
  },
  slack: async (c) => {
    const h = await slackHealth(slackConnFrom(c));
    c.mode = h.connected ? 'live' : 'offline';
    c.health = h.connected ? 'healthy' : 'needs-reconnect';
    return h.connected
      ? { ok: true, mode: 'live', detail: `Slack is reachable${h.detail ? ` (${h.detail})` : ''}. The bot token never leaves the server.` }
      : { ok: false, mode: 'offline', detail: `Slack is unreachable (${h.reason ?? 'network error'}) — check the bot token + egress, then re-test.` };
  },
  gmail: async (c) => {
    const h = await gmailHealth(googleMailConnFrom(c));
    c.mode = h.connected ? 'live' : 'offline';
    c.health = h.connected ? 'healthy' : 'needs-reconnect';
    return h.connected
      ? { ok: true, mode: 'live', detail: `Gmail is reachable${h.detail ? ` (${h.detail})` : ''}. The token never leaves the server.` }
      : { ok: false, mode: 'offline', detail: `Gmail is unreachable (${h.reason ?? 'network error'}) — the access token may be expired; refresh it + check egress, then re-test.` };
  },
  gcal: async (c) => {
    const h = await gcalHealth(gcalConnFrom(c));
    c.mode = h.connected ? 'live' : 'offline';
    c.health = h.connected ? 'healthy' : 'needs-reconnect';
    return h.connected
      ? { ok: true, mode: 'live', detail: `Google Calendar is reachable${h.detail ? ` (${h.detail})` : ''}. The token never leaves the server.` }
      : { ok: false, mode: 'offline', detail: `Google Calendar is unreachable (${h.reason ?? 'network error'}) — the access token may be expired; refresh it + check egress, then re-test.` };
  },
  outlook: async (c) => {
    const h = await outlookHealth(graphConnFrom(c));
    c.mode = h.connected ? 'live' : 'offline';
    c.health = h.connected ? 'healthy' : 'needs-reconnect';
    return h.connected
      ? { ok: true, mode: 'live', detail: `Outlook (Microsoft Graph) is reachable${h.detail ? ` (${h.detail})` : ''}. The token never leaves the server.` }
      : { ok: false, mode: 'offline', detail: `Outlook is unreachable (${h.reason ?? 'network error'}) — the access token may be expired; refresh it + check egress, then re-test.` };
  },
  teams: async (c) => {
    const h = await teamsHealth(teamsConnFrom(c));
    c.mode = h.connected ? 'live' : 'offline';
    c.health = h.connected ? 'healthy' : 'needs-reconnect';
    return h.connected
      ? { ok: true, mode: 'live', detail: `Microsoft Teams (Graph) is reachable${h.detail ? ` (${h.detail})` : ''}. The token never leaves the server.` }
      : { ok: false, mode: 'offline', detail: `Teams is unreachable (${h.reason ?? 'network error'}) — the access token may be expired; refresh it + check egress, then re-test.` };
  },
  entra: async (c) => {
    const h = await entraHealth(entraConnFrom(c));
    c.mode = h.connected ? 'live' : 'offline';
    c.health = h.connected ? 'healthy' : 'needs-reconnect';
    return h.connected
      ? { ok: true, mode: 'live', detail: `Microsoft Entra (Graph) is reachable${h.detail ? ` (${h.detail})` : ''}. The token never leaves the server.` }
      : { ok: false, mode: 'offline', detail: `Entra is unreachable (${h.reason ?? 'network error'}) — the access token may be expired; refresh it + check egress, then re-test.` };
  },
  purview: async (c) => {
    const h = await purviewHealth(purviewConnFrom(c));
    c.mode = h.connected ? 'live' : 'offline';
    c.health = h.connected ? 'healthy' : 'needs-reconnect';
    return h.connected
      ? { ok: true, mode: 'live', detail: `Microsoft Purview is reachable${h.detail ? ` (${h.detail})` : ''}. The token never leaves the server.` }
      : { ok: false, mode: 'offline', detail: `Purview is unreachable (${h.reason ?? 'network error'}) — check the account URL + token, then re-test.` };
  },
  'ai-foundry': async (c) => {
    const h = await aiFoundryHealth(aiFoundryConnFrom(c));
    c.mode = h.connected ? 'live' : 'offline';
    c.health = h.connected ? 'healthy' : 'needs-reconnect';
    return h.connected
      ? { ok: true, mode: 'live', detail: `Azure AI Foundry is reachable${h.detail ? ` (${h.detail})` : ''}. The token never leaves the server.` }
      : { ok: false, mode: 'offline', detail: `Azure AI Foundry is unreachable (${h.reason ?? 'network error'}) — check the workspace endpoint + token, then re-test.` };
  },
  sagemaker: async (c) => {
    const h = await sagemakerHealth(sagemakerConnFrom(c));
    c.mode = h.connected ? 'live' : 'offline';
    c.health = h.connected ? 'healthy' : 'needs-reconnect';
    return h.connected
      ? { ok: true, mode: 'live', detail: `AWS SageMaker is reachable${h.detail ? ` (${h.detail})` : ''}. The AWS keys never leave the server.` }
      : { ok: false, mode: 'offline', detail: `SageMaker is unreachable (${h.reason ?? 'network error'}) — check the region endpoint + IAM keys, then re-test.` };
  },
  'gcp-identity': async (c) => {
    const h = await gcpIdentityHealth(gcpIdentityConnFrom(c));
    c.mode = h.connected ? 'live' : 'offline';
    c.health = h.connected ? 'healthy' : 'needs-reconnect';
    return h.connected
      ? { ok: true, mode: 'live', detail: `Google Cloud (Resource Manager + IAM) is reachable${h.detail ? ` (${h.detail})` : ''}. The service-account key never leaves the server.` }
      : { ok: false, mode: 'offline', detail: `Google Cloud is unreachable (${h.reason ?? 'network error'}) — check the service-account key + egress, then re-test.` };
  },
  'gcp-directory': async (c) => {
    const h = await gcpDirectoryHealth(gcpDirectoryConnFrom(c));
    c.mode = h.connected ? 'live' : 'offline';
    c.health = h.connected ? 'healthy' : 'needs-reconnect';
    return h.connected
      ? { ok: true, mode: 'live', detail: `Google Workspace directory (Admin SDK) is reachable${h.detail ? ` (${h.detail})` : ''}. The service-account key never leaves the server.` }
      : { ok: false, mode: 'offline', detail: `Google Workspace directory is unreachable (${h.reason ?? 'network error'}) — check the service-account key, the domain-wide-delegation authorization + admin subject, then re-test.` };
  },
  'snowflake-governance': async (c) => {
    const h = await snowflakeGovHealth(snowflakeGovConnFrom(c));
    c.mode = h.connected ? 'live' : 'offline';
    c.health = h.connected ? 'healthy' : 'needs-reconnect';
    return h.connected
      ? { ok: true, mode: 'live', detail: `Snowflake ACCOUNT_USAGE is reachable${h.detail ? ` (${h.detail})` : ''}. The RSA private key never leaves the server. Note: ACCOUNT_USAGE has ~2h latency and queries consume credits.` }
      : { ok: false, mode: 'offline', detail: `Snowflake is unreachable (${h.reason ?? 'network error'}) — check the account/user + registered public key, then re-test.` };
  },
};

/**
 * Test the connection inline. Retrieves the secret SERVER-SIDE (never returned to
 * the client) and probes the endpoint best-effort; offline returns a deterministic
 * ok so the flow works with no live endpoint. Never echoes the secret.
 */
export async function testConnection(
  connId: string,
  user: CurrentUser,
  opts: { probe?: (provider: OAuthProvider, token: string) => Promise<{ ok: boolean; status: number }> } = {},
): Promise<{ ok: boolean; mode: 'live' | 'offline'; detail: string }> {
  const map = await getCache();
  const c = map.get(connId);
  if (!c || !visibleToUser(c, user)) throw withStatus(new Error('Connection not found'), 404);

  // DRIVE (personal OAuth): the honest test is a real, read-only call to the
  // provider (Google Drive `about.get` / Graph `/me/drive`) with the stored token.
  // Success ⇒ genuinely connected; a needs-reconnect/none resolution or a non-2xx
  // response is reported honestly — never a fake "ok". Governance: owner-only.
  const driveProvider = c.type === 'Drive' && c.auth === 'oauth' ? providerForTemplate(c.template) : null;
  if (driveProvider) {
    if (c.owner !== user.id) throw withStatus(new Error('Only the connection owner can test this connection'), 403);
    const probe = opts.probe ?? probeDrive;
    const token = await resolveConnectionAccessToken(c.id, user.id); // silent refresh; owner-gated
    if (!token) {
      const reason =
        c.health === 'needs-reconnect'
          ? 'the stored token expired and could not be refreshed — click Reconnect'
          : 'no account is connected yet — click Connect to authorize';
      c.mode = 'offline';
      c.updatedAt = now();
      writeThrough(c);
      return { ok: false, mode: 'offline', detail: `${providerConfig(driveProvider).label}: ${reason}.` };
    }
    const res = await probe(driveProvider, token);
    c.mode = res.ok ? 'live' : 'offline';
    c.health = res.ok ? 'healthy' : 'needs-reconnect';
    c.updatedAt = now();
    writeThrough(c);
    return res.ok
      ? { ok: true, mode: 'live', detail: `${providerConfig(driveProvider).label}: live call succeeded — the connected account's drive is reachable. The token is never sent to the browser.` }
      : { ok: false, mode: 'offline', detail: `${providerConfig(driveProvider).label}: the live API rejected the stored token (HTTP ${res.status || 'unreachable'}) — click Reconnect.` };
  }

  // WAREHOUSE: the honest test is the provider's probe. When the probe is `sql` the
  // live check is running `SHOW SCHEMAS FROM <catalog>` through the governed query
  // path — but that only works once an operator has registered the catalog in Trino
  // (a GitOps step). Until then, and for `none`-probe platforms, we honestly report
  // "credential present; the live probe is the operator's step", never a fake ok.
  if (c.template === 'warehouse' && c.warehouse) {
    const provider = providerFor(c.warehouse.platform);
    const source = toWarehouseSource({ platform: c.warehouse.platform, catalog: c.warehouse.catalog, config: c.warehouse.config });
    if (provider.testProbe.kind === 'none') {
      // No safe live probe exists for this platform — so the connection is NOT verified.
      // M7: report ok:false + untested (config-valid is not connectivity-verified); never
      // a fake ok on a check we didn't actually run.
      c.mode = 'untested';
      c.health = 'untested';
      c.updatedAt = now();
      writeThrough(c);
      return { ok: false, mode: 'offline', detail: `Config valid for ${provider.label}, but NOT verified — no safe live probe exists (${provider.testProbe.reason}). Reachability is the operator's step on a live tenant.` };
    }
    const query = provider.testProbe.query(source);
    try {
      const res = await queryRun(query, c.domain, c.domain);
      c.mode = 'live';
      c.health = 'healthy';
      c.updatedAt = now();
      writeThrough(c);
      return { ok: true, mode: 'live', detail: `Ran \`${query}\` through the governed query path — ${res.rowCount} schema(s) visible in catalog '${c.warehouse.catalog}'.` };
    } catch (e) {
      // The catalog is not registered/queryable yet — the live probe FAILED, so this is
      // NOT ok. M7: pending-registration is an untested state, not a success.
      c.mode = 'untested';
      c.health = 'untested';
      c.updatedAt = now();
      writeThrough(c);
      return { ok: false, mode: 'offline', detail: `Config valid, but catalog '${c.warehouse.catalog}' is NOT queryable yet (${(e as Error).message}). Register it in Trino (values.trino.externalCatalogs) + rolling-restart, then re-test.` };
    }
  }

  // Registered connectors: look up the per-template health probe in CONNECTION_HEALTH.
  // Each entry performs a real round-trip and mutates c.mode/c.health in-place.
  // Unknown templates fall through to the generic credential-presence check below.
  const healthFn = CONNECTION_HEALTH[c.template];
  if (healthFn) {
    c.updatedAt = now();
    const result = await healthFn(c);
    writeThrough(c);
    return result;
  }

  const secret = getSecretServerSide(c.secretRef); // server-side only
  if (!secret) {
    return { ok: false, mode: 'offline', detail: 'No credential set in Secrets Manager for this connection.' };
  }

  // Best-effort reachability probe (never sends/echoes the secret in our response). NOTE:
  // this is an UNAUTHENTICATED HEAD — it says the host answered, NOT that the credential
  // is valid. So it can never justify a "healthy"/ok result on its own (M7).
  let reachable = false;
  if (c.egress.external && c.egress.allowed) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    try {
      await fetch(c.endpoint, { method: 'HEAD', signal: ctrl.signal, cache: 'no-store' });
      reachable = true;
    } catch {
      reachable = false;
    } finally {
      clearTimeout(timer);
    }
  }

  // M7 HONESTY: there is NO authenticated round-trip for this generic template, so we
  // CANNOT claim the connection is healthy. Leave it untested (never write 'healthy' on
  // an unverified check), and return ok:false. An unauthenticated HEAD only tells us the
  // host answered — reported as a hint, not as success.
  c.mode = 'untested';
  c.health = 'untested';
  c.updatedAt = now();
  map.set(c.id, c);
  writeThrough(c);
  return {
    ok: false,
    mode: 'offline',
    detail: reachable
      ? `Host ${c.egress.host} answered an unauthenticated probe and a credential is present (${c.secretFingerprint}), but this connector has no authenticated round-trip to verify it — status is UNTESTED, not verified.`
      : `Credential present in Secrets Manager (${c.secretFingerprint}); this connector has no authenticated round-trip to verify it — status is UNTESTED. The secret is never sent to the browser.`,
  };
}

// ---------------------------------------------------------------- Warehouse ---

/** The identity threaded to the governed WRITE path (mirrors the data store's shape). */
function executeIdentity(user: CurrentUser): ExecuteIdentity {
  return { principal: user.domains[0] ?? user.id, uid: user.id, domains: user.domains, role: user.role };
}

/**
 * The GitOps registration snippet for a warehouse connection: the Trino catalog
 * props + the exact `values.trino.externalCatalogs` entry an operator pastes, plus
 * the secret env vars + OM hint. Registration is a values edit + rolling restart
 * (the pod's catalog dir is a read-only ConfigMap) — this returns what to apply, it
 * never mutates the cluster. Visible to anyone who can see the connection.
 */
export async function warehouseRegistration(connId: string, user: CurrentUser): Promise<CatalogRegistration> {
  const map = await getCache();
  const c = map.get(connId);
  if (!c || !visibleToUser(c, user)) throw withStatus(new Error('Connection not found'), 404);
  if (c.template !== 'warehouse' || !c.warehouse) throw withStatus(new Error('Not a warehouse connection'), 400);
  const source = toWarehouseSource({ platform: c.warehouse.platform, catalog: c.warehouse.catalog, config: c.warehouse.config });
  return catalogRegistration(source);
}

// -------------------------------------------------------- Warehouse discovery ---

/** One discovered schema/table pair, shaped so the UI can render a browse tree. */
export type DiscoveryResult = {
  ok: boolean;
  mode: 'live' | 'offline';
  catalog: string;
  /** Schemas visible in the catalog (from SHOW SCHEMAS). */
  schemas: string[];
  /** Tables in the requested schema (from SHOW TABLES FROM <catalog>.<schema>). */
  tables: string[];
  /** The schema the tables belong to, when one was requested. */
  schema: string | null;
  detail: string;
};

/**
 * DISCOVER a warehouse's schemas (and, given a schema, its tables) through the SAME
 * governed query path `testConnection` probes with — running the provider's pure
 * `SHOW SCHEMAS` / `SHOW TABLES` queries AS the caller's domain so Trino→OPA governs
 * the reads. Requires the catalog to be registered + queryable in Trino; until then
 * (and for a `none`-probe platform like Fabric that exposes no metastore) it honestly
 * reports offline rather than inventing a listing. Visible to anyone who can see the
 * connection (read-only).
 */
export async function discoverWarehouse(
  connId: string,
  user: CurrentUser,
  opts: { schema?: string } = {},
): Promise<DiscoveryResult> {
  const map = await getCache();
  const c = map.get(connId);
  if (!c || !visibleToUser(c, user)) throw withStatus(new Error('Connection not found'), 404);
  if (c.template !== 'warehouse' || !c.warehouse) throw withStatus(new Error('Not a warehouse connection'), 400);
  const provider = providerFor(c.warehouse.platform);
  const source = toWarehouseSource({ platform: c.warehouse.platform, catalog: c.warehouse.catalog, config: c.warehouse.config });
  const catalog = c.warehouse.catalog;

  // Honest: a platform whose metastore exposes no table listing (Fabric/OneLake) has
  // no `discoverTables`. We say so instead of pretending to enumerate.
  if (!provider.discoverTables) {
    return {
      ok: false,
      mode: 'offline',
      catalog,
      schemas: [],
      tables: [],
      schema: null,
      detail: `${provider.label} is not discoverable — OneLake exposes no metastore; provide explicit table locations when importing.`,
    };
  }

  const schema = (opts.schema ?? '').trim();
  // The SHOW SCHEMAS probe reuses the provider's testProbe (sql); guarded above.
  const schemasQuery = provider.testProbe.kind === 'sql' ? provider.testProbe.query(source) : `SHOW SCHEMAS FROM ${catalog}`;
  try {
    const schemasRes = await queryRun(schemasQuery, c.domain, c.domain);
    const schemas = schemasRes.rows.map((r) => String(r[0])).filter(Boolean);
    let tables: string[] = [];
    if (schema) {
      // `discoverTables` validates the schema identifier (throws on bad input).
      const tablesQuery = provider.discoverTables(source, schema);
      const tablesRes = await queryRun(tablesQuery, c.domain, c.domain);
      tables = tablesRes.rows.map((r) => String(r[0])).filter(Boolean);
    }
    void trace({
      principal: c.principal,
      tool: 'generate',
      input: { action: 'discover_warehouse', by: user.id, catalog, schema: schema || null },
      output: { schemas: schemas.length, tables: tables.length },
      decision: 'allow',
    });
    return {
      ok: true,
      mode: 'live',
      catalog,
      schemas,
      tables,
      schema: schema || null,
      detail: schema
        ? `Discovered ${schemas.length} schema(s); ${tables.length} table(s) in '${schema}'.`
        : `Discovered ${schemas.length} schema(s) in catalog '${catalog}'.`,
    };
  } catch (e) {
    return {
      ok: false,
      mode: 'offline',
      catalog,
      schemas: [],
      tables: [],
      schema: schema || null,
      detail: `Catalog '${catalog}' is not queryable yet (${(e as Error).message}). Register it (one-click Register, or values.trino.externalCatalogs + rolling restart), then retry.`,
    };
  }
}

// ------------------------------------------------------- Warehouse registration ---

export type RegisterWarehouseResult = RegisterK8sOutcome;

/**
 * ONE-CLICK REGISTER a warehouse connection as a LIVE Trino catalog — no values edit,
 * no manual helm. Renders the connection's `catalogRegistration()` (the exact props +
 * secret env plumbing), reads the connection's vaulted secret VALUES server-side (never
 * returned), and applies them to the cluster via {@link applyLiveRegistration}: merge the
 * `<catalog>.properties` into the live `trino-catalog` ConfigMap, materialize a
 * `trino-ext-<catalog>` Secret + patch the Trino env for the provider's env vars (keyless
 * platforms emit NO secret), and roll the Trino Deployment. Governed: Builder/Admin with
 * edit rights on the connection; audit-logged; honest failure surfaced. `k8s` is
 * injectable for tests.
 */
export async function registerWarehouseCatalog(
  connId: string,
  user: CurrentUser,
  opts: { k8s?: RegK8s } = {},
): Promise<RegisterWarehouseResult> {
  const map = await getCache();
  const c = map.get(connId);
  if (!c || !visibleToUser(c, user)) throw withStatus(new Error('Connection not found'), 404);
  if (c.template !== 'warehouse' || !c.warehouse) throw withStatus(new Error('Not a warehouse connection'), 400);
  // Governed: registering a live catalog writes cluster state — edit rights + Builder+.
  if (!canManageArtifact(user, manageArg(c))) {
    throw withStatus(new Error('Not permitted to register this connection'), 403);
  }
  if (!roleAtLeast(user.role, 'builder')) {
    throw withStatus(new Error('Registering a warehouse catalog requires a Builder or Administrator'), 403);
  }

  const source = toWarehouseSource({ platform: c.warehouse.platform, catalog: c.warehouse.catalog, config: c.warehouse.config });
  const reg = catalogRegistration(source);

  // Materialize the vaulted secret VALUES keyed by ENV-VAR name. The provider pairs
  // secretKeys[i] ↔ envVars[i] (see each provider's secretMaterial). A keyless platform
  // (Glue IRSA / BigQuery WI) has NO env vars → no values, no Secret emitted.
  const provider = providerFor(c.warehouse.platform);
  const { secretKeys, envVars } = provider.secretMaterial;
  const values: SecretValues = {};
  for (let i = 0; i < envVars.length; i++) {
    const key = secretKeys[i];
    // Each secret field is stored under its own key in the connection's vault secret.
    const val = key ? getSecretServerSide({ name: c.secretRef.name, key }) : null;
    if (val) values[envVars[i]] = val;
  }

  const outcome = await applyLiveRegistration(reg, values, { namespace: config.platformNamespace, k8s: opts.k8s });

  // Reflect the outcome on the record so the UI can show "registered" honestly.
  if (outcome.ok) {
    c.updatedAt = now();
    map.set(c.id, c);
    writeThrough(c);
  }
  void trace({
    principal: c.principal,
    tool: 'generate',
    input: { action: 'register_warehouse_catalog', by: user.id, catalog: reg.name, envVars }, // env-var NAMES only, never values
    output: { ok: outcome.ok, live: outcome.live, steps: outcome.steps },
    decision: outcome.ok ? 'allow' : 'deny',
  });
  return outcome;
}

/**
 * IMPORT a federated external table into the OS Iceberg lakehouse as an owned,
 * GOVERNED DATASET (P0 A2 — the import used to run a bare CTAS and create no
 * registry row, so the promised "governed dataset" never existed and the UI's
 * open-it navigation dead-ended). Now the import:
 *   1. registers the Dataset row first (name-unique per domain — an honest 409
 *      beats an orphaned table);
 *   2. lands the copy at that row's CANONICAL personal-lane Bronze target
 *      (`iceberg.personal_<uid>.bronze_<slug>`) via the SAME governed `executeRun`
 *      write path — as `CREATE OR REPLACE TABLE … AS SELECT`, the only CTAS shape
 *      the query-tool write allowlist admits (plain CREATE TABLE is rejected), run
 *      AS the uid (personal-lane owner rule, same as the transform route);
 *   3. lights the Bronze dot ONLY after the CTAS succeeded (executeRun throws on
 *      any rejection/Trino error; a failed landing removes the fresh row again).
 * The dataset then refines Bronze → Silver → Gold and promotes like any other.
 * Returns the target FQN, the SQL run and the new `datasetId` for the UI to open.
 */
export async function importWarehouseTable(
  connId: string,
  user: CurrentUser,
  input: { schema: string; table: string; name?: string; targetDomain?: string },
): Promise<{ ok: true; target: string; sql: string; rowsAffected: number | null; datasetId: string }> {
  const map = await getCache();
  const c = map.get(connId);
  if (!c || !visibleToUser(c, user)) throw withStatus(new Error('Connection not found'), 404);
  if (c.template !== 'warehouse' || !c.warehouse) throw withStatus(new Error('Not a warehouse connection'), 400);
  if (!canManageArtifact(user, manageArg(c))) {
    throw withStatus(new Error('Not permitted to import from this connection'), 403);
  }
  const provider = providerFor(c.warehouse.platform);
  if (!provider.capabilities.import) {
    throw withStatus(new Error(`${provider.label} does not support import-as-product`), 400);
  }
  const targetDomain = input.targetDomain && user.domains.includes(input.targetDomain) ? input.targetDomain : c.domain;
  const name = (input.name ?? input.table).trim();
  // Compile the CTAS BEFORE creating the registry row, so a malformed source is a
  // clean 400 with no cleanup. Target identifiers are slugged (personal_<uid> /
  // bronze_<slug>) so they always satisfy the builder's identifier rule.
  const targetSchema = personalSchema(user.id);
  const targetTable = `bronze_${slug(name)}`;
  let sql: string;
  try {
    sql = buildImportCtas(
      { domain: targetSchema, name: targetTable },
      { catalog: c.warehouse.catalog, schema: input.schema, table: input.table },
    );
  } catch (e) {
    throw withStatus(e as Error, (e as Error & { status?: number }).status ?? 400);
  }
  // The query-tool write allowlist admits only CREATE OR REPLACE / IF NOT EXISTS
  // CTAS shapes; the pure builder emits plain CREATE TABLE, so lift it here (the
  // prefix is fixed — see buildImportCtas). OR REPLACE keeps a re-import honest
  // (fresh rows, never a silent no-op).
  sql = sql.replace(/^CREATE TABLE /, 'CREATE OR REPLACE TABLE ');

  // 1. Registry row first (throws a tagged 409 on a duplicate name in the domain).
  const dataset = createDataset(user, { name, domain: targetDomain });
  const target = `iceberg.${targetSchema}.${targetTable}`;

  // 2. Land the physical copy AS the uid (personal-lane owner rule — Trino→OPA
  //    denies the personal schema under the domain principal).
  const identity = executeIdentity(user);
  identity.principal = user.id;
  let res: { rowsAffected: number | null };
  try {
    res = await executeRun(sql, identity);
  } catch (e) {
    // The landing failed → do not leave a phantom, empty dataset behind.
    try { deleteDataset(dataset.id, user); } catch { /* best-effort cleanup */ }
    throw withStatus(e as Error, (e as Error & { status?: number }).status ?? 502);
  }

  // 3. CTAS succeeded → NOW light the Bronze dot on the registry row (the same
  //    register-after-landing contract as the ingest pipeline).
  buildVersion(dataset.id, user, 'bronze', {
    quality: 'unknown', // raw copy: no dbt tests have run — honestly unknown.
    artifact: stageArtifact(dataset.name, 'bronze'),
  });

  void trace({
    principal: c.principal,
    tool: 'generate',
    input: { action: 'import_warehouse_table', by: user.id, source: `${c.warehouse.catalog}.${input.schema}.${input.table}` },
    output: { target, datasetId: dataset.id, rowsAffected: res.rowsAffected },
    decision: 'allow',
  });
  return { ok: true, target, sql, rowsAffected: res.rowsAffected, datasetId: dataset.id };
}

// ------------------------------------------------------------------- Promote ---

/**
 * Promotion ladder: Personal → Shared (Builder/Admin) → Marketplace (Admin only),
 * audited. Domain-scoped. Mirrors the artifact/app ladder.
 */
export async function promoteConnection(connId: string, user: CurrentUser): Promise<Connection> {
  const map = await getCache();
  const c = map.get(connId);
  if (!c) throw withStatus(new Error('Connection not found'), 404);
  if (!user.domains.includes(c.domain)) {
    throw withStatus(new Error('You can only promote connections in a domain you belong to'), 403);
  }
  let next: Visibility;
  if (c.visibility === 'Personal') {
    if (!canPromote(user.role, 'Personal')) throw withStatus(new Error('Promoting to Shared requires a Domain admin or Administrator'), 403);
    next = 'Shared';
  } else if (c.visibility === 'Shared') {
    if (!canPromote(user.role, 'Shared')) throw withStatus(new Error('Listing in the Marketplace requires an Administrator'), 403);
    next = 'Certified';
  } else {
    throw withStatus(new Error('Already in the Marketplace'), 400);
  }
  c.visibility = next;
  c.updatedAt = now();
  map.set(c.id, c);
  writeThrough(c);
  void trace({
    principal: c.principal,
    tool: 'generate',
    input: { action: 'promote_connection', by: user.id, role: user.role },
    output: { connectionId: c.id, visibility: next },
    decision: 'allow',
  });
  return c;
}

/**
 * Demotion (revoke sharing): the reverse of {@link promoteConnection}, one step
 * down — Certified → Shared (admin only) → Personal (owner or in-domain
 * builder/admin). Never deletes the connection; only lowers its visibility so it
 * leaves the marketplace / domain surface. The effect seam is the primary gate.
 */
export async function demoteConnection(connId: string, user: CurrentUser): Promise<Connection> {
  const map = await getCache();
  const c = map.get(connId);
  if (!c) throw withStatus(new Error('Connection not found'), 404);
  if (!user.domains.includes(c.domain)) {
    throw withStatus(new Error('You can only revoke sharing on connections in a domain you belong to'), 403);
  }
  let next: Visibility;
  if (c.visibility === 'Certified') {
    if (user.role !== 'admin') throw withStatus(new Error('Revoking from the Marketplace requires an Administrator'), 403);
    next = 'Shared';
  } else if (c.visibility === 'Shared') {
    if (!canManageArtifact(user, manageArg(c))) {
      throw withStatus(new Error('Unsharing requires the owner, an in-domain Domain admin, or an Administrator'), 403);
    }
    next = 'Personal';
  } else {
    throw withStatus(new Error('Already Personal — nothing to revoke'), 400);
  }
  c.visibility = next;
  c.updatedAt = now();
  map.set(c.id, c);
  writeThrough(c);
  void trace({
    principal: c.principal,
    tool: 'generate',
    input: { action: 'demote_connection', by: user.id, role: user.role },
    output: { connectionId: c.id, visibility: next },
    decision: 'allow',
  });
  return c;
}

// --------------------------------------------------------------- Grant to agent --

/**
 * Grant the connection to a specific agent, FURTHER RESTRICTED (never broadened).
 * `read-only` exposes just the connection's Read tools to that agent — even if the
 * connection itself allows a bounded/approval write.
 */
export async function grantToAgent(
  connId: string,
  user: CurrentUser,
  agentPrincipal: string,
  scope: 'read-only' | 'full',
): Promise<Connection> {
  const map = await getCache();
  const c = map.get(connId);
  if (!c) throw withStatus(new Error('Connection not found'), 404);
  // Fail-closed edit-scope: owner, domain_admin of the owning domain, or admin.
  if (!canManageArtifact(user, manageArg(c))) {
    throw withStatus(new Error('Not permitted to grant this connection'), 403);
  }
  if (!roleAtLeast(user.role, 'builder')) {
    throw withStatus(new Error('Granting a connection requires a Builder or Administrator'), 403);
  }

  // The grant can only narrow: read-only -> the Read tools; full -> all EXPOSED tools.
  // Operational ACTION tools (sf_*) live outside the static bundle: fold the currently-
  // exposed ones (the exposure+adoption intersection) in so a `full` grant can carry
  // them, and a `read-only` grant carries only their read/search tools. The runtime
  // intersection still re-checks per call, so a later revoke narrows a stale grant.
  const exposed = exposedConnectionTools(c.principal);
  // Fold the action tools currently exposed to the granting admin's domains (C4). The
  // per-call intersection re-checks with the actual caller's domains, so this is only the
  // grant's static list; a later revoke or a different-domain caller still narrows it.
  const actionExposed = await exposedActionTools(c, user.domains);
  const readActionTools = actionExposed.filter((t) => t === 'sf_get_record' || t === 'sf_search');
  const readTools = [...c.tools.filter((t) => t.mode === 'Read').map((t) => t.name), ...readActionTools];
  const allowedTools = scope === 'read-only' ? readTools : [...exposed, ...actionExposed];

  restrictConnectionForAgent(agentPrincipal, c.principal, allowedTools);
  c.grants = c.grants.filter((g) => g.agent !== agentPrincipal);
  c.grants.push({ agent: agentPrincipal, scope, tools: allowedTools, grantedBy: user.id, at: now() });
  c.updatedAt = now();
  map.set(c.id, c);
  writeThrough(c);
  void trace({
    principal: c.principal,
    tool: 'generate',
    input: { action: 'grant_to_agent', agent: agentPrincipal, scope, by: user.id },
    output: { allowedTools },
    decision: 'allow',
  });
  return c;
}

// ----------------------------------------------------------- Governed tool call --

/**
 * The FOUR-LAYER INTERSECTION authz for an operational action tool (sf_*), recomputed
 * fresh over the live exposure + adoption stores. Returns the SAME `{effect, reason,
 * mode}` shape as `authorizeConnectionCall` so the downstream gate is unchanged:
 *   • no exposure / no adoption / flag off / no valid object ⇒ deny (fail closed),
 *   • delete ⇒ deny (Blocked),
 *   • read/search ⇒ allow,
 *   • create/update ⇒ requires_approval (or Write-bounded allow within the bound / deny
 *     over it),
 *   • an `asAgent` grant that excludes the tool ⇒ deny (layer 4, restrict-only).
 */
async function authorizeActionCall(
  c: Connection,
  tool: string,
  args: Record<string, unknown>,
  callerDomains: string[],
  asAgent?: string,
): Promise<{ effect: 'allow' | 'deny' | 'requires_approval'; reason: string; mode?: CapabilityMode }> {
  // Archived ⇒ every action tool is disabled (M3), even via a direct approveOnce re-check.
  if (c.archived) return { effect: 'deny', reason: 'archived — tools disabled' };
  // Layer 4 (grant, restrict-only): a per-agent grant that does not list this tool denies.
  if (asAgent) {
    const grant = c.grants.find((g) => g.agent === asAgent);
    if (grant && !grant.tools.includes(tool)) {
      return { effect: 'deny', reason: `agent ${asAgent} is granted a narrower scope; ${tool} is not in the grant` };
    }
  }
  const object = String(args.object ?? '');
  const [exposures, adoptions] = await Promise.all([allActiveExposures(), allActiveAdoptions()]);
  // Layers 2+3 are keyed on the CALLER'S domains (C4), threaded from the callConnectionTool
  // boundary — not the connection's own domain.
  const decision = decideActionTool(c, tool, object, exposures, adoptions, callerDomains);
  if (decision.mode === null) return { effect: 'deny', reason: decision.reason };
  switch (decision.mode) {
    case 'Blocked':
    case 'Off':
      return { effect: 'deny', reason: decision.reason, mode: decision.mode };
    case 'Read':
      return { effect: 'allow', reason: decision.reason, mode: 'Read' };
    case 'Write-approval':
      return { effect: 'requires_approval', reason: decision.reason, mode: 'Write-approval' };
    case 'Write-bounded': {
      const limits = actionToolLimits(c, tool);
      const boundArg = limits?.boundArg ?? 'amount';
      if (limits?.maxAmount !== undefined) {
        const amount = Number((args.values as Record<string, unknown> | undefined)?.[boundArg] ?? args[boundArg]);
        if (!Number.isFinite(amount)) {
          return { effect: 'deny', reason: `bounded write requires a numeric ${boundArg} <= ${limits.maxAmount}`, mode: 'Write-bounded' };
        }
        if (amount > limits.maxAmount) {
          return { effect: 'deny', reason: `${boundArg} ${amount} exceeds the bound (<= ${limits.maxAmount})`, mode: 'Write-bounded' };
        }
        return { effect: 'allow', reason: `within bound (<= ${limits.maxAmount})`, mode: 'Write-bounded' };
      }
      return { effect: 'allow', reason: 'within bound', mode: 'Write-bounded' };
    }
    default:
      return { effect: 'deny', reason: 'unknown mode' };
  }
}

export type WritePreviewDTO = {
  action: string;
  args: Record<string, unknown>;
  diff: { field: string; before: unknown; after: unknown }[];
  who: string;
  reason: string;
};

export type ToolCallResult = {
  tool: string;
  principal: string;
  decision: 'allow' | 'deny' | 'requires_approval' | 'propose' | 'block';
  reason: string;
  mode?: string;
  traceId: string;
  result?: unknown;
  approvalId?: string;
  /** Full preview shown inline for a Mode-A Write-approval pause. */
  preview?: WritePreviewDTO;
  /** True when an autonomous (Mode B) out-of-policy action was queued for review. */
  queuedForReview?: boolean;
};

/**
 * Call a connection's governed tool exactly as an agent would: authorize against
 * the compiled capability profile (+ any per-agent restriction), then either
 * execute (seed-backed offline), hold for approval, or deny — all Langfuse-traced.
 * The secret is injected SERVER-SIDE and never appears in the trace or response.
 */
export async function callConnectionTool(
  connId: string,
  user: CurrentUser,
  input: { tool: string; args?: Record<string, unknown>; asAgent?: string; autonomous?: boolean; reason?: string },
): Promise<ToolCallResult> {
  const map = await getCache();
  const c = map.get(connId);
  if (!c || !visibleToUser(c, user)) throw withStatus(new Error('Connection not found'), 404);

  const tool = String(input.tool ?? '');
  const args = input.args ?? {};
  const reason = input.reason ?? 'tool call';
  // ARCHIVED connections have their tools DISABLED (M3): a soft-hidden connection must not
  // execute anything (the exposures it fed are also frozen). Fail closed, honestly traced.
  if (c.archived) {
    const tr = await trace({ principal: c.principal, tool, input: { args, asAgent: input.asAgent }, output: { denied: 'archived — tools disabled' }, decision: 'deny' });
    return { tool, principal: c.principal, decision: 'deny', reason: 'archived — tools disabled', traceId: tr.id };
  }
  // Operational action tools (sf_*) are NOT in the static bundle: their authz is the
  // four-layer intersection, recomputed FRESH here over the live exposure/adoption
  // stores (no cache outlives a revoke). Everything else uses the compiled profile.
  const authz = isSalesforceActionTool(tool)
    ? await authorizeActionCall(c, tool, args, user.domains, input.asAgent)
    : authorizeConnectionCall(c.principal, tool, args, input.asAgent);

  // Hard deny (Off / Blocked / over-bound / out-of-grant) — same in both modes.
  if (authz.effect === 'deny') {
    const tr = await trace({ principal: c.principal, tool, input: { args, asAgent: input.asAgent }, output: { denied: authz.reason }, decision: 'deny' });
    if (input.autonomous && input.asAgent) {
      // Mode B: out-of-policy → block + log + async Governance-inbox review (no inline prompt).
      const approval = queueAutonomousReview(c, tool, args, input.asAgent, user.id, authz.reason, tr.id);
      return { tool, principal: c.principal, decision: 'block', reason: authz.reason, mode: authz.mode, traceId: tr.id, approvalId: approval.id, queuedForReview: true };
    }
    return { tool, principal: c.principal, decision: 'deny', reason: authz.reason, mode: authz.mode, traceId: tr.id };
  }

  // ----- AUTONOMOUS (Mode B): pre-authorized via the agent's safety preset -----
  if (input.autonomous && input.asAgent) {
    const preset = effectivePreset(input.asAgent, c.domain, c.principal, tool);
    const a = resolveAutonomous(preset, { effect: authz.effect, reason: authz.reason, mode: authz.mode }, (authz.mode ?? 'Read'), Boolean(c.tools.find((x) => x.name === tool)?.write));
    if (a.effect === 'allow') {
      return runAllow(c, tool, args, input.asAgent, `autonomous(${preset}): ${a.reason}`, authz.mode);
    }
    // propose or block → never run; log + queue for async review (no inline prompt).
    const tr = await trace({ principal: c.principal, tool, input: { args, asAgent: input.asAgent }, output: { [a.effect]: a.reason }, decision: a.effect === 'propose' ? 'requires_approval' : 'deny' });
    const approval = queueAutonomousReview(c, tool, args, input.asAgent, user.id, `${preset}: ${a.reason}`, tr.id);
    return { tool, principal: c.principal, decision: a.effect, reason: a.reason, mode: authz.mode, traceId: tr.id, approvalId: approval.id, queuedForReview: a.queue };
  }

  // ----- IN-TAB ASSISTANT (Mode A): human present at run time -----
  if (authz.effect === 'requires_approval') {
    // "Approve & remember" standing policy auto-allows identical calls (no prompt).
    if (matchStandingPolicy(c.principal, tool, args)) {
      return runAllow(c, tool, args, input.asAgent, 'standing policy (approve & remember) — auto-allowed', authz.mode);
    }
    const before = await readBefore(c, tool, args);
    const preview = buildPreview({ action: tool, args, before, who: user.id, reason });
    const tr = await trace({ principal: c.principal, tool, input: { args, asAgent: input.asAgent }, output: { held: authz.reason }, decision: 'requires_approval' });
    const approval = enqueue({
      kind: 'connection_write',
      title: `${c.name}: ${tool}`,
      detail: `${authz.reason}. ${tool}(${JSON.stringify(args)})`,
      agent: input.asAgent ?? c.principal,
      domain: c.domain,
      requestedBy: user.id,
      tool,
      payload: { connectionId: c.id, preview, account: args.account ?? args.id ?? '', field: tool, value: args.amount ?? args.value ?? '' },
      traceId: tr.id,
    });
    return { tool, principal: c.principal, decision: 'requires_approval', reason: authz.reason, mode: authz.mode, traceId: tr.id, approvalId: approval.id, preview };
  }

  // allow (Read / Write-bounded within limit)
  return runAllow(c, tool, args, input.asAgent, authz.reason, authz.mode);
}

/**
 * A per-template EXECUTOR: runs one ALREADY-ALLOWED tool call against the real
 * backing system and returns an honest result. The governance gate (Read auto /
 * Write-approval / Blocked) has already been applied UPSTREAM in
 * `callConnectionTool` — an executor is only reached once a call is allowed, and it
 * NEVER throws (each hand-built client degrades to `{ ok:false, reason }`).
 *
 * This is the connector REGISTRY the CONNECTOR-STANDARD praises: instead of one
 * growing `template === 'airflow' ? … : …` ternary, each real connector registers
 * its dispatch here (mirroring `warehouse/registry.ts`), so connectors append
 * cleanly on disjoint branches. A template with no entry falls through to the
 * offline `executeMock` (the demonstrable, LABELLED offline path).
 */
type Executor = (c: Connection, tool: string, args: Record<string, unknown>) => Promise<unknown>;

const CONNECTION_EXECUTORS: Partial<Record<ConnectionTemplateKey, Executor>> = {
  airflow: (c, tool, args) => executeAirflow(c, tool, args),
  github: (c, tool, args) => executeGithub(c, tool, args),
  supabase: (c, tool, args) => executeSupabase(c, tool, args),
  'notion-mcp': (c, tool, args) => executeNotion(c, tool, args),
  atlassian: (c, tool, args) => executeAtlassian(c, tool, args),
  slack: (c, tool, args) => executeSlack(c, tool, args),
  gmail: (c, tool, args) => executeGmail(c, tool, args),
  gcal: (c, tool, args) => executeGcal(c, tool, args),
  outlook: (c, tool, args) => executeOutlook(c, tool, args),
  teams: (c, tool, args) => executeTeams(c, tool, args),
  entra: (c, tool, args) => executeEntra(c, tool, args),
  purview: (c, tool, args) => executePurview(c, tool, args),
  'ai-foundry': (c, tool, args) => executeAiFoundry(c, tool, args),
  sagemaker: (c, tool, args) => executeSageMaker(c, tool, args),
  'gcp-identity': (c, tool, args) => executeGcpIdentity(c, tool, args),
  'gcp-directory': (c, tool, args) => executeGcpDirectory(c, tool, args),
  'snowflake-governance': (c, tool, args) => executeSnowflakeGov(c, tool, args),
  // OData (SAP S/4HANA + generic V4) + Workday RaaS: REAL thin READ executors (C2) — the
  // preset read tools make a live $metadata/page or RaaS-report round-trip, never a mock.
  'sap-odata': (c, tool, args) => executeODataTool(c, tool, args),
  'odata-v4': (c, tool, args) => executeODataTool(c, tool, args),
  'workday-raas': (c, tool, args) => executeWorkdayTool(c, tool, args),
  // Operational action tools (Phase 3). Registered but INERT unless the flag is on:
  // executeSalesforceAction dispatches the entity-generic sf_* tools; the sync-only
  // capability tools of a salesforce-api connection never reach here (the profile has
  // no other exposed write tool, and reads on the legacy preset fall to executeMock).
  // When the flag is OFF, no sf_* call is ever ALLOWED upstream (the intersection
  // denies), so this executor stays unreached.
  'salesforce-api': async (c, tool, args) => {
    if (config.operationalActionsEnabled && isSalesforceActionTool(tool)) {
      return executeSalesforceAction(c, tool, args);
    }
    return executeMock(c, tool, args, true);
  },
};

/** Execute an allowed call: inject the secret SERVER-SIDE (never logged), trace + log egress. */
async function runAllow(
  c: Connection,
  tool: string,
  args: Record<string, unknown>,
  asAgent: string | undefined,
  reason: string,
  mode?: string,
): Promise<ToolCallResult> {
  // CONNECTOR-STANDARD §3.3: egress allowlist re-checked before EVERY call (fail-closed
  // — mirrors the create-time check). Deny-by-default now also covers INTERNAL /
  // in-cluster / loopback targets (SSRF hardening): a user-supplied `http://query-tool`
  // (or trino/opa/minio/kubernetes.default.svc) is refused unless an operator explicitly
  // allowlisted that host. `isEgressAllowed` returns allowed:false for such targets.
  {
    const egress = isEgressAllowed(c.endpoint);
    if (!egress.allowed) {
      const tr = await trace({ principal: c.principal, tool, input: { args, asAgent }, output: { denied: `egress not allowed: ${egress.host}` }, decision: 'deny' });
      return { tool, principal: c.principal, decision: 'deny', reason: `Egress to "${egress.host}" is not on the allowlist — an Administrator must approve it first`, traceId: tr.id };
    }
  }

  const secret = getSecretServerSide(c.secretRef);
  // A registered executor hits the REAL API (the secret is injected server-side
  // inside the client and never logged); every other connector uses the offline
  // mock (the LABELLED demonstrable path). Look up the executor for this template.
  const executor = CONNECTION_EXECUTORS[c.template];
  const result = executor
    ? await executor(c, tool, args)
    : executeMock(c, tool, args, Boolean(secret));
  if (c.egress.external) logEgress({ host: c.egress.host, connectionId: c.id, tool }); // monitored egress
  const tr = await trace({
    principal: c.principal,
    tool,
    input: { args, asAgent }, // NOTE: no secret here
    output: result,
    decision: 'allow',
    costUsd: 0.0003,
  });
  return { tool, principal: c.principal, decision: 'allow', reason, mode, traceId: tr.id, result };
}

/**
 * A before-snapshot for the approval diff — HONEST (M12). An approver must never decide on
 * invented data, so for a LIVE connector with a real read we fetch the REAL current record;
 * otherwise we return an explicitly-labelled `unavailable` before-state (never a fabricated
 * one). Today the only held write with a real read is a Salesforce `sf_update_record`
 * (its before is a real `sf_get_record`); everything else is labelled unavailable.
 */
async function readBefore(c: Connection, tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (tool === 'sf_update_record' && operationalActionsActive(c)) {
    const object = String(args.object ?? '');
    const idArg = String(args.id ?? '');
    if (object && idArg) {
      const res = (await executeSalesforceAction(c, 'sf_get_record', { object, id: idArg, fields: args.fields })) as {
        ok?: boolean;
        record?: Record<string, unknown>;
        reason?: string;
      };
      if (res.ok && res.record) return res.record;
      return { unavailable: true, reason: `live read unavailable: ${res.reason ?? 'the record could not be fetched'}` };
    }
  }
  // No real read wired for this tool/connector — say so; never fabricate a before-state.
  return { unavailable: true, reason: 'no live read is available for this connector — before-state is unavailable' };
}

/** Mode B: queue an out-of-policy autonomous action for async Governance-inbox review. */
function queueAutonomousReview(c: Connection, tool: string, args: Record<string, unknown>, agent: string, requestedBy: string, reason: string, traceId: string) {
  return enqueue({
    kind: 'connection_write',
    title: `Autonomous review: ${c.name} · ${tool}`,
    detail: `Out-of-policy autonomous action blocked and queued. ${reason}. ${tool}(${JSON.stringify(args)})`,
    agent,
    domain: c.domain,
    requestedBy,
    tool,
    payload: { connectionId: c.id, autonomous: true, account: args.account ?? args.id ?? '', field: tool, value: args.amount ?? args.value ?? '' },
    traceId,
  });
}

/**
 * Register the connection as a DATA SOURCE — the second usage. Database/API/SaaS →
 * dlt → Bronze; Drive → Files index. Runs the adapter's `sync` op; the connection
 * stays a governed agent tool at the same time (one object, two usages).
 */
export async function enableDataUsage(connId: string, user: CurrentUser, usage: DataUsage): Promise<Connection> {
  const map = await getCache();
  const c = map.get(connId);
  if (!c || !visibleToUser(c, user)) throw withStatus(new Error('Connection not found'), 404);
  const adapter = adapterFor(c.connector);
  const sync = await adapter.sync({ template: templateByKey(c.template)!, endpoint: c.endpoint, credentialPresent: c.secretSet });
  const target = usage ?? (sync.data?.target === 'files' ? 'files' : 'bronze');
  if (target === 'files') {
    indexToFiles({ connectionId: c.id, name: c.name, items: sync.data?.records ?? 0, indexedBy: user.id });
    c.dataUsage = 'files';
  } else {
    registerBronzeSource({ connectionId: c.id, name: c.name, connector: c.connector, rows: sync.data?.records ?? 0, registeredBy: user.id });
    c.dataUsage = 'bronze';
  }
  // M8 HONESTY: no live sync client is injected here (the real fetch-backed clients are a
  // server-side wire that does not exist yet), so `sync.mode` is 'offline-mock' and the
  // row/item counts are FABRICATED. Stamp the mode onto the record so the UI can label the
  // registration a mock instead of presenting the fabricated count as a real ingest.
  c.dataUsageMode = sync.mode; // 'live' once a real sync client is wired; 'offline-mock' today
  c.updatedAt = now();
  map.set(c.id, c);
  writeThrough(c);
  void trace({ principal: c.principal, tool: 'generate', input: { action: 'enable_data_usage', usage: target, by: user.id }, output: { mode: sync.mode, records: sync.data?.records }, decision: 'allow' });
  return c;
}

/**
 * "Approve once" (Mode A): the connection owner or a domain Builder/Admin approves a
 * held Write-approval call INLINE and resumes the run — executing it exactly once,
 * WITHOUT creating a standing policy. Re-authorizes against the compiled capability
 * profile first, so an Off / Blocked / over-bound call can NEVER be executed via this
 * path (the profile is still the ceiling); only a genuinely held (requires_approval)
 * or already-allowed call runs. Consistent with "approve & remember", which also runs.
 */
export async function approveOnce(
  connId: string,
  user: CurrentUser,
  input: { tool: string; args?: Record<string, unknown> },
): Promise<ToolCallResult> {
  const map = await getCache();
  const c = map.get(connId);
  if (!c || !visibleToUser(c, user)) throw withStatus(new Error('Connection not found'), 404);
  const isOwner = c.owner === user.id;
  const isDomainBuilderAdmin = roleAtLeast(user.role, 'builder') && user.domains.includes(c.domain);
  if (!isOwner && !isDomainBuilderAdmin) throw withStatus(new Error('Only the owner or a domain Builder/Admin can approve this write'), 403);
  const tool = String(input.tool ?? '');
  const args = input.args ?? {};
  // A held `sf_*` action lives OUTSIDE the compiled bundle, so re-checking it via the
  // compiled-bundle `authorizeConnectionCall` would default-deny it (M6). Re-check an
  // action tool via the (C4-fixed) four-layer intersection under the APPROVER's domains
  // instead; everything else re-checks against the compiled capability profile.
  const authz = isSalesforceActionTool(tool)
    ? await authorizeActionCall(c, tool, args, user.domains)
    : authorizeConnectionCall(c.principal, tool, args);
  if (authz.effect === 'deny') {
    // The capability profile still rules: a Blocked / Off / over-bound call is refused
    // even by an approver — approving cannot broaden the profile.
    const tr = await trace({ principal: c.principal, tool, input: { args, approvedBy: user.id }, output: { denied: authz.reason }, decision: 'deny' });
    return { tool, principal: c.principal, decision: 'deny', reason: authz.reason, mode: authz.mode, traceId: tr.id };
  }
  // requires_approval or allow → the present approver resumes the run: execute once.
  return runAllow(c, tool, args, undefined, `approved inline (once) by ${user.id}`, authz.mode);
}

/**
 * "Approve & remember" (Mode A): approve a held write AND create a bounded standing
 * policy so identical calls stop prompting. The bound is carried from the call.
 */
export async function approveAndRemember(
  connId: string,
  user: CurrentUser,
  input: { tool: string; args?: Record<string, unknown> },
): Promise<{ standingPolicyId: string; result: ToolCallResult }> {
  const map = await getCache();
  const c = map.get(connId);
  if (!c || !visibleToUser(c, user)) throw withStatus(new Error('Connection not found'), 404);
  const isOwner = c.owner === user.id;
  const isDomainAdmin = roleAtLeast(user.role, 'builder') && user.domains.includes(c.domain);
  if (!isOwner && !isDomainAdmin) throw withStatus(new Error('Only the owner or a domain Builder/Admin can approve & remember'), 403);
  const args = input.args ?? {};
  const toolDef = c.tools.find((t) => t.name === input.tool);
  const pol = rememberPolicy({ principal: c.principal, tool: input.tool, maxAmount: toolDef?.limits?.maxAmount, createdBy: user.id });
  // Now the call auto-allows under the standing policy.
  const result = await callConnectionTool(connId, user, { tool: input.tool, args, reason: 'approved & remembered' });
  void trace({ principal: c.principal, tool: 'generate', input: { action: 'approve_and_remember', tool: input.tool, by: user.id }, output: { standingPolicyId: pol.id }, decision: 'allow' });
  return { standingPolicyId: pol.id, result };
}

/** Deterministic seed responses so the slice is demonstrable with no live endpoint. */
/** Build the pure Airflow client config from a connection — the credential is
 *  dereferenced from the vault HERE (server-side) and never leaves this process. */
function airflowConnFor(c: Connection): AirflowConn {
  const authType: AirflowAuthType = c.airflow?.authType ?? 'bearer';
  return {
    baseUrl: c.endpoint,
    authType,
    username: c.airflow?.username,
    secret: getSecretServerSide(c.secretRef) ?? undefined,
    fetchImpl: fetch,
    timeoutMs: 4000,
  };
}

/**
 * Execute an ALLOWED Airflow tool against the real REST API. The governance gate
 * (Read auto-allow · trigger_dag Write-approval) already passed upstream; here we
 * only run the call and shape an honest result. `trigger_dag` additionally honours
 * the connection's non-secret DAG allowlist as a bound. Never throws.
 */
async function executeAirflow(c: Connection, tool: string, args: Record<string, unknown>): Promise<unknown> {
  const conn = airflowConnFor(c);
  const dagId = String(args.dagId ?? args.dag_id ?? '');
  switch (tool) {
    case 'list_dags': {
      const r = await afListDags(conn);
      return r.ok ? { connection: c.name, dags: r.data } : { connection: c.name, ok: false, reason: r.reason };
    }
    case 'get_dag_run': {
      const runId = String(args.runId ?? args.dag_run_id ?? '');
      if (!dagId || !runId) return { connection: c.name, ok: false, reason: 'get_dag_run needs a dagId and a runId' };
      const r = await afGetDagRun(conn, dagId, runId);
      return r.ok ? { connection: c.name, run: r.data } : { connection: c.name, ok: false, reason: r.reason };
    }
    case 'list_dag_runs': {
      if (!dagId) return { connection: c.name, ok: false, reason: 'list_dag_runs needs a dagId' };
      const limit = args.limit !== undefined ? Number(args.limit) : undefined;
      const state = args.state ? String(args.state) : undefined;
      const r = await afListDagRuns(conn, dagId, { limit, state });
      return r.ok ? { connection: c.name, runs: r.data } : { connection: c.name, ok: false, reason: r.reason };
    }
    case 'get_task_instances': {
      const runId = String(args.runId ?? args.dag_run_id ?? '');
      if (!dagId || !runId) return { connection: c.name, ok: false, reason: 'get_task_instances needs a dagId and a runId' };
      const r = await afGetTaskInstances(conn, dagId, runId);
      return r.ok ? { connection: c.name, taskInstances: r.data } : { connection: c.name, ok: false, reason: r.reason };
    }
    case 'get_task_logs': {
      const runId = String(args.runId ?? args.dag_run_id ?? '');
      const taskId = String(args.taskId ?? args.task_id ?? '');
      if (!dagId || !runId || !taskId) return { connection: c.name, ok: false, reason: 'get_task_logs needs a dagId, runId and taskId' };
      const tryNumber = args.tryNumber !== undefined ? Number(args.tryNumber) : undefined;
      const r = await afGetTaskLogs(conn, dagId, runId, taskId, { tryNumber });
      return r.ok ? { connection: c.name, logs: r.data } : { connection: c.name, ok: false, reason: r.reason };
    }
    case 'get_xcom': {
      const runId = String(args.runId ?? args.dag_run_id ?? '');
      const taskId = String(args.taskId ?? args.task_id ?? '');
      if (!dagId || !runId || !taskId) return { connection: c.name, ok: false, reason: 'get_xcom needs a dagId, runId and taskId' };
      const key = args.key ? String(args.key) : undefined;
      const r = await afGetXcom(conn, dagId, runId, taskId, { key });
      return r.ok ? { connection: c.name, xcom: r.data } : { connection: c.name, ok: false, reason: r.reason };
    }
    case 'list_datasets': {
      const limit = args.limit !== undefined ? Number(args.limit) : undefined;
      const r = await afListDatasets(conn, limit);
      return r.ok ? { connection: c.name, datasets: r.data } : { connection: c.name, ok: false, reason: r.reason };
    }
    case 'get_dataset_events': {
      const limit = args.limit !== undefined ? Number(args.limit) : undefined;
      const r = await afGetDatasetEvents(conn, limit);
      return r.ok ? { connection: c.name, events: r.data } : { connection: c.name, ok: false, reason: r.reason };
    }
    case 'pause_dag':
    case 'unpause_dag': {
      if (!dagId) return { connection: c.name, ok: false, reason: `${tool} needs a dagId` };
      if (!airflowDagAllowed(c, dagId)) return { connection: c.name, ok: false, reason: `DAG "${dagId}" is not on this connection's allowlist` };
      const r = await afSetDagPaused(conn, dagId, tool === 'pause_dag');
      return r.ok ? { connection: c.name, dag: r.data } : { connection: c.name, ok: false, reason: r.reason };
    }
    case 'clear_task': {
      const runId = String(args.runId ?? args.dag_run_id ?? '');
      if (!dagId || !runId) return { connection: c.name, ok: false, reason: 'clear_task needs a dagId and a runId' };
      if (!airflowDagAllowed(c, dagId)) return { connection: c.name, ok: false, reason: `DAG "${dagId}" is not on this connection's allowlist` };
      const taskIds = Array.isArray(args.taskIds) ? (args.taskIds as unknown[]).map(String)
        : Array.isArray(args.task_ids) ? (args.task_ids as unknown[]).map(String) : undefined;
      const onlyFailed = Boolean(args.onlyFailed ?? args.only_failed);
      const r = await afClearTask(conn, dagId, runId, { taskIds, onlyFailed });
      return r.ok ? { connection: c.name, cleared: r.data } : { connection: c.name, ok: false, reason: r.reason };
    }
    case 'trigger_dag': {
      if (!dagId) return { connection: c.name, ok: false, reason: 'trigger_dag needs a dagId' };
      if (!airflowDagAllowed(c, dagId)) return { connection: c.name, ok: false, reason: `DAG "${dagId}" is not on this connection's trigger allowlist` };
      const conf = (args.conf && typeof args.conf === 'object') ? (args.conf as Record<string, unknown>) : undefined;
      const logicalDate = args.logicalDate ? String(args.logicalDate) : (args.logical_date ? String(args.logical_date) : undefined);
      const r = await afTriggerDag(conn, dagId, conf, logicalDate);
      return r.ok ? { connection: c.name, triggered: r.data } : { connection: c.name, ok: false, reason: r.reason };
    }
    default:
      return { connection: c.name, ok: false, reason: `Unknown Airflow tool: ${tool}` };
  }
}

/**
 * Execute an ALLOWED GitHub tool against the real REST API. The governance gate
 * (reads auto · writes Write-approval · deletes Blocked) already passed upstream;
 * here we only run the call and shape an honest result. Never throws — the client
 * degrades to `{ ok:false, reason }` and we surface it as `{ ok:false, reason }`.
 */
async function executeGithub(c: Connection, tool: string, args: Record<string, unknown>): Promise<unknown> {
  const conn = githubConnFrom(c);
  const repo = String(args.repo ?? args.repository ?? '');
  const number = Number(args.number ?? args.issue ?? args.pull ?? 0);
  const fail = (reason: string) => ({ connection: c.name, ok: false, reason });
  const done = <T>(r: { ok: true; data: T; truncated?: boolean } | { ok: false; reason: string }, key: string) =>
    r.ok ? { connection: c.name, [key]: r.data, ...(('truncated' in r && r.truncated) ? { truncated: true } : {}) } : fail(r.reason);
  switch (tool) {
    case 'list_repos':
      return done(await ghListRepos(conn), 'repos');
    case 'get_repo':
      return done(await ghGetRepo(conn, repo), 'repo');
    case 'list_issues':
      return done(await ghListIssues(conn, repo, { state: args.state ? String(args.state) : undefined }), 'issues');
    case 'get_issue':
      if (!number) return fail('get_issue needs a number');
      return done(await ghGetIssue(conn, repo, number), 'issue');
    case 'search_code':
      return done(await ghSearchCode(conn, String(args.query ?? args.q ?? '')), 'results');
    case 'list_pull_requests':
      return done(await ghListPulls(conn, repo, { state: args.state ? String(args.state) : undefined }), 'pullRequests');
    case 'get_pull_request':
      if (!number) return fail('get_pull_request needs a number');
      return done(await ghGetPull(conn, repo, number), 'pullRequest');
    case 'list_commits':
      return done(await ghListCommits(conn, repo), 'commits');
    case 'create_issue':
      return done(await ghCreateIssue(conn, repo, { title: String(args.title ?? ''), body: args.body ? String(args.body) : undefined }), 'issue');
    case 'add_issue_comment':
      if (!number) return fail('add_issue_comment needs a number');
      return done(await ghAddIssueComment(conn, repo, number, String(args.body ?? '')), 'comment');
    case 'create_pull_request':
      return done(await ghCreatePullRequest(conn, repo, {
        title: String(args.title ?? ''),
        head: String(args.head ?? ''),
        base: String(args.base ?? ''),
        body: args.body ? String(args.body) : undefined,
      }), 'pullRequest');
    default:
      return fail(`Unknown GitHub tool: ${tool}`);
  }
}

/**
 * Execute an ALLOWED Supabase Management-API tool. Governance already passed
 * upstream (reads auto · execute_sql Write-approval + DDL-refused · apply_migration/
 * deploy_edge_function Blocked). Never throws. Service-role keys are never surfaced.
 */
async function executeSupabase(c: Connection, tool: string, args: Record<string, unknown>): Promise<unknown> {
  const conn = supabaseConnFrom(c);
  const ref = String(args.ref ?? args.project ?? args.projectRef ?? '');
  const fail = (reason: string) => ({ connection: c.name, ok: false, reason });
  const done = <T>(r: { ok: true; data: T } | { ok: false; reason: string }, key: string) =>
    r.ok ? { connection: c.name, [key]: r.data } : fail(r.reason);
  const needsRef = (): string | null => (ref ? null : `${tool} needs a project ref`);
  switch (tool) {
    case 'list_projects':
      return done(await sbListProjects(conn), 'projects');
    case 'list_tables':
      return needsRef() ? fail(needsRef()!) : done(await sbListTables(conn, ref), 'tables');
    case 'list_migrations':
      return needsRef() ? fail(needsRef()!) : done(await sbListMigrations(conn, ref), 'migrations');
    case 'get_advisors':
      return needsRef() ? fail(needsRef()!) : done(await sbGetAdvisors(conn, ref, args.type === 'performance' ? 'performance' : 'security'), 'advisors');
    case 'get_logs':
      return needsRef() ? fail(needsRef()!) : done(await sbGetLogs(conn, ref), 'logs');
    case 'get_project_url':
      return needsRef() ? fail(needsRef()!) : done(await sbGetProjectUrl(conn, ref), 'project');
    case 'execute_sql':
      return needsRef() ? fail(needsRef()!) : done(await sbExecuteSql(conn, ref, String(args.sql ?? args.query ?? '')), 'result');
    default:
      return fail(`Unknown Supabase tool: ${tool}`);
  }
}

/**
 * Execute an ALLOWED Atlassian (Jira + Confluence) tool. Governance already passed
 * upstream (reads auto · writes Write-approval · deletes Blocked). Never throws.
 */
async function executeAtlassian(c: Connection, tool: string, args: Record<string, unknown>): Promise<unknown> {
  const conn = atlassianConnFrom(c);
  const fail = (reason: string) => ({ connection: c.name, ok: false, reason });
  const done = <T>(r: { ok: true; data: T; truncated?: boolean } | { ok: false; reason: string }, key: string) =>
    r.ok ? { connection: c.name, [key]: r.data, ...(('truncated' in r && r.truncated) ? { truncated: true } : {}) } : fail(r.reason);
  switch (tool) {
    case 'jira_search_issues':
      return done(await atlJiraSearchIssues(conn, String(args.jql ?? args.query ?? '')), 'issues');
    case 'jira_get_issue':
      return done(await atlJiraGetIssue(conn, String(args.key ?? args.issue ?? '')), 'issue');
    case 'jira_list_projects':
      return done(await atlJiraListProjects(conn), 'projects');
    case 'confluence_search':
      return done(await atlConfluenceSearch(conn, String(args.cql ?? args.query ?? '')), 'results');
    case 'confluence_get_page':
      return done(await atlConfluenceGetPage(conn, String(args.id ?? args.pageId ?? '')), 'page');
    case 'jira_create_issue':
      return done(await atlJiraCreateIssue(conn, {
        projectKey: String(args.projectKey ?? args.project ?? ''),
        issueType: String(args.issueType ?? args.type ?? 'Task'),
        summary: String(args.summary ?? args.title ?? ''),
        description: args.description ? String(args.description) : undefined,
      }), 'issue');
    case 'jira_add_comment':
      return done(await atlJiraAddComment(conn, String(args.key ?? args.issue ?? ''), String(args.body ?? args.comment ?? '')), 'comment');
    case 'jira_transition_issue':
      return done(await atlJiraTransitionIssue(conn, String(args.key ?? args.issue ?? ''), String(args.transitionId ?? args.transition ?? '')), 'transition');
    case 'confluence_create_page':
      return done(await atlConfluenceCreatePage(conn, {
        spaceKey: String(args.spaceKey ?? args.space ?? ''),
        title: String(args.title ?? ''),
        body: String(args.body ?? args.content ?? ''),
      }), 'page');
    default:
      return fail(`Unknown Atlassian tool: ${tool}`);
  }
}

/**
 * Execute an ALLOWED Notion tool against the REAL Notion API using the token the
 * hosted-MCP OAuth flow already stored. Governance already passed upstream (reads
 * auto · notion_create_page Write-approval · delete Blocked). Never throws. This
 * makes the already-user-visible Notion connector HONEST (was executeMock fixtures).
 */
async function executeNotion(c: Connection, tool: string, args: Record<string, unknown>): Promise<unknown> {
  const conn = notionConnFor(c);
  const fail = (reason: string) => ({ connection: c.name, ok: false, reason });
  const done = <T>(r: { ok: true; data: T } | { ok: false; reason: string }, key: string) =>
    r.ok ? { connection: c.name, [key]: r.data } : fail(r.reason);
  switch (tool) {
    case 'notion_search':
      return done(await apiNotionSearch(conn, String(args.query ?? args.q ?? '')), 'results');
    case 'notion_get_page':
      return done(await apiNotionGetPage(conn, String(args.id ?? args.pageId ?? '')), 'page');
    case 'notion_create_page':
      return done(await apiNotionCreatePage(conn, {
        parentId: String(args.parentId ?? args.parent ?? ''),
        title: String(args.title ?? ''),
        text: args.text ? String(args.text) : undefined,
      }), 'page');
    default:
      return fail(`Unknown Notion tool: ${tool}`);
  }
}

/** Build the pure Notion API client config — the OAuth access token is resolved from
 *  the vault HERE (server-side) and never leaves this process. */
function notionConnFor(c: Connection) {
  return notionConnFrom(c, readTokens(c.secretRef)?.accessToken);
}

/**
 * Execute an ALLOWED Slack Web API tool. Governance already passed upstream (reads
 * auto · post_message Write-approval · delete_message Blocked). Never throws. The
 * bot token is injected server-side inside the client and never logged/returned.
 */
async function executeSlack(c: Connection, tool: string, args: Record<string, unknown>): Promise<unknown> {
  const conn = slackConnFrom(c);
  const fail = (reason: string) => ({ connection: c.name, ok: false, reason });
  const done = <T>(r: { ok: true; data: T; truncated?: boolean } | { ok: false; reason: string }, key: string) =>
    r.ok ? { connection: c.name, [key]: r.data, ...(('truncated' in r && r.truncated) ? { truncated: true } : {}) } : fail(r.reason);
  switch (tool) {
    case 'list_channels':
      return done(await slkListChannels(conn), 'channels');
    case 'list_users':
      return done(await slkListUsers(conn), 'users');
    case 'conversations_history':
      return done(await slkConversationsHistory(conn, String(args.channel ?? args.channelId ?? ''), { limit: args.limit !== undefined ? Number(args.limit) : undefined }), 'messages');
    case 'post_message':
      return done(await slkPostMessage(conn, { channel: String(args.channel ?? ''), text: String(args.text ?? '') }), 'posted');
    default:
      return fail(`Unknown Slack tool: ${tool}`);
  }
}

/**
 * Execute an ALLOWED Gmail tool. Governance already passed upstream (reads auto ·
 * send_message/create_draft Write-approval — NEVER auto-send · trash/delete Blocked).
 * Never throws. The OAuth access token is injected server-side, never logged/returned.
 */
async function executeGmail(c: Connection, tool: string, args: Record<string, unknown>): Promise<unknown> {
  const conn = googleMailConnFrom(c);
  const fail = (reason: string) => ({ connection: c.name, ok: false, reason });
  const done = <T>(r: { ok: true; data: T; truncated?: boolean } | { ok: false; reason: string }, key: string) =>
    r.ok ? { connection: c.name, [key]: r.data, ...(('truncated' in r && r.truncated) ? { truncated: true } : {}) } : fail(r.reason);
  switch (tool) {
    case 'list_messages':
      return done(await gmailListMessages(conn, { query: args.query ? String(args.query) : undefined }), 'messages');
    case 'get_message':
      return done(await gmailGetMessage(conn, String(args.id ?? args.messageId ?? '')), 'message');
    case 'list_labels':
      return done(await gmailListLabels(conn), 'labels');
    case 'send_message':
      return done(await gmailSendMessage(conn, { to: String(args.to ?? ''), subject: String(args.subject ?? ''), body: String(args.body ?? args.text ?? '') }), 'sent');
    case 'create_draft':
      return done(await gmailCreateDraft(conn, { to: String(args.to ?? ''), subject: String(args.subject ?? ''), body: String(args.body ?? args.text ?? '') }), 'draft');
    default:
      return fail(`Unknown Gmail tool: ${tool}`);
  }
}

/**
 * Execute an ALLOWED Google Calendar tool. Governance already passed upstream (reads
 * auto · create/update event Write-approval · delete_event Blocked). Never throws.
 */
async function executeGcal(c: Connection, tool: string, args: Record<string, unknown>): Promise<unknown> {
  const conn = gcalConnFrom(c);
  const cal = String(args.calendarId ?? args.calendar ?? 'primary');
  const fail = (reason: string) => ({ connection: c.name, ok: false, reason });
  const done = <T>(r: { ok: true; data: T; truncated?: boolean } | { ok: false; reason: string }, key: string) =>
    r.ok ? { connection: c.name, [key]: r.data, ...(('truncated' in r && r.truncated) ? { truncated: true } : {}) } : fail(r.reason);
  switch (tool) {
    case 'list_calendars':
      return done(await gcalListCalendars(conn), 'calendars');
    case 'list_events':
      return done(await gcalListEvents(conn, cal, { timeMin: args.timeMin ? String(args.timeMin) : undefined }), 'events');
    case 'get_event':
      return done(await gcalGetEvent(conn, cal, String(args.id ?? args.eventId ?? '')), 'event');
    case 'create_event':
      return done(await gcalCreateEvent(conn, cal, { summary: String(args.summary ?? args.title ?? ''), start: String(args.start ?? ''), end: String(args.end ?? ''), description: args.description ? String(args.description) : undefined }), 'event');
    case 'update_event':
      return done(await gcalUpdateEvent(conn, cal, String(args.id ?? args.eventId ?? ''), { summary: args.summary ? String(args.summary) : undefined, start: args.start ? String(args.start) : undefined, end: args.end ? String(args.end) : undefined, description: args.description ? String(args.description) : undefined }), 'event');
    default:
      return fail(`Unknown Google Calendar tool: ${tool}`);
  }
}

/**
 * Execute an ALLOWED Outlook tool over Microsoft Graph. Governance already passed
 * upstream (reads auto · send_mail/create_draft Write-approval — NEVER auto-send ·
 * delete Blocked). Never throws. The OAuth access token is injected server-side.
 */
async function executeOutlook(c: Connection, tool: string, args: Record<string, unknown>): Promise<unknown> {
  const conn = graphConnFrom(c);
  const fail = (reason: string) => ({ connection: c.name, ok: false, reason });
  const done = <T>(r: { ok: true; data: T; truncated?: boolean } | { ok: false; reason: string }, key: string) =>
    r.ok ? { connection: c.name, [key]: r.data, ...(('truncated' in r && r.truncated) ? { truncated: true } : {}) } : fail(r.reason);
  switch (tool) {
    case 'list_messages':
      return done(await outlookListMessages(conn, { search: args.search ? String(args.search) : undefined }), 'messages');
    case 'get_message':
      return done(await outlookGetMessage(conn, String(args.id ?? args.messageId ?? '')), 'message');
    case 'send_mail':
      return done(await outlookSendMail(conn, { to: String(args.to ?? ''), subject: String(args.subject ?? ''), body: String(args.body ?? args.text ?? '') }), 'sent');
    case 'create_draft':
      return done(await outlookCreateDraft(conn, { to: String(args.to ?? ''), subject: String(args.subject ?? ''), body: String(args.body ?? args.text ?? '') }), 'draft');
    default:
      return fail(`Unknown Outlook tool: ${tool}`);
  }
}

/**
 * Execute an ALLOWED Microsoft Teams tool over Microsoft Graph. Governance already
 * passed upstream (reads auto · post_channel_message Write-approval · delete Blocked).
 * Never throws. The OAuth access token is injected server-side, never logged/returned.
 */
async function executeTeams(c: Connection, tool: string, args: Record<string, unknown>): Promise<unknown> {
  const conn = teamsConnFrom(c);
  const team = String(args.teamId ?? args.team ?? '');
  const channel = String(args.channelId ?? args.channel ?? '');
  const fail = (reason: string) => ({ connection: c.name, ok: false, reason });
  const done = <T>(r: { ok: true; data: T; truncated?: boolean } | { ok: false; reason: string }, key: string) =>
    r.ok ? { connection: c.name, [key]: r.data, ...(('truncated' in r && r.truncated) ? { truncated: true } : {}) } : fail(r.reason);
  switch (tool) {
    case 'list_teams':
      return done(await teamsListTeams(conn), 'teams');
    case 'list_channels':
      return done(await teamsListChannels(conn, team), 'channels');
    case 'list_channel_messages':
      return done(await teamsListChannelMessages(conn, team, channel), 'messages');
    case 'post_channel_message':
      return done(await teamsPostChannelMessage(conn, team, channel, String(args.text ?? args.body ?? '')), 'posted');
    default:
      return fail(`Unknown Teams tool: ${tool}`);
  }
}

/**
 * Execute an ALLOWED Microsoft Entra tool over Microsoft Graph. READ-ONLY connector —
 * every tool is a read (governance already passed upstream). Never throws. The OAuth
 * access token is injected server-side, never logged/returned.
 */
async function executeEntra(c: Connection, tool: string, args: Record<string, unknown>): Promise<unknown> {
  const conn = entraConnFrom(c);
  const fail = (reason: string) => ({ connection: c.name, ok: false, reason });
  const done = <T>(r: { ok: true; data: T; truncated?: boolean } | { ok: false; reason: string }, key: string) =>
    r.ok ? { connection: c.name, [key]: r.data, ...(('truncated' in r && r.truncated) ? { truncated: true } : {}) } : fail(r.reason);
  switch (tool) {
    case 'list_users':
      return done(await entraListUsers(conn, { search: args.search ? String(args.search) : undefined }), 'users');
    case 'get_user':
      return done(await entraGetUser(conn, String(args.id ?? args.userId ?? args.userPrincipalName ?? '')), 'user');
    case 'list_groups':
      return done(await entraListGroups(conn), 'groups');
    case 'list_role_assignments':
      return done(await entraListRoleAssignments(conn), 'roleAssignments');
    default:
      return fail(`Unknown Entra tool: ${tool}`);
  }
}

/**
 * Execute an ALLOWED Microsoft Purview tool over the account's Atlas/Purview URL.
 * READ-ONLY connector — every tool is a read. Never throws. The OAuth access token is
 * injected server-side, never logged/returned.
 */
async function executePurview(c: Connection, tool: string, args: Record<string, unknown>): Promise<unknown> {
  const conn = purviewConnFrom(c);
  const fail = (reason: string) => ({ connection: c.name, ok: false, reason });
  const done = <T>(r: { ok: true; data: T; truncated?: boolean } | { ok: false; reason: string }, key: string) =>
    r.ok ? { connection: c.name, [key]: r.data, ...(('truncated' in r && r.truncated) ? { truncated: true } : {}) } : fail(r.reason);
  switch (tool) {
    case 'search_assets':
      return done(await purviewSearchAssets(conn, String(args.keywords ?? args.query ?? args.q ?? '')), 'assets');
    case 'get_asset':
      return done(await purviewGetAsset(conn, String(args.guid ?? args.id ?? '')), 'asset');
    case 'list_classifications':
      return done(await purviewListClassifications(conn), 'classifications');
    case 'get_lineage':
      return done(await purviewGetLineage(conn, String(args.guid ?? args.id ?? '')), 'lineage');
    default:
      return fail(`Unknown Purview tool: ${tool}`);
  }
}

/**
 * Execute an ALLOWED Azure AI Foundry tool over the workspace/region base. READ-ONLY
 * connector — every tool is a read. Never throws. The OAuth access token is injected
 * server-side, never logged/returned.
 */
async function executeAiFoundry(c: Connection, tool: string, args: Record<string, unknown>): Promise<unknown> {
  const conn = aiFoundryConnFrom(c);
  const fail = (reason: string) => ({ connection: c.name, ok: false, reason });
  const done = <T>(r: { ok: true; data: T; truncated?: boolean } | { ok: false; reason: string }, key: string) =>
    r.ok ? { connection: c.name, [key]: r.data, ...(('truncated' in r && r.truncated) ? { truncated: true } : {}) } : fail(r.reason);
  switch (tool) {
    case 'list_models':
      return done(await aiFoundryListModels(conn), 'models');
    case 'list_deployments':
      return done(await aiFoundryListDeployments(conn), 'deployments');
    case 'get_deployment':
      return done(await aiFoundryGetDeployment(conn, String(args.name ?? args.deployment ?? '')), 'deployment');
    default:
      return fail(`Unknown Azure AI Foundry tool: ${tool}`);
  }
}

/**
 * Execute an ALLOWED AWS SageMaker tool over api.sagemaker.<region>.amazonaws.com.
 * READ-ONLY connector — every tool is a read. Never throws. The AWS keys are injected
 * server-side (SigV4-signed), never logged/returned.
 */
async function executeSageMaker(c: Connection, tool: string, args: Record<string, unknown>): Promise<unknown> {
  const conn = sagemakerConnFrom(c);
  const fail = (reason: string) => ({ connection: c.name, ok: false, reason });
  const done = <T>(r: { ok: true; data: T; truncated?: boolean } | { ok: false; reason: string }, key: string) =>
    r.ok ? { connection: c.name, [key]: r.data, ...(('truncated' in r && r.truncated) ? { truncated: true } : {}) } : fail(r.reason);
  switch (tool) {
    case 'list_models':
      return done(await sagemakerListModels(conn), 'models');
    case 'list_endpoints':
      return done(await sagemakerListEndpoints(conn), 'endpoints');
    case 'list_training_jobs':
      return done(await sagemakerListTrainingJobs(conn), 'trainingJobs');
    case 'describe_endpoint':
      return done(await sagemakerDescribeEndpoint(conn, String(args.name ?? args.endpointName ?? '')), 'endpoint');
    default:
      return fail(`Unknown SageMaker tool: ${tool}`);
  }
}

/**
 * Execute an ALLOWED Google Cloud identity/IAM governance tool over Cloud Resource
 * Manager + IAM. READ-ONLY connector — every tool is a read. Never throws. The
 * service-account key is dereferenced server-side, signs a JWT exchanged for a
 * read-only OAuth2 bearer, and never leaves the process.
 */
async function executeGcpIdentity(c: Connection, tool: string, args: Record<string, unknown>): Promise<unknown> {
  const conn = gcpIdentityConnFrom(c);
  const fail = (reason: string) => ({ connection: c.name, ok: false, reason });
  const done = <T>(r: { ok: true; data: T; truncated?: boolean } | { ok: false; reason: string }, key: string) =>
    r.ok ? { connection: c.name, [key]: r.data, ...(('truncated' in r && r.truncated) ? { truncated: true } : {}) } : fail(r.reason);
  switch (tool) {
    case 'list_projects':
      return done(await gcpListProjects(conn), 'projects');
    case 'get_iam_policy':
      return done(await gcpGetIamPolicy(conn, String(args.projectId ?? args.project ?? args.id ?? '')), 'bindings');
    case 'list_service_accounts':
      return done(await gcpListServiceAccounts(conn, String(args.projectId ?? args.project ?? args.id ?? '')), 'serviceAccounts');
    default:
      return fail(`Unknown Google Cloud tool: ${tool}`);
  }
}

/**
 * Execute an ALLOWED Google Workspace directory governance tool over the Admin SDK
 * Directory API. READ-ONLY connector — every tool is a read. Never throws. The
 * service-account key is dereferenced server-side, signs a domain-wide-delegation JWT
 * (sub = the impersonated Workspace admin) exchanged for a read-only OAuth2 bearer,
 * and never leaves the process.
 */
async function executeGcpDirectory(c: Connection, tool: string, _args: Record<string, unknown>): Promise<unknown> {
  const conn = gcpDirectoryConnFrom(c);
  const fail = (reason: string) => ({ connection: c.name, ok: false, reason });
  const done = <T>(r: { ok: true; data: T; truncated?: boolean } | { ok: false; reason: string }, key: string) =>
    r.ok ? { connection: c.name, [key]: r.data, ...(('truncated' in r && r.truncated) ? { truncated: true } : {}) } : fail(r.reason);
  switch (tool) {
    case 'list_users':
      return done(await gcpDirListUsers(conn), 'users');
    case 'list_groups':
      return done(await gcpDirListGroups(conn), 'groups');
    case 'list_org_units':
      return done(await gcpDirListOrgUnits(conn), 'orgUnits');
    case 'list_roles':
      return done(await gcpDirListRoles(conn), 'roles');
    case 'list_domains':
      return done(await gcpDirListDomains(conn), 'domains');
    default:
      return fail(`Unknown Google Workspace directory tool: ${tool}`);
  }
}

/**
 * Execute an ALLOWED Snowflake ACCOUNT_USAGE governance tool over the SQL REST API.
 * READ-ONLY connector — every tool is a bounded SELECT built server-side (no user
 * SQL). Never throws. The RSA private key signs a key-pair JWT server-side and never
 * leaves the process. Note: ACCOUNT_USAGE has ~2h latency + consumes warehouse credits.
 */
async function executeSnowflakeGov(c: Connection, tool: string, _args: Record<string, unknown>): Promise<unknown> {
  const conn = snowflakeGovConnFrom(c);
  const fail = (reason: string) => ({ connection: c.name, ok: false, reason });
  const done = <T>(r: { ok: true; data: T; truncated?: boolean } | { ok: false; reason: string }, key: string) =>
    r.ok ? { connection: c.name, [key]: r.data, ...(('truncated' in r && r.truncated) ? { truncated: true } : {}) } : fail(r.reason);
  switch (tool) {
    case 'list_users':
      return done(await snowflakeGovListUsers(conn), 'users');
    case 'list_roles':
      return done(await snowflakeGovListRoles(conn), 'roles');
    case 'grants_to_users':
      return done(await snowflakeGovGrantsToUsers(conn), 'grants');
    case 'grants_to_roles':
      return done(await snowflakeGovGrantsToRoles(conn), 'grants');
    case 'login_history':
      return done(await snowflakeGovLoginHistory(conn), 'logins');
    case 'access_history':
      return done(await snowflakeGovAccessHistory(conn), 'accesses');
    default:
      return fail(`Unknown Snowflake governance tool: ${tool}`);
  }
}

function executeMock(c: Connection, tool: string, args: Record<string, unknown>, credentialPresent: boolean): unknown {
  // EVERY offline-mock envelope carries an explicit HONESTY LABEL (C2): `mode:'offline-mock'`
  // + a human note, so the tool-result UI + the agent tool-result path can render/carry it and
  // nobody mistakes a demonstration fixture for a live call. A registered real executor never
  // reaches here; this is only the fallback path for connectors with no live client wired.
  const base = {
    connection: c.name,
    credentialInjectedServerSide: credentialPresent,
    mode: 'offline-mock' as const,
    note: 'demonstration data — no live call was made',
  };
  switch (tool) {
    case 'list_files':
    case 'search_files':
      return { ...base, files: [{ id: 'f1', name: 'Q3 plan.docx' }, { id: 'f2', name: 'budget.xlsx' }, { id: 'f3', name: 'notes.md' }] };
    case 'read_file':
      return { ...base, file: { id: String(args.id ?? 'f1'), name: 'Q3 plan.docx', text: '…' } };
    case 'query':
      return { ...base, columns: ['id', 'amount'], rows: [[1, 42000], [2, 13500]] };
    case 'read_messages':
      return { ...base, messages: [{ user: 'ada', text: 'shipping today' }] };
    case 'post_message':
      return { ...base, posted: { channel: String(args.channel ?? 'general'), text: String(args.text ?? '') } };
    default:
      return { ...base, ok: true, tool, args };
  }
}

// -------------------------------------------------------- OAuth token wiring ---

/**
 * OAuth CALLBACK sink: persist the real token set on a Drive connection's secret
 * ref (overwriting the offline placeholder minted at create time). ONLY the
 * connection owner may complete the OAuth flow for their personal connection.
 * The token set is the credential — never returned, traced, or logged (we trace
 * ONLY that a connection was authorized + its non-reversible fingerprint).
 */
export async function storeConnectionTokens(connId: string, userId: string, tokens: TokenSet): Promise<Connection> {
  const map = await getCache();
  const c = map.get(connId);
  if (!c) throw withStatus(new Error('Connection not found'), 404);
  if (c.owner !== userId) throw withStatus(new Error('Only the connection owner can complete its OAuth flow'), 403);
  if (c.type !== 'Drive') throw withStatus(new Error('This connection is not an OAuth Drive connection'), 400);
  storeTokens(c.secretRef, tokens); // raw token set → Secrets Manager only
  c.secretSet = true;
  c.secretFingerprint = secretFingerprint(c.secretRef);
  c.health = 'healthy';
  c.mode = 'live';
  c.updatedAt = now();
  map.set(c.id, c);
  writeThrough(c);
  void trace({
    principal: c.principal,
    tool: 'generate',
    input: { action: 'oauth_connected', by: userId, provider: providerForTemplate(c.template) },
    output: { connectionId: c.id, fingerprint: c.secretFingerprint }, // fingerprint, NEVER the token
    decision: 'allow',
  });
  return c;
}

/**
 * Resolve a live OAuth access token for a Drive connection so the Files sync can
 * pull the REAL drive. GOVERNANCE: only the connection OWNER may sync it. Silently
 * refreshes an expired token (and re-stores it); on a hard auth failure marks the
 * connection `needs-reconnect` and returns null so the sync degrades to the mock
 * client instead of throwing. The token is returned ONLY to the trusted server
 * sync path — never to a client, trace, or log.
 */
export async function resolveConnectionAccessToken(connId: string, userId: string): Promise<string | null> {
  const map = await getCache();
  const c = map.get(connId);
  if (!c) throw withStatus(new Error('Connection not found'), 404);
  if (c.owner !== userId) throw withStatus(new Error('Only the connection owner can sync this connection'), 403);
  const provider = c.type === 'Drive' ? providerForTemplate(c.template) : null;
  if (!provider) return null; // not an OAuth drive connection → mock path
  const res = await resolveAccessToken(c.secretRef, provider);
  if (res.status === 'live') {
    if (res.refreshed || c.health !== 'healthy') {
      c.health = 'healthy';
      c.updatedAt = now();
      map.set(c.id, c);
      writeThrough(c);
    }
    return res.accessToken;
  }
  if (res.status === 'needs-reconnect' && c.health !== 'needs-reconnect') {
    c.health = 'needs-reconnect';
    c.updatedAt = now();
    map.set(c.id, c);
    writeThrough(c);
  }
  return null; // 'none' (offline placeholder) or 'needs-reconnect' → mock fake-drive
}

// --------------------------------------------- Notion hosted-MCP OAuth wiring ---

/** The vault ref for the connection's registered MCP client (parallel to the token ref). */
function notionRegRef(c: Connection): { name: string; key: string } {
  return { name: c.secretRef.name, key: 'mcp-client' };
}

function isNotionMcp(c: Connection): boolean {
  return c.template === 'notion-mcp';
}

/**
 * Notion MCP OAuth CALLBACK sink: persist the user's token set AND the registered
 * client (both server-side, in Secrets Manager) on the connection, overwriting the
 * placeholder minted at create time. Only the owner may complete their own flow.
 * Neither the token nor any client secret is ever returned/traced — only the
 * non-reversible fingerprint is surfaced.
 */
export async function storeNotionConnection(
  connId: string,
  userId: string,
  tokens: TokenSet,
  reg: NotionClientReg,
): Promise<Connection> {
  const map = await getCache();
  const c = map.get(connId);
  if (!c) throw withStatus(new Error('Connection not found'), 404);
  if (c.owner !== userId) throw withStatus(new Error('Only the connection owner can complete its OAuth flow'), 403);
  if (!isNotionMcp(c)) throw withStatus(new Error('This connection is not a Notion MCP connection'), 400);
  storeTokens(c.secretRef, tokens); // token set → Secrets Manager only
  const ref = notionRegRef(c);
  putSecret(ref.name, ref.key, serializeClientReg(reg)); // client reg → vault only (never a record)
  c.secretSet = true;
  c.secretFingerprint = secretFingerprint(c.secretRef);
  c.health = 'healthy';
  c.mode = 'live';
  c.updatedAt = now();
  map.set(c.id, c);
  writeThrough(c);
  void trace({
    principal: c.principal,
    tool: 'generate',
    input: { action: 'notion_mcp_connected', by: userId },
    output: { connectionId: c.id, fingerprint: c.secretFingerprint }, // fingerprint, NEVER the token
    decision: 'allow',
  });
  return c;
}

/** Read the stored Notion client registration (server-side only). */
export function getNotionClientReg(c: Connection): NotionClientReg | null {
  return parseClientReg(getSecretServerSide(notionRegRef(c)));
}

/**
 * PROVE LIVENESS: resolve the stored token (silently refreshing when expired),
 * then run a real MCP initialize + tools/list round-trip through the Notion hosted
 * server and return its advertised tools. Owner-only. On a hard auth/transport
 * failure the connection is marked needs-reconnect. `fetchImpl` is injectable so
 * the whole path unit-tests against a fake; the token is used ONLY as the bearer
 * server-side and is never returned to the client.
 */
export async function verifyNotionConnection(
  connId: string,
  userId: string,
  opts: { fetchImpl?: FetchFn; now?: number } = {},
): Promise<{ ok: boolean; tools: McpToolInfo[]; detail: string }> {
  const map = await getCache();
  const c = map.get(connId);
  if (!c || c.owner !== userId) throw withStatus(new Error('Connection not found'), 404);
  if (!isNotionMcp(c)) throw withStatus(new Error('This connection is not a Notion MCP connection'), 400);

  const reg = getNotionClientReg(c);
  const ts = readTokens(c.secretRef);
  if (!reg || !ts) {
    return { ok: false, tools: [], detail: 'Notion is not connected yet — click Connect Notion to authorize your workspace.' };
  }

  const nowSec = opts.now ?? Math.floor(Date.now() / 1000);
  try {
    let access = ts.accessToken;
    if (isExpired(ts, nowSec)) {
      const next = await refreshNotionToken(reg, ts, { fetchImpl: opts.fetchImpl, now: nowSec });
      storeTokens(c.secretRef, next);
      access = next.accessToken;
    }
    const tools = await listNotionMcpTools(reg, access, { fetchImpl: opts.fetchImpl });
    c.health = 'healthy';
    c.mode = 'live';
    c.updatedAt = now();
    map.set(c.id, c);
    writeThrough(c);
    void trace({
      principal: c.principal,
      tool: 'generate',
      input: { action: 'notion_tools_list', by: userId },
      output: { count: tools.length }, // tool count only — never the token
      decision: 'allow',
    });
    return { ok: true, tools, detail: `Live — the Notion MCP server advertises ${tools.length} tool${tools.length === 1 ? '' : 's'} through your token.` };
  } catch (e) {
    c.health = 'needs-reconnect';
    c.updatedAt = now();
    map.set(c.id, c);
    writeThrough(c);
    return { ok: false, tools: [], detail: `Could not reach the Notion MCP server: ${(e as Error).message}. Try Reconnect.` };
  }
}

/** The store's edit authority for archive/delete/restore: owner or a domain admin. */
function requireConnEdit(c: Connection | undefined, user: CurrentUser): Connection {
  if (!c) throw withStatus(new Error('Connection not found'), 404);
  // Fail-closed edit-scope: owner, domain_admin of the owning domain, or admin.
  if (!canManageArtifact(user, manageArg(c))) {
    throw withStatus(new Error('Not permitted to modify this connection'), 403);
  }
  return c;
}

// ------------------------------------------------------------------- rename ---

/**
 * Rename a connection — change its DISPLAY `name` ONLY. Edit-scoped exactly like every
 * other mutation (owner always; an in-domain domain_admin / platform admin on a
 * shared/certified connection — the reused {@link canManageArtifact} gate via
 * {@link requireConnEdit}). Snapshots the prior profile to the version log so the rename
 * is auditable + reversible. Trims, rejects empty (400), no-ops when unchanged.
 *
 * CRITICAL — the FROZEN physical identity NEVER moves. Unlike a dataset (whose physical
 * slug is DERIVED from its name at build time and so must be pinned before a rename), a
 * connection's physical identity was FROZEN at CREATE: `slug = slugify(name-owner)` is
 * baked ONCE into the `principal` (`conn-<slug>`), the Trino `catalog` (a warehouse's
 * `endpoint: catalog:<cat>` + `warehouse.catalog`) and the vault secret name
 * (`connection-<slug>` on `secretRef.name`). None of those are name-derived after create,
 * so a rename that touches ONLY `name` leaves the live Trino catalog + K8s secret identity
 * untouched by construction — we deliberately DO NOT recompute any of them here. Requiring
 * this discipline in code: we write `c.name` and NOTHING that feeds the physical identity.
 */
export async function renameConnection(connId: string, user: CurrentUser, newName: string): Promise<Connection> {
  const map = await getCache();
  const c = requireConnEdit(map.get(connId), user);
  const name = (newName ?? '').trim();
  if (!name) throw withStatus(new Error('a connection needs a name'), 400);
  if (name === c.name) return c; // no-op → no version churn
  // Snapshot the live profile BEFORE the name changes, so the rename can be undone.
  versions.record(c.id, user.id, snapshotState(c), 'rename');
  // DISPLAY-only write: principal / endpoint(catalog) / secretRef.name are FROZEN and are
  // intentionally NOT touched here — the live Trino catalog + K8s secret keep their identity.
  c.name = name;
  c.updatedAt = now();
  map.set(c.id, c);
  writeThrough(c);
  return c;
}

/**
 * ROTATE the vaulted credential of a SERVICE-credential connection (M13). Many
 * OAuth-access-token templates (gmail/gcal/outlook/teams/entra/purview/ai-foundry, …) are
 * `auth:'service'` — the user PASTES a Bearer access token — and flip to `needs-reconnect`
 * when that token expires, with NO surface to supply a fresh one (only Drive/Notion, which
 * use the OAuth *flow*, had Reconnect). The dead-end was delete+recreate, losing grants and
 * exposures. This writes the NEW secret over the SAME secretRef (frozen K8s identity), re-
 * fingerprints, and clears the stale needs-reconnect health back to untested — grants,
 * exposures, tools and principal are untouched. Edit-scoped (owner or domain admin).
 * NEVER for a warehouse connection (multi-field register path) or a flow-based OAuth
 * connection (use Connect/Reconnect). The secret never travels to the browser.
 */
export async function rotateConnectionCredential(connId: string, user: CurrentUser, newCredential: string): Promise<Connection> {
  const map = await getCache();
  const c = requireConnEdit(map.get(connId), user);
  const value = String(newCredential ?? '');
  if (!value) throw withStatus(new Error('a new credential is required to rotate'), 400);
  if (c.template === 'warehouse') {
    throw withStatus(new Error('Rotate a warehouse credential by re-registering the catalog, not here'), 400);
  }
  if (c.auth === 'oauth') {
    throw withStatus(new Error('This connection uses the OAuth flow — use Connect / Reconnect to re-authorize'), 400);
  }
  // Write the new value over the SAME ref (name + key frozen), then re-fingerprint.
  const ref = putSecret(c.secretRef.name, c.secretRef.key, value);
  c.secretRef = ref;
  c.secretSet = true;
  c.secretFingerprint = secretFingerprint(ref);
  // A rotated credential is UNVERIFIED until the next test — clear a stale needs-reconnect
  // rather than claim health we did not verify (M7 discipline).
  c.health = 'untested';
  c.mode = 'untested';
  c.updatedAt = now();
  map.set(c.id, c);
  writeThrough(c);
  // Audit — NEVER the secret, only the new fingerprint.
  void trace({
    principal: c.principal,
    tool: 'generate',
    input: { action: 'rotate_credential', by: user.id },
    output: { fingerprint: c.secretFingerprint },
    decision: 'allow',
  });
  return c;
}

// -------------------------------------------------------------------- folder ---

/** The folder scope a connection lives in: a Personal connection's folders are the
 *  owner's PERSONAL tree; a Shared/Certified one's folders are the owning DOMAIN's tree.
 *  Mirrors `lib/data/store.folderScopeOf` (grouping by tier/visibility). */
function folderScopeOf(c: Connection): FolderScope {
  return c.visibility === 'Personal' ? 'personal' : 'domain';
}

/** Best-effort: mirror a connection's folder path into the governed folder registry so an
 *  empty folder still shows in the rail. The root is implicit (never a row). createFolder
 *  is idempotent and edit-scoped; any gate failure is swallowed so a successful move is
 *  never rolled back by a folder-registry hiccup (mirrors Data's upsertFolderRow). */
function upsertConnFolderRow(c: Connection, user: CurrentUser): void {
  const path = normaliseFolderPath(c.folder ?? '/');
  if (path === '/') return;
  const principal: FolderPrincipal = { id: user.id, role: user.role, domains: user.domains };
  try {
    createFolder(principal, { tab: 'connections', scope: folderScopeOf(c), path, domain: c.domain });
  } catch {
    /* folder-registry mirror is best-effort; the connection move already succeeded */
  }
}

/**
 * Move a connection into a folder (edit-scoped, write-through like every other mutation).
 * Mirrors `lib/data/store.moveDataset`: the folder is a normalised path on the record; the
 * folder ROOT (personal vs domain tree) is decided by visibility. On move we also upsert an
 * EXPLICIT folder row in the governed registry so the destination folder persists even when
 * it holds no connections. A viewer who cannot edit is rejected 403 and nothing is written.
 *
 * SYNCHRONOUS by design — the shared folder LIFECYCLE + its `ArtifactAdapter` seam are sync,
 * so this reads the already-warm cache via {@link syncCache} (like the Data/Bigbets stores).
 * Purely organisational — it NEVER touches the FROZEN physical identity.
 */
export function moveConnection(connId: string, user: CurrentUser, folder: string): Connection {
  const c = requireConnEdit(syncCache().get(connId), user);
  c.folder = normaliseFolderPath(folder);
  c.updatedAt = now();
  syncCache().set(c.id, c);
  writeThrough(c);
  // The move already passed the connection's edit-scope gate above, so this same-owner
  // folder create can only mirror an authorised move (best-effort; never rolls it back).
  upsertConnFolderRow(c, user);
  return c;
}

/**
 * Recompile the OPA exposure bundle after an ARCHIVE/UNARCHIVE (M3). On archive we snapshot
 * this connection's exposure FQNs and recompile WITHDRAWING them — `activeExposureGovernanceInputs`
 * now skips archived connections, so those tables drop to the fail-closed floor (zero rows).
 * On unarchive the plain recompile re-adds them. Dynamically imported to avoid a static import
 * cycle (exposure-policy imports back into this store). Best-effort + never throws.
 */
async function recompileAfterArchive(connId: string): Promise<void> {
  try {
    const [{ allActiveExposures }, { exposureFqns, recompileExposures }] = await Promise.all([
      import('@/lib/connections/exposures'),
      import('@/lib/connections/exposure-policy'),
    ]);
    const exps = (await allActiveExposures()).filter((e) => e.connectionId === connId);
    const withdraw: string[] = [];
    for (const e of exps) withdraw.push(...(await exposureFqns(e.id)));
    await recompileExposures({ withdraw });
  } catch {
    /* best-effort: a recompile failure never blocks the archive flip */
  }
}

// ------------------------------------ sync lifecycle (for the folder cascade) ---

/**
 * SYNCHRONOUS archive / unarchive / delete used by the folder-lifecycle cascade (the
 * shared `ArtifactAdapter` is sync). Each is the same edit-scoped, write-through behaviour
 * as the async {@link setConnectionArchived} / {@link deleteConnection} — reading the
 * already-warm cache via {@link syncCache} — so a folder archive/restore/delete cascades
 * over member connections identically to Data/Metrics. Archive KEEPS the vault secret; a
 * cascade DELETE purges it (the ONE rule: a "deleted" connection whose credential still
 * lives in Secrets Manager isn't deleted) — the same physical purge the async
 * {@link deleteConnection} runs, done synchronously here (purgeConnectionSecrets is pure +
 * injected sync deleteSecret), so a folder-delete cascade never leaves a live secret behind.
 */
export function setConnectionArchivedSync(connId: string, user: CurrentUser, archived: boolean): Connection {
  const c = requireConnEdit(syncCache().get(connId), user);
  c.archived = archived;
  c.updatedAt = now();
  syncCache().set(c.id, c);
  writeThrough(c);
  // Fire-and-forget recompile so a folder-cascade archive/restore withdraws/re-adds the
  // member connection's exposure FQNs from OPA (M3). The sync seam can't await it.
  void recompileAfterArchive(c.id);
  return c;
}

/** PHYSICAL delete (sync, for the cascade): forget the registry record + OPA profile +
 *  snapshot history, then purge the vault credential/token best-effort. Edit-scoped.
 *  Returns the deleted connection so a caller may follow up. */
export function deleteConnectionSync(connId: string, user: CurrentUser): Connection {
  const map = syncCache();
  const c = requireConnEdit(map.get(connId), user);
  // Tear down what the connection granted (C1) — exposures revoked + OPA withdrawn, bound
  // action adoptions revoked, any live Trino catalog + its credential-copy Secret removed.
  // The folder-cascade seam is SYNC and can't await, so this fires best-effort BEFORE the
  // record delete (teardown filters exposures by connectionId, which survives the delete).
  void import('@/lib/connections/exposure-propagation')
    .then(({ teardownConnection }) => teardownConnection(c, user))
    .catch(() => {});
  unregisterConnectionProfile(c.principal);
  map.delete(connId);
  mirror.deleteThrough(connId);
  versions.purge(connId);
  // Physical: purge the credential + OAuth token (+ Notion MCP client) from the vault —
  // best-effort per target, never silent (mirrors the async deleteConnection's ONE rule).
  purgeConnectionSecrets(c, hasSecret, deleteSecret);
  return c;
}

/**
 * Archive / unarchive a connection: a reversible soft-hide (owner or domain admin). The
 * vault secret + any OAuth token are KEPT — an archived connection reconnects with no
 * re-auth. The OPA profile stays compiled so a restore is instant. Never purges physical.
 */
export async function setConnectionArchived(connId: string, user: CurrentUser, archived: boolean): Promise<Connection> {
  const map = await getCache();
  const c = requireConnEdit(map.get(connId), user);
  c.archived = archived;
  c.updatedAt = now();
  writeThrough(c);
  // Recompile OPA so the archived connection's exposure FQNs drop to the fail-closed floor
  // (and an unarchive re-adds them) — the exposures it fed are frozen while archived (M3).
  await recompileAfterArchive(c.id);
  return c;
}

/** Version history for a connection's capability profile, newest first (edit-scoped). */
export async function listConnectionVersions(connId: string, user: CurrentUser): Promise<ArtifactVersion[]> {
  const map = await getCache();
  requireConnEdit(map.get(connId), user);
  return versions.list(connId);
}

/**
 * Restore a prior capability profile. Auditable + reversible: the current profile is
 * snapshotted first, THEN the chosen version is applied and re-compiled into the OPA
 * mirror. Edit-scoped.
 */
export async function restoreConnectionVersion(connId: string, user: CurrentUser, version: number): Promise<Connection> {
  const map = await getCache();
  const c = requireConnEdit(map.get(connId), user);
  const snap = versions.get(connId, version);
  if (!snap) throw withStatus(new Error(`version ${version} not found`), 404);
  const tools = (snap.state as { tools?: ConnectionTool[] }).tools;
  if (!tools) throw withStatus(new Error(`version ${version} has no restorable profile`), 422);
  versions.record(connId, user.id, snapshotState(c), `restore of v${version}`);
  c.tools = tools;
  c.updatedAt = now();
  map.set(c.id, c);
  compileProfile(c);
  writeThrough(c);
  return c;
}

/**
 * Permanently delete a connection — registry record AND its VAULT secret (the credential
 * plus any stored OAuth token/Notion MCP client, all under `secretRef`). A "deleted"
 * connection whose credential still lives in Secrets Manager isn't deleted: the secret
 * could still be injected. The record delete (profile unregister + registry forget) runs
 * first, then the vault is purged best-effort AS the caller. A secret the vault couldn't
 * forget is reported as `physical` ok:false — the delete stands, the leftover is never
 * silent. Archive KEEPS every vault entry. Returns an honest report.
 */
export async function deleteConnection(connId: string, user: CurrentUser): Promise<PhysicalDeleteReport> {
  const map = await getCache();
  const c = map.get(connId);
  if (!c) return { recordDeleted: false, physical: [] };
  requireConnEdit(c, user);
  // TEAR DOWN what the connection GRANTED before forgetting the record (C1): revoke its
  // exposure sets (freeze/notify + OPA withdraw), revoke the action adoptions bound to
  // them, and remove any live Trino catalog registration + its credential-copy Secret.
  // Runs FIRST, while the exposures/adoptions still resolve; its honest outcomes fold into
  // the report's `physical` list alongside the vault purge.
  const { teardownConnection } = await import('@/lib/connections/exposure-propagation');
  const teardown = await teardownConnection(c, user);
  unregisterConnectionProfile(c.principal);
  map.delete(connId);
  mirror.deleteThrough(connId);
  versions.purge(connId);
  // Physical: purge the credential + OAuth token (+ Notion MCP client) from the vault.
  const physical = [...teardown, ...purgeConnectionSecrets(c, hasSecret, deleteSecret)];
  void trace({
    principal: c.principal,
    tool: 'generate',
    input: { action: 'delete_connection', by: user.id },
    output: { connectionId: c.id, physical }, // secret refs only, never values
    decision: 'allow',
  });
  return { recordDeleted: true, physical };
}

export function __resetConnections(): void {
  const s = connState();
  s.cache = null;
  mirror.__reset();
  versions.__reset();
}

export type { Connection };
