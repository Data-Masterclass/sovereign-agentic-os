/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
// Pure logic (no `server-only`) so it is unit-tested with `node --test`. The
// value import of the registry is RELATIVE (node resolves it; `@/` it would not).
import { getModel, upsertModel, compilePredictPolicy } from './model-service.ts';
import type { ConsumptionMode, ServiceModel } from '@/lib/science/types';

/**
 * Marketplace consumption for `features` + `ML models` — the owner's choice at
 * certify time, enforced when another domain imports (Opus spine).
 *
 *   • read-in-place (DEFAULT) — the consumer calls the shared model's governed
 *     `predict` (OPA-scoped, online features live) WITHOUT copying it; single
 *     source, the owner sees usage. Import = a policy-compiler grant.
 *   • fork-allowed — the consumer may FORK-to-retrain: a copy lands in its own
 *     domain (governed there; may drift from source).
 *
 * Imports are policy-compiler grants, audited; Governance approval if required.
 * This mirrors `lib/artifacts.ts::addFromMarketplace` for the data-like pattern.
 */

function withStatus(err: Error, status: number): Error {
  (err as Error & { status?: number }).status = status;
  return err;
}

export type ImportResult =
  | {
      mode: 'read-in-place';
      model: string;
      consumerDomain: string;
      /** The compiled grant that now lets the consumer domain call `predict` (no copy). */
      grant: { tool: 'predict'; principalDomain: string; source: string };
    }
  | {
      mode: 'fork-allowed';
      model: string;
      consumerDomain: string;
      /** The forked model now owned + governed by the consumer domain. */
      fork: ServiceModel;
    };

/**
 * Import a certified Marketplace model into a consumer domain, honoring the
 * owner's consumption mode set at certify time.
 *   • read-in-place ⇒ register a `predict` grant for the consumer domain. The
 *     source stays single; the consumer calls it cross-domain (Marketplace tier).
 *   • fork-allowed  ⇒ drop a Domain-tier fork owned by the consumer domain.
 */
export function importModel(
  model: string,
  consumer: { id: string; domain: string },
): ImportResult {
  const src = getModel(model);
  if (!src) throw withStatus(new Error(`unknown model ${model}`), 404);
  if (src.tier !== 'Marketplace') {
    throw withStatus(new Error(`${model} is not certified to the Marketplace yet`), 400);
  }
  const mode: ConsumptionMode = src.consumptionMode ?? 'read-in-place';

  if (mode === 'read-in-place') {
    // No copy. The Marketplace tier already opens cross-domain callable scope;
    // the import is the audited grant that records this consumer's access.
    compilePredictPolicy(src); // the source-of-truth policy the grant compiles from
    return {
      mode,
      model,
      consumerDomain: consumer.domain,
      grant: { tool: 'predict', principalDomain: consumer.domain, source: src.domain },
    };
  }

  // fork-allowed: a fresh model owned + governed by the consumer domain.
  const fork: ServiceModel = {
    ...src,
    id: `svc_${src.model}_fork_${consumer.domain}`,
    model: `${src.model}_${consumer.domain}`,
    name: `${src.name} (forked → ${consumer.domain})`,
    owner: consumer.id,
    domain: consumer.domain,
    tier: 'Domain', // governed afresh in the consumer's domain; may drift from source.
    consumptionMode: undefined,
    versions: src.versions.map((v) => ({ ...v })),
  };
  upsertModel(fork);
  return { mode, model, consumerDomain: consumer.domain, fork };
}
