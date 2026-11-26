/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { isCompanyScope, inLiveDomainScope } from '@core/kernel/company-scope';
import {
  type Schedule,
  type System,
  type Visibility,
  SystemError,
  parseSystem,
  serializeSystem,
  assertGrantsWithinRole,
} from '@tabs/agents/lib/system-schema';
import { legacyWorkflowFindings } from '@tabs/agents/lib/legacy-workflow-grants';
import { canPromote, roleAtLeast } from '@core/kernel/session';
import { type TemplateKey, templateYaml } from '@tabs/agents/lib/templates';
import { canManageArtifact, type ArtifactScope } from '@core/policy/edit-scope';
import { osMirror, type MirrorPatch } from '@core/infra/os-mirror';
import { type ArtifactVersion, versionLog } from '@core/kernel/versioning';
import { normaliseFolderPath } from '@core/kernel/folders';
// The GOVERNED folder registry (Wave 1) — a moved-into folder is upserted as an
// explicit row so it persists even when empty. Reused, never forked (mirrors Data).
import { ensureFolderRow, type EnsureFolderResult, type FolderScope, type Principal as FolderPrincipal } from '@core/folders/index';
// Part D: the pure event seam the git commit hook subscribes to (never git from here — this
// module is reachable from the client bundle).
import { emitSystemChange } from '@tabs/agents/lib/system-events';
import { materializeDeclaredFolders, type FolderMaterialization } from '@tabs/agents/lib/declared-folders';
import { identifierProblems } from '@tabs/agents/lib/safe-ids';
import { assertSystemWriteAvailable, isRunWorkerProcess } from '@tabs/agents/lib/write-availability';

/**
 * The agent-system store — the durable file-backed record behind the Agents tab (kind-only,
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
export type Role = import('@core/kernel/session').Role;
export type Principal = { id: string; domains: string[]; role: Role };

/** One row in the per-tool build report (mirrors BuildRow from lib/agents/build/adapter.ts). */
export type LastBuildRow = {
  tool: string;
  applied: boolean;
  verified: boolean;
  status: 'ok' | 'fail' | 'pending' | 'warn';
  detail: string;
  error?: string;
};

/** The last build outcome persisted server-side so it survives tab-switches + reloads. */
export type LastBuild = {
  ok: boolean;
  at: number;
  rows: LastBuildRow[];
  /**
   * LEGACY, no longer written or read. Builds before the durable key store kept a reference to an
   * in-process secret here; old persisted records may still carry it. A system's key now lives
   * only in `core/infra/agent-system-keys.ts`, addressed by the system id.
   */
  litellmKeyRef?: { name: string; key: string };
};

/**
 * A per-PROCESS nonce, generated once when this module first loads. It stamps
 * every in-progress activity marker with the instance that started it, so a
 * later process can tell a run its OWN process is executing (same instance id)
 * apart from one a NOW-DEAD process left dangling (a different/absent instance
 * id). This is the "the process is gone" signal that {@link recoverInterrupted}
 * keys off — a pod restart mints a fresh nonce, so every marker from the prior
 * pod is provably stale. Kept module-local (never persisted as a global) so a
 * restart cannot accidentally reuse it.
 */
const PROCESS_INSTANCE = `proc_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;

/**
 * Lightweight in-progress marker written at the START of a build or run and
 * cleared in the route's `finally` block. A returning user sees "building since
 * …" / "running since …" rather than a stale blank slate. `instanceId` records
 * WHICH process started it, so a fresh process can recover a run the prior
 * (crashed) process abandoned.
 */
export type ActivityMarker = { kind: 'building' | 'running'; startedAt: number; instanceId?: string };

/**
 * A durable, per-step checkpoint of an IN-FLIGHT run. Written at the run's start
 * and updated as each node begins/finishes, so a process restart mid-run leaves a
 * LEGIBLE record (which nodes completed, with their outputs) instead of a silently
 * lost run. Recovery ({@link recoverInterrupted}) reads this to seed an
 * `interrupted` {@link LastRun} with the last completed step preserved and a resume
 * affordance. Additive + back-compatible: absent on records written before it
 * shipped, and never touched by any non-run path.
 */
export type RunCheckpoint = {
  /** The process that owns this in-flight run — matches its {@link ActivityMarker}. */
  instanceId: string;
  startedAt: number;
  updatedAt: number;
  /** The run task (prompt) so a resume can re-enter with the same intent. */
  prompt?: string;
  /** The full node walk order (path), so recovery knows what had NOT yet run. */
  plannedNodes?: string[];
  /** Each node that has FINISHED, in order, with its status + a bounded final text. */
  completedNodes: { node: string; status: string; finalText?: string }[];
  /** The node currently executing (started, not yet finished), if any. */
  currentNode?: string;
  /** The LangGraph thread id (= run id) when the `langgraph` engine ran it — what a Resume continues. */
  runId?: string;
  /** Where that thread's checkpoints live. Only `postgres` survives a process restart, so recovery
   *  offers Resume only then (review finding M3). */
  checkpointer?: 'postgres' | 'memory';
};

/** The last interactive run report — persisted so navigating away and back does not wipe it. */
export type LastRun = {
  at: number;
  running: boolean;
  ok: boolean;
  path: string[];
  /** Did the run reach the natural end of `path`, vs stop early (run-budget
   *  exhaustion or a node failure)? Absent on a pre-existing persisted run. */
  reachedEnd?: boolean;
  /**
   * The run ended because an AGENT FAILED (it stopped there; nothing after it ran) — with the
   * agent and the reason. Absent on a run that did not fail and on runs recorded before this
   * existed (`ok: false` already marked those not-ok; this says why).
   */
  failed?: true;
  failedNode?: string;
  failureReason?: string;
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
  /**
   * "Context actually used per run" (#177) — derived from `nodes[].steps[]`: which
   * datasets/knowledge/files/metrics/connections the run read, retrieved or wrote.
   * Additive + back-compatible: absent on runs recorded before it shipped (the UI
   * re-derives client-side from `nodes` as a fallback). See `build/context-usage.ts`.
   */
  contextUsage?: import('./build/context-usage.ts').RunContextUsage;
  /**
   * The system's declared grant ids at run time, per kind — so the Evaluate view can
   * show granted-but-unused ("dead") grants next to what was actually used. Best-effort:
   * absent when the yaml could not be parsed. Purely for the used-vs-granted strip.
   */
  grantedIds?: { data: string[]; knowledge: string[]; files: string[]; metrics: string[]; connections: string[] };
  output?: string;
  /**
   * The run's WRITE accounting, counted DIRECTLY from the executed steps (never
   * inferred): how many records were written straight to the runner's own My scope
   * (the My-direct rule) vs how many writes are HELD in Governance → Inbox. Drives the
   * honest "wrote N to My <tab> · M awaiting approval" line in the Run panel + Evaluate.
   * Additive + back-compatible: absent on runs recorded before it shipped.
   */
  writeSummary?: {
    line: string;
    wrote: { tab: string; count: number }[];
    /** Everything the run wrote: direct tool writes (`wrote`) + declared outputs saved (`outputsSaved`). */
    wroteTotal: number;
    heldTotal: number;
    /** Declared outputs the output saver saved after the run (`build/write-summary.ts`). */
    outputsSaved?: number;
  };
  mode?: 'live' | 'offline-mock';
  traceStoreAvailable?: boolean;
  traceUrl?: string;
  /**
   * Set when this record was RECOVERED after a process restart interrupted a run
   * mid-flight (see {@link recoverInterrupted}). The run is legible, not lost: the
   * nodes that completed before the crash are preserved as `steps`/`nodes`, and the
   * UI shows an "interrupted — resume" affordance instead of a stale live spinner.
   */
  interrupted?: boolean;
  /** For an interrupted run: the node index the run reached. Best-effort, informational. */
  resumeFromIndex?: number;
  /** The run id (= LangGraph thread id = Langfuse trace id).
   *  `POST …/run { resume: true, runId }` continues it from its last checkpoint. */
  runId?: string;
  /** Which executor produced this run. Always `'langgraph'` since A5; a record written before
   *  that may still carry `'walker'`, which is why the string is not narrowed on READ. */
  engine?: string;
  checkpointer?: 'postgres' | 'memory';
  /** A2: the approvals a PARKED run is waiting on (LangGraph `interrupt()`); the decision resumes it. */
  heldApprovals?: { approvalId: string; tool: string; node: string }[];
  /** A2: `buildGraph` compile warnings reported with the run (e.g. a guard over a channel nothing sets). */
  warnings?: string[];
  /**
   * What happened to each DECLARED OUTPUT of this run ("Where the results go"): saved where, with
   * which id, promotion requested, or not saved and why (`output-saver.ts`). Written twice: as
   * `pending` together with the report, BEFORE the save, and again with the outcome — so a
   * process that dies in between leaves a record that says the save is unfinished. Absent on a
   * system that declares no output and on runs recorded before this existed.
   */
  outputs?: import('./output-saver.ts').OutputResult[];
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
  /** The folder this system lives in (normalised path; `'/'` = root). Mirrors Data. */
  folder: string;
  updatedAt: string;
  lastActivity: string | null;
  /** Last build outcome. Absent on records created before this field was added. */
  lastBuild?: LastBuild;
  /** In-progress marker: set at start of build/run, cleared in finally. */
  activity?: ActivityMarker;
  /** Durable per-step checkpoint of the CURRENT in-flight run (set at run start,
   *  updated per node, cleared on completion). Present only while a run is live;
   *  a stale one from a dead process is what {@link recoverInterrupted} salvages. */
  runCheckpoint?: RunCheckpoint;
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
  /** The folder this system lives in (normalised path; `'/'` = root). */
  folder: string;
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

export type RepoFile = {
  path: string;
  content: string;
  sha: string;
  /** On a `system.yaml` save: the folders the definition names that now exist, and those that
   *  could not be created (with the reason) — see `declared-folders.ts`. */
  folders?: FolderMaterialization;
};

export const WHITELIST_HINT = 'only system.yaml, AGENT.md and MEMORY.md are editable';

/**
 * State container pinned to `globalThis` so it is a TRUE singleton. The Next.js
 * App Router bundles each route handler separately, which otherwise gives every
 * route its own copy of this module — and its own empty `store` Map. A system
 * created via `POST /api/agents/systems` (one route bundle) would then be invisible
 * to `GET /api/agents/systems/[id]/files` (another route bundle), so AGENT.md /
 * MEMORY.md would 404 and never load. Pinning to globalThis makes the record
 * written by one route visible to every other route — and survives dev HMR. (Same
 * reason `lib/approvals.ts` pins its state.)
 */
type AgentsState = {
  store: Map<string, SystemRecord>;
  seeded: boolean;
  hydration: Promise<void> | null;
  /** Set when the last hydration found the mirror DOWN — gates the throttled retry. */
  hydrateFailedAt?: number;
  /** Set when a hydration READ THE MIRROR SUCCESSFULLY — what `hydrationState` reports. */
  hydratedAt?: number;
};
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
        folder: { type: 'keyword' },
        running: { type: 'boolean' },
        yaml: { type: 'text', index: false },
        schedule: { type: 'object', enabled: false },
        disabledAgents: { type: 'keyword' },
        lastBuild: { type: 'object', enabled: false },
        activity: { type: 'object', enabled: false },
        runCheckpoint: { type: 'object', enabled: false },
        lastRun: { type: 'object', enabled: false },
        archived: { type: 'boolean' },
      },
    },
  },
});

// Durable, per-artifact version history (reused across the OS). A system's
// canonical `yaml` is snapshotted here on every meaningful edit + on restore.
const versions = versionLog('agent-system');

/**
 * What a write means, for the git commit hook (Part D). REQUIRED on every `writeThrough` so a
 * new writer cannot be added without deciding: a `SystemChangeSpec` is a DEFINITION change and
 * becomes a commit (`writeThrough`); run/build bookkeeping is deliberately not a commit and goes
 * through `writeRunState` with the run fields it changed. `lib/git/commit.test.ts` enumerates
 * both sets so neither can grow silently.
 */
type SystemChangeSpec = { action: string; actorId: string; previousDomain?: string };

/**
 * The fields of a record that belong to a RUN, not to the definition — the same set the git
 * snapshot leaves out (`git/snapshot.ts`). The run worker writes these and nothing else.
 */
const RUN_FIELDS = ['activity', 'runCheckpoint', 'lastRun', 'lastActivity'] as const;
type RunField = (typeof RUN_FIELDS)[number];

/** Every DEFINITION field (all of `SystemRecord` but the run fields) — checked complete by the compiler. */
const DEFINITION_FIELDS = Object.keys({
  id: 1, name: 1, domain: 1, owner: 1, visibility: 1, origin: 1, sourceId: 1, running: 1, schedule: 1,
  disabledAgents: 1, yaml: 1, folder: 1, updatedAt: 1, lastBuild: 1, archived: 1,
} satisfies Record<Exclude<keyof SystemRecord, RunField>, 1>) as (keyof SystemRecord)[];

/** The mirror patch that writes exactly `fields` of `rec` (an absent field is removed). */
function patchOf(rec: SystemRecord, fields: readonly (keyof SystemRecord)[]): MirrorPatch {
  const set: Record<string, unknown> = {};
  const unset: string[] = [];
  for (const k of fields) {
    if (rec[k] === undefined) unset.push(k);
    else set[k] = rec[k];
  }
  return { set, unset };
}

/**
 * Persist a DEFINITION change. Only the definition fields are written (a partial update), so a
 * run the worker is executing at the same time keeps its in-flight marker, checkpoint and report
 * in the mirror. The whole record is the `upsert`: stored only if the mirror has no doc yet.
 */
function writeThrough(rec: SystemRecord, change: SystemChangeSpec, opts: { create?: true } = {}): void {
  // Part D review H-3: a DEFINITION change must become a commit. In the run-worker process it
  // cannot — no `os-repos` mount, no commit hook — so it fails CLOSED with a typed error instead
  // of reaching the durable mirror uncommitted.
  assertSystemWriteAvailable(change.action);
  // A brand-new record (create, install) has no doc anyone else could have advanced: store it whole.
  if (opts.create) mirror.writeThrough(rec.id, rec);
  else mirror.patchThrough(rec.id, patchOf(rec, DEFINITION_FIELDS), { upsert: rec });
  emitSystemChange({
    domain: rec.domain,
    systemId: rec.id,
    name: rec.name,
    action: change.action,
    actorId: change.actorId,
    previousDomain: change.previousDomain,
  });
}

/**
 * Persist run/build BOOKKEEPING — never a commit, and never a definition field. Only the run
 * fields named are written, as a partial update WITHOUT upsert: this process's copy of the yaml,
 * name, grants or last build can be older than what os-ui has since saved, and a write here must
 * not put it back (the worker runs for minutes while the owner keeps editing). A record deleted
 * meanwhile stays deleted — the mirror answers 404 and nothing is created.
 */
function writeRunState(rec: SystemRecord, fields: readonly RunField[]): void {
  mirror.patchThrough(rec.id, patchOf(rec, fields));
}

/** The versioned slice of a system record — the single source (system.yaml). */
function snapshotState(rec: SystemRecord): { yaml: string } {
  return { yaml: rec.yaml };
}

/** Retry a failed hydration at most this often (a down mirror must not add a
 *  probe round-trip to EVERY request — mirrors lib/data/store.ts). */
const HYDRATE_RETRY_MS = 60_000;

export async function ensureHydrated(): Promise<void> {
  const s = state();
  if (!s.hydration) {
    // After a mirror-down hydration, retry (throttled) instead of staying pinned
    // to an empty registry for the pod's lifetime — a transient OpenSearch blip
    // at boot must not "lose" every mirrored system until the next deploy.
    if (s.hydrateFailedAt && Date.now() - s.hydrateFailedAt < HYDRATE_RETRY_MS) return;
    s.hydration = hydrate();
  }
  return s.hydration;
}

/**
 * Worker-side freshness for ONE system (0.9.2 incident, 2026-11-18). The run worker never writes
 * a definition, so its in-process registry is only ever as fresh as its last hydration — and
 * `hydrate()` deliberately keeps a record it already holds. In os-ui that is right (the process
 * that writes is authoritative); in the worker it meant every run answered "System not found" on
 * a cold registry, and would have run a STALE definition after any edit. So, in the run-worker
 * process only, re-read the one record a job needs from the mirror and let it overwrite memory.
 * In every other process this is a no-op. `read` is injectable for tests; `null` from the mirror
 * (missing or unreachable — `getDoc` cannot tell) leaves memory untouched, so the lookup that
 * follows answers exactly as it would have.
 */
export async function refreshSystemFromMirror(
  systemId: string,
  read: (id: string) => Promise<unknown | null> = (id) => mirror.getDoc(id),
): Promise<'refreshed' | 'unavailable' | 'not-worker'> {
  if (!isRunWorkerProcess()) return 'not-worker';
  const doc = (await read(systemId)) as Partial<SystemRecord> | null;
  if (!doc || doc.id !== systemId || typeof doc.yaml !== 'string') return 'unavailable';
  state().store.set(systemId, doc as SystemRecord);
  return 'refreshed';
}

/**
 * Did the registry in memory actually come from the durable mirror?
 *
 * THE POINT (Part D review H-1): {@link ensureHydrated} RESOLVES when `mirror.hydrate()` returned
 * null — a mirror-down hydration is recorded for the throttled retry and never thrown. Every read
 * path is right to degrade that way; a boot-time WRITER is not. The Sept-2026 login outage was
 * exactly this shape: an os-ui/OpenSearch startup race hydrated a store to EMPTY without any
 * error, and an empty store looks identical to a tenant that owns nothing. Anything that would
 * COMMIT or DELETE on the strength of the store being empty must check this first.
 *
 *   'hydrated' — a mirror read succeeded in this process; the registry is as complete as the
 *                mirror is. (An empty answer here is a genuinely empty mirror.)
 *   'failed'   — the last attempt found the mirror unreachable; the registry may be missing
 *                everything, and nothing may be deleted on its authority.
 *   'pending'  — no attempt has completed yet.
 */
export function hydrationState(): 'hydrated' | 'failed' | 'pending' {
  const s = state();
  if (s.hydratedAt !== undefined) return 'hydrated';
  return s.hydrateFailedAt !== undefined ? 'failed' : 'pending';
}

async function hydrate(): Promise<void> {
  const s = state();
  const docs = await mirror.hydrate(2000);
  if (docs === null) {
    // Mirror down → stay un-hydrated and retry on a later read (never cache a
    // FAILED hydration as done — the data store's rule).
    s.hydrateFailedAt = Date.now();
    s.hydration = null;
    return;
  }
  s.hydrateFailedAt = undefined;
  s.hydratedAt = Date.now();
  for (const rec of docs as SystemRecord[]) {
    if (rec && rec.id && !s.store.has(rec.id)) s.store.set(rec.id, rec);
  }
  await versions.ensureHydrated();
  // Crash recovery: any record whose in-flight run was owned by a NOW-DEAD process
  // (a different/absent instanceId) is salvaged to `interrupted` — the run becomes
  // legible (last completed step preserved, resume affordance) instead of a stale
  // "running" spinner that never resolves. Runs owned by THIS process are untouched.
  for (const rec of s.store.values()) recoverInterrupted(rec);
  s.seeded = true;
}

/**
 * Recover a single record whose in-flight run was abandoned by a dead process.
 * A run is "abandoned" when its `activity` marker says `running` but the marker's
 * `instanceId` is NOT this process's (a pod restart mints a fresh nonce, so every
 * prior-process marker is provably stale). We turn the durable {@link RunCheckpoint}
 * into an `interrupted` {@link LastRun}: the nodes that finished before the crash are
 * preserved, `held`/`ok` reflect a run that did not complete, and `resumeFromIndex`
 * points at where a resume would re-enter. Idempotent + fail-soft: a record with no
 * running marker, or one this process owns, is left exactly as-is.
 *
 * Returns true iff it changed (and wrote through) the record — used by tests + the
 * boot sweep. Never throws.
 */
export function recoverInterrupted(rec: SystemRecord): boolean {
  const marker = rec.activity;
  if (!marker || marker.kind !== 'running') return false;
  // Owned by THIS live process → a genuinely in-flight run; do not disturb it.
  if (marker.instanceId && marker.instanceId === PROCESS_INSTANCE) return false;
  const cp = rec.runCheckpoint;
  const completed = cp?.completedNodes ?? [];
  const planned = cp?.plannedNodes ?? [];
  const steps = completed.map((n) => ({ node: n.node, tool: '(node)', effect: n.status, ran: n.status === 'ok' }));
  const nodes = completed.map((n) => ({ node: n.node, status: n.status, finalText: n.finalText, steps: [] }));
  const reachedIdx = completed.length; // next node to run = count of finished ones
  const outputLines = [
    `Run interrupted by a restart after ${completed.length}${planned.length ? ` of ${planned.length}` : ''} step(s).`,
    cp?.currentNode ? `Was executing '${cp.currentNode}' when the process stopped.` : '',
    cp?.runId && cp.checkpointer === 'postgres'
      ? 'The steps below completed before the interruption. Resume to continue from the last checkpoint.'
      : cp?.runId
        ? 'The steps below completed before the interruption. Its checkpoints were in memory and died with the process — re-run to continue.'
        : 'The steps below completed before the interruption. Re-run to continue.',
  ].filter(Boolean);
  const lastRun: LastRun = {
    at: cp?.updatedAt ?? marker.startedAt,
    running: false,
    ok: false,
    path: completed.map((n) => n.node),
    traces: 0,
    held: 0,
    steps,
    nodes: nodes.length ? nodes : undefined,
    output: outputLines.join(' '),
    mode: 'live',
    interrupted: true,
    resumeFromIndex: reachedIdx,
    runId: cp?.runId,
    engine: cp?.runId ? 'langgraph' : undefined,
    checkpointer: cp?.checkpointer,
  };
  rec.lastRun = lastRun;
  delete rec.activity; // clear the stale live spinner
  delete rec.runCheckpoint; // the checkpoint has been consumed into lastRun
  rec.running = false;
  rec.updatedAt = now();
  writeRunState(rec, ['lastRun', 'activity', 'runCheckpoint']); // run bookkeeping salvaged from a dead process — not a definition change
  return true;
}

// --------------------------------------------------------------------- utils --

function now(): string {
  return new Date().toISOString();
}

function id(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;
}

/** Mint a run id — the LangGraph thread id of one run. Lives in the kernel (`core/kernel/run-id.ts`,
 *  `crypto.randomUUID`) since A2: the old store-shaped id was guessable (review finding H1). */
export { newRunId } from '@core/kernel/run-id';

/** Stable blob sha for optimistic concurrency. */
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
    grants: { data: [], knowledge: [], metrics: [], tools: ['search_knowledge'], connections: [], files: [], workflows: [], plan: [] },
    routing: { overrides: {} },
    agents: [
      {
        id: 'assistant',
        role: 'A helpful assistant',
        agent_md: `# ${name}\n\nYou are a helpful assistant in the Sovereign Agentic OS.\nUse only your granted, governed tools.`,
        memory_md: '# Memory\n\n(Durable facts the assistant should always know.)',
        // No per-agent `tools:` — the agent inherits everything the team is granted.
      },
    ],
    edges: [],
  };
  return serializeSystem(sys);
}

function record(partial: Omit<SystemRecord, 'updatedAt' | 'lastActivity' | 'running' | 'schedule' | 'disabledAgents' | 'origin' | 'folder'> & Partial<SystemRecord>): SystemRecord {
  return {
    running: false,
    schedule: { kind: 'manual' },
    disabledAgents: [],
    origin: 'authored',
    folder: '/',
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

/** Test hook: the LIVE stored record by id (not a copy), so a test can drive the
 *  crash-recovery sweep over the exact object the boot path iterates. */
export function __recordFor(systemId: string): SystemRecord | undefined {
  return state().store.get(systemId);
}

/** Test hook: wipe the in-process store + reseed. */
export function __resetStore(): void {
  const s = state();
  s.store.clear();
  s.seeded = false;
  s.hydration = null;
  s.hydrateFailedAt = undefined;
  s.hydratedAt = undefined;
  mirror.__reset();
  versions.__reset();
}

/**
 * Cross-domain governance move (admin-only, gated in lib/platform-admin/domain-move.ts).
 * Scoping reads the record's `domain` field (the yaml's domain is cosmetic), so
 * we set the field and write through. `sel.id` moves one; `sel.onlyUnassigned`
 * sweeps only empty-domain records. Returns the ids moved.
 */
export function moveSystemsDomain(
  sel: { id?: string; onlyUnassigned?: boolean },
  target: string,
  /** NIGHT-2 MERGE: the acting admin's principal id (D's M-8, applied to this sibling mover).
   *  Optional only so pre-existing callers keep compiling; absent is recorded as `system`. */
  actorId?: string,
): string[] {
  const moved: string[] = [];
  for (const rec of state().store.values()) {
    if (sel.id !== undefined && rec.id !== sel.id) continue;
    if (sel.onlyUnassigned && rec.domain) continue;
    if (rec.domain === target) continue;
    const previousDomain = rec.domain;
    rec.domain = target;
    // Part D: a cross-domain move changes TWO repos — the old one loses the system, the new one
    // gains it. `previousDomain` is what tells the commit hook to regenerate both.
    writeThrough(rec, { action: `move domain from ${previousDomain || '(unassigned)'} to ${target}`, actorId: actorId ?? 'system', previousDomain });
    moved.push(rec.id);
  }
  return moved;
}

/**
 * The ONE-TIME rewrite of stored systems from the old workflow/knowledge spelling to the new one
 * (`wf_…` under `grants.knowledge` → `grants.workflows`; `author_knowledge` → `author_workflow`, …).
 * The read path already applies the same rule (`parseSystem`), so a system keeps running whether or
 * not this has run; this makes the stored text say what the system means, so a person reading
 * `system.yaml` (or the domain repo) sees the real grants.
 *
 *   - DRY RUN (`dryRun: true`): reads and reports, writes nothing.
 *   - IDEMPOTENT: a system with nothing in the old spelling is not touched (no version, no commit),
 *     so a second pass changes nothing and reports an empty list.
 *   - Each rewrite snapshots the prior definition (restorable from the version history) and is a
 *     definition change like any other edit (it reaches the durable mirror and the domain repo).
 *   - Returns `null` when the registry did not come from the durable mirror: it must not conclude
 *     "nothing to migrate" from an empty or partial registry.
 */
export type WorkflowGrantMigrationReport = {
  dryRun: boolean;
  scanned: number;
  changed: { id: string; domain: string; findings: string[] }[];
  failed: { id: string; error: string }[];
};

export function migrateStoredWorkflowGrants(opts: { dryRun?: boolean; actorId?: string } = {}): WorkflowGrantMigrationReport | null {
  if (hydrationState() !== 'hydrated') return null;
  ensureSeeded();
  const dryRun = opts.dryRun === true;
  const report: WorkflowGrantMigrationReport = { dryRun, scanned: 0, changed: [], failed: [] };
  for (const rec of state().store.values()) {
    report.scanned += 1;
    let findings: string[];
    try {
      findings = legacyWorkflowFindings(rec.yaml);
    } catch (e) {
      report.failed.push({ id: rec.id, error: e instanceof Error ? e.message : String(e) });
      continue;
    }
    if (findings.length === 0) continue;
    if (dryRun) {
      report.changed.push({ id: rec.id, domain: rec.domain, findings });
      continue;
    }
    try {
      const next = serializeSystem(parseSystem(rec.yaml)); // parse upgrades; serialize writes the new spelling
      const actorId = opts.actorId ?? 'migration';
      versions.record(rec.id, actorId, snapshotState(rec), 'migrate workflow grants');
      rec.yaml = next;
      rec.updatedAt = now();
      writeThrough(rec, { action: 'migrate workflow grants', actorId });
      report.changed.push({ id: rec.id, domain: rec.domain, findings });
    } catch (e) {
      report.failed.push({ id: rec.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return report;
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
  if (isCompanyScope(rec.visibility)) return true; // Company: every domain (core/kernel/company-scope)
  return false;
}

function canEdit(rec: SystemRecord, user: Principal): boolean {
  // Fail-closed edit-scope: owner always; a Personal agent system is owner-only
  // (no admin/domain_admin reaches another user's private agent). A Shared /
  // Marketplace one admits an in-domain domain_admin or a platform admin.
  const scope: ArtifactScope = rec.visibility === 'Personal' ? 'personal' : rec.visibility === 'Marketplace' ? 'certified' : 'shared';
  return canManageArtifact(user, { owner: rec.owner, domain: rec.domain, scope });
}

function requireView(systemId: string, user: Principal): SystemRecord {
  const rec = get(systemId);
  if (!canView(rec, user)) fail('Not permitted to view this system', 403);
  return rec;
}

/** The PROMOTE/APPROVE governance authority (separate from private-artifact
 *  management): owner, in-domain domain_admin, or admin — scope-agnostic, so a
 *  Builder/Admin can still SHARE a filed Personal system. A non-owner Builder is
 *  still blocked (not a domain_admin/admin). Preserves the promotion gate the
 *  manage-rights change must not alter. */
function canGovern(rec: SystemRecord, user: Principal): boolean {
  return canManageArtifact(user, { owner: rec.owner, domain: rec.domain, scope: 'shared' });
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
    // Nil-safe: records mirrored before the folder field shipped hydrate without it.
    folder: normaliseFolderPath(rec.folder ?? '/'),
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
 *
 * GROUP BY VISIBILITY, not ownership: a Shared system is DOMAIN knowledge and belongs
 * under Domain even when the caller authored it; a Marketplace system under this tab's
 * "Company" tier; only a Personal system is "Mine". (This fixes the leak where an owned
 * Shared/Marketplace system showed under "My Agents" instead of "Domain Agents".)
 *
 * ACTIVE-DOMAIN NARROWING for My and Domain: with an active domain chosen (sidebar
 * switcher) auth.ts narrows user.domains to [active], so those tiers filter to that domain;
 * "All Domains" keeps every membership. A domainless (unassigned) system always shows. A
 * COMPANY (Marketplace) system shows in EVERY domain — owner decision 2026-11-23, the one
 * rule in core/kernel/company-scope.
 */
export function listSystems(user: Principal, opts: { includeArchived?: boolean } = {}): SystemGroups {
  ensureSeeded();
  const mine: SystemSummary[] = [];
  const domain: SystemSummary[] = [];
  const marketplace: SystemSummary[] = [];
  for (const rec of state().store.values()) {
    if (rec.archived && !opts.includeArchived) continue;
    if (!canView(rec, user)) continue;
    // Active-domain narrowing for My + Domain; a Company system shows in every domain.
    if (!inLiveDomainScope({ company: isCompanyScope(rec.visibility), domain: rec.domain, archived: rec.archived, owner: rec.owner }, user.domains, user)) continue;
    if (rec.visibility === 'Marketplace') marketplace.push(summarise(rec));
    else if (rec.visibility === 'Shared') domain.push(summarise(rec));
    else mine.push(summarise(rec)); // Personal
  }
  const byName = (a: SystemSummary, b: SystemSummary) => a.name.localeCompare(b.name);
  return { mine: mine.sort(byName), domain: domain.sort(byName), marketplace: marketplace.sort(byName) };
}

/** Agent systems visible to the user that hold a per-item (non-folder) DATA grant on
 *  a given dataset — the reverse lookup the Data tab's Publish stage uses to list
 *  "agent systems that use this dataset". Pure over {@link listSystems} + {@link getSystem}
 *  (both RLS-scoped), so it never widens visibility. A system whose yaml can't be parsed
 *  is skipped rather than throwing (fail-soft, matches the read-model discipline). */
export function getSystemsUsingDataset(datasetId: string, user: Principal): SystemSummary[] {
  const { mine, domain, marketplace } = listSystems(user);
  const out: SystemSummary[] = [];
  for (const s of [...mine, ...domain, ...marketplace]) {
    try {
      const view = getSystem(s.id, user);
      if (view.system.grants.data.some((g) => g.id === datasetId && !g.folder)) out.push(s);
    } catch {
      // unreadable/unparseable system — skip, never fabricate a match
    }
  }
  return out;
}

/**
 * UNSCOPED enumeration of every agent system with its parsed grants — for the OS-wide
 * `dependentsOf` dependency walk (lib/core/dependents.ts) which must see EVERY dependent
 * regardless of the actor's visibility (a warn-before-break preflight). Server-side only;
 * never expose through a user-facing route. A system whose yaml can't be parsed is skipped.
 */
/**
 * Every system that exists, with its definition and owner — for the one-time key migration
 * (`build/system-key-migration.ts`). NULL when the registry did not come from the durable mirror
 * (`hydrationState()` is not 'hydrated'): the migration must then neither conclude "nothing to
 * migrate" nor tell the sweep which systems exist. Archived systems are included: an archived
 * system can be restored, and must then still have its key.
 */
export function listSystemsForKeyMigration(): { id: string; domain: string; owner: string; yaml: string }[] | null {
  if (hydrationState() !== 'hydrated') return null;
  ensureSeeded();
  return [...state().store.values()].map((r) => ({ id: r.id, domain: r.domain, owner: r.owner, yaml: r.yaml }));
}

/**
 * Every system's stored schedule — for the boot CronJob resync (`schedule-cron.ts`
 * `resyncScheduleCrons`). NULL unless the registry came from the durable mirror: the resync deletes
 * CronJobs nothing wants, so an un-hydrated (empty) registry must never be mistaken for "none".
 */
export function listSchedulesForResync(): { id: string; schedule: Schedule; archived: boolean }[] | null {
  if (hydrationState() !== 'hydrated') return null;
  ensureSeeded();
  return [...state().store.values()].map((r) => ({ id: r.id, schedule: r.schedule, archived: r.archived === true }));
}

export function listAllSystemsInternal(): { id: string; name: string; grants: System['grants'] }[] {
  ensureSeeded();
  const out: { id: string; name: string; grants: System['grants'] }[] = [];
  for (const rec of state().store.values()) {
    if (rec.archived) continue;
    try {
      out.push({ id: rec.id, name: rec.name, grants: parseSystem(rec.yaml).grants });
    } catch {
      // unparseable system — skip, never fabricate a dependent
    }
  }
  return out;
}

/**
 * UNSCOPED: every live agent system whose last Build wrote its OPA grants (the `opa` row
 * applied), with its parsed definition — the OPA state restore re-grants exactly these after an
 * OPA restart. Server-side only; never expose through a user-facing route. Unparseable → skipped.
 */
export function listOpaGrantedSystemsInternal(): { id: string; system: System }[] {
  ensureSeeded();
  const out: { id: string; system: System }[] = [];
  for (const rec of state().store.values()) {
    if (rec.archived) continue;
    if (!rec.lastBuild?.rows.some((r) => r.tool === 'opa' && r.applied)) continue;
    try {
      out.push({ id: rec.id, system: parseSystem(rec.yaml) });
    } catch (err) {
      // unparseable system — skipped (never fabricate a grant), and said so
      console.error(`[os-ui] agents: system ${rec.id} not re-granted in OPA — its definition does not parse: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}

/** One agent-system row for Agent Monitoring: identity + last-run health + activity. */
export type AgentHealthRow = {
  id: string;
  name: string;
  scope: 'mine' | 'domain' | 'marketplace';
  agentCount: number;
  running: boolean;
  scheduled: boolean;
  /** ms epoch of the last run, or null if it has never run. */
  lastRunAt: number | null;
  /** true = last run succeeded, false = failed, null = never run. */
  lastRunOk: boolean | null;
  /** tool steps the last run held/blocked (governance denials) — the error count. */
  held: number;
  /** Rolled-up dot: green ok · amber ok-with-holds · red failed · grey never-run. */
  health: 'green' | 'amber' | 'red' | 'grey';
};

/**
 * Agent Monitoring feed: EVERY agent system the caller can access — their own
 * (`mine`), shared-to-their-domain (`domain`), and marketplace (`marketplace`) —
 * each with its last-run health. This is the artifact-centric monitor: you start
 * from the agent systems you built or use, not from a firehose of raw traces. A
 * never-run system shows `grey`/"not run yet" rather than being hidden.
 */
export function agentHealthRows(user: Principal): AgentHealthRow[] {
  ensureSeeded();
  const rows: AgentHealthRow[] = [];
  for (const rec of state().store.values()) {
    if (rec.archived) continue;
    if (!canView(rec, user)) continue;
    // Mirror listSystems: GROUP BY VISIBILITY (Shared→domain, Marketplace→marketplace,
    // else→mine), and narrow EVERY tier to the active domain (strict isolation). A
    // domainless system always shows; cross-domain discovery is the Marketplace's job.
    if (rec.domain && !user.domains.includes(rec.domain)) continue;
    const scope: AgentHealthRow['scope'] =
      rec.visibility === 'Marketplace' ? 'marketplace' : rec.visibility === 'Shared' ? 'domain' : 'mine';
    let agentCount = 0;
    try { agentCount = parseSystem(rec.yaml).agents.length; } catch { agentCount = 0; }
    const lr = rec.lastRun;
    const health: AgentHealthRow['health'] = !lr ? 'grey' : !lr.ok ? 'red' : lr.held > 0 ? 'amber' : 'green';
    rows.push({
      id: rec.id,
      name: rec.name,
      scope,
      agentCount,
      running: rec.running,
      scheduled: rec.schedule.kind !== 'manual',
      lastRunAt: lr?.at ?? null,
      lastRunOk: lr?.ok ?? null,
      held: lr?.held ?? 0,
      health,
    });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
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
/** Exported so the systems GET route can stamp `canRun` onto the client payload.
 *  Server is the source of truth — the client never re-computes authz. */
export function canRunCheck(rec: SystemRecord, user: Principal): boolean {
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
  if (!canRunCheck(rec, user)) fail('Not permitted to run this system', 403);
  return { ...rec, system: parseSystem(rec.yaml) };
}

// ------------------------------------------------------------- create / fork --

/** Every agent without a model choice starts on `model` (Auto unless a creator chose one). */
function withAutoModels(yaml: string, model: 'strong' | 'standard' | 'auto' = 'auto'): string {
  const sys = parseSystem(yaml);
  for (const a of sys.agents) a.model ??= model;
  return serializeSystem(sys);
}

/** Each agent's model choice in a definition (`agent-model.ts`; no field = strong), for a create/read answer. */
export function agentModelsOf(yaml: string): { id: string; model: string; model_resolved?: string; model_reason?: string }[] {
  return parseSystem(yaml).agents.map((a) => ({ id: a.id, model: a.model ?? 'strong', ...(a.model_resolved ? { model_resolved: a.model_resolved, model_reason: a.model_reason } : {}) }));
}

export function createSystem(
  user: Principal,
  input: { name: string; domain?: string; yaml?: string; template?: TemplateKey; model?: 'strong' | 'standard' | 'auto' },
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
  // A NEW system's agents start on `model: auto` (Build chooses Strong or Standard, `agent-model.ts`); a fork or a
  // pushed definition keeps what it says. (The shipped templates themselves stay unchanged: they are frozen fixtures.)
  const yaml = input.yaml ?? withAutoModels(input.template ? templateYaml(input.template, name, domain, visibility) : starterYaml(name, domain, visibility), input.model);
  if (input.yaml !== undefined) {
    // A forked or pushed definition: its identifiers become paths and keys in generated code (WP-53).
    const idProblems = identifierProblems(parseSystem(input.yaml));
    if (idProblems.length > 0) fail(`system.yaml: ${idProblems.join('; ')}`, 400);
  }
  const rec = record({
    id: id('sys'),
    name,
    domain,
    owner: user.id,
    visibility,
    yaml,
  });
  state().store.set(rec.id, rec);
  writeThrough(rec, { action: 'create system', actorId: user.id }, { create: true });
  // A forked / pushed definition may already name folders: they exist from creation on, like on a
  // save. A refusal is logged by `ensureFolderRow` and shows again (in the result) on Save / Build.
  if (input.yaml !== undefined) materializeDeclaredFolders(parseSystem(yaml), { id: user.id, role: user.role, domains: user.domains }, domain);
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
    writeThrough(rec, { action: `reassign owner to ${toId}`, actorId: toId });
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
  const rec = get(systemId);
  // Promotion is the sanctioned SHARE action — gate on the governance authority
  // (owner/domain_admin/admin), NOT the owner-only private-manage gate, so an
  // admin can approve a filed Personal→Shared promotion.
  if (!canGovern(rec, user)) fail('Not permitted to promote this system', 403);
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
  writeThrough(rec, { action: `promote to ${rec.visibility}`, actorId: user.id });
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
    if (!canManageArtifact(user, { owner: rec.owner, domain: rec.domain, scope: 'shared' })) {
      fail('Unsharing requires the owner, an in-domain Domain admin, or an Admin', 403);
    }
    rec.visibility = 'Personal';
  } else {
    fail('This system is already personal — nothing to revoke', 400);
  }
  rec.updatedAt = now();
  writeThrough(rec, { action: `demote to ${rec.visibility}`, actorId: user.id });
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
  writeThrough(rec, { action: `install system from ${src.id}`, actorId: user.id }, { create: true });
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

/**
 * Build's safety net for `writeFile`'s folder materialization: make sure every folder the saved
 * definition names exists, as `user` (edit-scoped — Build is an edit-level act). Returns what was
 * ensured and what was refused, for the build result.
 */
export function ensureSystemFolders(systemId: string, user: Principal): FolderMaterialization {
  const rec = requireEdit(systemId, user);
  return materializeDeclaredFolders(parseSystem(rec.yaml), { id: user.id, role: user.role, domains: user.domains }, rec.domain);
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
    // Identifiers become file names, node names and object keys in generated code (WP-53).
    const idProblems = identifierProblems(parsed);
    if (idProblems.length > 0) fail(`system.yaml: ${idProblems.join('; ')}`, 400);
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
  writeThrough(rec, { action: `edit ${path}`, actorId: user.id });
  const newContent = project(rec, path);
  // A folder the definition names (an output's "where the results go", a folder grant) exists
  // from this save on — not only once a run first writes there. As the saving user, governed;
  // what could not be created is returned with the save (`declared-folders.ts`).
  const folders = path === 'system.yaml'
    ? materializeDeclaredFolders(parseSystem(rec.yaml), { id: user.id, role: user.role, domains: user.domains }, rec.domain)
    : undefined;
  return { path, content: newContent, sha: sha(newContent), ...(folders ? { folders } : {}) };
}

/**
 * Write the Build's `model: auto` decisions into the stored definition (`build/model-choice.ts`). Reads the CURRENT
 * definition, so an edit made while the Build ran is kept; an agent no longer on Auto is left alone. A decision that
 * is already stored is no change (no version churn). Returns the stored yaml.
 */
export function setAutoModelDecisions(
  systemId: string,
  user: Principal,
  decisions: readonly { id: string; tier: 'strong' | 'standard'; reason: string; basis?: string }[],
): string {
  const rec = requireEdit(systemId, user);
  const sys = parseSystem(rec.yaml);
  let changed = false;
  for (const d of decisions) {
    const a = sys.agents.find((x) => x.id === d.id);
    if (!a || a.model !== 'auto') continue;
    if (a.model_resolved === d.tier && a.model_reason === d.reason && a.model_basis === d.basis) continue;
    a.model_resolved = d.tier;
    a.model_reason = d.reason;
    // A fallback decision keeps no basis, so the next Build asks again.
    if (d.basis) a.model_basis = d.basis;
    else delete a.model_basis;
    changed = true;
  }
  if (!changed) return rec.yaml;
  versions.record(rec.id, user.id, snapshotState(rec), 'build: auto model choice');
  rec.yaml = serializeSystem(sys);
  rec.updatedAt = now();
  writeThrough(rec, { action: 'build: auto model choice', actorId: user.id });
  return rec.yaml;
}

// -------------------------------------------------------- run / schedule / toggle --

export function setRunning(systemId: string, user: Principal, running: boolean): SystemRecord {
  const rec = requireEdit(systemId, user);
  rec.running = running;
  rec.updatedAt = now();
  if (running) rec.lastActivity = now();
  writeThrough(rec, { action: running ? 'start system' : 'stop system', actorId: user.id });
  return rec;
}

export function setSchedule(systemId: string, user: Principal, schedule: Schedule): SystemRecord {
  const rec = requireEdit(systemId, user);
  rec.schedule = schedule;
  rec.updatedAt = now();
  writeThrough(rec, { action: `set schedule ${schedule.kind}`, actorId: user.id });
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
  writeThrough(rec, { action: `${on ? 'enable' : 'disable'} agent ${agentId}`, actorId: user.id });
  return rec;
}

export function recordActivity(systemId: string): void {
  const rec = state().store.get(systemId);
  if (rec) rec.lastActivity = now();
  if (rec) writeRunState(rec, ['lastActivity']); // last-activity stamp — a run artefact, never a commit
}

export function setLastBuild(systemId: string, user: Principal, build: LastBuild): SystemRecord {
  const rec = requireEdit(systemId, user);
  rec.lastBuild = build;
  rec.updatedAt = now();
  writeThrough(rec, { action: `build system (${build.ok ? 'ok' : 'failed'})`, actorId: user.id });
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
  // Stamp the marker with THIS process's nonce (unless the caller already set one),
  // so a later process can recognise a run this process abandoned on a crash.
  rec.activity = { ...marker, instanceId: marker.instanceId ?? PROCESS_INSTANCE };
  writeRunState(rec, ['activity']); // in-flight marker — a run artefact, never a commit
}

/** Clear the in-progress marker once a build or run completes (or errors). Also
 *  clears any run checkpoint — a completed run has no in-flight state to recover. */
export function clearActivity(systemId: string): void {
  const rec = state().store.get(systemId);
  if (!rec) return;
  delete rec.activity;
  delete rec.runCheckpoint;
  writeRunState(rec, ['activity', 'runCheckpoint']); // in-flight marker cleared — a run artefact, never a commit
}

/**
 * Open a durable run checkpoint at the START of a run. Stamps the current process's
 * instance id (matching the activity marker) and records the run's intent + planned
 * node walk. Called from the run route alongside {@link setActivity}. No-op for an
 * unknown system. The checkpoint is updated per node via {@link checkpointNode} and
 * cleared by {@link clearActivity} on completion.
 */
export function startRunCheckpoint(
  systemId: string,
  input: { prompt?: string; plannedNodes?: string[]; runId?: string; checkpointer?: 'postgres' | 'memory' },
): void {
  const rec = state().store.get(systemId);
  if (!rec) return;
  const at = Date.now();
  rec.runCheckpoint = {
    instanceId: PROCESS_INSTANCE,
    startedAt: at,
    updatedAt: at,
    prompt: input.prompt,
    plannedNodes: input.plannedNodes,
    completedNodes: [],
    runId: input.runId,
    checkpointer: input.checkpointer,
  };
  writeRunState(rec, ['runCheckpoint']); // run checkpoint — a run artefact, never a commit
}

/** Upper bound on a checkpointed node's finalText (chars) — the checkpoint stays lean. */
const CHECKPOINT_TEXT_MAX = 2_000;

/**
 * Record run progress at a node boundary into the durable checkpoint. `phase:'start'`
 * marks a node as the one now executing; `phase:'complete'` appends it to the finished
 * list (with a bounded final text + status) and clears `currentNode`. Every call writes
 * through to the mirror, so a crash after ANY node leaves that node's completion durable.
 * Fail-soft: a no-checkpoint or unknown record is ignored (never throws).
 */
export function checkpointNode(
  systemId: string,
  ev: { phase: 'start' | 'complete'; node: string; status?: string; finalText?: string },
): void {
  const rec = state().store.get(systemId);
  const cp = rec?.runCheckpoint;
  if (!rec || !cp) return;
  cp.updatedAt = Date.now();
  if (ev.phase === 'start') {
    cp.currentNode = ev.node;
  } else {
    const finalText = ev.finalText
      ? ev.finalText.length > CHECKPOINT_TEXT_MAX
        ? `${ev.finalText.slice(0, CHECKPOINT_TEXT_MAX)}…`
        : ev.finalText
      : undefined;
    cp.completedNodes.push({ node: ev.node, status: ev.status ?? 'ok', finalText });
    if (cp.currentNode === ev.node) delete cp.currentNode;
  }
  writeRunState(rec, ['runCheckpoint']); // run checkpoint — a run artefact, never a commit
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
  writeRunState(rec, ['lastRun']); // last-run report — a run artefact, never a commit
  return rec;
}

// -------------------------------------------------------------- rename / folder --

/**
 * Rename an agent system — change its DISPLAY name ONLY. Edit-scoped exactly like every
 * other mutation ({@link requireEdit}: owner always; an in-domain domain_admin / platform
 * admin on a Shared/Marketplace system — the reused {@link canManageArtifact} gate).
 *
 * FROZEN IDENTITY: the record `id` is the system's permanent identity — every route,
 * grant, approval and schedule CronJob keys off it, so a rename
 * NEVER touches `id`. The canonical `system.yaml` ALSO embeds `system.name`; the SAFE
 * choice (documented) is to change the DISPLAY `name` field ONLY and leave the yaml's
 * `system.name` frozen — the yaml name is cosmetic (scoping/identity read `rec.id` +
 * `rec.domain`, never the yaml name), so rewriting it would only churn the versioned
 * source + risk a stale-sha edit conflict for no functional gain.
 *
 * Trimmed; empty rejected (400); a no-op (unchanged) returns without version churn. The
 * prior canonical source is snapshotted to the version log so the rename is auditable.
 */
export function renameAgentSystem(systemId: string, user: Principal, newName: string): SystemRecord {
  const rec = requireEdit(systemId, user);
  const name = newName.trim();
  if (!name) fail('a system needs a name', 400);
  if (name === rec.name) return rec; // no-op → no version churn
  // Snapshot the canonical source before the (metadata) change, mirroring writeFile —
  // a rename is a meaningful, restorable edit even though the yaml identity is frozen.
  versions.record(rec.id, user.id, snapshotState(rec), 'rename');
  rec.name = name; // DISPLAY name only — `id` (and the yaml's system.name) stay frozen
  rec.updatedAt = now();
  writeThrough(rec, { action: 'rename system', actorId: user.id });
  return rec;
}

/** The folder scope an agent system lives in: a Personal system's folders are the
 *  owner's PERSONAL tree; a Shared/Marketplace system's folders are the owning DOMAIN's
 *  tree. Mirrors how {@link listSystems} groups by visibility. */
function folderScopeOf(rec: SystemRecord): FolderScope {
  return rec.visibility === 'Personal' ? 'personal' : 'domain';
}

/** Best-effort: mirror a system's folder path into the governed folder registry so an
 *  empty folder still shows in the rail. The root is implicit (never a row). createFolder
 *  is idempotent and edit-scoped; a gate refusal is logged + returned by `ensureFolderRow`, and a
 *  successful move is never rolled back by it (mirrors Data's upsertFolderRow). */
function upsertFolderRow(rec: SystemRecord, user: Principal): EnsureFolderResult {
  // `ensureFolderRow` is the shared door: root is a no-op, a governed refusal is logged and
  // returned (never swallowed), and it never rolls the move back.
  const principal: FolderPrincipal = { id: user.id, role: user.role, domains: user.domains };
  return ensureFolderRow(principal, { tab: 'agents', scope: folderScopeOf(rec), path: rec.folder, domain: rec.domain });
}

/**
 * Move an agent system into a folder (edit-scoped, write-through like every other
 * mutation). Mirrors `lib/data/store.moveDataset`: the folder is a normalised path on
 * the record; the folder ROOT (personal vs domain tree) is decided by visibility. On
 * move we also upsert an EXPLICIT folder row in the governed registry so the destination
 * folder persists even when it holds no systems. A viewer who cannot edit is rejected 403
 * and nothing is written.
 */
export function moveAgentSystem(systemId: string, user: Principal, folder: string, onFolder?: (r: EnsureFolderResult) => void): SystemRecord {
  const rec = requireEdit(systemId, user);
  rec.folder = normaliseFolderPath(folder);
  rec.updatedAt = now();
  writeThrough(rec, { action: `move to folder ${rec.folder}`, actorId: user.id });
  // The move already passed the record's edit-scope gate above, so this same-owner
  // folder create can only mirror an authorised move (best-effort; never rolls it back).
  // Evaluated FIRST: `onFolder?.(…)` would skip its argument (the row) when no callback is passed.
  const folderRow = upsertFolderRow(rec, user);
  onFolder?.(folderRow); // the door says a refusal
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
  writeThrough(rec, { action: 'archive system', actorId: user.id });
  return rec;
}

/** Restore an archived system back into the working lists (edit-scoped). */
export function unarchiveSystem(systemId: string, user: Principal): SystemRecord {
  const rec = requireEdit(systemId, user);
  rec.archived = false;
  rec.updatedAt = now();
  writeThrough(rec, { action: 'unarchive system', actorId: user.id });
  return rec;
}

/**
 * Permanently delete a system + its version history (edit-scoped, irreversible).
 * The API route confirms intent; this is the hard delete once confirmed. Returns the
 * deleted record so the route can PHYSICALLY purge its backing resources (any schedule
 * CronJob) via physical-delete.ts — a "deleted" system whose CronJob still exists isn't
 * deleted. Archive (above) never purges either.
 */
export function deleteSystem(systemId: string, user: Principal): SystemRecord {
  const rec = requireEdit(systemId, user);
  state().store.delete(rec.id);
  mirror.deleteThrough(rec.id);
  versions.purge(rec.id);
  // Part D: the ONE path a removal takes. The record is already gone, so the commit hook's
  // snapshot no longer contains it and the commit REMOVES the system's directory with this reason.
  emitSystemChange({ domain: rec.domain, systemId: rec.id, name: rec.name, action: 'delete system', actorId: user.id });
  return rec;
}

/**
 * Part D — the unscoped, server-side read the git generator works from: every LIVE (non-archived)
 * system of one domain, with the version number of its canonical source. Sorted by id so every
 * generated file is byte-stable. An archived system is deliberately absent: archive leaves the
 * working lists, so it leaves the repo too (and the commit that archives it REMOVES its directory).
 */
/**
 * Every definition in the durable mirror, read with NO side effect (WP-53b review): no hydration
 * of this process's registry, no crash recovery (which would mark in-flight runs `interrupted`
 * and write that back), no index creation — `_count` and `_search` only. `null` → the mirror did
 * not give a complete answer. For the read-only id preflight.
 */
export async function readSystemDefinitionsReadOnly(): Promise<{ id: string; domain: string; yaml: string; archived: boolean }[] | null> {
  const docs = await mirror.readOnlyList(2000);
  if (docs === null) return null;
  return (docs as Partial<SystemRecord>[])
    .filter((r) => r && typeof r.id === 'string' && typeof r.yaml === 'string')
    .map((r) => ({ id: r.id as string, domain: String(r.domain ?? ''), yaml: r.yaml as string, archived: !!r.archived }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Every domain that currently holds a live system — the set the boot reconcile walks. */
export function projectDomains(): string[] {
  ensureSeeded();
  const out = new Set<string>();
  for (const rec of state().store.values()) {
    if (!rec.archived && rec.domain) out.add(rec.domain);
  }
  return [...out].sort();
}

export function systemsForProject(domain: string): { rec: SystemRecord; version: number }[] {
  ensureSeeded();
  const out: { rec: SystemRecord; version: number }[] = [];
  for (const rec of state().store.values()) {
    if (rec.archived || rec.domain !== domain) continue;
    out.push({ rec, version: versions.latest(rec.id) });
  }
  return out.sort((a, b) => a.rec.id.localeCompare(b.rec.id));
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
  writeThrough(rec, { action: `restore v${version}`, actorId: user.id });
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
): { yaml: string; domain: string; owner: string; disabledAgents: string[]; archived: boolean } | null {
  ensureSeeded();
  const rec = state().store.get(systemId);
  if (!rec) return null;
  // `owner` is exposed so the scheduled-run endpoint can resolve it to the OWNER's
  // live governed identity and run the agent's tools under exactly the owner's
  // rights (delegated identity) — never a service principal.
  return { yaml: rec.yaml, domain: rec.domain, owner: rec.owner, disabledAgents: rec.disabledAgents, archived: !!rec.archived };
}

// ------------------------------------------------------------------ delete domain (admin) --
/** Delete-domain: every agent system of a domain, archived included. */
export function listSystemsForDomain(domain: string): { id: string; name: string; owner: string; archived: boolean }[] {
  ensureSeeded();
  return [...state().store.values()].filter((r) => r.domain === domain).map((r) => ({ id: r.id, name: r.name, owner: r.owner, archived: !!r.archived }));
}
