/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
/**
 * Models & Providers — what the OS itself decides about models. NOT the list of models.
 *
 * OWNERSHIP: LiteLLM owns providers, credentials, models and global budgets. The model list the
 * OS shows is LiteLLM's, read live (`core/models/gateway-catalog.ts`, behind `/api/agents/models`);
 * this module keeps NO catalog, NO seed, and NO enable/disable or per-model cap — those were a
 * second owner for facts that belong in LiteLLM (model access, budgets). What is left is what only
 * the OS can decide:
 *   • the ASSISTANT PIN — which LiteLLM alias powers every built-in artifact-building assistant
 *     (Agents/Software build chat, Big Bets planner, Knowledge, Metric). EMPTY = follow the
 *     LEAD role (`core/models/roles.ts` `leadModel()`: `sovereign-strong` by default, the worker in cost-saving mode): the assistant orchestrates,
 *     plans, chooses tools and writes the final answer on strong, and hands only clearly defined
 *     sub-tasks to the worker (`core/runtime/delegate.ts`). A non-empty value is an explicit override. The
 *     route that sets it checks, against LiteLLM right now, that the alias exists and is a chat model.
 *     A pin at an alias that was later removed in LiteLLM is not hidden: the gateway's own "model not
 *     found" answers the call, and Models & Providers lists it under "References".
 *   • the legacy PROVIDER-KEY references (a reference + fingerprint, never a raw key) — read-only.
 * The per-ROLE defaults (standard/reasoning/embeddings) are ONE store, the settings `modelRoles`.
 *
 * Older releases also mirrored a catalog (`enabled`, `capEUR`, registered endpoints) into the
 * `os-model-config` index. Those documents are no longer read and nothing writes them; they are
 * harmless leftovers.
 */

import { osMirror } from '@core/infra/os-mirror';
import { leadModel, roleModel } from '@core/models/roles';

export type ModelTask = 'chat' | 'reasoning' | 'embedding';

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
  keys: Map<string, ProviderKey>;
  /** EMPTY = follow the STRONG role; non-empty = an explicit override an admin set. */
  assistant: string;
  hydration: Promise<void> | null;
};
const MODELS_KEY = Symbol.for('soa.platform.models');
const DEFAULT_ASSISTANT = '';

function modelsState(): ModelsState {
  const g = globalThis as unknown as Record<symbol, ModelsState | undefined>;
  if (!g[MODELS_KEY]) g[MODELS_KEY] = { keys: new Map(), assistant: DEFAULT_ASSISTANT, hydration: null };
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
        addedAt: { type: 'date' },
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
  const docs = (await mirror.hydrate(500)) ?? [];
  for (const doc of docs as Record<string, unknown>[]) {
    if (!doc || typeof doc.id !== 'string') continue;
    const docId = doc.id as string;
    if (docId === '__assistant__') {
      // Restore the explicit assistant override ('' = follow the STRONG role).
      const a = doc as unknown as { assistant?: string };
      if (typeof a.assistant === 'string') s.assistant = a.assistant;
    } else if (docId.startsWith('key:')) {
      // Restore provider key (ref+fingerprint; NEVER a raw value).
      const pk = doc as unknown as ProviderKey;
      if (pk.provider) s.keys.set(pk.provider, pk);
    }
    // Anything else is a leftover of the retired OS-side catalog (models, `__defaults__`): ignored.
  }
}

/**
 * The three per-role defaults, as a task→model_name map, read from the ONE store
 * (settings `modelRoles` via roles.ts). Read-only projection for display.
 */
export function getDefaults(): Record<ModelTask, string> {
  return { chat: roleModel('standard'), reasoning: roleModel('reasoning'), embedding: roleModel('embeddings') };
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
 * The id of the ONE model that powers every built-in assistant. An EMPTY explicit
 * override means "follow the STRONG role", so this returns the effective
 * model_name the assistant will actually run on (planning, tool choice and the final answer).
 */
export function getAssistantModelId(): string {
  return modelsState().assistant || leadModel().lead;
}

/**
 * The effective assistant model and which role it stands for: `strong` (the default), or `pinned`
 * (an admin override, whatever the alias is). What Platform → Models shows.
 */
export function assistantModelInfo(): { model: string; role: 'strong' | 'worker' | 'pinned'; explicit: boolean } {
  const explicit = isAssistantExplicit();
  return { model: getAssistantModelId(), role: explicit ? 'pinned' : leadModel().mode, explicit };
}

/** True when an admin has pinned an EXPLICIT assistant override (not "follow Strong"). */
export function isAssistantExplicit(): boolean {
  return modelsState().assistant.length > 0;
}

/**
 * The assistant model's id, or `null` when none resolves — the caller turns `null` into an HONEST
 * "configure it in Platform Admin" error (never a silent fake-AI fallback). Whether the alias still
 * exists is LiteLLM's to say: the call is made through the gateway, which refuses an unknown model.
 */
export function getAssistantModel(): { id: string } | null {
  const id = getAssistantModelId();
  return id ? { id } : null;
}

/** Clear an explicit assistant override — the assistant follows the STRONG role again. */
export function clearAssistantModel(): void {
  modelsState().assistant = '';
  mirror.writeThrough('__assistant__', { id: '__assistant__', assistant: '' });
}

/**
 * Choose the assistant model. The CALLER has checked, against LiteLLM, that the alias exists and
 * is a chat model (`app/api/platform-admin/models/[id]/route.ts`): this module holds no model list.
 */
export function setAssistantModel(modelId: string): string {
  const id = modelId.trim();
  if (!id) throw fail('A model alias is required', 400);
  modelsState().assistant = id;
  mirror.writeThrough('__assistant__', { id: '__assistant__', assistant: id });
  return id;
}

/** After a model is removed in LiteLLM: an explicit pin at it goes back to "follow Strong" — never a ghost pin. */
export function clearAssistantIf(modelId: string): boolean {
  if (modelsState().assistant !== modelId) return false;
  clearAssistantModel();
  return true;
}

export function _reset(): void {
  const s = modelsState();
  s.keys.clear();
  s.assistant = DEFAULT_ASSISTANT;
  s.hydration = null;
  mirror.__reset();
}
