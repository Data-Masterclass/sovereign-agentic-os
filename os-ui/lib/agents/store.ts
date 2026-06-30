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

const store = new Map<string, SystemRecord>();
let seeded = false;

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
    entrypoint: 'assistant',
    state: { channels: { messages: 'add_messages' } },
    grants: { data: [], knowledge: [], tools: ['retrieve'], connections: [] },
    routing: { overrides: {} },
    agents: [
      {
        id: 'assistant',
        role: 'A helpful assistant',
        agent_md: `# ${name}\n\nYou are a helpful assistant in the Sovereign Agentic OS.\nUse only your granted, governed tools.`,
        memory_md: '# Memory\n\n(Durable facts the assistant should always know.)',
        tools: ['retrieve'],
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
  if (seeded) return;
  seeded = true;
}

/** Test hook: wipe the in-process store + reseed. */
export function __resetStore(): void {
  store.clear();
  seeded = false;
}

// ------------------------------------------------------------------- scoping --

function get(systemId: string): SystemRecord {
  ensureSeeded();
  const rec = store.get(systemId);
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
  for (const rec of store.values()) {
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

// ------------------------------------------------------------- create / fork --

export function createSystem(
  user: Principal,
  input: { name: string; domain?: string; visibility?: Visibility; yaml?: string },
): SystemRecord {
  ensureSeeded();
  const domain = input.domain && user.domains.includes(input.domain) ? input.domain : user.domains[0] ?? 'platform';
  const visibility = input.visibility ?? 'Personal';
  const rec = record({
    id: id('sys'),
    name: input.name.trim() || 'Untitled system',
    domain,
    owner: user.id,
    visibility,
    yaml: input.yaml ?? starterYaml(input.name.trim() || 'Untitled system', domain, visibility),
  });
  store.set(rec.id, rec);
  return rec;
}

/** Marketplace install = fork into an independent copy the installer owns. */
export function forkSystem(systemId: string, user: Principal): SystemRecord {
  const src = get(systemId);
  if (src.visibility !== 'Marketplace') fail('Only Marketplace systems can be installed', 400);
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
  store.set(rec.id, rec);
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
  const rec = store.get(systemId);
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
): { yaml: string; domain: string; disabledAgents: string[] } | null {
  ensureSeeded();
  const rec = store.get(systemId);
  if (!rec) return null;
  return { yaml: rec.yaml, domain: rec.domain, disabledAgents: rec.disabledAgents };
}
