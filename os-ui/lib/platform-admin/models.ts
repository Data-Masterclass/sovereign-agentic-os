/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
/**
 * Models & Providers adapter — the LiteLLM catalog governance layer.
 *
 * SOURCE OF TRUTH = the LIVE gateway. This OS is open source: an operator deploys
 * it with their OWN models/providers behind the fixed LiteLLM aliases (set in helm
 * values, never in app code). So the admin UI sources its model lists LIVE from the
 * gateway (`/api/agents/models` → LiteLLM `/model/info`) plus any admin-registered
 * OpenAI-compatible endpoints; a self-registered model surfaces even if it is not a
 * known display id. The seed below is ONLY this repo's DEPLOY DEFAULTS (the aliases
 * our helm configures) — the governance/policy substrate + offline fallback, NOT a
 * fixed menu of the only models an operator may pick.
 *
 * Admins set the enable/disable + per-model cap governance here; the three
 * per-ROLE defaults (standard/reasoning/embeddings) are unified into ONE authoritative
 * store — the platform-admin settings `modelRoles` resolved by lib/models/roles.ts.
 * Provider keys are added VIA THE SECRETS MANAGER: the route calls
 * `lib/secrets.putSecret()` and passes us ONLY the resulting reference + a
 * non-reversible fingerprint — this module NEVER sees, stores, or serializes a raw
 * key. That invariant is unit-tested.
 *
 * Pure (the live source is LiteLLM `/v1/models` + the secrets vault);
 * unit-testable.
 */

import { osMirror } from '../infra/os-mirror.ts';
import { roleModel } from '../models/roles.ts';

export type ModelTask = 'chat' | 'reasoning' | 'embedding';
export type ModelTier = 'sovereign' | 'premium';
export type ModelRoute = 'self-hosted' | 'stackit';

/**
 * The OpenAI-compatible endpoint of an ADMIN-REGISTERED model (e.g. the STACKIT
 * managed LLM service). It carries ONLY the base URL, the upstream model name and
 * a secrets-manager REFERENCE (+ fingerprint) to its API key — NEVER a raw key.
 * The raw key lives solely in the secrets vault; the LiteLLM gateway reads it once
 * at registration time to proxy the model.
 */
export type ModelEndpoint = {
  baseUrl: string;
  modelName: string;
  keyRef: { name: string; key: string };
  fingerprint: string;
};

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
  /** Present only for admin-registered OpenAI-compatible models (ref, never raw). */
  endpoint?: ModelEndpoint;
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

type ModelsState = {
  catalog: Map<string, Model>;
  keys: Map<string, ProviderKey>;
  /** The ONE assistant model that powers every built-in artifact-building
   *  assistant (Agents/Software build chat, Big Bets planner, Knowledge, Metric).
   *  EMPTY = follow the unified STANDARD role (lib/models/roles.ts) so the assistant
   *  tracks the admin's Standard default out of the box; a non-empty value is an
   *  EXPLICIT override an admin set (e.g. a bespoke registered model). */
  assistant: string;
  hydration: Promise<void> | null;
};
const MODELS_KEY = Symbol.for('soa.platform.models');
// The assistant defaults to '' — "follow the STANDARD role" — resolved via
// roleModel('standard') (default `sovereign-default`, admin-repointable). So the
// built-in assistants work out of the box against the same model the rest of the
// OS uses, with a single place to change it, and no stale hardcoded pin.
const DEFAULT_ASSISTANT = '';

// The per-ROLE defaults are ONE store: the platform-admin settings `modelRoles`,
// resolved by lib/models/roles.ts. There is NO separate defaults record here — the
// legacy task→model map used to live on this state and silently resolved nowhere.
// `ModelTask` (chat/reasoning/embedding) still names a catalog model's job (chat≈
// standard, reasoning≈reasoning, embedding≈embeddings) for the governance table.

/** The effective model_names that are current ROLE defaults (from roles.ts). */
function roleDefaultIds(): string[] {
  return [roleModel('standard'), roleModel('reasoning'), roleModel('tools'), roleModel('embeddings')];
}

function modelsState(): ModelsState {
  const g = globalThis as unknown as Record<symbol, ModelsState | undefined>;
  if (!g[MODELS_KEY]) g[MODELS_KEY] = { catalog: new Map(), keys: new Map(), assistant: DEFAULT_ASSISTANT, hydration: null };
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
        // Arbitrary shapes (cap, ref, endpoint, defaults) stored but not field-indexed.
        capEUR: { type: 'double' },
        ref: { type: 'object', enabled: false },
        endpoint: { type: 'object', enabled: false },
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
      // Legacy per-task defaults record (retired — the ONE store is settings
      // `modelRoles`). Ignore any historical mirror doc so it can't resurrect a
      // competing store.
      continue;
    } else if (docId === '__assistant__') {
      // Restore the explicit assistant override ('' = follow the STANDARD role).
      const a = doc as unknown as { assistant?: string };
      if (typeof a.assistant === 'string') s.assistant = a.assistant;
    } else if (docId.startsWith('key:')) {
      // Restore provider key (ref+fingerprint; NEVER a raw value).
      const pk = doc as unknown as ProviderKey;
      if (pk.provider) s.keys.set(pk.provider, pk);
    } else if (typeof doc.task === 'string' && !s.catalog.has(docId)) {
      // An admin-REGISTERED model (e.g. the STACKIT managed LLM) not in the static
      // seed — restore it in full (endpoint holds only a ref + fingerprint).
      s.catalog.set(docId, doc as unknown as Model);
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
  // The LIVE LiteLLM aliases and the STACKIT-managed model behind each. There is no
  // self-hosted in-box model server anymore, so every route is `stackit`/external.
  // These ids ARE the gateway model_names, so the catalog can never drift from what
  // the gateway actually serves (the page also refreshes options from /model/info).
  const rows: Model[] = [
    { id: 'sovereign-default', label: 'gpt-oss-20b (standard)', provider: 'stackit', task: 'chat', tier: 'premium', route: 'stackit', enabled: true, capEUR: null },
    { id: 'sovereign-reasoning', label: 'Qwen3-VL-235B (reasoning)', provider: 'stackit', task: 'reasoning', tier: 'premium', route: 'stackit', enabled: true, capEUR: null },
    { id: 'sovereign-embed', label: 'Qwen3-VL-Embedding-8B (embeddings)', provider: 'stackit', task: 'embedding', tier: 'premium', route: 'stackit', enabled: true, capEUR: null },
    { id: 'sovereign-mock', label: 'Mock model (offline only)', provider: 'stackit', task: 'chat', tier: 'sovereign', route: 'stackit', enabled: true, capEUR: null },
  ];
  for (const m of rows) modelsState().catalog.set(m.id, m);
}

export function listModels(): Model[] {
  seed();
  return [...modelsState().catalog.values()];
}

/**
 * The three per-role defaults, as a task→model_name map, read from the ONE store
 * (settings `modelRoles` via roles.ts). Read-only projection for display + the
 * governance guards; writes go through `setRoleDefault` (which writes modelRoles).
 */
export function getDefaults(): Record<ModelTask, string> {
  return { chat: roleModel('standard'), reasoning: roleModel('reasoning'), embedding: roleModel('embeddings') };
}

export function setEnabled(modelId: string, enabled: boolean): Model {
  seed();
  const m = modelsState().catalog.get(modelId);
  if (!m) throw fail('Unknown model', 404);
  if (!enabled && roleDefaultIds().includes(modelId)) {
    throw fail('Cannot disable a model that is a current role default', 409);
  }
  if (!enabled && getAssistantModelId() === modelId) {
    throw fail('Cannot disable the current assistant model', 409);
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

// ------------------------------------------------------- assistant LLM (the ONE) --

/**
 * Register an admin-supplied OpenAI-compatible model (the STACKIT managed LLM
 * service). THE SECRETS RULE holds: the caller passes only the secrets-manager
 * `keyRef` + `fingerprint` (the raw key was written to the vault + handed to the
 * gateway server-side); this catalog NEVER sees or stores a raw key. The model is
 * a `chat`-task premium route so it is eligible to be the default assistant.
 */
export function registerAssistantModel(input: {
  id?: string;
  label: string;
  endpoint: ModelEndpoint;
  addedBy: string;
}): Model {
  seed();
  const id = (input.id?.trim() || 'stackit-managed-assistant');
  if (!input.label.trim()) throw fail('A model label is required', 400);
  if (!input.endpoint.baseUrl.trim() || !input.endpoint.modelName.trim()) throw fail('A base URL and model name are required', 400);
  if (!input.endpoint.keyRef?.name || !input.endpoint.keyRef?.key) throw fail('A secrets-manager key reference is required', 400);
  const m: Model = {
    id,
    label: input.label.trim(),
    provider: 'stackit',
    task: 'chat',
    tier: 'premium',
    route: 'stackit',
    enabled: true,
    capEUR: null,
    endpoint: input.endpoint,
  };
  modelsState().catalog.set(id, m);
  mirror.writeThrough(id, m);
  return m;
}

/**
 * The id of the ONE model that powers every built-in assistant. An EMPTY explicit
 * override means "follow the unified STANDARD role", so this returns the effective
 * model_name the assistant will actually run on.
 */
export function getAssistantModelId(): string {
  seed();
  return modelsState().assistant || roleModel('standard');
}

/** True when an admin has pinned an EXPLICIT assistant override (not "follow Standard"). */
export function isAssistantExplicit(): boolean {
  seed();
  return modelsState().assistant.length > 0;
}

/**
 * Resolve the assistant model, or `null` when it is unset / unknown / disabled —
 * the caller turns `null` into an HONEST "configure it in Platform Admin" error
 * (never a silent fake-AI fallback).
 *
 * Two paths:
 *  • No explicit override → FOLLOW the STANDARD role. That alias is a seeded,
 *    enabled catalog model out of the box; if an admin re-pointed the role live to
 *    an alias not in the catalog, trust the gateway alias so the assistant runs.
 *  • Explicit override → it MUST be an enabled catalog chat model; otherwise `null`
 *    (honest error). A pin at a ghost/disabled model must never silently "work".
 */
export function getAssistantModel(): Model | null {
  seed();
  const explicit = modelsState().assistant;
  if (explicit.length > 0) {
    const m = modelsState().catalog.get(explicit);
    return m && m.enabled ? m : null;
  }
  // Following the STANDARD role.
  const id = roleModel('standard');
  const m = modelsState().catalog.get(id);
  if (m) return m.enabled ? m : null;
  return { id, label: id, provider: 'stackit', task: 'chat', tier: 'premium', route: 'stackit', enabled: true, capEUR: null };
}

/** Clear an explicit assistant override — the assistant follows the STANDARD role again. */
export function clearAssistantModel(): void {
  seed();
  modelsState().assistant = '';
  mirror.writeThrough('__assistant__', { id: '__assistant__', assistant: '' });
}

/** Choose the assistant model. It must exist, be enabled and be chat-capable. */
export function setAssistantModel(modelId: string): Model {
  seed();
  const m = modelsState().catalog.get(modelId);
  if (!m) throw fail('Unknown model', 404);
  if (m.task !== 'chat') throw fail(`Model ${modelId} is not a chat model — the assistant must be chat-capable`, 400);
  if (!m.enabled) throw fail('Cannot set a disabled model as the assistant', 409);
  modelsState().assistant = modelId;
  mirror.writeThrough('__assistant__', { id: '__assistant__', assistant: modelId });
  return m;
}

/** model id → enabled, for the policy compiler. */
export function enabledMap(): Record<string, boolean> {
  return Object.fromEntries(listModels().map((m) => [m.id, m.enabled]));
}

export function _reset(): void {
  const s = modelsState();
  s.catalog.clear();
  s.keys.clear();
  s.assistant = DEFAULT_ASSISTANT;
  s.hydration = null;
  mirror.__reset();
}
