/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '@/lib/config';
import { knowledgeIndexMapping } from './index-pipeline.ts';

/**
 * The `knowledge` index MUST self-create its knn_vector mapping (mirroring the
 * `files` index) — otherwise OpenSearch auto-creates it with NO `embedding` field,
 * writes fail, and retrieval silently falls back to the in-memory mirror.
 */

test('knowledgeIndexMapping declares the embedding knn_vector with config dim', () => {
  const m = knowledgeIndexMapping() as {
    settings: { index: { knn: boolean } };
    mappings: { properties: Record<string, { type: string; dimension?: number }> };
  };
  assert.equal(m.settings.index.knn, true);
  const emb = m.mappings.properties.embedding;
  assert.equal(emb.type, 'knn_vector');
  assert.equal(emb.dimension, config.embedDim); // never hardcoded — from config
});

test('mapping includes every field the writer sets and the query filters on', () => {
  const props = (knowledgeIndexMapping() as { mappings: { properties: Record<string, unknown> } })
    .mappings.properties;
  // writer (index-pipeline.writeOpenSearch) + query (retrieve.dlsFilter/bm25Clause) fields
  for (const f of [
    'title', 'text', 'embedding', 'domain', 'workflow_id', 'step_id',
    'type', 'actor', 'owner', 'version', 'visibility', 'trust', 'authority',
    'updated_at', 'ingested_at',
  ]) {
    assert.ok(props[f], `mapping is missing field: ${f}`);
  }
});

test('dimension is templated (a custom dim flows through unchanged)', () => {
  const m = knowledgeIndexMapping(1536) as {
    mappings: { properties: { embedding: { dimension: number } } };
  };
  assert.equal(m.mappings.properties.embedding.dimension, 1536);
});
