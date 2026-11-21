/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { type Capability, type System } from '@tabs/agents/lib/system-schema';
import {
  type RoutingTable,
  ACTIVITIES,
  defaultRoutingTable,
  resolveModel,
  routeProbe,
} from '@tabs/agents/lib/routing';
import { type Decision } from '@tabs/agents/lib/gateway';
import { type BuildAdapter, type BuildChange, type BuildContext, type StepResult } from '@tabs/agents/lib/build/adapter';
import { principalFor } from '@tabs/agents/lib/build/runtime-contract';
import { compileVerify } from '@tabs/agents/lib/build/compile-verify';
import { config } from '@core/kernel/config';
import {
  forgetSystemKey,
  isLegacyDerivedToken,
  mintSystemKey,
  openSystemKey,
  retiringAlias,
  sealSystemKey,
  tokenIdOf,
  tryOpenSystemKey,
  type Kek,
  type SystemKeyJournal,
  type SystemKeyCaps,
  type SystemKeyRecord,
  type SystemKeyStore,
} from '@core/infra/agent-system-keys';

/**
 * The 4 LIVE Build adapters (Approach A) — the real apply→verify against the
 * services, replacing {@link makeMockAdapters}. They share the SAME
 * {@link BuildAdapter} interface, the same run order (opa → litellm → langgraph →
 * langfuse) and the same cardinal rule (a row is ✓ ONLY when both apply AND verify
 * pass). Every backend is injected as a small client interface so this module stays
 * PURE and unit-testable against in-memory fakes; the real fetch-backed clients live
 * in `live-clients.ts` (server-only).
 *
 * There is NO git backend: a system's `system.yaml` + per-agent AGENT.md/MEMORY.md
 * live in the agent store (the durable record + its version log), so Build has no
 * repo step — it provisions governance, routing, the graph and tracing.
 *
 *   • opa      — PUT grants for principal os-<id> (+ connection_<id>; Write-approval
 *                merged into requires_approval); verify probes allow/deny/approval.
 *   • litellm  — the system's OWN key: a random value registered under alias os-<id>
 *                (routed models + the run's role models + gateway fallback targets, budget,
 *                rpm/tpm/parallel caps) and stored ENCRYPTED in the durable key store, so
 *                every process that runs the system reads the same key. A rebuild reconciles
 *                the caps; an old guessable key (`sk-os-<id>`), a key whose stored copy is
 *                missing or unreadable, or an explicit rotation is REPLACED: old deleted at the
 *                gateway, new minted and stored. verify reads the gateway and the store back.
 *   • langgraph— compile()→IR→`buildGraph` (the REAL StateGraph the run path executes);
 *                verify re-compiles and reports the node set, the step budget and every
 *                compile warning. A5 replaced a POST to the Python runtime's /reload +
 *                a mock test-invocation with the actual compile, in this process.
 *   • langfuse — ensure the project; verify a trace landed for the test invocation.
 */

// ----------------------------------------------------------------- clients -------

export interface OpaClient {
  /** PUT the principal's allowed tools (in-memory data document). */
  putGrants(principal: string, tools: string[]): Promise<void>;
  /** Merge tool names into the global requires_approval list (held writes). */
  mergeRequiresApproval(tools: string[]): Promise<void>;
  decision(principal: string, tool: string): Promise<Decision>;
}

export type LiteLlmKeyInput = {
  /** The system the key belongs to — stamped on the key as `metadata.os_id`. */
  systemId: string;
  alias: string;
  models: string[];
  maxBudget: number;
  /** LiteLLM `budget_duration` ("7d", "30d", …): `maxBudget` resets every period. '' = never resets. */
  budgetDuration: string;
  modelMaxBudget: Record<string, number>;
  rpmLimit: number;
  tpmLimit: number;
  /** LiteLLM `max_parallel_requests`: model calls in flight on this key at once. */
  maxParallelRequests: number;
  allowedTools: string[];
};

/** What LiteLLM currently holds for a key — every field Build sets, so a rebuild can compare. */
export type LiteLlmKeyState = {
  /** LiteLLM's id for the key (its `token`: the SHA-256 of the value). Addresses update and delete. */
  tokenId: string;
  models: string[];
  maxBudget?: number;
  /** '' / absent = the budget never resets. */
  budgetDuration?: string;
  rpmLimit?: number;
  tpmLimit?: number;
  maxParallelRequests?: number;
  allowedTools?: string[];
};

export interface LiteLlmClient {
  /**
   * Every key the gateway holds under this alias (normally none or one). THROWS when the gateway
   * cannot be read: "could not look" must never be mistaken for "there is no key", because the
   * caller would then mint a second one.
   */
  keysByAlias(alias: string): Promise<LiteLlmKeyState[]>;
  /** Register `key` (a value minted by the OS) with the given properties (`/key/generate`). Throws on refusal. */
  generateKey(input: LiteLlmKeyInput, key: string): Promise<void>;
  /** Bring an EXISTING key to the given state (`/key/update`). Throws when the gateway refuses. */
  updateKey(tokenId: string, input: LiteLlmKeyInput): Promise<void>;
  /** Remove a key at the gateway (`/key/delete`), so its value stops working. Throws on refusal. */
  deleteKey(tokenId: string): Promise<void>;
  /** Give an EXISTING key another alias (`/key/update` with `key_alias` only). Its value keeps working. Throws on refusal. */
  renameKey(tokenId: string, alias: string): Promise<void>;
  /** LiteLLM's own key expiry: the key is refused `seconds` from now (`/key/update` with `duration`). Throws on refusal. */
  expireKey(tokenId: string, seconds: number): Promise<void>;
  models(): Promise<string[]>;
}

export interface LangfuseClient {
  ensureProject(name: string): Promise<void>;
  /** How many traces have landed for the system principal (os-<id>). */
  tracesFor(principal: string): Promise<number>;
}

/**
 * Per-key cost + rate caps for the key Build mints for ONE agent system (`os-<systemId>`).
 * They come from deployment config (`config.agentSystemKey` ← `AGENT_SYSTEM_KEY_*` ← the chart's
 * `osUI.agentSystemKey`), passed in by the server wiring — they used to be hard-coded here, so no
 * operator setting could reach a system's key.
 */
export type KeyCaps = {
  /** USD the key may spend per `budgetDuration`. */
  maxBudget: number;
  /** LiteLLM `budget_duration`. '' = `maxBudget` is a LIFETIME cap that never resets. */
  budgetDuration: string;
  modelMaxBudget: Record<string, number>;
  rpmLimit: number;
  tpmLimit: number;
  maxParallelRequests: number;
};

/**
 * The gateway's router fallbacks: `fallbacks[alias]` are the aliases LiteLLM retries on when
 * `alias` fails; `default` are tried when no per-alias rule matches. LiteLLM authorises the key
 * against the model it falls back TO, so those targets must be on the key.
 */
export type GatewayFallbacks = { fallbacks: Record<string, string[]>; default: string[] };

/**
 * Parse the chart-rendered fallback map (`AGENT_SYSTEM_KEY_FALLBACKS_JSON`). Empty means "no
 * fallbacks configured". Text that is not JSON is a deployment error and throws: a key built
 * without the gateway's fallback targets would be refused exactly when the gateway falls back.
 * Non-string entries inside valid JSON are dropped.
 */
export function parseGatewayFallbacks(json: string): GatewayFallbacks {
  const out: GatewayFallbacks = { fallbacks: {}, default: [] };
  if (!json.trim()) return out;
  let raw: { fallbacks?: unknown; default?: unknown };
  try {
    raw = JSON.parse(json) as { fallbacks?: unknown; default?: unknown };
  } catch (e) {
    throw new Error(`AGENT_SYSTEM_KEY_FALLBACKS_JSON is not valid JSON (${(e as Error).message}) — check the chart's litellm router_settings rendering`);
  }
  {
    const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : []);
    if (raw.fallbacks && typeof raw.fallbacks === 'object' && !Array.isArray(raw.fallbacks)) {
      for (const [from, targets] of Object.entries(raw.fallbacks as Record<string, unknown>)) out.fallbacks[from] = strings(targets);
    }
    out.default = strings(raw.default);
  }
  return out;
}

/** Where Build keeps the key it minted: the durable encrypted store + this deployment's encryption key. */
export type KeyVault = {
  store: SystemKeyStore;
  /** Where a key replacement is written down before each gateway step (make-before-break). */
  journal: SystemKeyJournal;
  /** The key-encryption key. Throws `SystemKeyUnavailableError('not-configured')` when there is none. */
  kek: () => Kek;
  /** Injected in tests; defaults to 32 CSPRNG bytes (`mintSystemKey`). */
  mint?: () => string;
  /**
   * How long a replaced key keeps working before LiteLLM refuses it (default
   * {@link RETIRE_GRACE_SECONDS}). 0 deletes it at once.
   */
  retireGraceSeconds?: number;
  now?: () => number;
};

/**
 * The defaults when nothing is configured. The budget RESETS WEEKLY: a lifetime cap means a
 * system stops working for good once it has spent it — after a few dozen ordinary runs on the
 * reasoning model — with nothing its owner can do. The rate limits match the shared agent key's.
 */
export const DEFAULT_KEY_CAPS: KeyCaps = {
  maxBudget: 5,
  budgetDuration: '7d',
  modelMaxBudget: {},
  rpmLimit: 300,
  tpmLimit: 1_000_000,
  maxParallelRequests: 8,
};

/** The default grace a replaced key keeps working for (`config.agentSystemKeyRetireGraceSeconds`). */
export const RETIRE_GRACE_SECONDS = config.agentSystemKeyRetireGraceSeconds;

export type LiveDeps = {
  opa: OpaClient;
  litellm: LiteLlmClient;
  langfuse: LangfuseClient;
  /** Where the minted key is kept (encrypted) for the run path. */
  keys: KeyVault;
  caps?: KeyCaps;
  /**
   * The models a RUN picks regardless of the definition: the reasoning role (every plan step and
   * every supervisor routing call) and the tools role (the fast tier). Read at build time, so a
   * role an admin re-points later needs a Rebuild — the run says so when the gateway refuses.
   */
  runModels?: () => string[];
  fallbacks?: GatewayFallbacks;
};

// ------------------------------------------------------------------ helpers ------

const enabled = (c: Capability) => c === 'Read' || c === 'Write-approval' || c === 'Write-bounded';

/** A system's routing table = the defaults with its activity→model overrides applied. */
function routingTableFor(sys: System): RoutingTable {
  const table = defaultRoutingTable();
  for (const [activity, model] of Object.entries(sys.routing.overrides)) {
    const a = activity as keyof RoutingTable;
    if (table[a]) table[a] = { tier: table[a].tier, model };
  }
  return table;
}

/** Distinct LiteLLM model_names a system can route to (tier defaults + per-agent pins). */
function routedModels(sys: System, table: RoutingTable): string[] {
  const set = new Set<string>();
  for (const a of ACTIVITIES) set.add(table[a].model);
  // `auto` is the "let the engine choose" sentinel, not a model.
  for (const ag of sys.agents) if (ag.model && ag.model.trim().toLowerCase() !== 'auto') set.add(ag.model.trim());
  return [...set];
}

/**
 * Every model a key must allow so that no call a run can make is refused: the given models plus,
 * transitively, each one's gateway fallback targets, plus the gateway's default fallbacks.
 */
export function withFallbackTargets(models: string[], fb: GatewayFallbacks | undefined): string[] {
  const out = new Set(models.filter(Boolean));
  if (!fb) return [...out];
  for (const d of fb.default) out.add(d);
  const queue = [...out];
  while (queue.length > 0) {
    const m = queue.pop()!;
    for (const target of fb.fallbacks[m] ?? []) {
      if (!out.has(target)) { out.add(target); queue.push(target); }
    }
  }
  return [...out];
}

/**
 * The tool vocabulary granted to a system's principal in OPA / LiteLLM: the RAW
 * grant names (kept so the runtime's raw-IR tool calls stay authorized) UNIONED
 * with their RESOLVED MCP registry names (so a legacy `retrieve` grant ALSO
 * authorizes `search_knowledge`, matching the sanctioned MCP vocabulary the Run
 * path resolves to), plus the enabled connection tools. Resolved via a dynamic
 * import so this module has no eager dependency on the (heavier) os-tools chain.
 */
async function grantVocabulary(input: System, connections: string[]): Promise<string[]> {
  const { resolveGrantedTools } = await import('./os-tools.ts');
  const { withOutputTools } = await import('@tabs/agents/lib/output-tools');
  // The vocabulary is the one the RUN uses: a declared output's write tool (save_knowledge_note,
  // upload_file, create_dataset) is added at run time (run-service.ts → withOutputTools), so the
  // key's allowed tools and the OPA grant must include it too — or the gateway refuses the run.
  const sys = withOutputTools(input);
  const resolved = resolveGrantedTools(sys).mcpNames;
  return [...new Set([...sys.grants.tools, ...resolved, ...connections])];
}

/** connection_<id> tool names for enabled connections; and the write-held subset. */
function connectionTools(sys: System): { all: string[]; held: string[] } {
  const all: string[] = [];
  const held: string[] = [];
  for (const c of sys.grants.connections) {
    if (!enabled(c.capability)) continue;
    const tool = `connection_${c.id}`;
    all.push(tool);
    if (c.capability === 'Write-approval') held.push(tool);
  }
  return { all, held };
}

/**
 * The OPA state one system's Build writes: its principal, the granted tool vocabulary, and the
 * connection writes held for approval. Shared by the Build's `opa` adapter and the OPA state
 * restore (`opa-state.ts`), so a restore writes exactly what a Build wrote.
 */
export async function systemOpaGrants(systemId: string, sys: System): Promise<{ principal: string; tools: string[]; held: string[] }> {
  const { all, held } = connectionTools(sys);
  return { principal: principalFor(systemId), tools: await grantVocabulary(sys, all), held };
}

function ok(detail: string, change?: BuildChange): StepResult {
  return change ? { ok: true, detail, change } : { ok: true, detail };
}
function fail(error: string): StepResult {
  return { ok: false, detail: error, error };
}
/** A NEUTRAL "verified from a run trace — needs a run first" result (not a failure). */
function pending(detail: string): StepResult {
  return { ok: true, pending: true, detail };
}

/** "budget $5 per 7d, 300 requests/min, 1000000 tokens/min" — the caps in words. */
export function describeCaps(k: Pick<LiteLlmKeyInput, 'maxBudget' | 'budgetDuration' | 'rpmLimit' | 'tpmLimit' | 'maxParallelRequests'>): string {
  const budget = k.budgetDuration ? `$${k.maxBudget} per ${k.budgetDuration}` : `$${k.maxBudget} in total (never resets)`;
  return `budget ${budget}, ${k.rpmLimit} requests/min, ${k.tpmLimit} tokens/min, ${k.maxParallelRequests} at once`;
}

const sameSet = (a: string[] | undefined, b: string[]) => {
  const x = new Set(a ?? []);
  return x.size === new Set(b).size && b.every((v) => x.has(v));
};

/**
 * How an existing key differs from the one the definition wants, as human sentences
 * ("tokens/min 200000 → 1000000"). Empty = already up to date. Compares every field Build sets
 * that the gateway reports back.
 */
export function keyDrift(have: Omit<LiteLlmKeyState, 'tokenId'>, want: LiteLlmKeyInput): string[] {
  const out: string[] = [];
  const show = (v: number | string | undefined) => (v === undefined || v === '' ? 'none' : String(v));
  if (!sameSet(have.models, want.models)) out.push(`models ${[...(have.models ?? [])].sort().join(', ') || 'none'} → ${[...want.models].sort().join(', ')}`);
  if (have.maxBudget !== want.maxBudget) out.push(`budget $${show(have.maxBudget)} → $${want.maxBudget}`);
  if ((have.budgetDuration ?? '') !== want.budgetDuration) out.push(`budget reset ${show(have.budgetDuration)} → ${show(want.budgetDuration)}`);
  if (have.rpmLimit !== want.rpmLimit) out.push(`requests/min ${show(have.rpmLimit)} → ${want.rpmLimit}`);
  if (have.tpmLimit !== want.tpmLimit) out.push(`tokens/min ${show(have.tpmLimit)} → ${want.tpmLimit}`);
  if (have.maxParallelRequests !== want.maxParallelRequests) out.push(`calls at once ${show(have.maxParallelRequests)} → ${want.maxParallelRequests}`);
  // `allowedTools` absent from the read-back (a gateway that hides metadata) is not drift.
  if (have.allowedTools !== undefined && !sameSet(have.allowedTools, want.allowedTools)) {
    out.push(`allowed tools ${have.allowedTools.length} → ${want.allowedTools.length}`);
  }
  return out;
}

// ----------------------------------------------------------------- adapters ------

export function makeLiveAdapters(deps: LiveDeps): BuildAdapter[] {
  const caps = deps.caps ?? DEFAULT_KEY_CAPS;

  const opa: BuildAdapter = {
    tool: 'opa',
    async apply(ctx) {
      const { principal, tools, held } = await systemOpaGrants(ctx.systemId ?? 'sys', ctx.system);
      await deps.opa.putGrants(principal, tools);
      if (held.length > 0) await deps.opa.mergeRequiresApproval(held);
      return ok(`granted ${tools.length} tool(s) to ${principal}${held.length ? `; ${held.length} held for approval` : ''}`, 'reapplied');
    },
    async verify(ctx) {
      const principal = principalFor(ctx.systemId ?? 'sys');
      const { all, held } = connectionTools(ctx.system);
      const grantedTool = ctx.system.grants.tools[0] ?? all[0];
      const probes: string[] = [];
      if (grantedTool) {
        const d = await deps.opa.decision(principal, grantedTool);
        if (d.effect !== 'allow') return fail(`granted tool ${grantedTool} did not resolve (${d.effect})`);
        probes.push(`granted '${grantedTool}' → allow`);
      }
      const d2 = await deps.opa.decision(principal, 'connection_ghost');
      if (d2.effect === 'allow') return fail('a non-granted tool was not blocked');
      probes.push(`non-granted → ${d2.effect}`);
      if (held[0]) {
        const d3 = await deps.opa.decision(principal, held[0]);
        if (d3.effect !== 'requires_approval') return fail(`write tool ${held[0]} not held (${d3.effect})`);
        probes.push(`write '${held[0]}' → requires_approval`);
      }
      return ok(probes.join('; '));
    },
  };

  /** The key this system SHOULD have, from its definition and the configured caps. */
  const desiredKey = async (ctx: BuildContext): Promise<LiteLlmKeyInput> => {
    const table = routingTableFor(ctx.system);
    // What the definition routes to, what a run picks by ROLE (the plan step's reasoning model, the
    // fast tools model), and every model the gateway may fall back to from any of those.
    const models = withFallbackTargets([...new Set([...routedModels(ctx.system, table), ...(deps.runModels?.() ?? [])])], deps.fallbacks);
    // Per-model hard cost cap for the pay-per-token STACKIT (qwen) routes only.
    const modelMaxBudget: Record<string, number> = { ...caps.modelMaxBudget };
    for (const m of models) {
      if (/stackit|qwen/i.test(m) && modelMaxBudget[m] === undefined) modelMaxBudget[m] = 2;
    }
    const { all } = connectionTools(ctx.system);
    return {
      systemId: ctx.systemId ?? 'sys',
      alias: principalFor(ctx.systemId ?? 'sys'),
      models,
      maxBudget: caps.maxBudget,
      budgetDuration: caps.budgetDuration,
      modelMaxBudget,
      rpmLimit: caps.rpmLimit,
      tpmLimit: caps.tpmLimit,
      maxParallelRequests: caps.maxParallelRequests,
      allowedTools: await grantVocabulary(ctx.system, all),
    };
  };

  const storedCaps = (want: LiteLlmKeyInput): SystemKeyCaps => ({
    models: [...want.models],
    maxBudget: want.maxBudget,
    budgetDuration: want.budgetDuration,
    rpmLimit: want.rpmLimit,
    tpmLimit: want.tpmLimit,
    maxParallelRequests: want.maxParallelRequests,
  });
  const now = () => deps.keys.now?.() ?? Date.now();

  /** The stored record, and whether this deployment can still decrypt it. */
  const storedKey = async (systemId: string, kek: Kek): Promise<{ record: SystemKeyRecord | null; readable: boolean }> => {
    const record = await deps.keys.store.get(systemId);
    if (!record) return { record: null, readable: false };
    try {
      openSystemKey(record, kek);
      return { record, readable: true };
    } catch {
      return { record, readable: false };
    }
  };

  const litellm: BuildAdapter = {
    tool: 'litellm',
    /**
     * RECONCILE the system's own key, in the gateway AND in the durable store.
     *
     *   KEEP    the gateway holds the key whose encrypted copy is stored and readable, no
     *           rotation was asked for and no replacement is half-done → compare its caps with the
     *           definition and `/key/update` when they differ. The value is untouched.
     *   REPLACE in every other case — no key yet; an old GUESSABLE key (`sk-os-<id>`); a key at the
     *           gateway whose stored copy is missing or unreadable; an explicit rotation; a
     *           replacement a crashed process left in the journal.
     *
     * REPLACE IS MAKE-BEFORE-BREAK (`SystemKeyJournal` in `core/infra/agent-system-keys.ts`): the
     * new value is staged first, the old key is moved off the alias but KEEPS WORKING, the new key
     * is registered and swapped into the store, and only then is the old key deleted. There is no
     * moment in which the system has no working key, and a re-run after a crash at any step
     * continues with the same staged value.
     */
    async apply(ctx) {
      const want = await desiredKey(ctx);
      const kek = deps.keys.kek();
      const journal = deps.keys.journal;
      const atGateway = await deps.litellm.keysByAlias(want.alias);
      const { record, readable } = await storedKey(want.systemId, kek);
      const staged = await journal.staged(want.systemId);
      const current = record && readable ? atGateway.find((k) => k.tokenId === record.tokenId) : undefined;

      if (!staged && record && current && !ctx.rotateKey) {
        // A second key under the alias cannot be ours (ours is `current`): remove it.
        for (const stray of atGateway) if (stray.tokenId !== current.tokenId) await deps.litellm.deleteKey(stray.tokenId);
        const drift = keyDrift(current, want);
        if (drift.length === 0) return ok(`key '${want.alias}' already up to date — ${describeCaps(want)}`, 'unchanged');
        await deps.litellm.updateKey(current.tokenId, want);
        await deps.keys.store.put({ ...record, caps: storedCaps(want) });
        return ok(`updated key '${want.alias}': ${drift.join('; ')}`, 'updated');
      }

      const hadLegacy = atGateway.some((k) => isLegacyDerivedToken(want.alias, k.tokenId))
        || (staged?.retire.some((r) => isLegacyDerivedToken(want.alias, r.tokenId)) ?? false);
      const why = staged
        ? 'a replacement interrupted earlier was completed with the value it had staged'
        : current
          ? 'rotated on request: a new random key was issued, then the old one deleted at the gateway'
          : atGateway.length === 0
            ? record ? 'the gateway no longer had this system\'s key, so a new random key was issued' : ''
            : hadLegacy
              ? 'the old key could be derived from the system id; a random key replaced it before the old one was deleted'
              : 'the key at the gateway had no readable stored copy; a new random key replaced it';

      // 1. STAGE — or resume what was staged. A staged value this deployment cannot open is
      //    useless; it is replaced, and the keys it was retiring are still retired.
      let entry = staged;
      let key: string | null = null;
      if (entry) {
        const opened = tryOpenSystemKey(entry.record, kek);
        key = opened.ok ? opened.key : null;
      }
      const at = now();
      if (!entry || key === null) {
        key = (deps.keys.mint ?? mintSystemKey)();
        const fresh = tokenIdOf(key);
        const retire = [
          ...(entry?.retire ?? []),
          ...atGateway.filter((k) => k.tokenId !== fresh).map((k) => ({ tokenId: k.tokenId, alias: retiringAlias(want.alias, k.tokenId) })),
        ];
        entry = {
          record: sealSystemKey({ systemId: want.systemId, alias: want.alias, key, caps: storedCaps(want), createdAt: record?.createdAt ?? at, rotatedAt: record ? at : null }, kek),
          retire: retire.filter((r, i) => retire.findIndex((x) => x.tokenId === r.tokenId) === i),
          stagedAt: at,
        };
        await journal.stage(entry);
      }
      const newToken = tokenIdOf(key);

      // 2. MOVE every other key off the alias. Its value keeps working until step 5.
      for (const k of atGateway) {
        if (k.tokenId === newToken) continue;
        const target: string = entry.retire.find((r) => r.tokenId === k.tokenId)?.alias ?? retiringAlias(want.alias, k.tokenId);
        if (!entry.retire.some((r) => r.tokenId === k.tokenId)) {
          entry = { ...entry, retire: [...entry.retire, { tokenId: k.tokenId, alias: target }] };
          await journal.stage(entry);
        }
        await deps.litellm.renameKey(k.tokenId, target);
      }

      // 3. REGISTER the staged value, unless an earlier attempt already did.
      if (!atGateway.some((k) => k.tokenId === newToken)) {
        try {
          await deps.litellm.generateKey(want, key);
        } catch (e) {
          // Nothing was broken: the old key (if any) still works under its retiring alias, the store
          // is unchanged, and the journal keeps the value for the next Build.
          throw new Error(`${(e as Error).message} — the system keeps its previous key; press Build again to finish the replacement`);
        }
      }

      // 4. SWAP — from here every run reads the new key.
      try {
        await deps.keys.store.put(entry.record);
      } catch (e) {
        throw new Error(`the new key could not be stored (${(e as Error).message}) — the system keeps its previous key; press Build again to finish the replacement`);
      }
      forgetSystemKey(want.systemId);

      // 5. RETIRE the old key(s), each only if the gateway still holds it: LiteLLM's own expiry
      //    refuses it after the grace period, so a run still holding the old value (a LangGraph
      //    segment resolves its key once) finishes its calls. The sweep deletes it once expired.
      //    A grace of 0 deletes at once. Then close the journal.
      const grace = deps.keys.retireGraceSeconds ?? RETIRE_GRACE_SECONDS;
      for (const old of entry.retire) {
        const still = await deps.litellm.keysByAlias(old.alias);
        if (!still.some((k) => k.tokenId === old.tokenId)) continue;
        if (grace > 0) await deps.litellm.expireKey(old.tokenId, grace);
        else await deps.litellm.deleteKey(old.tokenId);
      }
      await journal.clear(want.systemId);

      const what = `${want.models.length} model(s), ${describeCaps(want)}`;
      return why || entry.retire.length > 0
        ? ok(`replaced key '${want.alias}' — ${why || 'a new random key was issued'}; ${what}`, 'updated')
        : ok(`created key '${want.alias}' — ${what}`, 'created');
    },
    async verify(ctx) {
      const want = await desiredKey(ctx);
      const { record, readable } = await storedKey(want.systemId, deps.keys.kek());
      // The run path reads the key from the store: a key that is not there, or not readable, is
      // not a key the system can run on — whatever the gateway says.
      if (!record) return fail(`key '${want.alias}' is not in the key store — a run could not use it`);
      if (!readable) return fail(`the stored copy of key '${want.alias}' cannot be decrypted`);
      const atGateway = await deps.litellm.keysByAlias(want.alias);
      const info = atGateway.find((k) => k.tokenId === record.tokenId);
      if (!info) return fail(`key '${want.alias}' not found at the gateway`);
      if (atGateway.length !== 1) return fail(`the gateway holds ${atGateway.length} keys under '${want.alias}' — exactly one is expected`);
      if (isLegacyDerivedToken(want.alias, info.tokenId)) return fail(`key '${want.alias}' is still the old guessable key`);
      // Read back what apply wrote: a gateway that accepted the update but did not store it must
      // not read as ✓.
      const drift = keyDrift(info, want);
      if (drift.length > 0) return fail(`key '${want.alias}' does not match the definition after the build: ${drift.join('; ')}`);
      const table = routingTableFor(ctx.system);
      const light = routeProbe('coding', table);
      const reason = routeProbe('planning', table);
      if (light.tier !== 'light') return fail(`light activity routed to ${light.tier}`);
      if (reason.tier !== 'reasoning') return fail(`reasoning activity routed to ${reason.tier}`);
      const models = ctx.system.agents.map((a) => `${a.id}=${resolveModel('tool-selection', table, a.model)}`);
      return ok(`random key, stored encrypted; light→${light.model}; reasoning→${reason.model}; agents: ${models.join(', ')}; allowed models: ${[...want.models].sort().join(', ')}; ${describeCaps(want)}`);
    },
  };

  const langgraph: BuildAdapter = {
    tool: 'langgraph',
    async apply(ctx) {
      // A5: the graph is COMPILED here, with `buildGraph` — the same function the run path
      // calls. A build that passes therefore proves the StateGraph the engine will execute can
      // be constructed from this system.yaml: unmapped grants, a disabled entrypoint, a
      // malformed `when` guard and a channel shadowing an engine key all fail HERE.
      const built = await compileVerify(ctx.system, ctx.ir);
      if (!built.ok) return fail(built.error);
      return ok(`graph compiled — ${built.nodes} agent(s), entrypoint '${ctx.ir.entrypoint}', step budget ${built.stepBudget}`, 'reapplied');
    },
    async verify(ctx) {
      const built = await compileVerify(ctx.system, ctx.ir);
      if (!built.ok) return fail(built.error);
      // Compile warnings are not failures (a guard over a channel nothing sets still routes —
      // to false), but they must be SEEN. The row stays ✓ and says what is wrong.
      const detail =
        `${built.graphNodes} graph node(s) over ${built.nodes} agent(s); recursion limit ${built.recursionLimit}` +
        (built.warnings.length > 0 ? ` — warnings: ${built.warnings.join('; ')}` : '');
      return ok(detail);
    },
  };

  const langfuse: BuildAdapter = {
    tool: 'langfuse',
    async apply(ctx) {
      const project = `os-${ctx.systemId ?? 'sys'}`;
      await deps.langfuse.ensureProject(project);
      return ok(`Langfuse project ${project} comes with the platform — nothing to create per system`, 'unchanged');
    },
    async verify(ctx) {
      const principal = principalFor(ctx.systemId ?? 'sys');
      const n = await deps.langfuse.tracesFor(principal);
      if (n <= 0) return pending('this component is verified from a run trace — run the agent once, then Build again');
      return ok(`${n} trace(s) landed for the test invocation`);
    },
  };

  return [opa, litellm, langgraph, langfuse];
}
