/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import {
  type Schedule,
  type System,
  type Visibility,
  SystemError,
  parseSystem,
  serializeSystem,
} from './system-schema.ts';
import { canPromote } from '../session.ts';
import { type TemplateKey, templateYaml } from './templates.ts';

/**
 * The agent-system store — the MOCK Forgejo repo behind the Agents tab (kind-only,
 * in-process; no STACKIT). Each system persists exactly ONE canonical source file,
 * `system.yaml`. The per-agent `AGENT.md` / `MEMORY.md` are PROJECTIONS of that
 * file's `agents[].agent_md` / `memory_md`, so the canvas, the Monaco file panel
 * and the agent-system chat all edit the same single source (Approach A).
 *
 * Whitelisted paths only: `system.yaml`, `agents/<id>/AGENT.md`,
 * `agents/<id>/MEMORY.md`. Writes use optimistic concurrency (a blob sha), so a
 * stale edit is rejected rather than silently clobbering a concurrent change.
 *
 * Kept free of `server-only`/Next imports so it is unit-testable directly; the API
 * routes are the server boundary that authenticates + scopes callers.
 */

// Single source of truth for roles (now User/Creator/Builder/Admin). Re-exported
// so existing `store.Role` consumers keep working after Governance widened it.
export type Role = import('../session.ts').Role;
export type Principal = { id: string; domains: string[]; role: Role };

export type SystemRecord = {
  id: string;
  name: string;
  domain: string;
  owner: string;
  visibility: Visibility;
  origin: 'authored' | 'forked';
  sourceId?: string;
  running: boolean;
  schedule: Schedule;
  /** Sub-agent ids toggled off inside a running system. */
  disabledAgents: string[];
  /** The single source of truth. */
  yaml: string;
  updatedAt: string;
  lastActivity: string | null;
};

export type SystemSummary = {
  id: string;
  name: string;
  domain: string;
  owner: string;
  visibility: Visibility;
  origin: SystemRecord['origin'];
  running: boolean;
  scheduled: boolean;
  agentCount: number;
  lastActivity: string | null;
};

export type RepoFile = { path: string; content: string; sha: string };

export const WHITELIST_HINT = 'only system.yaml, AGENT.md and MEMORY.md are editable';

/**
 * State container pinned to `globalThis` so it is a TRUE singleton. The Next.js
 * App Router bundles each route handler separately, which otherwise gives every
 * route its own copy of this module — and its own empty `store` Map. A system
 * created via `POST /api/agents/systems` (one route bundle) would then be invisible
 * to `GET /api/agents/systems/[id]/files` (another route bundle), so AGENT.md /
 * MEMORY.md would 404 and never load. Pinning to globalThis makes the record
 * written by one route visible to every other route — and survives dev HMR. (Same
 * reason `lib/marketplace/store.ts` and `lib/approvals.ts` pin their state.)
 */
type AgentsState = { store: Map<string, SystemRecord>; seeded: boolean };
const STATE_KEY = Symbol.for('soa.agents.store');
function state(): AgentsState {
  const g = globalThis as unknown as Record<symbol, AgentsState | undefined>;
  if (!g[STATE_KEY]) g[STATE_KEY] = { store: new Map(), seeded: false };
  return g[STATE_KEY]!;
}

// --------------------------------------------------------------------- utils --

function now(): string {
  return new Date().toISOString();
}

function id(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;
}

/** Stable blob sha for optimistic concurrency (mock Forgejo). */
function sha(content: string): string {
  let h = 0;
  for (let i = 0; i < content.length; i++) h = (Math.imul(31, h) + content.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).padStart(8, '0');
}

function fail(message: string, status: number): never {
  throw new SystemError(message, status);
}

// ------------------------------------------------------------------- seeding --

function starterYaml(name: string, domain: string, visibility: Visibility): string {
  const sys: System = {
    version: '1',
    system: { name, domain, visibility },
    runtime: 'langgraph',
    safetyPreset: 'read-only',
    entrypoint: 'assistant',
    state: { channels: { messages: 'add_messages' } },
    grants: { data: [], knowledge: [], tools: ['search_knowledge'], connections: [] },
    routing: { overrides: {} },
    agents: [
      {
        id: 'assistant',
        role: 'A helpful assistant',
        agent_md: `# ${name}\n\nYou are a helpful assistant in the Sovereign Agentic OS.\nUse only your granted, governed tools.`,
        memory_md: '# Memory\n\n(Durable facts the assistant should always know.)',
        tools: ['search_knowledge'],
      },
    ],
    edges: [],
  };
  return serializeSystem(sys);
}

function record(partial: Omit<SystemRecord, 'updatedAt' | 'lastActivity' | 'running' | 'schedule' | 'disabledAgents' | 'origin'> & Partial<SystemRecord>): SystemRecord {
  return {
    running: false,
    schedule: { kind: 'manual' },
    disabledAgents: [],
    origin: 'authored',
    updatedAt: now(),
    lastActivity: null,
    ...partial,
  };
}

function ensureSeeded(): void {
  // A fresh tenant starts EMPTY. Agent systems are authored only through the
  // platform's own governed flows (e.g. the Northpeak e-commerce seed).
  const s = state();
  if (s.seeded) return;
  s.seeded = true;
}

/** Test hook: wipe the in-process store + reseed. */
export function __resetStore(): void {
  const s = state();
  s.store.clear();
  s.seeded = false;
}

// ------------------------------------------------------------------- scoping --

function get(systemId: string): SystemRecord {
  ensureSeeded();
  const rec = state().store.get(systemId);
  if (!rec) fail('System not found', 404);
  return rec;
}

function canView(rec: SystemRecord, user: Principal): boolean {
  if (rec.owner === user.id) return true;
  if (rec.visibility === 'Shared') return user.domains.includes(rec.domain);
  if (rec.visibility === 'Marketplace') return true;
  return false;
}

function canEdit(rec: SystemRecord, user: Principal): boolean {
  if (rec.owner === user.id) return true;
  return user.role === 'admin' && user.domains.includes(rec.domain);
}

function requireView(systemId: string, user: Principal): SystemRecord {
  const rec = get(systemId);
  if (!canView(rec, user)) fail('Not permitted to view this system', 403);
  return rec;
}

function requireEdit(systemId: string, user: Principal): SystemRecord {
  const rec = get(systemId);
  if (!canEdit(rec, user)) fail('Not permitted to edit this system', 403);
  return rec;
}

// --------------------------------------------------------------------- lists --

function summarise(rec: SystemRecord): SystemSummary {
  let agentCount = 0;
  try {
    agentCount = parseSystem(rec.yaml).agents.length;
  } catch {
    agentCount = 0;
  }
  return {
    id: rec.id,
    name: rec.name,
    domain: rec.domain,
    owner: rec.owner,
    visibility: rec.visibility,
    origin: rec.origin,
    running: rec.running,
    scheduled: rec.schedule.kind !== 'manual',
    agentCount,
    lastActivity: rec.lastActivity,
  };
}

export type SystemGroups = { mine: SystemSummary[]; domain: SystemSummary[]; marketplace: SystemSummary[] };

export function listSystems(user: Principal): SystemGroups {
  ensureSeeded();
  const mine: SystemSummary[] = [];
  const domain: SystemSummary[] = [];
  const marketplace: SystemSummary[] = [];
  for (const rec of state().store.values()) {
    if (rec.owner === user.id) mine.push(summarise(rec));
    else if (rec.visibility === 'Shared' && user.domains.includes(rec.domain)) domain.push(summarise(rec));
    else if (rec.visibility === 'Marketplace') marketplace.push(summarise(rec));
  }
  const byName = (a: SystemSummary, b: SystemSummary) => a.name.localeCompare(b.name);
  return { mine: mine.sort(byName), domain: domain.sort(byName), marketplace: marketplace.sort(byName) };
}

export type SystemView = SystemRecord & { system: System };

export function getSystem(systemId: string, user: Principal): SystemView {
  const rec = requireView(systemId, user);
  return { ...rec, system: parseSystem(rec.yaml) };
}

/**
 * Edit-scoped read of the canonical yaml. The Run / Build / Probe routes use this
 * (not {@link getSystem}) so a mere viewer is rejected (403) BEFORE any
 * side effect — they execute the system (Langfuse traces, Governance approvals),
 * which is an edit-level action, not a view.
 */
export function getSystemForEdit(systemId: string, user: Principal): SystemView {
  const rec = requireEdit(systemId, user);
  return { ...rec, system: parseSystem(rec.yaml) };
}

/**
 * Run-scope authorization — DISTINCT from edit-scope. A domain-Shared system may be
 * RUN (executed) by any Creator+ that belongs to its domain, WITHOUT the right to
 * edit its files or rebuild it. This is the governed "consume a shared agent" path:
 * a course participant (Creator) runs the domain's ready-made Campaign Evaluation
 * Agent but can never mutate it. Owner and in-domain Admin keep full rights (they
 * can also edit ⇒ they can run). Personal systems stay owner-only. Marketplace
 * execution stays edit-scoped (the governed path there is install-to-own/fork), so
 * this widens NOTHING for Marketplace. File WRITES and Build still use
 * {@link getSystemForEdit}, keeping a crisp boundary: run ≠ edit.
 */
function canRun(rec: SystemRecord, user: Principal): boolean {
  if (canEdit(rec, user)) return true;
  if (rec.visibility === 'Shared' && user.domains.includes(rec.domain)) {
    // Any in-domain member (creator+) may RUN a Shared agent; the base
    // role carries `run.attended`. WRITE/Build still route through edit-scope.
    return true;
  }
  return false;
}

export function getSystemForRun(systemId: string, user: Principal): SystemView {
  const rec = get(systemId);
  if (!canRun(rec, user)) fail('Not permitted to run this system', 403);
  return { ...rec, system: parseSystem(rec.yaml) };
}

// ------------------------------------------------------------- create / fork --

export function createSystem(
  user: Principal,
  input: { name: string; domain?: string; yaml?: string; template?: TemplateKey },
): SystemRecord {
  ensureSeeded();
  const domain = input.domain && user.domains.includes(input.domain) ? input.domain : user.domains[0] ?? 'platform';
  // Security: a newly created system is ALWAYS Personal (owner-only). Making it
  // domain-Shared or Marketplace is a governed PROMOTION (`promoteSystem`) that
  // enforces the role ladder — never a client-supplied field at create time.
  const visibility: Visibility = 'Personal';
  const name = input.name.trim() || 'Untitled system';
  // Starter yaml: an explicit yaml (fork), else a server-authored TEMPLATE (never
  // client yaml), else the default blank assistant.
  const yaml = input.yaml ?? (input.template ? templateYaml(input.template, name, domain, visibility) : starterYaml(name, domain, visibility));
  const rec = record({
    id: id('sys'),
    name,
    domain,
    owner: user.id,
    visibility,
    yaml,
  });
  state().store.set(rec.id, rec);
  return rec;
}

/**
 * Promotion ladder for an agent system — the mirror of `promoteArtifact`:
 *   Personal ──(Builder+)──▶ Shared ──(Admin)──▶ Marketplace
 * The actor must belong to the system's domain (Admin spans the tenant via
 * `canEdit`). Forked (installed) copies cannot be re-published. Same-visibility
 * or already-Marketplace calls are rejected. Enforcement is server-side here, so
 * the ladder holds regardless of any client input.
 */
export function promoteSystem(systemId: string, user: Principal): SystemRecord {
  const rec = requireEdit(systemId, user);
  if (rec.origin === 'forked') fail('An installed (forked) system cannot be re-published', 400);
  if (rec.visibility === 'Personal') {
    if (!canPromote(user.role, 'Personal')) fail('Promoting to Shared requires a Builder or Admin', 403);
    rec.visibility = 'Shared';
  } else if (rec.visibility === 'Shared') {
    if (!canPromote(user.role, 'Shared')) fail('Publishing to the Marketplace requires an Admin', 403);
    rec.visibility = 'Marketplace';
  } else {
    fail('This system is already published to the Marketplace', 400);
  }
  rec.updatedAt = now();
  return rec;
}

/**
 * Marketplace install = fork into an independent copy the installer owns.
 * Installing an agent template is a **Builder+** action, mirroring the promotion
 * ladder: a User (participant) or Creator has no Marketplace surface, so they may
 * not pull a public template into a domain either. The gate lives here (the store
 * is the security boundary) so it holds regardless of the client.
 */
export function forkSystem(systemId: string, user: Principal): SystemRecord {
  const src = get(systemId);
  if (src.visibility !== 'Marketplace') fail('Only Marketplace systems can be installed', 400);
  if (user.role !== 'builder' && user.role !== 'admin') {
    fail('Installing a Marketplace agent template requires a Builder or Admin', 403);
  }
  const rec = record({
    id: id('sys'),
    name: src.name,
    domain: user.domains[0] ?? src.domain,
    owner: user.id,
    visibility: 'Personal',
    origin: 'forked',
    sourceId: src.id,
    yaml: src.yaml,
  });
  state().store.set(rec.id, rec);
  return rec;
}

// --------------------------------------------------------------------- files --

function whitelistedPaths(sys: System): string[] {
  const paths = ['system.yaml'];
  for (const a of sys.agents) {
    paths.push(`agents/${a.id}/AGENT.md`, `agents/${a.id}/MEMORY.md`);
  }
  return paths;
}

export function listFiles(systemId: string, user: Principal): { files: string[]; system: System } {
  const rec = requireView(systemId, user);
  const sys = parseSystem(rec.yaml);
  return { files: whitelistedPaths(sys), system: sys };
}

/** Resolve a whitelisted path's content from the single source. */
function project(rec: SystemRecord, path: string): string {
  if (path === 'system.yaml') return rec.yaml;
  const m = /^agents\/([^/]+)\/(AGENT|MEMORY)\.md$/.exec(path);
  if (!m) fail(`Path '${path}' is not editable — ${WHITELIST_HINT}`, 403);
  const sys = parseSystem(rec.yaml);
  const agent = sys.agents.find((a) => a.id === m[1]);
  if (!agent) fail(`Agent '${m[1]}' not found`, 404);
  return m[2] === 'AGENT' ? agent.agent_md : agent.memory_md;
}

export function readFile(systemId: string, user: Principal, path: string): RepoFile {
  const rec = requireView(systemId, user);
  const content = project(rec, path);
  return { path, content, sha: sha(content) };
}

export function writeFile(
  systemId: string,
  user: Principal,
  input: { path: string; content: string; sha: string },
): RepoFile {
  const rec = requireEdit(systemId, user);
  const { path, content } = input;

  // Optimistic concurrency against the CURRENT projected content.
  const current = project(rec, path);
  if (input.sha && input.sha !== sha(current)) {
    fail('The file changed since you opened it (stale sha) — reload and re-apply', 409);
  }

  if (path === 'system.yaml') {
    // Reject syntactically/structurally invalid YAML so the store never holds
    // garbage; semantic graph errors are surfaced later by Build.
    parseSystem(content); // throws SystemError on bad shape
    rec.yaml = content;
  } else {
    const m = /^agents\/([^/]+)\/(AGENT|MEMORY)\.md$/.exec(path);
    if (!m) fail(`Path '${path}' is not editable — ${WHITELIST_HINT}`, 403);
    const sys = parseSystem(rec.yaml);
    const agent = sys.agents.find((a) => a.id === m[1]);
    if (!agent) fail(`Agent '${m[1]}' not found`, 404);
    if (m[2] === 'AGENT') agent.agent_md = content;
    else agent.memory_md = content;
    rec.yaml = serializeSystem(sys); // write back into the ONE source
  }

  rec.updatedAt = now();
  const newContent = project(rec, path);
  return { path, content: newContent, sha: sha(newContent) };
}

// -------------------------------------------------------- run / schedule / toggle --

export function setRunning(systemId: string, user: Principal, running: boolean): SystemRecord {
  const rec = requireEdit(systemId, user);
  rec.running = running;
  rec.updatedAt = now();
  if (running) rec.lastActivity = now();
  return rec;
}

export function setSchedule(systemId: string, user: Principal, schedule: Schedule): SystemRecord {
  const rec = requireEdit(systemId, user);
  rec.schedule = schedule;
  rec.updatedAt = now();
  return rec;
}

export function toggleAgent(systemId: string, user: Principal, agentId: string, on: boolean): SystemRecord {
  const rec = requireEdit(systemId, user);
  const sys = parseSystem(rec.yaml);
  if (!sys.agents.some((a) => a.id === agentId)) fail(`Agent '${agentId}' not found`, 404);
  const set = new Set(rec.disabledAgents);
  if (on) set.delete(agentId);
  else set.add(agentId);
  rec.disabledAgents = [...set];
  rec.updatedAt = now();
  return rec;
}

export function recordActivity(systemId: string): void {
  const rec = state().store.get(systemId);
  if (rec) rec.lastActivity = now();
}

/**
 * UNSCOPED read for the in-cluster scheduler only (a schedule CronJob → the
 * token-authenticated scheduled-run endpoint). There is no human user in a
 * scheduled run, so this bypasses the per-user view scope; the endpoint is gated
 * by the shared runtime bearer instead. Returns null for an unknown system.
 */
export function systemForScheduler(
  systemId: string,
): { yaml: string; domain: string; owner: string; disabledAgents: string[] } | null {
  ensureSeeded();
  const rec = state().store.get(systemId);
  if (!rec) return null;
  // `owner` is exposed so the scheduled-run endpoint can resolve it to the OWNER's
  // live governed identity and run the agent's tools under exactly the owner's
  // rights (delegated identity) — never a service principal.
  return { yaml: rec.yaml, domain: rec.domain, owner: rec.owner, disabledAgents: rec.disabledAgents };
}
