/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
/**
 * Models & Providers adapter — the LiteLLM catalog governance layer.
 *
 * Catalog: self-hosted sovereign models (Magistral, Ministral, bge-m3) + the
 * STACKIT premium routes. Admins set the DEFAULT model per task/tier, enable or
 * disable a model, and cap per-model spend. Provider keys are added VIA THE
 * SECRETS MANAGER: the route calls `lib/secrets.putSecret()` and passes us ONLY
 * the resulting reference + a non-reversible fingerprint — this module NEVER
 * sees, stores, or serializes a raw key. That invariant is unit-tested.
 *
 * Pure (the live source is LiteLLM `/v1/models` + the secrets vault);
 * unit-testable.
 */

import { osMirror } from '../os-mirror.ts';

export type ModelTask = 'chat' | 'reasoning' | 'embedding';
export type ModelTier = 'sovereign' | 'premium';
export type ModelRoute = 'self-hosted' | 'stackit';

export type Model = {
  id: string;
  label: string;
  provider: string;
  task: ModelTask;
  tier: ModelTier;
  route: ModelRoute;
  enabled: boolean;
  /** Monthly spend cap in EUR for this model, or null for "envelope only". */
  capEUR: number | null;
};

/** A provider key as the catalog holds it: a REFERENCE + fingerprint, never raw. */
export type ProviderKey = {
  provider: string;
  ref: { name: string; key: string };
  fingerprint: string;
  addedBy: string;
  addedAt: string;
};

function fail(message: string, status: number): Error {
  const e = new Error(message);
  (e as Error & { status?: number }).status = status;
  return e;
}

type ModelsState = { catalog: Map<string, Model>; keys: Map<string, ProviderKey>; defaults: Record<ModelTask, string>; hydration: Promise<void> | null };
const MODELS_KEY = Symbol.for('soa.platform.models');
function modelsState(): ModelsState {
  const g = globalThis as unknown as Record<symbol, ModelsState | undefined>;
  if (!g[MODELS_KEY]) g[MODELS_KEY] = { catalog: new Map(), keys: new Map(), defaults: { chat: 'ministral-8b', reasoning: 'magistral-small', embedding: 'bge-m3' }, hydration: null };
  return g[MODELS_KEY]!;
}

// ---------------------------------------------------- durable mirror (best-effort) --
// SECURITY: only refs + fingerprints are stored; raw key values NEVER appear here.
const mirror = osMirror({
  index: 'os-model-config',
  createBody: {
    mappings: {
      properties: {
        id: { type: 'keyword' },
        provider: { type: 'keyword' },
        task: { type: 'keyword' },
        tier: { type: 'keyword' },
        route: { type: 'keyword' },
        enabled: { type: 'boolean' },
        addedAt: { type: 'date' },
        // Arbitrary shapes (cap, ref, defaults) stored but not field-indexed.
        capEUR: { type: 'double' },
        ref: { type: 'object', enabled: false },
        fingerprint: { type: 'keyword' },
      },
    },
  },
});

export async function ensureHydrated(): Promise<void> {
  const s = modelsState();
  if (!s.hydration) s.hydration = hydrateModels();
  return s.hydration;
}

async function hydrateModels(): Promise<void> {
  const s = modelsState();
  // Seed the static catalog first so defaults + enabled flags are known.
  seed();
  const docs = (await mirror.hydrate(500)) ?? [];
  for (const doc of docs as Record<string, unknown>[]) {
    if (!doc || typeof doc.id !== 'string') continue;
    const docId = doc.id as string;
    if (docId === '__defaults__') {
      // Restore the mutable defaults record.
      const d = doc as unknown as { chat?: string; reasoning?: string; embedding?: string };
      if (d.chat) s.defaults.chat = d.chat;
      if (d.reasoning) s.defaults.reasoning = d.reasoning;
      if (d.embedding) s.defaults.embedding = d.embedding;
    } else if (docId.startsWith('key:')) {
      // Restore provider key (ref+fingerprint; NEVER a raw value).
      const pk = doc as unknown as ProviderKey;
      if (pk.provider) s.keys.set(pk.provider, pk);
    } else {
      // Restore mutable model fields (enabled, capEUR) — keep seed catalog shape.
      const m = s.catalog.get(docId);
      if (m) {
        if (typeof doc.enabled === 'boolean') m.enabled = doc.enabled;
        if (doc.capEUR === null || typeof doc.capEUR === 'number') m.capEUR = doc.capEUR as number | null;
      }
    }
  }
}

function seed(): void {
  if (modelsState().catalog.size > 0) return;
  const rows: Model[] = [
    { id: 'magistral-small', label: 'Magistral Small (reasoning)', provider: 'self-hosted', task: 'reasoning', tier: 'sovereign', route: 'self-hosted', enabled: true, capEUR: null },
    { id: 'ministral-8b', label: 'Ministral 8B (chat)', provider: 'self-hosted', task: 'chat', tier: 'sovereign', route: 'self-hosted', enabled: true, capEUR: null },
    { id: 'bge-m3', label: 'bge-m3 (embeddings)', provider: 'self-hosted', task: 'embedding', tier: 'sovereign', route: 'self-hosted', enabled: true, capEUR: null },
    { id: 'sovereign-mock', label: 'Mock model (offline)', provider: 'self-hosted', task: 'chat', tier: 'sovereign', route: 'self-hosted', enabled: true, capEUR: null },
    { id: 'stackit-llama-70b', label: 'STACKIT Llama 3.3 70B (premium)', provider: 'stackit', task: 'chat', tier: 'premium', route: 'stackit', enabled: false, capEUR: 200 },
    { id: 'stackit-mistral-large', label: 'STACKIT Mistral Large (premium)', provider: 'stackit', task: 'reasoning', tier: 'premium', route: 'stackit', enabled: false, capEUR: 200 },
  ];
  for (const m of rows) modelsState().catalog.set(m.id, m);
}

export function listModels(): Model[] {
  seed();
  return [...modelsState().catalog.values()];
}

export function getDefaults(): Record<ModelTask, string> {
  seed();
  return { ...modelsState().defaults };
}

export function setDefault(task: ModelTask, modelId: string): Record<ModelTask, string> {
  seed();
  const m = modelsState().catalog.get(modelId);
  if (!m) throw fail('Unknown model', 404);
  if (m.task !== task) throw fail(`Model ${modelId} is not a ${task} model`, 400);
  if (!m.enabled) throw fail('Cannot set a disabled model as default', 409);
  modelsState().defaults[task] = modelId;
  mirror.writeThrough('__defaults__', { id: '__defaults__', ...modelsState().defaults });
  return { ...modelsState().defaults };
}

export function setEnabled(modelId: string, enabled: boolean): Model {
  seed();
  const m = modelsState().catalog.get(modelId);
  if (!m) throw fail('Unknown model', 404);
  if (!enabled && Object.values(modelsState().defaults).includes(modelId)) {
    throw fail('Cannot disable a model that is a current default', 409);
  }
  m.enabled = enabled;
  mirror.writeThrough(m.id, m);
  return m;
}

export function setCap(modelId: string, capEUR: number | null): Model {
  seed();
  const m = modelsState().catalog.get(modelId);
  if (!m) throw fail('Unknown model', 404);
  if (capEUR !== null && (!Number.isFinite(capEUR) || capEUR < 0)) throw fail('Cap must be ≥ 0', 400);
  m.capEUR = capEUR;
  mirror.writeThrough(m.id, m);
  return m;
}

/**
 * Register a provider key. THE RULE: callers pass only the secrets-manager
 * reference + fingerprint (from `lib/secrets.putSecret` / `secretFingerprint`).
 * No raw value is accepted or stored — there is no parameter for one.
 */
export function registerProviderKey(input: {
  provider: string;
  ref: { name: string; key: string };
  fingerprint: string;
  addedBy: string;
}): ProviderKey {
  seed();
  if (!input.provider.trim()) throw fail('A provider is required', 400);
  if (!input.ref?.name || !input.ref?.key) throw fail('A secrets-manager reference is required', 400);
  const pk: ProviderKey = {
    provider: input.provider.trim(),
    ref: input.ref,
    fingerprint: input.fingerprint,
    addedBy: input.addedBy,
    addedAt: new Date().toISOString(),
  };
  modelsState().keys.set(pk.provider, pk);
  mirror.writeThrough(`key:${pk.provider}`, pk);
  return pk;
}

/** Provider keys for display — refs + fingerprints only; never a raw value. */
export function listProviderKeys(): ProviderKey[] {
  return [...modelsState().keys.values()].sort((a, b) => a.provider.localeCompare(b.provider));
}

/** model id → enabled, for the policy compiler. */
export function enabledMap(): Record<string, boolean> {
  return Object.fromEntries(listModels().map((m) => [m.id, m.enabled]));
}

export function _reset(): void {
  const s = modelsState();
  s.catalog.clear();
  s.keys.clear();
  s.defaults.chat = 'ministral-8b';
  s.defaults.reasoning = 'magistral-small';
  s.defaults.embedding = 'bge-m3';
  s.hydration = null;
  mirror.__reset();
}
