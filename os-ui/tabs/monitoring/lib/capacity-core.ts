/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Monitoring → Platform → Capacity: one server-side verdict on whether the platform has
 *             room — node requests vs allocatable, node memory use, OOM kills, the agent-run queue —
 *             with a concrete recommendation per finding.
 * USER STORY: As a platform admin running a class of twelve people I want to be warned BEFORE runs
 *             queue for half an hour, and told the right fix: when the node is idle and runs wait, the
 *             answer is "raise the worker's concurrency", not "buy a bigger server"; only when the
 *             REQUESTS cross the critical line, or memory use stays high, is it "next flavour / a
 *             second node".
 * ARCHITECTURE:
 *   - Pure (no `server-only`, no I/O) so it runs under `node --test`. `adapters/capacity.ts` reads the
 *     signals (Kubernetes API, VictoriaMetrics, the run store) and hands them in as `CapacityInput`.
 *   - Every signal is a `Signal<T>`: `live` with a value, `unavailable` with a reason (the source did
 *     not answer), or `not_measured` with a reason (no source exists in this install). A missing signal
 *     never becomes 0 or "healthy": no finding is derived from it, the source row says why, and the
 *     headline is `partial` (some answered) or `unknown` (none answered).
 *   - Thresholds have documented defaults (CAPACITY_DEFAULTS) and can be overridden per install
 *     (chart `osUI.capacityReader.thresholds` → OS_CAPACITY_* env → `resolveThresholds`). An invalid
 *     override keeps the default AND is reported in `configErrors` — never silently ignored.
 *   - Findings carry a stable `code` + `params`; the UI renders them through the `monitoring` catalog
 *     (all seven languages), MCP clients read the English `title` / `recommendation`.
 */

// ------------------------------------------------------------------ thresholds --

export type CapacityThresholds = {
  /** Node memory REQUESTS / allocatable. */
  memRequestsWarn: number;
  memRequestsCrit: number;
  /** Node CPU REQUESTS / allocatable. */
  cpuRequestsWarn: number;
  cpuRequestsCrit: number;
  /** Node memory USE (working set / capacity), now; "stays high" = its minimum over the last hour. */
  memUsageWarn: number;
  /** Oldest queued agent run's wait, and the p95 wait-to-start of the last hour (seconds). */
  queueWaitWarnSec: number;
  queueWaitCritSec: number;
  /** p95 duration of agent runs finished in the last hour (seconds). */
  runP95WarnSec: number;
  /** Model gateway 429 / timeout share of calls in the last hour. */
  modelErrorRateWarn: number;
};

export const CAPACITY_DEFAULTS: CapacityThresholds = {
  memRequestsWarn: 0.75,
  memRequestsCrit: 0.85,
  cpuRequestsWarn: 0.8,
  cpuRequestsCrit: 0.9,
  memUsageWarn: 0.8,
  queueWaitWarnSec: 60,
  queueWaitCritSec: 300,
  runP95WarnSec: 600,
  modelErrorRateWarn: 0.02,
};

/** The env name of each threshold (chart: `osUI.capacityReader.thresholds.<key>`). */
export const THRESHOLD_ENV: Record<keyof CapacityThresholds, string> = {
  memRequestsWarn: 'OS_CAPACITY_MEM_REQUESTS_WARN',
  memRequestsCrit: 'OS_CAPACITY_MEM_REQUESTS_CRIT',
  cpuRequestsWarn: 'OS_CAPACITY_CPU_REQUESTS_WARN',
  cpuRequestsCrit: 'OS_CAPACITY_CPU_REQUESTS_CRIT',
  memUsageWarn: 'OS_CAPACITY_MEM_USAGE_WARN',
  queueWaitWarnSec: 'OS_CAPACITY_QUEUE_WAIT_WARN_SEC',
  queueWaitCritSec: 'OS_CAPACITY_QUEUE_WAIT_CRIT_SEC',
  runP95WarnSec: 'OS_CAPACITY_RUN_P95_WARN_SEC',
  modelErrorRateWarn: 'OS_CAPACITY_MODEL_ERROR_RATE_WARN',
};

const RATIO_KEYS = new Set<keyof CapacityThresholds>(['memRequestsWarn', 'memRequestsCrit', 'cpuRequestsWarn', 'cpuRequestsCrit', 'memUsageWarn', 'modelErrorRateWarn']);

/**
 * Overrides (raw env strings; empty/absent = default) → thresholds. A ratio must be in (0, 1], a
 * duration > 0, and each warn below its critical; anything else keeps the default and is reported.
 */
export function resolveThresholds(raw: Partial<Record<keyof CapacityThresholds, string | undefined>>): { thresholds: CapacityThresholds; configErrors: string[] } {
  const t: CapacityThresholds = { ...CAPACITY_DEFAULTS };
  const configErrors: string[] = [];
  for (const key of Object.keys(CAPACITY_DEFAULTS) as (keyof CapacityThresholds)[]) {
    const v = (raw[key] ?? '').trim();
    if (!v) continue;
    const n = Number(v);
    const ok = Number.isFinite(n) && n > 0 && (!RATIO_KEYS.has(key) || n <= 1);
    if (ok) t[key] = n;
    else configErrors.push(`${THRESHOLD_ENV[key]}=${JSON.stringify(v)} is not valid (${RATIO_KEYS.has(key) ? 'a ratio in (0, 1]' : 'a positive number of seconds'}); the default ${CAPACITY_DEFAULTS[key]} is used`);
  }
  for (const [w, c] of [['memRequestsWarn', 'memRequestsCrit'], ['cpuRequestsWarn', 'cpuRequestsCrit'], ['queueWaitWarnSec', 'queueWaitCritSec']] as const) {
    if (t[w] > t[c]) {
      configErrors.push(`${THRESHOLD_ENV[w]} (${t[w]}) is above ${THRESHOLD_ENV[c]} (${t[c]}); both defaults are used`);
      t[w] = CAPACITY_DEFAULTS[w];
      t[c] = CAPACITY_DEFAULTS[c];
    }
  }
  return { thresholds: t, configErrors };
}

// ------------------------------------------------------------------- signals --

export type Signal<T> = { state: 'live'; value: T } | { state: 'unavailable'; reason: string } | { state: 'not_measured'; reason: string };
export type SignalState = { state: 'live' } | { state: 'unavailable'; reason: string } | { state: 'not_measured'; reason: string };

export const stateOf = <T>(s: Signal<T>): SignalState => (s.state === 'live' ? { state: 'live' } : { state: s.state, reason: s.reason.slice(0, 300) });

/** One node: allocatable and the sum of the requests of the pods scheduled on it. */
export type NodeCapacity = {
  name: string;
  /** `node.kubernetes.io/instance-type` (SKE: the flavour, e.g. m3i.8), when labelled. */
  flavour: string | null;
  pool: string | null;
  allocCpuCores: number;
  allocMemBytes: number;
  reqCpuCores: number;
  reqMemBytes: number;
};

/** One node's measured use (VictoriaMetrics, kubelet_stats). Any field may be unknown (null). */
export type NodeUsage = { name: string; memNow: number | null; memMin1h: number | null; cpuCoresNow: number | null; cpuCoresAvg1h: number | null };

export type OomKill = { namespace: string; pod: string; container: string; app: string | null; at: number; restarts: number };

export type RunQueue = {
  queued: number;
  running: number;
  /** Seconds the oldest queued run has waited (since it was queued or re-queued); null = none queued. */
  oldestQueuedWaitSec: number | null;
  /** Runs that started (first event) in the last hour, and their p95 wait from filing to start. */
  startedLastHour: number;
  p95StartWaitSec: number | null;
  /** Runs that finished (done/failed, first attempt) in the last hour, and their p95 duration. */
  finishedLastHour: number;
  p95RunSec: number | null;
};

export type ModelGateway = { calls: number; rateLimitedOrTimedOut: number };

/** How agent runs are executed, so a queue recommendation names the right switch. */
export type Executor = { mode: 'inline' | 'worker' };

export type CapacityInput = {
  nowMs: number;
  thresholds: CapacityThresholds;
  configErrors?: string[];
  nodes: Signal<NodeCapacity[]>;
  usage: Signal<NodeUsage[]>;
  oomKills: Signal<OomKill[]>;
  runQueue: Signal<RunQueue>;
  modelGateway: Signal<ModelGateway>;
  executor: Executor;
  /** The release namespace, to name a chart values key for an OOM-killed platform container. */
  platformNamespace: string;
};

// ------------------------------------------------------------------ findings --

export const FINDING_CODES = ['memRequests', 'cpuRequests', 'memUsage', 'memUsageSustained', 'oomKill', 'oomKillRepeated', 'queueWait', 'queueWaitRecent', 'runDuration', 'modelErrors'] as const;
export type FindingCode = (typeof FINDING_CODES)[number];

export const ACTION_CODES = ['upgradeNode', 'planCapacity', 'watchMemory', 'raiseMemoryLimitKey', 'raiseMemoryLimit', 'raiseConcurrency', 'enableWorker', 'capacityFirst', 'investigateRunDuration', 'investigateModel'] as const;
export type ActionCode = (typeof ACTION_CODES)[number];

export type Params = Record<string, string | number>;

export type CapacityFinding = {
  id: string;
  code: FindingCode;
  severity: 'warning' | 'critical';
  params: Params;
  action: ActionCode;
  actionParams: Params;
  /** English, for MCP clients and logs; the UI renders `code` / `action` in the reader's language. */
  title: string;
  recommendation: string;
};

export const HEADLINES = ['healthy', 'partial', 'unknown', 'upgradeNode', 'raiseConcurrency', 'fixMemoryLimits', 'attention'] as const;
export type Headline = (typeof HEADLINES)[number];

export type NodeRow = {
  name: string;
  flavour: string | null;
  pool: string | null;
  cpuRequests: number;
  memRequests: number;
  /** null = not measured (VictoriaMetrics unavailable or no series for this node). */
  cpuUsage: number | null;
  memUsage: number | null;
  memUsageMin1h: number | null;
};

export type CapacityAssessment = {
  generatedAt: string;
  verdict: 'ok' | 'warning' | 'critical' | 'unknown';
  headline: Headline;
  thresholds: CapacityThresholds;
  configErrors: string[];
  sources: { nodes: SignalState; usage: SignalState; oomKills: SignalState; runQueue: SignalState; modelGateway: SignalState };
  nodes: NodeRow[];
  queue: RunQueue | null;
  executor: Executor;
  findings: CapacityFinding[];
};

/** A ratio as a whole percent for text (0.763 → 76). */
const pc = (r: number): number => Math.round(r * 100);
const mins = (sec: number): number => Math.round((sec / 60) * 10) / 10;

/** The next larger flavour by STACKIT's `<family>.<vCPU>` naming (m3i.8 → m3i.16); null when not that shape. */
export function nextFlavour(flavour: string | null): string | null {
  const m = /^([a-z][a-z0-9]*)\.(\d+)$/i.exec(flavour ?? '');
  return m ? `${m[1]}.${Number(m[2]) * 2}` : null;
}

/** The chart values key holding a platform component's memory limit, by its `app.kubernetes.io/name`. */
const VALUES_KEY: Record<string, string> = {
  'os-ui': 'osUI.resources.limits.memory',
  'os-ui-worker': 'osUI.worker.resources.limits.memory',
  valkey: 'valkey.resources.limits.memory',
  postgres: 'postgres.resources.limits.memory',
  clickhouse: 'clickhouse.resources.limits.memory',
  litellm: 'litellm.resources.limits.memory',
  opensearch: 'opensearch.resources.limits.memory',
  opa: 'opa.resources.limits.memory',
  docling: 'docling.resources.limits.memory',
  trino: 'trino.resources.limits.memory',
  polaris: 'polaris.resources.limits.memory',
  'query-tool': 'queryTool.resources.limits.memory',
  'data-runner': 'dataRunner.resources.limits.memory',
  'object-storage': 'objectStorage.resources.limits.memory',
  'egress-proxy': 'egressProxy.resources.limits.memory',
  'web-fetch': 'webFetch.resources.limits.memory',
  'victoria-metrics': 'observability.victoriaMetrics.resources.limits.memory',
  'victoria-logs': 'observability.victoriaLogs.resources.limits.memory',
  'otel-collector': 'observability.collector.resources.limits.memory',
  'pg-dump': 'backup.pgDump.resources.limits.memory',
};

export function valuesKeyFor(k: Pick<OomKill, 'namespace' | 'app' | 'container'>, platformNamespace: string): string | null {
  if (k.namespace !== platformNamespace || !k.app) return null;
  if (k.app === 'langfuse' && (k.container === 'web' || k.container === 'worker')) return `langfuse.langfuse.${k.container}.resources.limits.memory`;
  return VALUES_KEY[k.app] ?? null;
}

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------- assessment --

export function assessCapacity(input: CapacityInput): CapacityAssessment {
  const t = input.thresholds;
  const findings: CapacityFinding[] = [];
  const nodes = input.nodes.state === 'live' ? input.nodes.value : [];
  const usage = new Map((input.usage.state === 'live' ? input.usage.value : []).map((u) => [u.name, u]));

  const rows: NodeRow[] = nodes.map((n) => {
    const u = usage.get(n.name);
    return {
      name: n.name,
      flavour: n.flavour,
      pool: n.pool,
      cpuRequests: n.allocCpuCores > 0 ? n.reqCpuCores / n.allocCpuCores : 0,
      memRequests: n.allocMemBytes > 0 ? n.reqMemBytes / n.allocMemBytes : 0,
      cpuUsage: u?.cpuCoresNow != null && n.allocCpuCores > 0 ? u.cpuCoresNow / n.allocCpuCores : null,
      memUsage: u?.memNow ?? null,
      memUsageMin1h: u?.memMin1h ?? null,
    };
  });
  const poolSize = new Map<string, number>();
  for (const r of rows) poolSize.set(r.pool ?? '', (poolSize.get(r.pool ?? '') ?? 0) + 1);

  // --- node capacity: REQUESTS decide an upgrade; memory USE only when it stays high for an hour.
  for (const r of rows) {
    const next = nextFlavour(r.flavour);
    const alone = (poolSize.get(r.pool ?? '') ?? 0) <= 1;
    const upgrade = (): { action: ActionCode; actionParams: Params; recommendation: string } => ({
      action: 'upgradeNode',
      actionParams: { node: r.name, flavour: r.flavour ?? '', next: next ?? '', hasNext: r.flavour && next ? 'yes' : 'no', alone: alone ? 'yes' : 'no' },
      recommendation:
        `Move the pool to the next larger flavour${r.flavour && next ? ` (${r.flavour} → ${next}; check it is offered in your region)` : ''} or add a second node.` +
        (alone ? ' With one node in the pool, enable the SKE cluster autoscaler (node pool maximum > 1) so a node is added under load.' : '') +
        ' Requests, not limits, decide what the scheduler can still place.',
    });
    const plan = (what: string, value: number): { action: ActionCode; actionParams: Params; recommendation: string } => ({
      action: 'planCapacity',
      actionParams: { node: r.name, resource: what === 'Memory' ? 'memory' : 'cpu', value: pc(value) },
      recommendation: `${what} requests on ${r.name} are at ${pc(value)}% — not critical yet. Before adding workloads or a larger class, check for oversized requests and plan the next flavour or a second node; no purchase is needed today.`,
    });
    for (const [code, ratio, warn, crit, label] of [
      ['memRequests', r.memRequests, t.memRequestsWarn, t.memRequestsCrit, 'Memory'],
      ['cpuRequests', r.cpuRequests, t.cpuRequestsWarn, t.cpuRequestsCrit, 'CPU'],
    ] as const) {
      if (ratio < warn) continue;
      const critical = ratio >= crit;
      const title = `${label} requests on ${r.name} at ${pc(ratio)}% of allocatable (warn ${pc(warn)}%, critical ${pc(crit)}%)`;
      const rec = critical ? upgrade() : plan(label, ratio);
      findings.push({ id: `${code}:${r.name}`, code, severity: critical ? 'critical' : 'warning', params: { node: r.name, value: pc(ratio), warn: pc(warn), crit: pc(crit) }, title, ...rec });
    }
    if (r.memUsage != null && r.memUsage >= t.memUsageWarn) {
      const sustained = r.memUsageMin1h != null && r.memUsageMin1h >= t.memUsageWarn;
      if (sustained) {
        findings.push({ id: `memUsageSustained:${r.name}`, code: 'memUsageSustained', severity: 'critical', params: { node: r.name, value: pc(r.memUsage), min: pc(r.memUsageMin1h!), warn: pc(t.memUsageWarn) }, title: `Memory use on ${r.name} has stayed above ${pc(t.memUsageWarn)}% for an hour (now ${pc(r.memUsage)}%, lowest ${pc(r.memUsageMin1h!)}%)`, ...upgrade() });
      } else {
        findings.push({
          id: `memUsage:${r.name}`,
          code: 'memUsage',
          severity: 'warning',
          params: { node: r.name, value: pc(r.memUsage), warn: pc(t.memUsageWarn) },
          action: 'watchMemory',
          actionParams: { node: r.name, warn: pc(t.memUsageWarn) },
          title: `Memory use on ${r.name} at ${pc(r.memUsage)}% (warn ${pc(t.memUsageWarn)}%)`,
          recommendation: `A peak, not yet a trend: check the top memory pods below. If memory use stays above ${pc(t.memUsageWarn)}% for an hour, move to the next flavour or add a node.`,
        });
      }
    }
  }
  const nodeCritical = findings.some((f) => f.severity === 'critical' && (f.code === 'memRequests' || f.code === 'cpuRequests' || f.code === 'memUsageSustained'));

  // --- OOM kills in the last 24 h: the container's limit is too small — never a reason to buy a node.
  if (input.oomKills.state === 'live') {
    for (const k of input.oomKills.value) {
      if (input.nowMs - k.at > DAY_MS) continue;
      const repeated = k.restarts >= 2;
      const key = valuesKeyFor(k, input.platformNamespace);
      const where = `${k.namespace}/${k.pod}`;
      findings.push({
        id: `oom:${k.namespace}/${k.pod}/${k.container}`,
        code: repeated ? 'oomKillRepeated' : 'oomKill',
        severity: repeated ? 'critical' : 'warning',
        params: { container: k.container, pod: where, restarts: k.restarts },
        action: key ? 'raiseMemoryLimitKey' : 'raiseMemoryLimit',
        actionParams: key ? { container: k.container, key } : { container: k.container, pod: where },
        title: `Container ${k.container} (${where}) was OOM-killed in the last 24 h${repeated ? ` — ${k.restarts} restarts` : ''}`,
        recommendation: key
          ? `Raise the memory limit of ${k.container} (values key ${key}); the node itself is not short of memory because one container hit its own limit.`
          : `Raise the memory limit of ${k.container} in ${where} (in the manifest or chart that owns it); the node itself is not short of memory because one container hit its own limit.`,
      });
    }
  }

  // --- the agent-run queue: waiting with room on the node = too little concurrency, not too small a server.
  const q = input.runQueue.state === 'live' ? input.runQueue.value : null;
  if (q) {
    const queueAction = (): { action: ActionCode; actionParams: Params; recommendation: string } => {
      if (nodeCritical)
        return { action: 'capacityFirst', actionParams: {}, recommendation: 'The node is also at capacity (see the node finding): add capacity first, then raise osUI.worker.concurrency or osUI.worker.replicas — more parallel runs on a full node only move the wait.' };
      if (input.executor.mode === 'inline')
        return { action: 'enableWorker', actionParams: {}, recommendation: 'Runs execute inside os-ui (AGENTS_WORKER=inline). Turn on the worker (osUI.worker.enabled=true) and raise osUI.worker.concurrency or osUI.worker.replicas. The node has room, so this is not a reason to buy a bigger server.' };
      return { action: 'raiseConcurrency', actionParams: {}, recommendation: 'The worker runs too few agent runs at once. Raise osUI.worker.concurrency or osUI.worker.replicas. The node has room, so this is not a reason to buy a bigger server.' };
    };
    if (q.oldestQueuedWaitSec != null && q.oldestQueuedWaitSec >= t.queueWaitWarnSec) {
      const critical = q.oldestQueuedWaitSec >= t.queueWaitCritSec;
      findings.push({
        id: 'queueWait',
        code: 'queueWait',
        severity: critical ? 'critical' : 'warning',
        params: { queued: q.queued, running: q.running, wait: Math.round(q.oldestQueuedWaitSec), warn: t.queueWaitWarnSec, crit: t.queueWaitCritSec },
        title: `${q.queued} agent run(s) queued; the oldest has waited ${Math.round(q.oldestQueuedWaitSec)} s (warn ${t.queueWaitWarnSec} s, critical ${t.queueWaitCritSec} s) while ${q.running} run(s) execute`,
        ...queueAction(),
      });
    } else if (q.p95StartWaitSec != null && q.p95StartWaitSec >= t.queueWaitWarnSec) {
      const critical = q.p95StartWaitSec >= t.queueWaitCritSec;
      findings.push({
        id: 'queueWaitRecent',
        code: 'queueWaitRecent',
        severity: critical ? 'critical' : 'warning',
        params: { started: q.startedLastHour, wait: Math.round(q.p95StartWaitSec), warn: t.queueWaitWarnSec, crit: t.queueWaitCritSec },
        title: `Agent runs waited to start: p95 ${Math.round(q.p95StartWaitSec)} s over the ${q.startedLastHour} run(s) started in the last hour (warn ${t.queueWaitWarnSec} s, critical ${t.queueWaitCritSec} s)`,
        ...queueAction(),
      });
    }
    if (q.p95RunSec != null && q.p95RunSec >= t.runP95WarnSec) {
      findings.push({
        id: 'runDuration',
        code: 'runDuration',
        severity: 'warning',
        params: { finished: q.finishedLastHour, minutes: mins(q.p95RunSec), warn: mins(t.runP95WarnSec) },
        action: 'investigateRunDuration',
        actionParams: {},
        title: `p95 agent run duration in the last hour: ${mins(q.p95RunSec)} min over ${q.finishedLastHour} run(s) (warn ${mins(t.runP95WarnSec)} min)`,
        recommendation: 'Long runs hold a worker slot for their whole length, so the queue behind them grows. Check model latency and step counts in the run traces (Langfuse); more concurrency shortens the queue, not the runs.',
      });
    }
  }

  // --- model gateway: only from a real count.
  if (input.modelGateway.state === 'live' && input.modelGateway.value.calls > 0) {
    const g = input.modelGateway.value;
    const rate = g.rateLimitedOrTimedOut / g.calls;
    if (rate > t.modelErrorRateWarn) {
      findings.push({
        id: 'modelErrors',
        code: 'modelErrors',
        severity: 'warning',
        params: { value: Math.round(rate * 1000) / 10, calls: g.calls, warn: Math.round(t.modelErrorRateWarn * 1000) / 10 },
        action: 'investigateModel',
        actionParams: {},
        title: `${Math.round(rate * 1000) / 10}% of ${g.calls} model calls in the last hour were rate-limited or timed out (warn ${Math.round(t.modelErrorRateWarn * 1000) / 10}%)`,
        recommendation: 'The model provider is the bottleneck, not this cluster: raise the provider quota or the deployment\'s rpm/tpm in the gateway, or add a fallback model. More worker concurrency would make it worse.',
      });
    }
  }

  const order = { critical: 0, warning: 1 } as const;
  findings.sort((a, b) => order[a.severity] - order[b.severity] || a.id.localeCompare(b.id));

  const sources = { nodes: stateOf(input.nodes), usage: stateOf(input.usage), oomKills: stateOf(input.oomKills), runQueue: stateOf(input.runQueue), modelGateway: stateOf(input.modelGateway) };
  // The sources that SHOULD answer (the gateway count is not offered today: not_measured is not a gap).
  const expected = [sources.nodes, sources.usage, sources.oomKills, sources.runQueue];
  const answered = expected.filter((s) => s.state === 'live').length;
  const anyCritical = findings.some((f) => f.severity === 'critical');

  let headline: Headline;
  if (answered === 0) headline = 'unknown';
  else if (nodeCritical) headline = 'upgradeNode';
  else if (findings.some((f) => f.code === 'queueWait' || f.code === 'queueWaitRecent')) headline = 'raiseConcurrency';
  else if (findings.some((f) => f.code === 'oomKill' || f.code === 'oomKillRepeated')) headline = 'fixMemoryLimits';
  else if (findings.length > 0) headline = 'attention';
  else headline = answered < expected.length ? 'partial' : 'healthy';

  return {
    generatedAt: new Date(input.nowMs).toISOString(),
    verdict: answered === 0 ? 'unknown' : anyCritical ? 'critical' : findings.length ? 'warning' : 'ok',
    headline,
    thresholds: t,
    configErrors: input.configErrors ?? [],
    sources,
    nodes: rows,
    queue: q,
    executor: input.executor,
    findings,
  };
}

// --------------------------------------------------------- Kubernetes folding --

const DEC: Record<string, number> = { n: 1e-9, u: 1e-6, m: 1e-3, '': 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18 };
const BIN: Record<string, number> = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50, Ei: 2 ** 60 };

/** A Kubernetes resource quantity ("250m", "1.5", "512Mi", "1G", "1e3") as a number; NaN when malformed. */
export function parseQuantity(q: string | number | undefined | null): number {
  if (typeof q === 'number') return q;
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)([a-zA-Z]*)$/.exec(String(q ?? '').trim());
  if (!m) return Number.NaN;
  const n = Number(m[1]);
  const suffix = m[2];
  if (suffix in BIN) return n * BIN[suffix];
  if (suffix in DEC) return n * DEC[suffix];
  return Number.NaN;
}

type Resources = { requests?: Record<string, string> };
type K8sContainer = { name?: string; resources?: Resources };
type K8sTerminated = { reason?: string; finishedAt?: string };
type K8sContainerStatus = { name?: string; restartCount?: number; state?: { terminated?: K8sTerminated }; lastState?: { terminated?: K8sTerminated } };
export type K8sPod = {
  metadata?: { name?: string; namespace?: string; labels?: Record<string, string> };
  spec?: { nodeName?: string; containers?: K8sContainer[]; initContainers?: K8sContainer[]; overhead?: Record<string, string> };
  status?: { phase?: string; containerStatuses?: K8sContainerStatus[]; initContainerStatuses?: K8sContainerStatus[] };
};
export type K8sNodeObj = {
  metadata?: { name?: string; labels?: Record<string, string> };
  status?: { allocatable?: Record<string, string> };
};

const req = (c: K8sContainer, r: 'cpu' | 'memory'): number => {
  const v = parseQuantity(c.resources?.requests?.[r] ?? '0');
  return Number.isFinite(v) ? v : 0;
};

/** The scheduler's effective request of a pod: max(sum of containers, largest init container) + overhead. */
export function podRequest(p: K8sPod, r: 'cpu' | 'memory'): number {
  const main = (p.spec?.containers ?? []).reduce((s, c) => s + req(c, r), 0);
  const init = Math.max(0, ...(p.spec?.initContainers ?? []).map((c) => req(c, r)));
  const over = parseQuantity(p.spec?.overhead?.[r] ?? '0');
  return Math.max(main, init) + (Number.isFinite(over) ? over : 0);
}

const POOL_LABELS = ['worker.gardener.cloud/pool', 'node.kubernetes.io/pool', 'ske.stackit.cloud/pool', 'cloud.google.com/gke-nodepool', 'eks.amazonaws.com/nodegroup', 'kubernetes.azure.com/agentpool'];

/** Nodes + every pod in the cluster → per-node allocatable and summed requests (pods that hold resources only). */
export function foldNodeCapacity(nodes: readonly K8sNodeObj[], pods: readonly K8sPod[]): NodeCapacity[] {
  const out = new Map<string, NodeCapacity>();
  for (const n of nodes) {
    const name = n.metadata?.name ?? '?';
    const labels = n.metadata?.labels ?? {};
    out.set(name, {
      name,
      flavour: labels['node.kubernetes.io/instance-type'] ?? labels['beta.kubernetes.io/instance-type'] ?? null,
      pool: POOL_LABELS.map((k) => labels[k]).find(Boolean) ?? null,
      allocCpuCores: parseQuantity(n.status?.allocatable?.cpu ?? '0') || 0,
      allocMemBytes: parseQuantity(n.status?.allocatable?.memory ?? '0') || 0,
      reqCpuCores: 0,
      reqMemBytes: 0,
    });
  }
  for (const p of pods) {
    const phase = p.status?.phase;
    if (phase === 'Succeeded' || phase === 'Failed') continue;
    const node = out.get(p.spec?.nodeName ?? '');
    if (!node) continue;
    node.reqCpuCores += podRequest(p, 'cpu');
    node.reqMemBytes += podRequest(p, 'memory');
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Containers whose last (or current) termination was an OOM kill, with when it happened. */
export function foldOomKills(pods: readonly K8sPod[]): OomKill[] {
  const out: OomKill[] = [];
  for (const p of pods) {
    const statuses = [...(p.status?.containerStatuses ?? []), ...(p.status?.initContainerStatuses ?? [])];
    for (const cs of statuses) {
      const term = [cs.state?.terminated, cs.lastState?.terminated].find((x) => x?.reason === 'OOMKilled');
      if (!term) continue;
      const at = Date.parse(term.finishedAt ?? '');
      if (!Number.isFinite(at)) continue;
      out.push({ namespace: p.metadata?.namespace ?? '', pod: p.metadata?.name ?? '?', container: cs.name ?? '?', app: p.metadata?.labels?.['app.kubernetes.io/name'] ?? null, at, restarts: cs.restartCount ?? 0 });
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

// ------------------------------------------------------------ VictoriaMetrics --

/** PromQL over the Collector's `kubelet_stats` node series (the same naming as panels-core's PROMQL). */
export const CAPACITY_PROMQL = {
  memNow: 'k8s_node_memory_working_set_bytes / (k8s_node_memory_working_set_bytes + k8s_node_memory_available_bytes)',
  memMin1h: 'min_over_time((k8s_node_memory_working_set_bytes / (k8s_node_memory_working_set_bytes + k8s_node_memory_available_bytes))[1h:1m])',
  cpuNow: 'k8s_node_cpu_usage',
  cpuAvg1h: 'avg_over_time(k8s_node_cpu_usage[1h])',
} as const;

type Sample = { metric: Record<string, string>; value: number };

export function foldNodeUsage(s: { memNow: readonly Sample[]; memMin1h: readonly Sample[]; cpuNow: readonly Sample[]; cpuAvg1h: readonly Sample[] }): NodeUsage[] {
  const out = new Map<string, NodeUsage>();
  const at = (n: string) => out.get(n) ?? (out.set(n, { name: n, memNow: null, memMin1h: null, cpuCoresNow: null, cpuCoresAvg1h: null }), out.get(n)!);
  for (const x of s.memNow) at(x.metric.k8s_node_name ?? '?').memNow = x.value;
  for (const x of s.memMin1h) at(x.metric.k8s_node_name ?? '?').memMin1h = x.value;
  for (const x of s.cpuNow) at(x.metric.k8s_node_name ?? '?').cpuCoresNow = x.value;
  for (const x of s.cpuAvg1h) at(x.metric.k8s_node_name ?? '?').cpuCoresAvg1h = x.value;
  return [...out.values()];
}
