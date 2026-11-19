/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The Knowledge corpus re-index — re-chunk and re-embed the index agents cite
 * USER STORY: As a platform admin I want the hash vectors the offline-mock outage wrote into the
 *             Knowledge index replaced with real embeddings through the real gateway, because
 *             every agent answer that quotes this corpus quotes it WITH a citation — and a k-NN
 *             search over hash vectors ranks by a hash while looking exactly like retrieval.
 * ARCHITECTURE:
 *   - TAB-OWNED, mirroring `tabs/files/lib/reindex.ts` the way `knowledgeIndexMapping` mirrors
 *     `filesIndexMapping`. The contract, the job table and the pure plan assembly are
 *     `@core/kernel/reindex`; everything corpus-specific is here.
 *   - WHAT "RE-PARSE" MEANS ON THIS CORPUS. A Knowledge unit's source of truth is the workflow
 *     document in the store (and in git), not a binary a parser has to read — so the equivalent
 *     of Docling is `chunkWorkflow`, and `indexWorkflow` / `indexDomain` re-chunk AND re-embed in
 *     one governed step. The only engine a run needs is therefore the embeddings gateway. Three
 *     unit kinds:
 *       `<workflowId>`   → indexWorkflow(record)        re-chunked from the document
 *       `domain:<name>`  → indexDomain(card)            the pinned domain card
 *       `doc:<_id>`      → re-embed the stored text     a pasted doc (/api/knowledge/docs POST)
 *                                                        has no workflow behind it and no vector
 *                                                        at all; it is embedded in place
 *   - IT REFUSES, IT NEVER FALLS BACK. The gateway is probed first; unreachable ⇒
 *     `refuseOfflineMock(...)` (typed ENGINE_UNAVAILABLE, 503) before any row is read. And since
 *     a laptop MAY hash (`OS_OFFLINE_MOCK=allow`), a gateway that falls over MID-RUN is refused
 *     too — inside the pipeline, by `requireLive`, which raises after the embedding and BEFORE
 *     `upsertUnits` and `writeOpenSearch` (review M1; the first version read `embedSource` off
 *     the report, by which time the write AND the prune had happened). `verdictOf` re-reads the
 *     report as a second line, so a future caller that forgets `requireLive` still cannot
 *     replace a real vector with a hash.
 *   - NEVER DELETES A ROW IT COULD NOT REPLACE: `writeOpenSearch` now adds and then prunes only
 *     what the add did not cover (see `index-pipeline.ts`), and a report that says `store:
 *     'memory'` — the OpenSearch write did not land — is a failure here, not a success.
 *   - HONEST ABOUT ITS BLIND SPOT. See
 *     `docs/superpowers/plans/2026-11-19-reindex-files-knowledge.md` §1.1 and
 *     {@link UNMARKED_CAVEAT}. This index has a `source` FIELD, but what it holds is provenance
 *     (`os-ui-ingest`, `files-use-as`) — no writer in either index ever stamped a stand-in label
 *     into it, and the embedder's `offline-hash` was never written to a row at all. So the
 *     `marked` query is well-formed and its expected count is 0 on this corpus too: a hash vector
 *     stays indistinguishable from a real one, and only `all` re-does those.
 */
import 'server-only';
import { config } from '@core/kernel/config';
import { refuseOfflineMock } from '@core/kernel/offline-mock';
import {
  assertReindexAdmin,
  batchSize,
  buildReindexPlan,
  finishJob,
  jobFor,
  jobRemaining,
  recordUnit,
  startOrResume,
  REINDEX_UNIT_CAP,
  type EngineProbe,
  type IndexSnapshot,
  type ReindexFilter,
  type ReindexJob,
  type ReindexPlan,
  type ReindexPrincipal,
  type ReindexService,
  type ReindexUnit,
  type StoredUnit,
} from '@core/kernel/reindex';
import { indexDomain, indexWorkflow } from '@tabs/knowledge/lib/index-pipeline';
import { actingCaller, embed } from '@tabs/knowledge/lib/embed';
import {
  domainsForIndex,
  ensureHydrated,
  getDomainKnowledge,
  listAllForIndex,
  recordForIndex,
} from '@tabs/knowledge/lib/store';

const TARGET = 'knowledge' as const;

/** How many loose (workflow-less) rows one plan enumerates. */
export const LOOSE_DOC_CAP = 500;

// ---------------------------------------------------------------------------
//  The queries
// ---------------------------------------------------------------------------

/**
 * The stand-in labels a row could carry. This index does have a `source` keyword — but it holds
 * PROVENANCE (`os-ui-ingest`, `files-use-as`), not an honesty label, and no writer ever stamped
 * one of these strings into it. So the query is well-formed and finds nothing today, exactly as
 * on the Files corpus; it exists so that a row which DOES carry such a label (a hand-written doc,
 * a future writer) is found rather than assumed away. The embedder's `offline-hash` never reached
 * a row at all, which is the blind spot {@link UNMARKED_CAVEAT} exists for.
 */
export const STANDIN_MARKERS = ['offline-hash', 'offline-mock', 'mock', 'demo-seed'] as const;
export const MARKER_FIELDS = ['source', 'embed_source', 'embedSource', 'mode', 'embed_mode'] as const;

export function markedQuery(): Record<string, unknown> {
  const should: Record<string, unknown>[] = [];
  for (const field of MARKER_FIELDS) {
    for (const marker of STANDIN_MARKERS) {
      should.push({ match_phrase: { [field]: marker } });
      should.push({ term: { [`${field}.keyword`]: marker } });
    }
  }
  return { bool: { should, minimum_should_match: 1 } };
}

/** A row with no embedding at all — the pasted-document door writes exactly this. */
export function missingVectorQuery(field = 'embedding'): Record<string, unknown> {
  return { bool: { must_not: [{ exists: { field } }] } };
}

/** Rows that belong to no workflow scope: the domain cards and the pasted docs. */
export function looseQuery(extra?: Record<string, unknown>): Record<string, unknown> {
  const must_not: Record<string, unknown>[] = [{ exists: { field: 'workflow_id' } }];
  return extra
    ? { bool: { must: [extra], must_not } }
    : { bool: { must_not } };
}

// ---------------------------------------------------------------------------
//  The live seam
// ---------------------------------------------------------------------------

export type UnitOutcome = { outcome: 'replaced' | 'failed' | 'skipped'; reason?: string };

export type KnowledgeReindexDeps = {
  probeEngines: () => Promise<EngineProbe[]>;
  readSnapshot: () => Promise<IndexSnapshot>;
  storedUnits: () => StoredUnit[] | Promise<StoredUnit[]>;
  reindexUnit: (unitId: string, by: string) => Promise<UnitOutcome>;
};

type OsReply = { status: number; body: Record<string, unknown> } | null;

async function osJson(path: string, init?: RequestInit, ms = 6000): Promise<OsReply> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(`${config.opensearchUrl}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', accept: 'application/json', ...(init?.headers ?? {}) },
      signal: ctrl.signal,
      cache: 'no-store',
    });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      body = {};
    }
    return { status: res.status, body };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The ONE engine this corpus needs: the embeddings gateway. There is no document parser here. */
export async function probeKnowledgeEngines(): Promise<EngineProbe[]> {
  const url = `${config.litellmUrl}/health/liveliness`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);
  try {
    const res = await fetch(url, { method: 'GET', signal: ctrl.signal, cache: 'no-store' });
    return [{ name: 'embeddings gateway (LiteLLM)', url, ready: res.ok, detail: res.ok ? null : `HTTP ${res.status}` }];
  } catch (e) {
    return [{ name: 'embeddings gateway (LiteLLM)', url, ready: false, detail: (e as Error).message || 'no response' }];
  } finally {
    clearTimeout(timer);
  }
}

function countOf(reply: OsReply): number {
  const n = reply?.body?.count;
  return typeof n === 'number' ? n : 0;
}

function bucketsOf(reply: OsReply): { key: string; doc_count: number }[] {
  const aggs = (reply?.body?.aggregations ?? {}) as Record<string, { buckets?: unknown }>;
  const raw = aggs.units?.buckets;
  return Array.isArray(raw) ? (raw as { key: string; doc_count: number }[]) : [];
}

type LooseHit = { id: string; label: string; unit: string };

/** Map a workflow-less row onto its unit: a domain card's scope, or the doc itself. */
export function looseUnitOf(id: string, source: { domain?: unknown; title?: unknown }): LooseHit {
  const domain = typeof source.domain === 'string' ? source.domain : '';
  const title = typeof source.title === 'string' && source.title ? source.title : id;
  if (id.startsWith('domain:')) {
    // `domain:<name>:<section>` — the unit is the card, not the section.
    const name = domain || id.split(':')[1] || '';
    return { id, label: `domain card · ${name || 'unknown'}`, unit: `domain:${name}` };
  }
  return { id, label: title, unit: `doc:${id}` };
}

function hitsOf(reply: OsReply): { _id?: unknown; _source?: Record<string, unknown> }[] {
  const hits = (reply?.body?.hits ?? {}) as { hits?: unknown };
  return Array.isArray(hits.hits) ? (hits.hits as { _id?: unknown; _source?: Record<string, unknown> }[]) : [];
}

const unitAgg = { units: { terms: { field: 'workflow_id', size: REINDEX_UNIT_CAP } } };
const looseSearch = (query: Record<string, unknown>) =>
  JSON.stringify({ size: LOOSE_DOC_CAP, query, _source: { includes: ['title', 'domain', 'type'] } });

function emptySnapshot(reachable: boolean): IndexSnapshot {
  return {
    reachable, rowsTotal: 0, mappingDim: null, rowsMarked: 0, rowsMissingVector: 0,
    rowsByUnit: new Map(), unitsMarked: new Set(), unitsMissingVector: new Set(), looseDocs: [], truncated: false,
  };
}

/** Pull the knn field's dimension out of a `_mapping` body (keyed by the concrete index name). */
export function mappingDimension(body: Record<string, unknown>, field: string): number | null {
  for (const entry of Object.values(body)) {
    const props = (entry as { mappings?: { properties?: Record<string, { dimension?: unknown }> } })?.mappings?.properties;
    const dim = props?.[field]?.dimension;
    if (typeof dim === 'number') return dim;
  }
  return null;
}

export async function readKnowledgeSnapshot(): Promise<IndexSnapshot> {
  const idx = `/${config.knowledgeIndex}`;
  const mapping = await osJson(`${idx}/_mapping`, { method: 'GET' });
  if (mapping === null) return emptySnapshot(false);
  if (mapping.status === 404) return emptySnapshot(true);

  const [all, marked, noVec, allUnits, markedUnits, noVecUnits, loose, looseMarked, looseNoVec] = await Promise.all([
    osJson(`${idx}/_count`, { method: 'POST', body: JSON.stringify({ query: { match_all: {} } }) }),
    osJson(`${idx}/_count`, { method: 'POST', body: JSON.stringify({ query: markedQuery() }) }),
    osJson(`${idx}/_count`, { method: 'POST', body: JSON.stringify({ query: missingVectorQuery() }) }),
    osJson(`${idx}/_search`, { method: 'POST', body: JSON.stringify({ size: 0, aggs: unitAgg }) }),
    osJson(`${idx}/_search`, { method: 'POST', body: JSON.stringify({ size: 0, query: markedQuery(), aggs: unitAgg }) }),
    osJson(`${idx}/_search`, { method: 'POST', body: JSON.stringify({ size: 0, query: missingVectorQuery(), aggs: unitAgg }) }),
    osJson(`${idx}/_search`, { method: 'POST', body: looseSearch(looseQuery()) }),
    osJson(`${idx}/_search`, { method: 'POST', body: looseSearch(looseQuery(markedQuery())) }),
    osJson(`${idx}/_search`, { method: 'POST', body: looseSearch(looseQuery(missingVectorQuery())) }),
  ]);

  const rowsByUnit = new Map<string, number>();
  for (const b of bucketsOf(allUnits)) rowsByUnit.set(b.key, b.doc_count);

  // Loose rows roll up into their unit (a domain card is one unit, not one unit per section).
  const looseDocs = new Map<string, { id: string; label: string }>();
  for (const h of hitsOf(loose)) {
    const u = looseUnitOf(String(h._id ?? ''), h._source ?? {});
    if (!u.id) continue;
    if (!looseDocs.has(u.unit)) looseDocs.set(u.unit, { id: u.unit, label: u.label });
    rowsByUnit.set(u.unit, (rowsByUnit.get(u.unit) ?? 0) + 1);
  }
  const unitsMarked = new Set(bucketsOf(markedUnits).map((b) => b.key));
  for (const h of hitsOf(looseMarked)) unitsMarked.add(looseUnitOf(String(h._id ?? ''), h._source ?? {}).unit);
  const unitsMissingVector = new Set(bucketsOf(noVecUnits).map((b) => b.key));
  for (const h of hitsOf(looseNoVec)) unitsMissingVector.add(looseUnitOf(String(h._id ?? ''), h._source ?? {}).unit);

  return {
    reachable: true,
    rowsTotal: countOf(all),
    mappingDim: mappingDimension(mapping.body, 'embedding'),
    rowsMarked: countOf(marked),
    rowsMissingVector: countOf(noVec),
    rowsByUnit,
    unitsMarked,
    unitsMissingVector,
    looseDocs: [...looseDocs.values()],
    truncated: bucketsOf(allUnits).length >= REINDEX_UNIT_CAP || hitsOf(loose).length >= LOOSE_DOC_CAP,
  };
}

/** Workflow scopes + domain-card scopes. Archived workflows are excluded: a purged archive
 *  legitimately has no rows, and flagging it `missing-representation` would be a false alarm. */
async function storedKnowledgeUnits(): Promise<StoredUnit[]> {
  await ensureHydrated();
  const workflows = listAllForIndex()
    .filter(({ record }) => !record.archived)
    .map(({ record }) => ({ id: record.id, label: record.title }));
  const domains = domainsForIndex().map((d) => ({ id: `domain:${d}`, label: `domain card · ${d}` }));
  return [...workflows, ...domains];
}

// ---------------------------------------------------------------------------
//  One unit of work
// ---------------------------------------------------------------------------

/** The primitives one unit needs. Injected so the refusal and the ordering are testable. */
export type UnitDeps = {
  record: typeof recordForIndex;
  domainCard: typeof getDomainKnowledge;
  indexWorkflow: typeof indexWorkflow;
  indexDomain: typeof indexDomain;
  embed: typeof embed;
  readDoc: (id: string) => Promise<{ text: string; domain: string } | null>;
  writeDocVector: (id: string, vector: number[]) => Promise<boolean>;
};

async function readKnowledgeDoc(id: string): Promise<{ text: string; domain: string } | null> {
  // The doc's OWN domain comes back with it, so the embedding is billed to the domain the
  // document belongs to rather than to no domain at all (review low 2): the spend belongs to the
  // object, which is the rule `actingCaller` exists to keep (checklist A27).
  const res = await osJson(`/${config.knowledgeIndex}/_doc/${encodeURIComponent(id)}?_source_includes=text,domain`, { method: 'GET' });
  if (!res || res.status !== 200) return null;
  const src = (res.body._source ?? {}) as { text?: unknown; domain?: unknown };
  const text = typeof src.text === 'string' ? src.text : '';
  const domain = typeof src.domain === 'string' ? src.domain : '';
  return text.trim() ? { text, domain } : null;
}

async function writeKnowledgeDocVector(id: string, vector: number[]): Promise<boolean> {
  const res = await osJson(`/${config.knowledgeIndex}/_update/${encodeURIComponent(id)}?refresh=true`, {
    method: 'POST',
    body: JSON.stringify({ doc: { embedding: vector } }),
  });
  return Boolean(res && res.status >= 200 && res.status < 300);
}

export const LIVE_UNIT_DEPS: UnitDeps = {
  record: recordForIndex,
  domainCard: getDomainKnowledge,
  // `requireLive` is bound HERE rather than trusted to the caller: the refusal has to happen
  // inside the pipeline, before its first write (review M1).
  indexWorkflow: (workflow, opts) => indexWorkflow(workflow, { ...opts, requireLive: true }),
  indexDomain: (card, caller) => indexDomain(card, caller, { requireLive: true }),
  embed,
  readDoc: readKnowledgeDoc,
  writeDocVector: writeKnowledgeDocVector,
};

/**
 * Re-index ONE Knowledge unit through the live path. Every failure path leaves the existing rows
 * alone: the write is the last thing that happens, and it is only reached once the gateway
 * answered with a real embedding.
 */
export async function reindexOneUnit(unitId: string, by: string, deps: UnitDeps = LIVE_UNIT_DEPS): Promise<UnitOutcome> {
  // --- a pasted document: no workflow behind it, so re-embed its stored text in place ---
  if (unitId.startsWith('doc:')) {
    const id = unitId.slice('doc:'.length);
    const doc = await deps.readDoc(id);
    if (!doc) return { outcome: 'skipped', reason: 'the document is gone, or holds no text to embed' };
    const { vectors, source } = await deps.embed([doc.text], actingCaller(by, doc.domain));
    if (source !== 'litellm' || !vectors[0]?.length) {
      return { outcome: 'failed', reason: `the gateway answered with a stand-in (${source}) — the row was left as it was` };
    }
    const ok = await deps.writeDocVector(id, vectors[0]);
    return ok
      ? { outcome: 'replaced' }
      : { outcome: 'failed', reason: 'OpenSearch did not accept the new embedding — the row is unchanged' };
  }

  // --- a domain card ---
  if (unitId.startsWith('domain:')) {
    const domain = unitId.slice('domain:'.length);
    const card = deps.domainCard(domain);
    if (!card.sections.some((s) => s.content.trim())) {
      return { outcome: 'skipped', reason: 'the domain card is empty, so it has nothing to index' };
    }
    const report = await deps.indexDomain(card, actingCaller(by, domain));
    return verdictOf(report, 'the domain card');
  }

  // --- a workflow ---
  const found = deps.record(unitId);
  if (!found) return { outcome: 'skipped', reason: 'the workflow is no longer stored' };
  const { record } = found;
  const report = await deps.indexWorkflow(found.workflow, {
    owner: record.owner,
    tacit: record.tacit,
    updatedAt: record.updatedAt,
    caller: actingCaller(by, record.domain),
  });
  return verdictOf(report, 'the workflow');
}

/** One honest reading of an index report: a hash embedding or a memory-only write is a FAILURE. */
function verdictOf(report: { units: number; store: string; embedSource: string }, what: string): UnitOutcome {
  if (report.units === 0) return { outcome: 'skipped', reason: `${what} produced no units to index` };
  if (report.embedSource !== 'litellm') {
    return { outcome: 'failed', reason: `the gateway answered with a stand-in (${report.embedSource}) — nothing was replaced` };
  }
  if (report.store !== 'opensearch') {
    return { outcome: 'failed', reason: 'the OpenSearch write did not land (in-memory only) — the existing rows stand' };
  }
  return { outcome: 'replaced' };
}

const LIVE_DEPS: KnowledgeReindexDeps = {
  probeEngines: probeKnowledgeEngines,
  readSnapshot: readKnowledgeSnapshot,
  storedUnits: storedKnowledgeUnits,
  reindexUnit: (unitId, by) => reindexOneUnit(unitId, by),
};

// ---------------------------------------------------------------------------
//  plan · run
// ---------------------------------------------------------------------------

export async function planReindex(
  principal: ReindexPrincipal,
  opts: { filter: ReindexFilter; deps?: KnowledgeReindexDeps },
): Promise<ReindexPlan> {
  assertReindexAdmin(principal);
  const deps = opts.deps ?? LIVE_DEPS;
  const [engines, snapshot, stored] = await Promise.all([
    deps.probeEngines(),
    deps.readSnapshot(),
    deps.storedUnits(),
  ]);
  return buildReindexPlan({
    target: TARGET,
    filter: opts.filter,
    engines,
    snapshot,
    stored,
    configuredDim: config.embedDim,
  });
}

const WORK_KEY = Symbol.for('soa.reindex.knowledge.work');
function workList(): Map<string, ReindexUnit[]> {
  const g = globalThis as unknown as Record<symbol, Map<string, ReindexUnit[]> | undefined>;
  if (!g[WORK_KEY]) g[WORK_KEY] = new Map();
  return g[WORK_KEY]!;
}

const BUSY_KEY = Symbol.for('soa.reindex.knowledge.busy');
function busy(set?: boolean): boolean {
  const g = globalThis as unknown as Record<symbol, boolean | undefined>;
  if (set !== undefined) g[BUSY_KEY] = set;
  return Boolean(g[BUSY_KEY]);
}

export async function runReindex(
  principal: ReindexPrincipal,
  plan: ReindexPlan | null,
  opts: { batch?: number; onProgress?: (job: ReindexJob) => void | Promise<void>; deps?: KnowledgeReindexDeps } = {},
): Promise<{ started: boolean; job: ReindexJob; reason?: string }> {
  assertReindexAdmin(principal);
  const deps = opts.deps ?? LIVE_DEPS;

  // REFUSE BEFORE READING ANYTHING, so a refusal provably touches no row.
  const engines = await deps.probeEngines();
  const down = engines.find((e) => !e.ready);
  if (down) {
    refuseOfflineMock(
      `Cannot re-index the Knowledge corpus: ${down.name} is unreachable at ${down.url}` +
        `${down.detail ? ` (${down.detail})` : ''}. A hash of the text is not an embedding, so ` +
        're-embedding without the gateway would write exactly the rows this re-index exists to ' +
        'replace. Nothing was read, replaced or deleted.',
    );
  }

  const existing = jobFor(TARGET);
  if (existing?.status === 'running' && busy()) {
    return { started: false, job: existing, reason: 'already-running' };
  }

  // RESUME (`plan === null`): no re-plan, no second index read — the running job's own work list
  // and cursor are the facts (review M4). Nothing to resume is a stated conflict, not a silent
  // no-op, because the caller believed there was a job.
  if (!plan) {
    if (!existing || existing.status !== 'running') {
      const err = new Error(
        `There is no running ${TARGET} re-index to continue. Run a plan first, then start one.`,
      ) as Error & { status?: number };
      err.status = 409;
      throw err;
    }
  }

  const claim = plan
    ? startOrResume(TARGET, { filter: plan.filter, by: principal.id, total: plan.units.length })
    : { started: false, job: existing! };
  const job = claim.job;
  if (claim.started && plan) workList().set(job.id, plan.units);

  // A resume uses the list the job was CREATED with. If that list is GONE — the process was
  // replaced between batches — the cursor would index into a different list, so the units it
  // points past would silently never be re-indexed while the job reported progress. That is a
  // false claim about the corpus, so the job FAILS here instead (review low 4). A fresh
  // plan + run then redoes the work honestly; the re-index is idempotent, so that costs only time.
  const work = workList().get(job.id);
  if (!work) {
    const dead = finishJob(
      TARGET,
      'failed',
      'The work list for this job was lost (the process was replaced between batches), so its ' +
        'cursor no longer points into a known list. Nothing was indexed against it. Run Plan ' +
        'again and start a fresh re-index — re-indexing is idempotent.',
    );
    return { started: false, job: dead ?? job, reason: 'work-list-lost' };
  }

  busy(true);
  try {
    const slice = work.slice(job.cursor, job.cursor + batchSize(opts.batch));
    for (const unit of slice) {
      // An ABANDON landing mid-batch stops the batch at the next unit boundary: `recordUnit`
      // already no-ops on a job that is not running, and continuing to call the gateway for a job
      // nobody is waiting for would spend budget on an answer no one reads.
      if (jobFor(TARGET)?.status !== 'running') break;
      let out: UnitOutcome;
      try {
        out = await deps.reindexUnit(unit.id, principal.id);
      } catch (e) {
        finishJob(TARGET, 'failed', (e as Error).message);
        workList().delete(job.id);
        throw e;
      }
      recordUnit(
        TARGET,
        out.outcome,
        out.outcome === 'replaced' ? undefined : { unit: unit.label, reason: out.reason ?? 'no reason given' },
      );
      const progressed = jobFor(TARGET);
      // AWAITED: a progress callback may itself be async (a UI flush, a re-entrant status read),
      // and a fire-and-forget call here would let the batch finish before the callback ran.
      if (progressed && opts.onProgress) await opts.onProgress(progressed);
    }
    const after = jobFor(TARGET)!;
    if (after.status === 'running' && jobRemaining(after) === 0) {
      finishJob(TARGET, 'done');
      workList().delete(job.id);
    }
    return { started: claim.started, job: jobFor(TARGET)!, reason: claim.started ? undefined : 'resumed' };
  } finally {
    busy(false);
  }
}

/**
 * ABANDON the target's running job (review H3). The only way out of a job whose process died
 * between batches: `busy` is process state, so without this the target stays wedged — the panel
 * would show a running job forever and every Continue would answer `already-running`.
 *
 * It marks the job FAILED and says who abandoned it rather than deleting it, because "somebody
 * gave up on this at 40/900" is a fact an operator needs afterwards. Nothing in the index is
 * touched or rolled back: the units already replaced are correctly replaced, and a later run
 * redoes the rest from a fresh plan.
 */
export async function abandonReindex(
  principal: ReindexPrincipal,
): Promise<{ abandoned: boolean; job: ReindexJob | null; reason?: string }> {
  assertReindexAdmin(principal);
  const job = jobFor(TARGET);
  if (!job || job.status !== 'running') {
    busy(false); // a stale flag with no running job is exactly what this door exists to clear
    return { abandoned: false, job, reason: 'nothing-running' };
  }
  const failed = finishJob(TARGET, 'failed', `Abandoned by ${principal.id} at ${job.cursor}/${job.total}. ` +
    'The units already replaced are replaced; the rest were not touched. Plan again to redo them.');
  workList().delete(job.id);
  busy(false);
  return { abandoned: true, job: failed ?? job };
}

/** Is a batch executing right now? Exposed so the panel can tell "running" from "busy" (H2). */
export function inFlight(): boolean {
  return busy();
}

/** Test hook. */
export function __resetKnowledgeReindex(): void {
  workList().clear();
  busy(false);
}

export const knowledgeReindexService: ReindexService = { planReindex, runReindex, abandonReindex, inFlight };
