/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { config } from '@/lib/core/config';
import { type Workflow, type DomainKnowledge } from './schema.ts';
import { chunkWorkflow, chunkDomain, type KnowledgeUnit } from './chunk.ts';
import { embed } from './embed.ts';
import { upsertUnits, removeUnits, type IndexedUnit } from './index-store.ts';

/**
 * The indexing pipeline (the "Dagster sensor → Haystack pipeline" of the design,
 * collapsed into one governed step for kind). On publish (or a manual re-index) we
 * UNIT-CHUNK the workflow + domain card, EMBED each unit via `sovereign-embed`, and
 * write to OpenSearch with provenance/trust metadata — incrementally (only the
 * changed scope's units). When OpenSearch is unreachable we still populate the
 * in-process index mirror so retrieval works offline. Honest about which store
 * landed it.
 */

export type IndexReport = {
  units: number;
  store: 'opensearch' | 'memory';
  embedSource: 'litellm' | 'offline-hash';
  scope: string;
};

async function withTimeout(url: string, init: RequestInit, ms = 6000): Promise<Response | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal, cache: 'no-store' });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function toIndexed(units: KnowledgeUnit[], vectors: number[][]): IndexedUnit[] {
  const now = new Date().toISOString();
  return units.map((u, i) => ({ ...u, embedding: vectors[i] ?? [], indexedAt: now }));
}

/**
 * PHYSICALLY purge a scope's indexed units — the delete side of the Knowledge
 * lifecycle. Removes the workflow/domain's vectors from OpenSearch (_delete_by_query)
 * AND the in-process offline mirror, so a DELETED knowledge artifact stops being
 * retrievable (by agents or search). Best-effort + honest: returns whether the
 * OpenSearch delete succeeded (the in-process removal always happens). Archive does
 * NOT call this — an archived workflow keeps its index until it is truly deleted.
 */
export async function purgeKnowledgeUnits(scope: string): Promise<boolean> {
  removeUnits(scope); // offline mirror — always
  const delBody = { query: { bool: { should: [{ term: { workflow_id: scope } }, { term: { _id: scope } }] } } };
  const res = await withTimeout(`${config.opensearchUrl}/${config.knowledgeIndex}/_delete_by_query?refresh=true`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(delBody),
  });
  return !!res && res.ok;
}

/** The `knowledge` index mapping — a knn_vector `embedding` whose dimension comes
 *  from config (never hardcoded), plus the keyword/text/date fields the writer sets
 *  and the retrieve query filters/searches on. Mirrors `filesIndexMapping`. */
export function knowledgeIndexMapping(dim = config.embedDim): Record<string, unknown> {
  return {
    settings: { index: { knn: true } },
    mappings: {
      properties: {
        title: { type: 'text' },
        text: { type: 'text' },
        embedding: { type: 'knn_vector', dimension: dim },
        domain: { type: 'keyword' },
        workflow_id: { type: 'keyword' },
        step_id: { type: 'keyword' },
        type: { type: 'keyword' },
        actor: { type: 'keyword' },
        owner: { type: 'keyword' },
        version: { type: 'keyword' },
        visibility: { type: 'keyword' },
        trust: { type: 'float' },
        authority: { type: 'float' },
        updated_at: { type: 'date' },
        ingested_at: { type: 'date' },
      },
    },
  };
}

/** Create the `knowledge` index with its knn_vector mapping if absent (best-effort).
 *  Without this the index auto-creates with NO `embedding` field → writes fail and
 *  retrieval silently falls back to the in-memory mirror. Mirrors `ensureFilesIndex`. */
export async function ensureKnowledgeIndex(): Promise<boolean> {
  const head = await withTimeout(`${config.opensearchUrl}/${config.knowledgeIndex}`, { method: 'HEAD' });
  if (head && head.ok) return true;
  const res = await withTimeout(`${config.opensearchUrl}/${config.knowledgeIndex}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(knowledgeIndexMapping()),
  });
  return Boolean(res && res.ok);
}

/** Bulk-write embedded units to OpenSearch (best-effort live path). */
async function writeOpenSearch(scope: string, indexed: IndexedUnit[]): Promise<boolean> {
  await ensureKnowledgeIndex();

  // Delete the scope's existing docs first (incremental re-index), then bulk-add.
  const delBody = {
    query: {
      bool: {
        should: [
          { term: { workflow_id: scope } },
          { term: { _id: scope } },
        ],
      },
    },
  };
  await withTimeout(`${config.opensearchUrl}/${config.knowledgeIndex}/_delete_by_query?refresh=true`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(delBody),
  });

  const lines: string[] = [];
  for (const u of indexed) {
    lines.push(JSON.stringify({ index: { _index: config.knowledgeIndex, _id: u.id } }));
    lines.push(JSON.stringify({
      title: u.title,
      text: u.text,
      embedding: u.embedding,
      // provenance / trust metadata (the retrieval + governance envelope)
      domain: u.provenance.domain,
      workflow_id: u.provenance.workflowId,
      step_id: u.provenance.stepId,
      type: u.provenance.type,
      actor: u.provenance.actor,
      owner: u.provenance.owner,
      version: u.provenance.version,
      visibility: u.provenance.visibility,
      trust: u.provenance.trust,
      authority: u.provenance.authority,
      updated_at: u.provenance.updatedAt,
      ingested_at: u.indexedAt,
    }));
  }
  const res = await withTimeout(`${config.opensearchUrl}/${config.knowledgeIndex}/_bulk?refresh=true`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-ndjson' },
    body: lines.join('\n') + '\n',
  });
  if (!res || !res.ok) return false;
  try {
    const data = (await res.json()) as { errors?: boolean };
    return data.errors !== true;
  } catch {
    return false;
  }
}

/** Index a workflow (steps + rules + tacit). Returns an honest store report. */
export async function indexWorkflow(
  workflow: Workflow,
  opts: { owner: string; tacit?: string; updatedAt?: string },
): Promise<IndexReport> {
  const units = chunkWorkflow({ workflow, owner: opts.owner, tacit: opts.tacit, updatedAt: opts.updatedAt });
  const { vectors, source } = await embed(units.map((u) => u.text));
  const indexed = toIndexed(units, vectors);

  // Always populate the in-process mirror (offline retrieval), best-effort live.
  upsertUnits(workflow.id, indexed);
  const live = await writeOpenSearch(workflow.id, indexed);

  return { units: units.length, store: live ? 'opensearch' : 'memory', embedSource: source, scope: workflow.id };
}

/** Index the general domain knowledge (the pinned domain card source). */
export async function indexDomain(dk: DomainKnowledge): Promise<IndexReport> {
  const units = chunkDomain(dk);
  const { vectors, source } = await embed(units.map((u) => u.text));
  const indexed = toIndexed(units, vectors);
  const scope = `domain:${dk.domain}`;
  upsertUnits(scope, indexed);
  const live = await writeOpenSearch(scope, indexed);
  return { units: units.length, store: live ? 'opensearch' : 'memory', embedSource: source, scope };
}
