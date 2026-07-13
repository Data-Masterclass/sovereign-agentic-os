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
  assertGrantsWithinRole,
} from './system-schema.ts';
import { canPromote, roleAtLeast } from '../core/session.ts';
import { type TemplateKey, templateYaml } from './templates.ts';
import { canManageArtifact } from '../governance/edit-scope.ts';
import { osMirror } from '../infra/os-mirror.ts';
import { type ArtifactVersion, versionLog } from '../core/versioning.ts';

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
export type Role = import('../core/session.ts').Role;
export type Principal = { id: string; domains: string[]; role: Role };

/** One row in the per-tool build report (mirrors BuildRow from lib/agents/build/adapter.ts). */
export type LastBuildRow = {
  tool: string;
  applied: boolean;
  verified: boolean;
  status: 'ok' | 'fail' | 'pending';
  detail: string;
  error?: string;
};

/** The last build outcome persisted server-side so it survives tab-switches + reloads. */
export type LastBuild = { ok: boolean; at: number; rows: LastBuildRow[] };

/**
 * Lightweight in-progress marker written at the START of a build or run and
 * cleared in the route's `finally` block. A returning user sees "building since
 * …" / "running since …" rather than a stale blank slate.
 */
export type ActivityMarker = { kind: 'building' | 'running'; startedAt: number };

/** The last interactive run report — persisted so navigating away and back does not wipe it. */
export type LastRun = {
  at: number;
  running: boolean;
  ok: boolean;
  path: string[];
  traces: number;
  held: number;
  steps: { node: string; tool: string; effect: string; ran?: boolean }[];
  /**
   * The per-agent drill-down for a team run (input given, output produced, status,
   * per-step args→result). Persisted so the per-agent cards survive a tab-switch /
   * reseed — without it a reload falls back to the flat step table. Absent for
   * single-agent runs.
   */
  nodes?: {
    node: string;
    model?: string;
    /** AUTO per-node routing: the resolved tier + why, so the drill-down explains the model. */
    tier?: 'fast' | 'reasoning';
    tierReason?: string;
    status: string;
    error?: string;
    input?: string;
    finalText?: string;
    steps: { tool: string; isError?: boolean; summary?: string; args?: string; result?: string }[];
  }[];
  output?: string;
  mode?: 'live' | 'offline-mock';
  traceStoreAvailable?: boolean;
  traceUrl?: string;
};

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
  /** Last build outcome. Absent on records created before this field was added. */
  lastBuild?: LastBuild;
  /** In-progress marker: set at start of build/run, cleared in finally. */
  activity?: ActivityMarker;
  /** Last interactive run report. Absent until the first run completes. */
  lastRun?: LastRun;
  /** Soft-archived: hidden from the working lists, reversible, retained. */
  archived?: boolean;
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
  /**
   * True when a Personal system has a pending Personal→Shared promotion filed
   * (owner filed `request_promotion`, a Builder/Admin has not yet approved). Left
   * undefined by the store; the API route decorates it from the approvals queue so
   * the list can honestly show "pending share approval" instead of looking inert.
   */
  pendingShare?: boolean;
  /** Soft-archived (retained, reversible). Absent/false = live. */
  archived?: boolean;
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
type AgentsState = { store: Map<string, SystemRecord>; seeded: boolean; hydration: Promise<void> | null };
const STATE_KEY = Symbol.for('soa.agents.store');
function state(): AgentsState {
  const g = globalThis as unknown as Record<symbol, AgentsState | undefined>;
  if (!g[STATE_KEY]) g[STATE_KEY] = { store: new Map(), seeded: false, hydration: null };
  return g[STATE_KEY]!;
}

// ---------------------------------------------------- durable mirror (best-effort) --
const mirror = osMirror({
  index: 'os-agent-systems',
  createBody: {
    mappings: {
      properties: {
        id: { type: 'keyword' },
        owner: { type: 'keyword' },
        domain: { type: 'keyword' },
        visibility: { type: 'keyword' },
        origin: { type: 'keyword' },
        sourceId: { type: 'keyword' },
        updatedAt: { type: 'date' },
        lastActivity: { type: 'date' },
        name: { type: 'keyword' },
        running: { type: 'boolean' },
        yaml: { type: 'text', index: false },
        schedule: { type: 'object', enabled: false },
        disabledAgents: { type: 'keyword' },
        lastBuild: { type: 'object', enabled: false },
        activity: { type: 'object', enabled: false },
        lastRun: { type: 'object', enabled: false },
        archived: { type: 'boolean' },
      },
    },
  },
});

// Durable, per-artifact version history (reused across the OS). A system's
// canonical `yaml` is snapshotted here on every meaningful edit + on restore.
const versions = versionLog('agent-system');

function writeThrough(rec: SystemRecord): void {
  mirror.writeThrough(rec.id, rec);
}

/** The versioned slice of a system record — the single source (system.yaml). */
function snapshotState(rec: SystemRecord): { yaml: string } {
  return { yaml: rec.yaml };
}

export async function ensureHydrated(): Promise<void> {
  const s = state();
  if (!s.hydration) s.hydration = Promise.all([hydrate(), versions.ensureHydrated()]).then(() => {});
  return s.hydration;
}

async function hydrate(): Promise<void> {
  const s = state();
  const docs = (await mirror.hydrate(2000)) ?? [];
  for (const rec of docs as SystemRecord[]) {
    if (rec && rec.id && !s.store.has(rec.id)) s.store.set(rec.id, rec);
  }
  s.seeded = true;
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
    grants: { data: [], knowledge: [], metrics: [], tools: ['search_knowledge'], connections: [] },
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
  s.hydration = null;
  mirror.__reset();
  versions.__reset();
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
  // Fail-closed edit-scope: owner, domain_admin of the owning domain, or admin.
  return canManageArtifact(user, { owner: rec.owner, domain: rec.domain });
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
    archived: rec.archived ?? false,
  };
}

export type SystemGroups = { mine: SystemSummary[]; domain: SystemSummary[]; marketplace: SystemSummary[] };

/**
 * The caller's systems, grouped. Archived systems are HIDDEN by default (soft
 * archive) — the owner/Admin can list them explicitly via `includeArchived` to
 * restore or delete. A shared/marketplace system, once archived by its owner,
 * disappears from everyone's domain/marketplace list too.
 */
export function listSystems(user: Principal, opts: { includeArchived?: boolean } = {}): SystemGroups {
  ensureSeeded();
  const mine: SystemSummary[] = [];
  const domain: SystemSummary[] = [];
  const marketplace: SystemSummary[] = [];
  for (const rec of state().store.values()) {
    if (rec.archived && !opts.includeArchived) continue;
    if (rec.owner === user.id) mine.push(summarise(rec));
    else if (rec.visibility === 'Shared' && user.domains.includes(rec.domain)) domain.push(summarise(rec));
    else if (rec.visibility === 'Marketplace') marketplace.push(summarise(rec));
  }
  const byName = (a: SystemSummary, b: SystemSummary) => a.name.localeCompare(b.name);
  return { mine: mine.sort(byName), domain: domain.sort(byName), marketplace: marketplace.sort(byName) };
}

/**
 * Decorate the caller's groups with `pendingShare` for any Personal system that has
 * a promotion request in flight (the ids come from the approvals queue, resolved in
 * the API route — this stays pure/store-only). Pure + non-mutating so it is unit
 * testable without the server-only approvals module.
 */
export function markPendingShares(groups: SystemGroups, pendingIds: ReadonlySet<string>): SystemGroups {
  if (pendingIds.size === 0) return groups;
  const mark = (s: SystemSummary): SystemSummary =>
    s.visibility === 'Personal' && pendingIds.has(s.id) ? { ...s, pendingShare: true } : s;
  return {
    mine: groups.mine.map(mark),
    domain: groups.domain.map(mark),
    marketplace: groups.marketplace.map(mark),
  };
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
  writeThrough(rec);
  return rec;
}

/**
 * Governed offboard support: transfer this owner's PERSONAL-lane records to a new
 * owner (used by lib/platform-admin/offboard.ts when a user is offboarded with
 * reassignment). Only personal, owner-only artifacts move; shared/domain/certified
 * are untouched. Returns the count moved.
 */
export function reassignOwner(fromId: string, toId: string): number {
  let moved = 0;
  for (const rec of state().store.values()) {
    if (rec.owner !== fromId) continue;
    if (rec.visibility !== 'Personal') continue; // personal lane only
    rec.owner = toId;
    rec.updatedAt = now();
    writeThrough(rec);
    moved++;
  }
  return moved;
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
    if (!canPromote(user.role, 'Personal')) fail('Promoting to Shared requires a Domain admin or Admin', 403);
    rec.visibility = 'Shared';
  } else if (rec.visibility === 'Shared') {
    if (!canPromote(user.role, 'Shared')) fail('Publishing to the Marketplace requires an Admin', 403);
    rec.visibility = 'Marketplace';
  } else {
    fail('This system is already published to the Marketplace', 400);
  }
  rec.updatedAt = now();
  writeThrough(rec);
  return rec;
}

/**
 * Demotion (revoke sharing) — the reverse of `promoteSystem`, one step down:
 *   Marketplace ──(Admin)──▶ Shared ──(owner | in-domain Builder+)──▶ Personal
 * Marketplace→Shared is Admin-only (only an Admin published it); Shared→Personal is
 * the owner or an in-domain Builder/Admin (mirrors who could have promoted it).
 * Forked (installed) copies have no shared lineage to revoke. Never deletes the
 * system; only lowers its visibility. Server-side enforcement, so the gate holds.
 */
export function demoteSystem(systemId: string, user: Principal): SystemRecord {
  const rec = get(systemId);
  if (rec.origin === 'forked') fail('An installed (forked) system has no sharing to revoke', 400);
  if (!user.domains.includes(rec.domain)) fail('You can only revoke sharing on systems in a domain you belong to', 403);
  if (rec.visibility === 'Marketplace') {
    if (user.role !== 'admin') fail('Revoking from the Marketplace requires an Admin', 403);
    rec.visibility = 'Shared';
  } else if (rec.visibility === 'Shared') {
    if (!canManageArtifact(user, { owner: rec.owner, domain: rec.domain })) {
      fail('Unsharing requires the owner, an in-domain Domain admin, or an Admin', 403);
    }
    rec.visibility = 'Personal';
  } else {
    fail('This system is already personal — nothing to revoke', 400);
  }
  rec.updatedAt = now();
  writeThrough(rec);
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
  if (!roleAtLeast(user.role, 'builder')) {
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
  writeThrough(rec);
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
  if (content === current) return { path, content, sha: sha(content) }; // no-op edit → no version churn

  // Snapshot the PRIOR canonical source before overwriting it, so every
  // meaningful edit is restorable from the version history.
  versions.record(rec.id, user.id, snapshotState(rec), `edit ${path}`);

  if (path === 'system.yaml') {
    // Reject syntactically/structurally invalid YAML so the store never holds
    // garbage; semantic graph errors are surfaced later by Build.
    const parsed = parseSystem(content); // throws SystemError on bad shape
    // Governance escalation guard: a direct-write (Write-bounded) grant on any
    // artifact is builder-only. Enforced here at the ONE save chokepoint so a
    // crafted client payload can't grant an agent direct write when its owner is
    // only a creator. The editor is the owner (self-edit) or a same-domain admin
    // (builder+) — either way the saver's role is the authority for the grant.
    // Only the DELTA vs the currently-stored system is checked: a pre-existing
    // direct-write grant never blocks an unrelated edit — it is instead
    // neutralised at run time by downgradeGrantsForRole.
    assertGrantsWithinRole(parsed, user.role, parseSystem(current));
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
  writeThrough(rec);
  const newContent = project(rec, path);
  return { path, content: newContent, sha: sha(newContent) };
}

// -------------------------------------------------------- run / schedule / toggle --

export function setRunning(systemId: string, user: Principal, running: boolean): SystemRecord {
  const rec = requireEdit(systemId, user);
  rec.running = running;
  rec.updatedAt = now();
  if (running) rec.lastActivity = now();
  writeThrough(rec);
  return rec;
}

export function setSchedule(systemId: string, user: Principal, schedule: Schedule): SystemRecord {
  const rec = requireEdit(systemId, user);
  rec.schedule = schedule;
  rec.updatedAt = now();
  writeThrough(rec);
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
  writeThrough(rec);
  return rec;
}

export function recordActivity(systemId: string): void {
  const rec = state().store.get(systemId);
  if (rec) rec.lastActivity = now();
  if (rec) writeThrough(rec);
}

export function setLastBuild(systemId: string, user: Principal, build: LastBuild): SystemRecord {
  const rec = requireEdit(systemId, user);
  rec.lastBuild = build;
  rec.updatedAt = now();
  writeThrough(rec);
  return rec;
}

/**
 * Mark a build or run as in-progress. Written at the START of the operation so a
 * returning user sees the "building since…/running since…" state even before the
 * operation finishes. The corresponding route clears it in `finally` via
 * {@link clearActivity}.
 */
export function setActivity(systemId: string, marker: ActivityMarker): void {
  const rec = state().store.get(systemId);
  if (!rec) return;
  rec.activity = marker;
  writeThrough(rec);
}

/** Clear the in-progress marker once a build or run completes (or errors). */
export function clearActivity(systemId: string): void {
  const rec = state().store.get(systemId);
  if (!rec) return;
  delete rec.activity;
  writeThrough(rec);
}

/**
 * Persist the last interactive run report so it survives tab-switches and page
 * reloads. Mirrored the same way as {@link setLastBuild}: edit-scoped so a mere
 * viewer or run-only consumer cannot overwrite the record. The route calls this
 * immediately after a successful run.
 */
export function setLastRun(systemId: string, user: Principal, run: LastRun): SystemRecord {
  const rec = requireEdit(systemId, user);
  rec.lastRun = run;
  rec.updatedAt = now();
  writeThrough(rec);
  return rec;
}

// ------------------------------------------------ archive / delete / versions --

/**
 * Archive a system: a reversible soft-hide that also STOPS it (an archived
 * agent must not keep running). Edit-scoped — only the owner or an in-domain
 * Admin may archive, exactly like editing it. The record + its history are
 * retained; the system just leaves the working lists until unarchived.
 */
export function archiveSystem(systemId: string, user: Principal): SystemRecord {
  const rec = requireEdit(systemId, user);
  rec.archived = true;
  rec.running = false;
  rec.updatedAt = now();
  writeThrough(rec);
  return rec;
}

/** Restore an archived system back into the working lists (edit-scoped). */
export function unarchiveSystem(systemId: string, user: Principal): SystemRecord {
  const rec = requireEdit(systemId, user);
  rec.archived = false;
  rec.updatedAt = now();
  writeThrough(rec);
  return rec;
}

/**
 * Permanently delete a system + its version history (edit-scoped, irreversible).
 * The API route confirms intent; this is the hard delete once confirmed. Returns the
 * deleted record so the route can PHYSICALLY purge its backing resources (its Forgejo
 * repo + any schedule CronJob) via physical-delete.ts — a "deleted" system whose repo
 * or CronJob still exists isn't deleted. Archive (above) never purges either.
 */
export function deleteSystem(systemId: string, user: Principal): SystemRecord {
  const rec = requireEdit(systemId, user);
  state().store.delete(rec.id);
  mirror.deleteThrough(rec.id);
  versions.purge(rec.id);
  return rec;
}

/** Version history for a system, newest first (view-scoped). */
export function listSystemVersions(systemId: string, user: Principal): ArtifactVersion[] {
  requireView(systemId, user);
  return versions.list(systemId);
}

/**
 * Restore a prior version of a system's canonical source. Restore is itself
 * auditable + reversible: the CURRENT state is snapshotted as a new version
 * first, THEN the chosen version's yaml is applied. Edit-scoped. The restored
 * yaml is re-validated (never trust stored garbage) before it goes live.
 */
export function restoreSystemVersion(systemId: string, user: Principal, version: number): SystemRecord {
  const rec = requireEdit(systemId, user);
  const snap = versions.get(systemId, version);
  if (!snap) fail(`Version ${version} not found`, 404);
  const restored = (snap.state as { yaml?: string }).yaml;
  if (typeof restored !== 'string') fail(`Version ${version} has no restorable source`, 422);
  parseSystem(restored); // reject a corrupt snapshot rather than go live with it
  // Snapshot the live state first so the restore can itself be undone.
  versions.record(systemId, user.id, snapshotState(rec), `restore of v${version}`);
  rec.yaml = restored;
  rec.updatedAt = now();
  writeThrough(rec);
  return rec;
}

/**
 * Apply a yaml restored from an EXTERNAL source of truth (a Forgejo commit, via
 * git-versioning) onto the live record. Edit-scoped + validated (never trust an
 * externally-supplied yaml) + snapshotted first (so the git restore is ALSO undoable
 * from the snapshot log). This is the store hook the git-backed versions route calls
 * after re-committing a prior build's files, so the in-process record + the durable
 * mirror reflect the restored source and the next Run/Build picks it up.
 */
export function applyRestoredYaml(systemId: string, user: Principal, yaml: string, summary: string): SystemRecord {
  const rec = requireEdit(systemId, user);
  parseSystem(yaml); // reject corrupt restored source rather than go live with it
  if (yaml !== rec.yaml) {
    versions.record(systemId, user.id, snapshotState(rec), summary);
    rec.yaml = yaml;
    rec.updatedAt = now();
    writeThrough(rec);
  }
  return rec;
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
