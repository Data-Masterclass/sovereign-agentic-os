/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { config } from '@/lib/core/config';
import { getFile, type Principal } from '@/lib/files/store';
import { recordLineage } from '@/lib/files/lineage';
import { createDataset, buildVersion } from '@/lib/data';

/**
 * "Use as" — distil a file into another context product (Files golden path §6).
 *   → Knowledge: the file's parsed text becomes a tacit/doc input (a transcript →
 *     a tacit note), ingested into the knowledge index.
 *   → Data: the file seeds a GUIDED Bronze import (decision #6 — pre-filled, NOT
 *     silent), via the REUSED lib/data primitives (createDataset + buildVersion).
 * Both record a file → derived-artifact lineage edge in OpenMetadata (mock-tolerant).
 *
 * lib/data is imported READ-ONLY (we call its createDataset/buildVersion; we never
 * modify it). server-only: it ingests + reaches the catalog.
 */

async function ingestKnowledge(title: string, text: string): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    const res = await fetch(`${config.opensearchUrl}/${config.knowledgeIndex}/_doc?refresh=true`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, cache: 'no-store', signal: ctrl.signal,
      body: JSON.stringify({ title, text, source: 'files-use-as', ingested_at: new Date().toISOString() }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { _id?: string };
    return data._id ?? null;
  } catch {
    return null; // OpenSearch off (kind) — the lineage + pre-filled input still stand
  } finally {
    clearTimeout(timer);
  }
}

export type UseAsKnowledgeResult = { target: 'knowledge'; title: string; text: string; docId: string | null; ingested: boolean };

export async function useAsKnowledge(fileId: string, user: Principal): Promise<UseAsKnowledgeResult> {
  const { asset, text } = getFile(fileId, user); // view-scope guard + the parsed body
  const title = `${asset.name} (from Files)`;
  const docId = await ingestKnowledge(title, text);
  recordLineage({ kind: 'file_to_knowledge', fileId: asset.id, fileName: asset.name, target: docId ? `knowledge:${docId}` : 'knowledge:pending', by: user.id });
  return { target: 'knowledge', title, text, docId, ingested: docId !== null };
}

function baseName(name: string): string {
  const dot = name.lastIndexOf('.');
  return (dot > 0 ? name.slice(0, dot) : name).replace(/[^a-z0-9]+/gi, ' ').trim() || 'dataset';
}

export type UseAsDataResult = { target: 'data'; datasetId: string; name: string; layer: 'bronze' };

/**
 * Guided Bronze import: create a private dataset pre-filled from the file and
 * build its Bronze version pointing at the file as the raw source. Returns the new
 * dataset id so the UI can open the Data tab at the Bronze step (the user finishes
 * the guided import — never silent).
 */
export async function useAsData(fileId: string, user: Principal): Promise<UseAsDataResult> {
  const { asset } = getFile(fileId, user); // view-scope guard
  const name = baseName(asset.name);
  const dataset = createDataset(user, { name, domain: asset.domain });
  buildVersion(dataset.id, user, 'bronze', {
    quality: 'passing',
    artifact: `bronze/${dataset.id}.from_file.yml`,
    body: `# Bronze import seeded from Files\n# source file: ${asset.name}\n# deep-link: ${asset.deepLink}\n# kind: ${asset.kind}\n`,
  });
  recordLineage({ kind: 'file_to_data', fileId: asset.id, fileName: asset.name, target: `dataset:${dataset.id}`, by: user.id });
  return { target: 'data', datasetId: dataset.id, name, layer: 'bronze' };
}
