/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { existsSync, readFileSync } from 'fs';
import { scheduleEvery } from '@core/reconcile/runtime';
import { config } from '@core/kernel/config';
import { isHostApproved } from '@tabs/connections/lib/egress-requests';
import { k8s as liveK8s } from '@core/infra/k8s';
import { clearHealthWarning, setHealthWarning } from '@core/infra/health-warnings';
import {
  kubernetesSecretBackend,
  memorySecretBackend,
  type SealedRecord,
  type SecretBackend,
} from '@core/infra/secret-backend';
import {
  fingerprintSecret,
  keyringFromEnv,
  openSecret,
  sealSecret,
  SecretCryptoError,
  type Keyring,
} from '@core/infra/secret-crypto';

/**
 * The connection-credential store (Connections golden path §2, security.md). THE ONE RULE: the
 * secret never leaves the store. A connection RECORD holds only a reference (`{ name, key }`); the
 * raw value is written here, server-side, and NEVER serialized into a record, an API response, a
 * Langfuse trace, or a log line.
 *
 * DURABLE (2026-11-23). This used to be an in-process Map: every os-ui restart lost every stored
 * credential, and the os-ui-worker had its own empty Map. Now:
 *   - Values are SEALED (AES-256-GCM, `secret-crypto.ts`) and kept by a {@link SecretBackend}:
 *     Kubernetes Secrets in the release namespace on a cluster, a Map in local dev/tests.
 *   - The public API stays SYNCHRONOUS (~30 callers read a credential inline): reads come from an
 *     in-process cache HYDRATED at boot (`ensureSecretsHydrated`, awaited by instrumentation.ts and
 *     the worker) and REFRESHED from the backend (`refreshSecrets`: a timer in both pods, and the
 *     worker before an agent tool reads connections), newest `updatedAt` wins. Writes are
 *     WRITE-THROUGH: the cache changes at once and the sealed value goes to the backend; a caller
 *     that must know it landed awaits `awaitSecretWrites()`.
 *   - NO SILENT FALLBACK. Backend selection is explicit (`OS_SECRETS_BACKEND=kubernetes|memory`); unset
 *     means `kubernetes` inside a cluster and `memory` only outside one. A cluster store that cannot be
 *     read or written (no RBAC, no encryption key) is a named health warning on `/api/status`, writes
 *     throw `SecretStoreUnavailableError` — it never quietly degrades to memory.
 *   - Fingerprints are an HMAC under the server key, not an unsalted SHA-256.
 *   - Later: STACKIT Secrets Manager is one more `SecretBackend`.
 */

export type SecretRef = { name: string; key: string };

export class SecretStoreUnavailableError extends Error {
  readonly status = 503;
  constructor(message: string) {
    super(message);
    this.name = 'SecretStoreUnavailableError';
  }
}

export const SECRETS_BACKEND_ENV = 'OS_SECRETS_BACKEND';
/** Health-warning name the store raises while it cannot do its job. */
export const SECRETS_HEALTH = 'connection-secrets';
/** Background refresh period (both pods) and the worker's max staleness before a read. */
export const SECRETS_REFRESH_MS = 15_000;
export const SECRETS_WORKER_MAX_AGE_MS = 5_000;

type Entry = { value: string; updatedAt: string };
type StoreStatus = 'unconfigured' | 'hydrating' | 'ready' | 'failed';
type State = {
  backend: SecretBackend | null;
  ring: Keyring | null;
  status: StoreStatus;
  reason: string;
  cache: Map<string, Entry>;
  /** In-flight writes/deletes by ref — a listing never overrides a ref with one pending. */
  pending: Map<string, Promise<void>>;
  /** Refs whose last durable write failed (the value lives only in this process). */
  failedWrites: Map<string, string>;
  /** Refs present in the backend that this pod cannot decrypt (other key, tampered). */
  unreadable: Map<string, string>;
  /** Refs a listing has contained — only these may be dropped when a later listing lacks them. */
  listed: Set<string>;
  hydrating: Promise<void> | null;
  refreshing: Promise<void> | null;
  refreshedAt: number;
  timer: (() => void) | null;
};

const STATE_KEY = Symbol.for('soa.secrets.store');
function st(): State {
  const g = globalThis as unknown as Record<symbol, State | undefined>;
  if (!g[STATE_KEY]) {
    g[STATE_KEY] = {
      backend: null, ring: null, status: 'unconfigured', reason: '', cache: new Map(), pending: new Map(),
      failedWrites: new Map(), unreadable: new Map(), listed: new Set(), hydrating: null, refreshing: null, refreshedAt: 0, timer: null,
    };
  }
  return g[STATE_KEY]!;
}

function refKey(ref: SecretRef): string {
  return `${ref.name}/${ref.key}`;
}

function inCluster(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.KUBERNETES_SERVICE_HOST);
}

function releaseNamespace(env: NodeJS.ProcessEnv): string {
  // The pod's own namespace (always mounted with the ServiceAccount token), else the configured one.
  const file = `${env.OS_K8S_SA_DIR ?? '/var/run/secrets/kubernetes.io/serviceaccount'}/namespace`;
  const ns = existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
  return ns || env.OS_NAMESPACE || config.deploymentNamespace;
}

function fail(reason: string): void {
  const s = st();
  s.status = 'failed';
  s.reason = reason;
  console.error(`[secrets] connection-credential store UNAVAILABLE — ${reason}`);
  publishHealth();
}

/** Raise/clear the one health warning that describes what the store cannot do right now. */
function publishHealth(): void {
  const s = st();
  const parts: string[] = [];
  if (s.status === 'failed') parts.push(`connection credentials cannot be stored or read: ${s.reason}`);
  if (s.failedWrites.size) parts.push(`${s.failedWrites.size} credential write(s) did not reach the ${s.backend?.kind ?? ''} store and will be lost on restart (last: ${[...s.failedWrites.values()].pop()})`);
  if (s.unreadable.size) parts.push(`${s.unreadable.size} stored credential(s) cannot be decrypted by this pod (${[...new Set(s.unreadable.values())].join('; ')})`);
  if (s.backend?.kind === 'memory' && inCluster(process.env)) parts.push(`${SECRETS_BACKEND_ENV}=memory inside a cluster: connection credentials are NOT durable and are lost on every restart`);
  if (parts.length) setHealthWarning(SECRETS_HEALTH, `Connection secrets: ${parts.join(' | ')}`);
  else clearHealthWarning(SECRETS_HEALTH);
}

/**
 * Select the backend + keyring once per process (lazily, so tests and `npm run dev` need nothing).
 * Exported for tests (`__configureSecretStore`) to inject a backend/keyring per simulated process.
 */
function configure(): State {
  const s = st();
  if (s.status !== 'unconfigured') return s;
  const env = process.env;
  const chosen = (env[SECRETS_BACKEND_ENV] ?? '').trim() || (inCluster(env) ? 'kubernetes' : 'memory');
  if (chosen === 'memory') {
    s.backend = memorySecretBackend();
    try {
      s.ring = keyringFromEnv(env, true);
    } catch (e) {
      fail((e as Error).message);
      return s;
    }
    s.status = 'ready'; // nothing to hydrate: a fresh process's memory store is empty by definition
    publishHealth();
    return s;
  }
  if (chosen !== 'kubernetes') {
    fail(`${SECRETS_BACKEND_ENV}='${chosen}' is not a known backend (kubernetes | memory)`);
    return s;
  }
  try {
    s.ring = keyringFromEnv(env, false);
  } catch (e) {
    fail(e instanceof SecretCryptoError ? e.message : String(e));
    return s;
  }
  s.backend = kubernetesSecretBackend({ namespace: releaseNamespace(env), k8s: liveK8s });
  s.status = 'hydrating';
  return s;
}

/** Apply one complete listing to the cache. Newer wins; pending refs are left alone. */
function applyListing(records: SealedRecord[]): void {
  const s = st();
  const seen = new Set<string>();
  for (const r of records) {
    const k = refKey(r);
    seen.add(k);
    if (s.pending.has(k)) continue;
    try {
      const value = openSecret(s.ring!, r.name, r.key, r.sealed);
      s.unreadable.delete(k);
      const held = s.cache.get(k);
      if (!held || r.updatedAt >= held.updatedAt) s.cache.set(k, { value, updatedAt: r.updatedAt });
      s.listed.add(k);
    } catch (e) {
      // Never guess: an unreadable value is reported (by ref and reason, never content) and not served.
      s.unreadable.set(k, e instanceof SecretCryptoError ? `${e.code}` : 'unreadable');
      s.cache.delete(k);
    }
  }
  for (const k of [...s.listed]) {
    if (seen.has(k) || s.pending.has(k)) continue;
    s.listed.delete(k);
    s.cache.delete(k); // deleted by the other pod
  }
  for (const k of [...s.unreadable.keys()]) if (!seen.has(k)) s.unreadable.delete(k);
}

/** Re-read the backend into the cache (both pods; the other pod's writes and deletes arrive here). */
export async function refreshSecrets(): Promise<void> {
  const s = configure();
  if (!s.backend || s.status === 'failed' || s.status === 'unconfigured') return;
  if (s.refreshing) return s.refreshing;
  s.refreshing = (async () => {
    try {
      const records = await s.backend!.list();
      applyListing(records);
      s.refreshedAt = Date.now();
      if (s.status === 'hydrating') {
        s.status = 'ready';
        console.info(`[secrets] connection-credential store ready (${s.backend!.kind}): ${s.cache.size} credential(s) loaded${s.unreadable.size ? `, ${s.unreadable.size} unreadable` : ''}`);
      }
      publishHealth();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (s.status === 'hydrating') fail(msg);
      else {
        // A refresh outage after a good hydration: keep serving what is held, but say so.
        setHealthWarning(SECRETS_HEALTH, `Connection secrets: refresh failed, serving the credentials loaded at ${new Date(s.refreshedAt).toISOString()} — ${msg}`);
      }
    } finally {
      s.refreshing = null;
    }
  })();
  return s.refreshing;
}

/** Load the store once (boot). Safe to call many times. A failure is recorded loudly, not thrown. */
export async function ensureSecretsHydrated(): Promise<void> {
  const s = configure();
  if (s.status !== 'hydrating') return;
  if (!s.hydrating) s.hydrating = refreshSecrets().finally(() => { st().hydrating = null; });
  return s.hydrating;
}

/** Re-read when the cache is older than `maxAgeMs` (the worker, before an agent tool reads a credential). */
export async function refreshSecretsIfStale(maxAgeMs = SECRETS_WORKER_MAX_AGE_MS): Promise<void> {
  const s = configure();
  if (s.backend?.kind !== 'kubernetes' || s.status !== 'ready') return ensureSecretsHydrated();
  if (Date.now() - s.refreshedAt >= maxAgeMs) await refreshSecrets();
}

/** Start the periodic background refresh in THIS process (idempotent; the timer never holds the process open). */
export function startSecretRefresh(periodMs = SECRETS_REFRESH_MS): boolean {
  const s = configure();
  if (s.backend?.kind !== 'kubernetes' || s.timer) return Boolean(s.timer);
  s.timer = scheduleEvery('connection-secrets refresh', periodMs, refreshSecrets);
  return true;
}

/** What the store is doing — for health, Monitoring, and the needs-reconnect check. */
export function secretStoreStatus(): { backend: 'memory' | 'kubernetes' | null; status: StoreStatus; reason: string; durable: boolean; count: number; unreadable: number; failedWrites: number } {
  const s = configure();
  return {
    backend: s.backend?.kind ?? null,
    status: s.status,
    reason: s.reason,
    durable: s.backend?.kind === 'kubernetes',
    count: s.cache.size,
    unreadable: s.unreadable.size,
    failedWrites: s.failedWrites.size,
  };
}

/** True once the store holds everything the backend held at boot — only then does "absent" mean "lost". */
export function secretStoreReady(): boolean {
  return configure().status === 'ready';
}

function requireWritable(): State {
  const s = configure();
  if (s.status === 'failed' || !s.backend || !s.ring) {
    throw new SecretStoreUnavailableError(`The connection-credential store is unavailable, so the credential was NOT saved: ${s.reason || 'not configured'}`);
  }
  return s;
}

function track(k: string, op: string, p: Promise<void>): void {
  const s = st();
  const run = p.then(
    () => {
      s.failedWrites.delete(k);
      publishHealth();
    },
    (e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      s.failedWrites.set(k, `${op} ${k}: ${msg}`);
      console.error(`[secrets] ${op} of credential ${k} did NOT reach the store — ${msg}`); // the ref, never the value
      publishHealth();
    },
  );
  const tracked = run.finally(() => {
    if (s.pending.get(k) === tracked) s.pending.delete(k);
  });
  s.pending.set(k, tracked);
}

/** Write a credential. Returns ONLY a reference. Durable write-through; see {@link awaitSecretWrites}. */
export function putSecret(name: string, key: string, value: string): SecretRef {
  const s = requireWritable();
  const ref = { name, key };
  const k = refKey(ref);
  const updatedAt = new Date().toISOString();
  const sealed = sealSecret(s.ring!, name, key, value);
  s.cache.set(k, { value, updatedAt });
  s.listed.add(k);
  const prior = s.pending.get(k) ?? Promise.resolve();
  track(k, 'write', prior.then(() => s.backend!.write({ name, key, sealed, updatedAt })));
  return ref;
}

/**
 * Wait for every write/delete this process has started. Throws `SecretStoreUnavailableError` naming
 * the refs when any did not reach the store — so a create/rotate path can refuse instead of claiming
 * a credential is saved that will vanish on the next restart.
 */
export async function awaitSecretWrites(refs?: SecretRef[]): Promise<void> {
  const s = st();
  const keys = refs ? refs.map(refKey) : [...s.pending.keys()];
  await Promise.all(keys.map((k) => s.pending.get(k)).filter(Boolean));
  const failed = keys.filter((k) => s.failedWrites.has(k));
  if (failed.length) throw new SecretStoreUnavailableError(`The credential could not be saved durably (${failed.map((k) => s.failedWrites.get(k)).join('; ')})`);
}

export function hasSecret(ref: SecretRef): boolean {
  return configure().cache.has(refKey(ref));
}

/**
 * A non-reversible, KEYED fingerprint of the stored secret — safe to show/audit. HMAC-SHA256 under a
 * key derived from the deployment's encryption secret, so it cannot be used to test guesses offline.
 */
export function secretFingerprint(ref: SecretRef): string {
  const s = configure();
  const v = s.cache.get(refKey(ref))?.value;
  if (!v || !s.ring) return '';
  return fingerprintSecret(s.ring, v);
}

/**
 * Retrieve a secret SERVER-SIDE only (e.g. for the connection proxy to inject the credential into an
 * outbound call, or to "test" the connection). Callers must never return this value to the client or
 * put it in a trace. Null when absent — including a credential lost before this store was durable
 * (the connection then reads `needs-reconnect`, see the Connections store).
 */
export function getSecretServerSide(ref: SecretRef): string | null {
  return configure().cache.get(refKey(ref))?.value ?? null;
}

export function deleteSecret(ref: SecretRef): void {
  const s = requireWritable();
  const k = refKey(ref);
  s.cache.delete(k);
  s.listed.delete(k);
  const prior = s.pending.get(k) ?? Promise.resolve();
  track(k, 'delete', prior.then(() => s.backend!.remove(ref)));
}

/**
 * TEST HOOK: make THIS (simulated) process use `backend` + `env`-derived keyring, with an empty cache —
 * i.e. a fresh process instance. Call `ensureSecretsHydrated()` afterwards to boot it.
 */
export function __configureSecretStoreForTests(backend: SecretBackend | null, env: NodeJS.ProcessEnv = process.env): void {
  const g = globalThis as unknown as Record<symbol, State | undefined>;
  const old = g[STATE_KEY];
  old?.timer?.();
  delete g[STATE_KEY];
  clearHealthWarning(SECRETS_HEALTH);
  if (!backend) return; // back to lazy env-based selection
  const s = st();
  s.backend = backend;
  try {
    s.ring = keyringFromEnv(env, backend.kind === 'memory');
  } catch (e) {
    s.status = 'hydrating';
    fail((e as Error).message);
    return;
  }
  s.status = 'hydrating';
}

// ------------------------------------------------------------- Egress allowlist --

/**
 * Egress allowlist guardrail (security.md). External endpoints must be on the
 * tenant allowlist (an Admin guardrail; the chart's `egressProxy.allowlist`). We
 * mirror it here so the guardrail is demonstrable offline; the live source of
 * truth is the egress proxy + Cilium FQDN policy.
 */
const DEFAULT_ALLOWLIST = [
  'example.com',
  'github.com',
  // Connections golden-path slice endpoints (also added to egressProxy.allowlist).
  'salesforce.com',
  'my.salesforce.com',
  'login.salesforce.com',
  'notion.com',
  'mcp.notion.com',
  'api.notion.com',
  // Connected-drive OAuth flow: the Google + Microsoft OAuth token endpoints and
  // the Drive / Microsoft Graph APIs the connector reads from (also add these to
  // egressProxy.allowlist + the Cilium FQDN policy on a real deploy).
  'googleapis.com', // www.googleapis.com (Drive) + oauth2.googleapis.com (token)
  'accounts.google.com', // Google authorize endpoint
  'graph.microsoft.com', // OneDrive via Microsoft Graph
  'login.microsoftonline.com', // Microsoft OAuth authorize + token endpoints
  // Connector wave — hand-built typed API clients (each host also added to the chart
  // egressProxy.allowlist + Cilium FQDN policy on a real deploy).
  'api.github.com', // GitHub REST + GraphQL (covered by github.com, listed explicitly)
  'uploads.github.com', // GitHub release/asset uploads
  'api.supabase.com', // Supabase Management API (projects/tables/migrations/advisors/logs)
  'atlassian.net', // Jira + Confluence Cloud sites (*.atlassian.net via subdomain rule)
  'api.atlassian.com', // Atlassian OAuth 3LO gateway (cloudId-scoped API)
  'auth.atlassian.com', // Atlassian OAuth token endpoint
  // Messaging + calendar wave — hand-built typed API clients (bot token / user-provided
  // OAuth access token). Each host also added to the chart egressProxy.allowlist +
  // Cilium FQDN policy on a real deploy.
  'slack.com', // Slack Web API (slack.com/api) + www.slack.com
  'gmail.googleapis.com', // Gmail API
  'oauth2.googleapis.com', // Google OAuth token endpoint (token refresh follow-up)
  // googleapis.com (above) already covers www.googleapis.com — Google Calendar API
  // graph.microsoft.com (above) already covers Outlook + Teams over Microsoft Graph
  // login.microsoftonline.com (above) already covers Microsoft OAuth token endpoint
  // Cloud key-services wave — governance / identity / ML metadata connectors (each
  // host also added to the chart egressProxy.allowlist + Cilium FQDN policy on a
  // real deploy). Entra reuses graph.microsoft.com (already above) — no new host.
  'purview.azure.com', // Microsoft Purview (<account>.purview.azure.com via subdomain rule)
  'api.azureml.ms', // Azure AI Foundry / Azure ML data plane (<region>.api.azureml.ms)
  'ml.azure.com', // Azure ML control-plane / OAuth audience host
  'amazonaws.com', // AWS SageMaker (api.sagemaker.<region>.amazonaws.com via subdomain rule)
  // Cloud key-services wave 2 — GCP identity/IAM governance + Snowflake ACCOUNT_USAGE
  // governance (each host also added to the chart egressProxy.allowlist + Cilium FQDN
  // policy on a real deploy — the operator's step, #176).
  'cloudresourcemanager.googleapis.com', // GCP Cloud Resource Manager (list projects, getIamPolicy)
  'iam.googleapis.com', // GCP IAM (service accounts)
  'admin.googleapis.com', // GCP Admin SDK (optional org/directory reads — reserved)
  // oauth2.googleapis.com (above) already covers the GCP JWT-bearer token exchange
  'snowflakecomputing.com', // Snowflake SQL REST API (<account>.snowflakecomputing.com via subdomain rule)
  // Kajabi public API — sync source (api-batch strategy). Token endpoint + data
  // API share the one host (also added to the chart egressProxy.allowlist +
  // deploy/egress-connectors-overlay.yaml).
  'api.kajabi.com',
  // Operational systems wave — SAP S/4HANA Cloud OData + generic OData V4 (Dynamics 365 /
  // Business Central) + Workday RaaS. Cloud-reachable services only; a customer-specific
  // host not covered here still passes via an Admin-approved egress request. (Also add to
  // the chart egressProxy.allowlist + Cilium FQDN policy on a real deploy.)
  's4hana.cloud.sap', // SAP S/4HANA Cloud (<tenant>.s4hana.cloud.sap via subdomain rule)
  'sap-oauth.cloud.sap', // SAP BTP OAuth token endpoints (client-credentials)
  'ondemand.com', // SAP BTP / Business Technology Platform hosts (*.ondemand.com)
  'sandbox.api.sap.com', // SAP API Business Hub sandbox (public-sandbox verification)
  'api.businesscentral.dynamics.com', // Microsoft Dynamics 365 Business Central OData
  'dynamics.com', // Microsoft Dynamics 365 (<org>.crm.dynamics.com via subdomain rule)
  'workday.com', // Workday RaaS tenant hosts (*.workday.com via subdomain rule)
  'myworkday.com', // Workday RaaS tenant hosts (*.myworkday.com via subdomain rule)
];

function allowlist(): string[] {
  const csv = process.env.OS_EGRESS_ALLOWLIST;
  if (csv && csv.trim().length > 0) {
    return csv.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return DEFAULT_ALLOWLIST;
}

export function egressHost(endpoint: string): string {
  const raw = (endpoint || '').trim();
  try {
    const u = new URL(raw.includes('://') ? raw : `https://${raw}`);
    return u.hostname.toLowerCase();
  } catch {
    return raw.replace(/^[a-z]+:\/\//i, '').split('/')[0].split(':')[0].toLowerCase();
  }
}

/**
 * Strip the surrounding brackets an IPv6 URL host carries (`[::1]` → `::1`) and
 * lowercase, so the literal-IP matchers below see a bare address.
 */
function bareAddr(host: string): string {
  return host.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
}

/**
 * HARD-DENIED egress targets — refused ALWAYS, even if explicitly allowlisted.
 * These IP literals are never a legitimate connector destination and are the
 * classic SSRF pivots:
 *   • cloud-metadata `169.254.169.254` + the whole link-local `169.254.0.0/16`
 *   • IPv4 loopback `127.0.0.0/8`
 *   • IPv6 loopback `::1`
 *   • IPv4-mapped-IPv6 forms of the above (`::ffff:127.0.0.1`, `::ffff:169.254.x`,
 *     and the dotless hex form `::ffff:a9fe:a9fe` for 169.254.169.254)
 * (`localhost` is handled as an internal NAME below; it can be an allowlisted
 * escape-hatch dev target, whereas a raw loopback/metadata literal never is.)
 */
export function isHardDeniedTarget(endpoint: string): boolean {
  const host = bareAddr(egressHost(endpoint));
  if (!host) return false;
  if (host === '::1') return true; // IPv6 loopback
  if (/^127\.\d+\.\d+\.\d+$/.test(host)) return true; // IPv4 loopback 127.0.0.0/8
  if (/^169\.254\.\d+\.\d+$/.test(host)) return true; // link-local incl. metadata 169.254.169.254
  // IPv4-mapped IPv6 (dotted tail): ::ffff:127.0.0.1 / ::ffff:169.254.169.254
  const mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped && isHardDeniedTarget(mapped[1])) return true;
  // IPv4-mapped IPv6 (hex tail): ::ffff:7f00:1 (127.0.0.1), ::ffff:a9fe:a9fe (169.254.169.254)
  const hex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    const oct = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    if (isHardDeniedTarget(oct)) return true;
  }
  return false;
}

/** Is `host` an RFC1918 private IPv4 literal (10/8, 172.16-31/12, 192.168/16)? */
function isRfc1918(host: string): boolean {
  const h = bareAddr(host);
  if (/^10\.\d+\.\d+\.\d+$/.test(h)) return true;
  if (/^192\.168\.\d+\.\d+$/.test(h)) return true;
  const m = h.match(/^172\.(\d+)\.\d+\.\d+$/);
  if (m) {
    const second = Number(m[1]);
    return second >= 16 && second <= 31;
  }
  return false;
}

/**
 * Is this host an INTERNAL / in-cluster / loopback / private target? These are the
 * hosts a user-supplied connector endpoint must NOT be able to reach by default —
 * reaching an in-cluster service (`query-tool`, `trino`, `opa`, `minio`,
 * `kubernetes.default`), loopback, or a private RFC1918 address would be a
 * server-side request forgery (SSRF) into the platform / private network.
 *
 * ACTUAL POLICY (two tiers):
 *   • HARD-DENIED (never egressable, even if allowlisted) — see
 *     `isHardDeniedTarget`: cloud-metadata / link-local `169.254.0.0/16`, loopback
 *     `127.0.0.0/8` + `::1`, and IPv4-mapped-IPv6 forms of these.
 *   • ALLOWLIST-GATED internal (denied UNLESS explicitly allowlisted — legit
 *     on-prem warehouses on RFC1918 may be allowlisted): bare hostnames (no dot,
 *     e.g. `opa`), `*.svc` / `*.cluster.local` / `*.local`, `localhost`, IPv6
 *     link-local `fe80::/10`, and RFC1918 literals (`10/8`, `172.16-31/12`,
 *     `192.168/16`).
 * The real egress enforcement is defence-in-depth OUTSIDE this function too — the
 * egress proxy plus the Cilium FQDN policy at the network boundary.
 */
export function isInternalTarget(endpoint: string): boolean {
  const host = egressHost(endpoint);
  if (!host) return true; // un-parseable / empty → treat as internal (deny by default)
  if (isHardDeniedTarget(endpoint)) return true;
  if (host === 'localhost') return true;
  if (/^\[?fe80:/i.test(host)) return true; // IPv6 link-local fe80::/10
  if (isRfc1918(host)) return true; // private RFC1918 IPv4 literal (allowlist-gated)
  if (/\.(local|cluster\.local|svc)$/.test(host)) return true; // in-cluster / local dev
  if (!host.includes('.')) return true; // bare service name (e.g. "opa", "query-tool")
  return false;
}

/** An endpoint is "external" unless it targets an in-cluster / local host. */
export function isExternal(endpoint: string): boolean {
  const host = egressHost(endpoint);
  if (!host) return false;
  return !isInternalTarget(endpoint);
}

/** Is `host` explicitly present on the egress allowlist (or an Admin-approved request)? */
function onAllowlist(host: string): boolean {
  const list = allowlist();
  return list.some((d) => host === d || host.endsWith(`.${d}`)) || isHostApproved(host);
}

/**
 * Is this endpoint permitted to egress? Subdomains of an allowlisted host pass.
 *
 * DENY-BY-DEFAULT for internal targets: an in-cluster / loopback host is refused
 * UNLESS it is explicitly on the egress allowlist. This closes the SSRF where a
 * signed-in user creates a connector with `endpoint: http://query-tool:8080` (or
 * trino/opa/minio/kubernetes.default.svc) and gets a server-side fetch to an internal
 * service. External hosts still require the allowlist as before.
 */
export function isEgressAllowed(endpoint: string): { external: boolean; host: string; allowed: boolean } {
  const host = egressHost(endpoint);
  // Hard-denied literals (cloud-metadata / link-local / loopback, incl. IPv4-mapped
  // IPv6) are refused ALWAYS — the allowlist cannot re-enable them (SSRF pivots).
  if (isHardDeniedTarget(endpoint)) {
    return { external: false, host, allowed: false };
  }
  const internal = isInternalTarget(endpoint);
  if (internal) {
    // Internal targets are denied unless the operator EXPLICITLY allowlisted them.
    return { external: false, host, allowed: onAllowlist(host) };
  }
  // Allowed if on the static Admin allowlist OR an Admin-approved egress request.
  return { external: true, host, allowed: onAllowlist(host) };
}
