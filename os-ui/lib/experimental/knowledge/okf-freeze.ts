/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { getWorkflow, type Principal } from './store.ts';
import { exportWorkflowBundle } from './okf-export.ts';
import { zipBundle } from './okf-zip.ts';
import { createFile, objectKeyForAsset, attachObject } from '../files/store.ts';
import { putBlob } from '../files/object-store.ts';

/**
 * CERTIFY-TIME OKF FREEZE (decision #2). When a knowledge product is certified to
 * the Marketplace, its OKF bundle is generated ONCE and frozen as a governed
 * Files-tab artifact. Server-only (object-store blob I/O) — injected into the
 * governance effect seam as `deps.freezeKnowledgeBundle` so the effects module stays
 * free of the heavy imports. Best-effort by contract: the caller wraps this so a
 * freeze hiccup never rolls back the certification.
 */
export async function freezeCertifiedKnowledgeBundle(
  workflowId: string,
  approver: Principal,
): Promise<{ fileId: string } | null> {
  // Read AS the approver (admin at certify time) — DLS-scoped, never a back door.
  const view = getWorkflow(workflowId, approver);
  const bundle = exportWorkflowBundle(view);
  const zip = zipBundle(bundle);

  const name = `${slug(view.title) || 'knowledge'}.certified.okf.zip`;
  const asset = createFile(approver, {
    name,
    text: `Frozen OKF v0.2 bundle for the certified “${view.title}” knowledge product.`,
    bytes: zip.length,
    tags: ['okf', 'certified', 'knowledge-product'],
    domain: view.domain,
  });
  const key = objectKeyForAsset(asset);
  if (!key) return { fileId: asset.id };
  await putBlob(key, zip, 'application/zip');
  attachObject(asset.id, approver, { contentType: 'application/zip', bytes: zip.length });
  return { fileId: asset.id };
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}
