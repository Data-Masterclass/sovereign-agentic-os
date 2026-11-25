/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The credential and attribution a model call carries. One helper,
 *             so every caller wires the same header the same way — and so the
 *             LiteLLM master key can never reach an inference path.
 *
 * USER STORY: As a platform admin I set a USD cap and a model allowlist on the
 *             agents' key and they actually bind, because runs use that key and
 *             not an unlimited master credential.
 *             As a finance owner I can ask LiteLLM what one person, one domain,
 *             one agent or ONE RUN spent, because every call is tagged and
 *             carries an end-user id.
 *             As a security reviewer I can see in one file which credential the
 *             run path uses, and that there is no code path from a run to the
 *             master key.
 *
 * ARCHITECTURE:
 *   Mirrors `core/infra/service-bearer.ts`: one shared helper rather than a
 *   header assembled per call site. Every inference caller uses it — the agent
 *   runtime (`core/runtime/runtime.ts`), the assistant (`core/runtime/complete.ts`),
 *   classify (`app/api/classify/route.ts`) and both embedders
 *   (`tabs/knowledge/lib/embed.ts`, `tabs/files/lib/embed.ts`).
 *
 *   The master key stays for ADMIN reads and writes (`litellm-admin.ts`,
 *   `litellm-write.ts`) because those operate on the gateway itself. It is
 *   never a run credential, and that separation is what the `MODEL-KEY` gate
 *   test pins down — repo-wide since A3.
 *
 *   AGENT-SYSTEM KEY: a run of an agent system passes the system's key
 *   REFERENCE (`keyRef`, never the value). The model caller reads the key from
 *   the durable, encrypted store (`agent-system-keys.ts`) and hands the value to
 *   `callerCredential`. A call that carries `keyRef` uses THAT key or none: it
 *   never falls back to the shared agent key, because the system's budget and
 *   limits would then silently not apply. Calls with no `keyRef` (the assistant,
 *   classify, the embedders) use the shared agent key. There is no third branch.
 *
 *   FAIL CLOSED: with no scoped key configured this returns `apiKey: ''` and
 *   the caller must refuse to run. Falling back to the master key would make a
 *   misconfiguration silently unlimited, which is the failure mode the cap
 *   exists to prevent.
 *
 *   Attribution rides along as LiteLLM's own `user` field plus request tags.
 *   The tag vocabulary (`domain:`, `agent:`, `tab:`, `run:`) is the one the
 *   gateway mirror reads back in `tabs/admin/lib/gateway-mirror.ts`; the two
 *   must stay in step, which is why the prefixes live in one exported constant.
 */
import 'server-only';
import type { RunEnv } from '@core/kernel/object-lifecycle';
import { config } from '@core/kernel/config';
import type { SecretRef } from '@core/infra/secrets';

/** Who and what a model call is for. `domain` is required: spend is per domain. */
export type CallerContext = {
  userId: string;
  domain: string;
  /** The agent system making the call, when a run is in flight. */
  systemId?: string;
  /** The tab the call originated from, for per-surface cost. */
  tab?: string;
  /** The run (= Langfuse trace id = LangGraph thread id) the call belongs to. */
  runId?: string;
  /**
   * LIFECYCLE (night 2, V-R4.1): which point of an object's life this call happens at, in
   * LiteLLM's own vocabulary — `studio` (editing the draft), `test` (trying the draft out) or
   * `run` (the pinned version that operates). Becomes the `env:` tag, so the gateway can budget
   * a draft separately from what is running: a draft must not drain the live key.
   * Omitted ⇒ no tag, never a fabricated one.
   */
  env?: RunEnv;
  /**
   * Marks the call as belonging to an AGENT SYSTEM, by reference to that system's own key
   * (`systemKeyRef(systemId)` — an id, never a value). Present ⇒ the system's key or nothing;
   * absent ⇒ the shared agent key.
   */
  keyRef?: SecretRef;
};

export type CallerCredential = {
  /** Bearer value. EMPTY means "no scoped credential" — the caller must refuse. */
  apiKey: string;
  /** Which credential was chosen: the system's own key or the shared agent key. */
  keySource: 'agent-key' | 'shared-agent-key' | 'none';
  /** LiteLLM `user` — becomes `end_user` in its spend ledger. */
  user: string;
  /** LiteLLM request tags, the vocabulary the gateway mirror reads back. */
  tags: string[];
};

/** The tag prefixes the mirror buckets by. Keep in step with gateway-mirror. */
export const TAG_DOMAIN = 'domain:';
export const TAG_AGENT = 'agent:';
export const TAG_TAB = 'tab:';
export const TAG_RUN = 'run:';
export const TAG_ENV = 'env:';

/** LiteLLM end-user ids are namespaced so OS ids never collide with others'. */
export function endUserId(userId: string): string {
  return `os-${userId}`;
}

/**
 * The credential and attribution for one model call.
 *
 * Deliberately NOT a fallback chain: an agent-system call (`ctx.keyRef`) uses the
 * system's own key — `ownKey`, already read from the durable store by the caller —
 * or NONE; every other call uses the shared agent key; and nothing ever uses the
 * master key. A run that silently spends on a different key than the one its
 * budget is set on is worse than a run that stops and says why.
 */
export function callerCredential(ctx: CallerContext, ownKey?: string): CallerCredential {
  const tags = [`${TAG_DOMAIN}${ctx.domain}`];
  if (ctx.systemId) tags.push(`${TAG_AGENT}${ctx.systemId}`);
  if (ctx.tab) tags.push(`${TAG_TAB}${ctx.tab}`);
  if (ctx.runId) tags.push(`${TAG_RUN}${ctx.runId}`);
  if (ctx.env) tags.push(`${TAG_ENV}${ctx.env}`);
  if (ctx.keyRef) {
    return ownKey && ownKey.length > 0
      ? { apiKey: ownKey, keySource: 'agent-key', user: endUserId(ctx.userId), tags }
      : { apiKey: '', keySource: 'none', user: endUserId(ctx.userId), tags };
  }
  const shared = config.litellmAgentKey;
  return { apiKey: shared, keySource: shared.length > 0 ? 'shared-agent-key' : 'none', user: endUserId(ctx.userId), tags };
}

/** True when a scoped run credential exists. False => the run path must refuse. */
export function runCredentialConfigured(): boolean {
  return config.litellmAgentKey.length > 0;
}

/** Thrown when a run is attempted with no scoped credential. */
export class NoRunCredentialError extends Error {
  readonly code = 'no_run_credential';
  constructor() {
    super(
      'No scoped LiteLLM key is configured (LITELLM_AGENT_KEY is empty). Refusing to run: ' +
      'using the master key would bypass the model allowlist and the spend cap.',
    );
    this.name = 'NoRunCredentialError';
  }
}

/**
 * Thrown when the gateway refuses an agent system's OWN key. Two cases (the run report shows the failing agent's
 * name in front of the message); a Rebuild fixes both — and the OS re-stamps the key's models and tools on every
 * save and before every run (`key-reconcile.ts` `syncDerivedKeyFields`), so the second should not happen:
 * `rejected` — the key is not (or no longer) registered at the gateway (deleted, or rotated
 * outside the OS); `model_not_allowed` — the key exists but its model list does not include the
 * model this call asked for (the model roles or the gateway's fallbacks changed since the build).
 */
export class SystemKeyRefusedError extends Error {
  readonly code: 'system_key_rejected' | 'system_key_model_not_allowed';
  readonly status: number;
  readonly detail: string;
  constructor(kind: 'rejected' | 'model_not_allowed', status: number, model: string, body: string) {
    super(
      kind === 'model_not_allowed'
        ? `This agent uses the ${model === 'sovereign-strong' ? 'Strong model' : model === 'sovereign-worker' ? 'Standard model' : `model "${model}"`}, ` +
          'and the model key of its agent system does not allow it yet (or the model the gateway fell back to). The OS ' +
          'updates the key when the system is saved and before every run; if this still happens, the gateway could not ' +
          'be reached for that update — press Rebuild on the system.'
        : 'The gateway refused this agent system\'s model key: it is no longer registered there (it was deleted or replaced ' +
          'outside the OS). Press Rebuild on the system to issue a new key.',
    );
    this.name = 'SystemKeyRefusedError';
    this.code = kind === 'model_not_allowed' ? 'system_key_model_not_allowed' : 'system_key_rejected';
    this.status = status;
    this.detail = body.slice(0, 300);
  }
}

/** Does this gateway rejection say "this key may not use this model"? (LiteLLM answers 401 or 403.) */
export function isModelAccessRejection(status: number, body: string): boolean {
  return (status === 401 || status === 403) && /key_model_access_denied|not allowed to access model|key not allowed to access/i.test(body);
}

/** Thrown when LiteLLM rejects a call because a budget is exhausted. */
export class BudgetExceededError extends Error {
  readonly code = 'budget_exceeded';
  readonly status = 402;
  /** LiteLLM's own message, kept for the audit trail. */
  readonly detail: string;
  // NOT a TS parameter property (`constructor(readonly detail: string)`): Node's
  // strip-only type removal rejects those, and the test runner loads .ts directly.
  constructor(detail: string) {
    super(
      'The model budget of the key this ran on is used up, so the gateway refused the call. Waiting a minute does not help: ' +
      'the budget comes back when its period resets, or when an admin raises it — the shared agent key in Admin → LLM Gateway ' +
      '(chart: litellmAgentKey.maxBudget); an agent system\'s own key via osUI.agentSystemKey.maxBudget, then Rebuild the system.',
    );
    this.name = 'BudgetExceededError';
    this.detail = detail;
  }
}

/**
 * Thrown when LiteLLM answers an inference call with a RATE-LIMIT 429 (requests or tokens per
 * minute — NOT a budget, see {@link isBudgetRejection}). The message is unchanged from the plain
 * `LiteLLM 429: …` error it replaces; what it adds is the gateway's `Retry-After`, so a caller that
 * wants to wait for the reset (the agent engine, `core/runtime/rate-limit.ts`) knows how long.
 */
export class GatewayRateLimitedError extends Error {
  readonly code = 'rate_limited';
  readonly status = 429;
  /** Seconds from the `Retry-After` header, when the gateway sent one. */
  readonly retryAfterSeconds?: number;
  readonly detail: string;
  constructor(body: string, retryAfter?: string | null) {
    super(`LiteLLM 429: ${body.slice(0, 300)}`);
    this.name = 'GatewayRateLimitedError';
    this.detail = body.slice(0, 600);
    const seconds = Number(retryAfter);
    if (retryAfter && Number.isFinite(seconds) && seconds > 0) this.retryAfterSeconds = seconds;
  }
}

/**
 * Is this LiteLLM rejection a budget problem? The STATUS has moved between versions while the
 * body kept saying so, which is why the body decides and the status only bounds it:
 *   • 1.90.0   — 429 `{"error":{"message":"Budget has been exceeded! Current cost: …, Max budget: …","type":"budget_exceeded","code":"429"}}`
 *   • 1.108.12 — 422 `{"error":{"message":"Budget has been exceeded! Key=<alias> (sk-...xxxx) Current cost: …, Max budget: …","type":"budget_exceeded","code":"422"}}`
 *   • older    — 400 with `ExceededBudget` / `max_budget` wording.
 * (Both newer bodies measured against real containers; docs/ops/litellm-upgrade.md.) A 422 that
 * is not about a budget — a validation error — must stay a plain rejection, so the wording is
 * still required, and a rate-limit 429 ("Rate limit exceeded … Limit resets at: …") never
 * matches it.
 */
export function isBudgetRejection(status: number, body: string): boolean {
  if (status !== 400 && status !== 422 && status !== 429) return false;
  return /"type"\s*:\s*"budget_exceeded"/.test(body) || /budget|exceeded.*spend|max_budget/i.test(body);
}

/** How the gateway refused a call — a 4xx the OS must surface, never paper over. */
export type GatewayRejectionCode = 'unauthorized' | 'forbidden' | 'budget_exceeded' | 'bad_request' | 'rate_limited';

/**
 * Thrown when LiteLLM answers an inference call with a 4xx: the key is wrong (401), the model is
 * outside the key's allowlist (403), the budget is spent (400 / 422 / 429 with budget wording), or the request is
 * malformed (400). A 4xx is a decision about THIS caller, so it is never a reason to fall back to
 * substitute data — the embedders throw it instead of indexing hash vectors (checklist A31).
 */
export class GatewayRejectedError extends Error {
  readonly code: GatewayRejectionCode;
  readonly status: number;
  readonly detail: string;
  constructor(status: number, body: string) {
    const code = classifyRejection(status, body);
    super(
      code === 'budget_exceeded'
        ? 'The LLM budget for this key is exhausted. Raise the cap in Admin → LLM Gateway.'
        : code === 'forbidden'
          ? 'The scoped LiteLLM key may not access this model (not in its allowlist). Add it to litellmAgentKey.models.'
          : code === 'unauthorized'
            ? 'LiteLLM rejected the scoped key (401). Check LITELLM_AGENT_KEY.'
            : `LiteLLM rejected the request (${status}).`,
    );
    this.name = 'GatewayRejectedError';
    this.code = code;
    this.status = status;
    this.detail = body.slice(0, 300);
  }
}

/** Map a LiteLLM 4xx onto the typed rejection codes. */
export function classifyRejection(status: number, body: string): GatewayRejectionCode {
  if (isBudgetRejection(status, body)) return 'budget_exceeded';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 429) return 'rate_limited';
  return 'bad_request';
}

/** True for any client-side rejection (4xx) — the class of answers that must never be retried with substitutes. */
export function isClientRejection(status: number): boolean {
  return status >= 400 && status < 500;
}
