/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { config } from '@/lib/core/config';
import { osMirror } from '@/lib/infra/os-mirror';
import type { CurrentUser } from '@/lib/core/auth';
import { canPromote, roleAtLeast } from '@/lib/core/session';
import { canManageArtifact } from '@/lib/governance/edit-scope';
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
  templateByKey,
  isPersonalConnectable,
} from '@/lib/connections/schema';
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
import type { WarehousePlatform } from '@/lib/connections/warehouse/types';
import { splitWarehouseFields, toWarehouseSource } from '@/lib/connections/warehouse/connection';
import { providerFor } from '@/lib/connections/warehouse/registry';
import { buildImportCtas } from '@/lib/connections/warehouse/import';
import { catalogRegistration, type CatalogRegistration } from '@/lib/connections/warehouse/registration';
import { applyLiveRegistration, type RegK8s, type RegisterK8sOutcome, type SecretValues } from '@/lib/connections/warehouse/k8s-registration';
import { executeRun, queryRun, type ExecuteIdentity } from '@/lib/infra/governed';
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

// ------------------------------------------------------------------- Scoping ---

function visibleToUser(c: Connection, user: CurrentUser): boolean {
  if (c.visibility === 'Personal') return c.owner === user.id;
  if (c.visibility === 'Shared') return user.domains.includes(c.domain);
  return true; // Certified (Marketplace) — discoverable across domains
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

export async function getConnectionForUser(connId: string, user: CurrentUser): Promise<Connection> {
  const map = await getCache();
  const c = map.get(connId);
  if (!c || !visibleToUser(c, user)) throw withStatus(new Error('Connection not found'), 404);
  return c;
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

export async function createConnection(
  user: CurrentUser,
  input: { name: string; template: ConnectionTemplateKey; endpoint: string; credential: string; domain?: string; openApiSpec?: unknown; warehouse?: WarehouseCreateInput; omService?: string; airflow?: AirflowCreateInput },
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
  const slug = slugify(`${name}-${user.id}`);
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
      id: id('conn'),
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

  // Egress guardrail: an external endpoint must be on the allowlist (Admin
  // guardrail; or an Admin-approved request). Checked BEFORE any credential use.
  const egress = isEgressAllowed(endpoint);
  if (egress.external && !egress.allowed) {
    throw withStatus(
      new Error(`Endpoint host "${egress.host}" is not on the egress allowlist — request access and an Administrator must approve it first`),
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
    id: id('conn'),
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
  if (!canManageArtifact(user, { owner: c.owner, domain: c.domain })) {
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
      c.updatedAt = now();
      writeThrough(c);
      return { ok: true, mode: 'offline', detail: `Config valid for ${provider.label}. No safe live probe exists (${provider.testProbe.reason}) — reachability is the operator's step on a live tenant.` };
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
      c.updatedAt = now();
      writeThrough(c);
      return { ok: true, mode: 'offline', detail: `Config valid; catalog '${c.warehouse.catalog}' is not queryable yet (${(e as Error).message}). Register it in Trino (values.trino.externalCatalogs) + rolling-restart, then re-test.` };
    }
  }

  // AIRFLOW: the honest test is a real, unauthenticated health probe against the
  // Airflow REST API (v2 /api/v2/monitor/health, falling back to v1 /api/v1/health).
  // ANY HTTP response ⇒ Airflow is reachable (live); a network error/timeout ⇒
  // offline. Never a stub — and the credential is never sent on the health probe.
  if (c.template === 'airflow') {
    const h = await airflowHealth(airflowConnFor(c));
    c.mode = h.connected ? 'live' : 'offline';
    c.health = h.connected ? 'healthy' : 'needs-reconnect';
    c.updatedAt = now();
    writeThrough(c);
    return h.connected
      ? { ok: true, mode: 'live', detail: `Airflow at ${c.egress.host} is reachable${h.detail ? ` (${h.detail})` : ''}. The token is never sent on the health probe.` }
      : { ok: false, mode: 'offline', detail: `Airflow at ${c.egress.host} is unreachable (${h.reason ?? 'network error'}) — check the base URL + egress, then re-test.` };
  }

  const secret = getSecretServerSide(c.secretRef); // server-side only
  if (!secret) {
    return { ok: false, mode: 'offline', detail: 'No credential set in Secrets Manager for this connection.' };
  }

  // Best-effort reachability probe (never sends/echoes the secret in our response).
  let mode: 'live' | 'offline' = 'offline';
  if (c.egress.external && c.egress.allowed) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    try {
      await fetch(c.endpoint, { method: 'HEAD', signal: ctrl.signal, cache: 'no-store' });
      mode = 'live';
    } catch {
      mode = 'offline';
    } finally {
      clearTimeout(timer);
    }
  }

  c.mode = mode;
  c.health = 'healthy'; // silent OAuth refresh keeps it healthy; hard failure → needs-reconnect
  c.updatedAt = now();
  map.set(c.id, c);
  writeThrough(c);
  return {
    ok: true,
    mode,
    detail:
      mode === 'live'
        ? `Reached ${c.egress.host}; credential present (${c.secretFingerprint}). Egress allowed.`
        : `Credential present in Secrets Manager (${c.secretFingerprint}); endpoint not probed offline. The secret is never sent to the browser.`,
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
  if (!canManageArtifact(user, { owner: c.owner, domain: c.domain })) {
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
 * IMPORT a federated external table into the OS Iceberg lakehouse as an owned data
 * product — a governed CTAS run through the SAME `executeRun` promote/materialize
 * path (Trino→OPA as the caller). Requires the provider to support import and the
 * caller to be able to edit the connection. Returns the target FQN + the SQL run.
 */
export async function importWarehouseTable(
  connId: string,
  user: CurrentUser,
  input: { schema: string; table: string; name?: string; targetDomain?: string },
): Promise<{ ok: true; target: string; sql: string; rowsAffected: number | null }> {
  const map = await getCache();
  const c = map.get(connId);
  if (!c || !visibleToUser(c, user)) throw withStatus(new Error('Connection not found'), 404);
  if (c.template !== 'warehouse' || !c.warehouse) throw withStatus(new Error('Not a warehouse connection'), 400);
  if (!canManageArtifact(user, { owner: c.owner, domain: c.domain })) {
    throw withStatus(new Error('Not permitted to import from this connection'), 403);
  }
  const provider = providerFor(c.warehouse.platform);
  if (!provider.capabilities.import) {
    throw withStatus(new Error(`${provider.label} does not support import-as-product`), 400);
  }
  const targetDomain = input.targetDomain && user.domains.includes(input.targetDomain) ? input.targetDomain : c.domain;
  const name = (input.name ?? input.table).trim();
  let sql: string;
  try {
    sql = buildImportCtas(
      { domain: targetDomain, name },
      { catalog: c.warehouse.catalog, schema: input.schema, table: input.table },
    );
  } catch (e) {
    throw withStatus(e as Error, (e as Error & { status?: number }).status ?? 400);
  }
  const res = await executeRun(sql, executeIdentity(user), targetDomain);
  const target = `iceberg.${targetDomain}.${name}`;
  void trace({
    principal: c.principal,
    tool: 'generate',
    input: { action: 'import_warehouse_table', by: user.id, source: `${c.warehouse.catalog}.${input.schema}.${input.table}` },
    output: { target, rowsAffected: res.rowsAffected },
    decision: 'allow',
  });
  return { ok: true, target, sql, rowsAffected: res.rowsAffected };
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
    if (!canManageArtifact(user, { owner: c.owner, domain: c.domain })) {
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
  if (!canManageArtifact(user, { owner: c.owner, domain: c.domain })) {
    throw withStatus(new Error('Not permitted to grant this connection'), 403);
  }
  if (!roleAtLeast(user.role, 'builder')) {
    throw withStatus(new Error('Granting a connection requires a Builder or Administrator'), 403);
  }

  // The grant can only narrow: read-only -> the Read tools; full -> all EXPOSED tools.
  const exposed = exposedConnectionTools(c.principal);
  const readTools = c.tools.filter((t) => t.mode === 'Read').map((t) => t.name);
  const allowedTools = scope === 'read-only' ? readTools : exposed;

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
  const authz = authorizeConnectionCall(c.principal, tool, args, input.asAgent);

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
    const before = readBefore(c, tool, args);
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

/** Execute an allowed call: inject the secret SERVER-SIDE (never logged), trace + log egress. */
async function runAllow(
  c: Connection,
  tool: string,
  args: Record<string, unknown>,
  asAgent: string | undefined,
  reason: string,
  mode?: string,
): Promise<ToolCallResult> {
  const secret = getSecretServerSide(c.secretRef);
  // Airflow tools hit the REAL REST API (the secret is injected server-side inside
  // the client and never logged); every other connector uses the offline mock.
  const result = c.template === 'airflow'
    ? await executeAirflow(c, tool, args)
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

/** A before-snapshot for the approval diff (seed-backed offline). */
function readBefore(c: Connection, tool: string, args: Record<string, unknown>): Record<string, unknown> {
  const cur = executeMock(c, tool.replace(/^update_/, 'read_'), args, true) as Record<string, unknown>;
  const obj = (cur.opportunity ?? cur.account ?? cur.page ?? {}) as Record<string, unknown>;
  return obj;
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
  const authz = authorizeConnectionCall(c.principal, tool, args);
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

function executeMock(c: Connection, tool: string, args: Record<string, unknown>, credentialPresent: boolean): unknown {
  const base = { connection: c.name, credentialInjectedServerSide: credentialPresent };
  switch (tool) {
    case 'notion_search':
      return { ...base, results: [{ id: 'pg_demo', title: 'Q3 Planning', url: 'notion://pg_demo' }] };
    case 'notion_get_page':
      return { ...base, page: { id: String(args.id ?? 'pg_demo'), title: 'Q3 Planning', blocks: 12 } };
    case 'read_account':
      return { ...base, account: { id: String(args.id ?? 'acct-1'), name: 'Sample Account', owner: 'Sales', arr: 48000 } };
    case 'read_opportunity':
      return { ...base, opportunity: { id: String(args.id ?? 'OPP-1'), account: 'Sample Account', amount: 42000, stage: 'Renewal' } };
    case 'update_opportunity_amount':
      return { ...base, updated: { id: String(args.id ?? 'OPP-1'), amount: Number(args.amount ?? 0) } };
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
  if (!canManageArtifact(user, { owner: c.owner, domain: c.domain })) {
    throw withStatus(new Error('Not permitted to modify this connection'), 403);
  }
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
  unregisterConnectionProfile(c.principal);
  map.delete(connId);
  mirror.deleteThrough(connId);
  versions.purge(connId);
  // Physical: purge the credential + OAuth token (+ Notion MCP client) from the vault.
  const physical = purgeConnectionSecrets(c, hasSecret, deleteSecret);
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
