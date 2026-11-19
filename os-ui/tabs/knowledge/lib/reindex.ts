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
  REINDEX_UNIT_CAP,
  type EngineProbe,
  type IndexSnapshot,
  type ReindexService,
  type StoredUnit,
} from '@core/kernel/reindex';
import {
  bucketsOf,
  countOf,
  createReindexRunner,
  mappingDimension,
  osJson,
  probeEngine,
  type OsReply,
  type ReindexRunnerDeps,
  type UnitOutcome,
} from '@core/kernel/reindex-runner';
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

export type { UnitOutcome };
/** Re-exported: the knowledge test (and any caller) reads it from here. */
export { mappingDimension };

export type KnowledgeReindexDeps = ReindexRunnerDeps;

/** The ONE engine this corpus needs: the embeddings gateway. There is no document parser here. */
export async function probeKnowledgeEngines(): Promise<EngineProbe[]> {
  return [await probeEngine('embeddings gateway (LiteLLM)', `${config.litellmUrl}/health/liveliness`)];
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
//  plan · run · abandon — the shared loop in `@core/kernel/reindex-runner`
// ---------------------------------------------------------------------------

const runner = createReindexRunner({
  target: TARGET,
  liveDeps: () => LIVE_DEPS,
  configuredDim: () => config.embedDim,
  refuse: (down) =>
    refuseOfflineMock(
      `Cannot re-index the Knowledge corpus: ${down.name} is unreachable at ${down.url}` +
        `${down.detail ? ` (${down.detail})` : ''}. A hash of the text is not an embedding, so ` +
        're-embedding without the gateway would write exactly the rows this re-index exists to ' +
        'replace. Nothing was read, replaced or deleted.',
    ),
});

export const { planReindex, runReindex, abandonReindex, inFlight } = runner;

/** Test hook. */
export function __resetKnowledgeReindex(): void {
  runner.reset();
}

export const knowledgeReindexService: ReindexService = runner.service;
