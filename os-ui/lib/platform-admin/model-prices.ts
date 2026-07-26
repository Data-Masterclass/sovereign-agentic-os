/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
/**
 * Model token prices — the durable, admin-editable price book behind Monitoring
 * cost attribution (EUR per 1M tokens per LiteLLM `model_name`).
 *
 * Resolution order (per model_name):
 *   1. the ADMIN-SAVED price (this store, durable via the os-mirror);
 *   2. ELSE the deployment seed — env `MODEL_PRICES_JSON` (`config.modelPrices`);
 *   3. ELSE unpriced — the model yields NO cost (`runCostUsd` → undefined → "—",
 *      never a fabricated 0).
 *
 * The store is ONE doc (`__prices__`) mapping model_name → {inputPerM, outputPerM}
 * plus updatedAt/updatedBy for audit. Same pattern as the models catalog mirror:
 * the in-process map is authoritative; the OpenSearch mirror is best-effort
 * write-through + hydrate-on-boot. FAIL-SOFT: an unreachable mirror never throws
 * into a run or a request — `effectiveModelPrices()` simply falls back to the env
 * seed. Kept free of `server-only`/Next imports so it is directly unit-testable.
 */

import { osMirror } from '../infra/os-mirror.ts';
import { config, type ModelPrice } from '../core/config.ts';

export type { ModelPrice };

export type StoredPrices = {
  /** model_name → EUR per 1M tokens. Only ADMIN-SAVED overrides live here. */
  prices: Record<string, ModelPrice>;
  updatedAt: string;
  updatedBy: string;
};

type PricesState = { doc: StoredPrices | null; hydration: Promise<void> | null };
const PRICES_KEY = Symbol.for('soa.platform.model-prices');
const DOC_ID = '__prices__';

function pricesState(): PricesState {
  const g = globalThis as unknown as Record<symbol, PricesState | undefined>;
  if (!g[PRICES_KEY]) g[PRICES_KEY] = { doc: null, hydration: null };
  return g[PRICES_KEY]!;
}

function fail(message: string, status: number): Error {
  const e = new Error(message);
  (e as Error & { status?: number }).status = status;
  return e;
}

const mirror = osMirror({
  index: 'os-model-prices',
  createBody: {
    mappings: {
      properties: {
        id: { type: 'keyword' },
        updatedAt: { type: 'date' },
        updatedBy: { type: 'keyword' },
        // The price map has arbitrary model_name keys — stored, not field-indexed.
        prices: { type: 'object', enabled: false },
      },
    },
  },
});

/** Keep only well-formed entries (finite, ≥ 0) — same rule as parseModelPrices. */
function sanitize(raw: unknown): Record<string, ModelPrice> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, ModelPrice> = {};
  for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
    const p = v as { inputPerM?: unknown; outputPerM?: unknown } | null;
    const inputPerM = Number(p?.inputPerM);
    const outputPerM = Number(p?.outputPerM);
    if (Number.isFinite(inputPerM) && inputPerM >= 0 && Number.isFinite(outputPerM) && outputPerM >= 0) {
      out[name] = { inputPerM, outputPerM };
    }
  }
  return out;
}

export async function ensureHydrated(): Promise<void> {
  const s = pricesState();
  if (!s.hydration) s.hydration = hydratePrices();
  return s.hydration;
}

async function hydratePrices(): Promise<void> {
  const s = pricesState();
  // null → mirror unreachable: stay empty (fail-soft, env seed still applies).
  const docs = (await mirror.hydrate(5)) ?? [];
  for (const doc of docs as Record<string, unknown>[]) {
    if (!doc || doc.id !== DOC_ID) continue;
    s.doc = {
      prices: sanitize(doc.prices),
      updatedAt: typeof doc.updatedAt === 'string' ? doc.updatedAt : '',
      updatedBy: typeof doc.updatedBy === 'string' ? doc.updatedBy : '',
    };
  }
}

/** The admin-saved overrides (or null when none saved yet). Callers hydrate first. */
export function getStoredPrices(): StoredPrices | null {
  return pricesState().doc;
}

/**
 * Save price overrides. `patch` merges over the stored map: a `{inputPerM,
 * outputPerM}` value sets/updates a model's price; `null` REMOVES the override
 * (the model falls back to the env seed, else unpriced). Rejects malformed
 * numbers — an honest price is finite and ≥ 0.
 */
export function setModelPrices(
  patch: Record<string, ModelPrice | null>,
  updatedBy: string,
): StoredPrices {
  const s = pricesState();
  const next: Record<string, ModelPrice> = { ...(s.doc?.prices ?? {}) };
  for (const [name, price] of Object.entries(patch)) {
    if (!name.trim()) throw fail('A model name is required', 400);
    if (price === null) {
      delete next[name];
      continue;
    }
    const inputPerM = Number(price.inputPerM);
    const outputPerM = Number(price.outputPerM);
    if (!Number.isFinite(inputPerM) || inputPerM < 0 || !Number.isFinite(outputPerM) || outputPerM < 0) {
      throw fail(`Price for ${name} must be finite and ≥ 0 (EUR per 1M tokens)`, 400);
    }
    next[name] = { inputPerM, outputPerM };
  }
  s.doc = { prices: next, updatedAt: new Date().toISOString(), updatedBy };
  mirror.writeThrough(DOC_ID, { id: DOC_ID, ...s.doc });
  return s.doc;
}

/**
 * The effective price book every cost consumer uses: stored overrides beat the
 * env seed; models in neither stay unpriced. FAIL-SOFT: hydration problems never
 * throw — the env seed is always returned.
 */
export async function effectiveModelPrices(): Promise<Record<string, ModelPrice>> {
  try {
    await ensureHydrated();
  } catch {
    // Store unreachable/corrupt → env seed only.
  }
  return { ...config.modelPrices, ...(pricesState().doc?.prices ?? {}) };
}

export function _reset(): void {
  const s = pricesState();
  s.doc = null;
  s.hydration = null;
  mirror.__reset();
}
