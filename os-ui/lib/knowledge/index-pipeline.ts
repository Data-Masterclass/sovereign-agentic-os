/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { config } from '@/lib/config';
import { type Workflow, type DomainKnowledge } from './schema.ts';
import { chunkWorkflow, chunkDomain, type KnowledgeUnit } from './chunk.ts';
import { embed } from './embed.ts';
import { upsertUnits, type IndexedUnit } from './index-store.ts';

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

/** Bulk-write embedded units to OpenSearch (best-effort live path). */
async function writeOpenSearch(scope: string, indexed: IndexedUnit[]): Promise<boolean> {
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
