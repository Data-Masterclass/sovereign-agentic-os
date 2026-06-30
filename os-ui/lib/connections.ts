/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { config } from '@/lib/config';
import type { CurrentUser } from '@/lib/auth';
import { canPromote } from '@/lib/session';
import type { Visibility } from '@/lib/artifact-model';
import {
  type Connection,
  type ConnectionTool,
  type ConnectionTemplateKey,
  type CapabilityMode,
  type CapabilityLimits,
  type DataUsage,
  templateByKey,
  isPersonalConnectable,
} from '@/lib/connection-model';
import { putSecret, secretFingerprint, getSecretServerSide, isEgressAllowed } from '@/lib/secrets';
import {
  registerConnectionProfile,
  unregisterConnectionProfile,
  restrictConnectionForAgent,
  authorizeConnectionCall,
  exposedConnectionTools,
  trace,
  type ConnToolPolicy,
} from '@/lib/agent-governed';
import { enqueue } from '@/lib/approvals';
import { adapterFor } from '@/lib/connection-adapters';
import {
  buildPreview,
  matchStandingPolicy,
  rememberPolicy,
  resolveAutonomous,
  effectivePreset,
} from '@/lib/governance';
import { registerBronzeSource, indexToFiles } from '@/lib/data-handoff';
import { logEgress } from '@/lib/egress-requests';

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

let cache: Map<string, Connection> | null = null;
let osHealthy = false;

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

async function osFetch(path: string, init?: RequestInit): Promise<Response | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);
  try {
    return await fetch(`${config.opensearchUrl}${path}`, {
      ...init,
      signal: ctrl.signal,
      cache: 'no-store',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...(init?.headers ?? {}) },
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function writeThrough(c: Connection): void {
  if (!osHealthy) return;
  void osFetch(`/os-connections/_doc/${c.id}?refresh=true`, { method: 'PUT', body: JSON.stringify(c) });
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
  if (cache) return cache;
  const map = new Map<string, Connection>();
  const ping = await osFetch('/os-connections/_count');
  if (ping && ping.ok) {
    osHealthy = true;
    const res = await osFetch('/os-connections/_search?size=500', {
      method: 'POST',
      body: JSON.stringify({ query: { match_all: {} } }),
    });
    if (res && res.ok) {
      const data = (await res.json()) as { hits?: { hits?: { _source: Connection }[] } };
      for (const h of data?.hits?.hits ?? []) {
        const c = h._source;
        map.set(c.id, c);
        compileProfile(c); // re-hydrate the OPA mirror after a restart
      }
    }
  } else {
    osHealthy = false;
  }
  cache = map;
  return map;
}

// ------------------------------------------------------------------- Scoping ---

function visibleToUser(c: Connection, user: CurrentUser): boolean {
  if (c.visibility === 'Personal') return c.owner === user.id;
  if (c.visibility === 'Shared') return user.domains.includes(c.domain);
  return true; // Certified (Marketplace) — discoverable across domains
}

export async function listConnectionsForUser(user: CurrentUser): Promise<Connection[]> {
  const map = await getCache();
  return [...map.values()]
    .filter((c) => visibleToUser(c, user))
    .sort((x, y) => y.updatedAt.localeCompare(x.updatedAt));
}

export async function getConnectionForUser(connId: string, user: CurrentUser): Promise<Connection> {
  const map = await getCache();
  const c = map.get(connId);
  if (!c || !visibleToUser(c, user)) throw withStatus(new Error('Connection not found'), 404);
  return c;
}

function assertBuilderOrAdmin(user: CurrentUser): void {
  if (user.role !== 'builder' && user.role !== 'admin') {
    throw withStatus(new Error('Creating connections requires a Builder or Administrator'), 403);
  }
}

// -------------------------------------------------------------------- Create ---

export async function createConnection(
  user: CurrentUser,
  input: { name: string; template: ConnectionTemplateKey; endpoint: string; credential: string; domain?: string; openApiSpec?: unknown },
): Promise<Connection> {
  const tpl = templateByKey(input.template);
  if (!tpl) throw withStatus(new Error('Unknown connection template'), 400);

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
  const isOwner = c.owner === user.id;
  const isDomainAdmin = user.role === 'admin' && user.domains.includes(c.domain);
  if (!isOwner && !isDomainAdmin) throw withStatus(new Error('Not permitted to edit this connection'), 403);
  if (user.role !== 'builder' && user.role !== 'admin') {
    throw withStatus(new Error('Editing capabilities requires a Builder or Administrator'), 403);
  }

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
export async function testConnection(connId: string, user: CurrentUser): Promise<{ ok: boolean; mode: 'live' | 'offline'; detail: string }> {
  const map = await getCache();
  const c = map.get(connId);
  if (!c || !visibleToUser(c, user)) throw withStatus(new Error('Connection not found'), 404);

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
    if (!canPromote(user.role, 'Personal')) throw withStatus(new Error('Promoting to Shared requires a Builder or Administrator'), 403);
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
  const isOwner = c.owner === user.id;
  const isDomainAdmin = user.role === 'admin' && user.domains.includes(c.domain);
  if (!isOwner && !isDomainAdmin) throw withStatus(new Error('Not permitted to grant this connection'), 403);
  if (user.role !== 'builder' && user.role !== 'admin') {
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
  const result = executeMock(c, tool, args, Boolean(secret));
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
  const isDomainAdmin = (user.role === 'admin' || user.role === 'builder') && user.domains.includes(c.domain);
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

export async function deleteConnection(connId: string, user: CurrentUser): Promise<void> {
  const map = await getCache();
  const c = map.get(connId);
  if (!c) return;
  const isOwner = c.owner === user.id;
  const isDomainAdmin = user.role === 'admin' && user.domains.includes(c.domain);
  if (!isOwner && !isDomainAdmin) throw withStatus(new Error('Not permitted to delete this connection'), 403);
  unregisterConnectionProfile(c.principal);
  map.delete(connId);
  if (osHealthy) void osFetch(`/os-connections/_doc/${connId}?refresh=true`, { method: 'DELETE' });
}

export type { Connection };
