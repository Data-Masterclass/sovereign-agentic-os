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
 *   PER-PRINCIPAL KEY (A3): when a system's Build minted its own virtual key,
 *   the caller passes its secret REFERENCE (`keyRef`, never the value) and the
 *   key is read from the secrets store at call time; otherwise the shared agent
 *   key. There is no third branch.
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
import { getSecretServerSide, type SecretRef } from '@core/infra/secrets';

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
  /** A per-agent virtual key minted by Build, by secret REFERENCE. Absent → the shared agent key. */
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
 * Deliberately NOT a fallback chain ending in the master key: a per-agent key
 * by reference, else the shared agent key, else the caller refuses. A silently
 * unlimited run is worse than a run that fails loudly on a misconfiguration.
 */
export function callerCredential(ctx: CallerContext): CallerCredential {
  const tags = [`${TAG_DOMAIN}${ctx.domain}`];
  if (ctx.systemId) tags.push(`${TAG_AGENT}${ctx.systemId}`);
  if (ctx.tab) tags.push(`${TAG_TAB}${ctx.tab}`);
  if (ctx.runId) tags.push(`${TAG_RUN}${ctx.runId}`);
  if (ctx.env) tags.push(`${TAG_ENV}${ctx.env}`);
  const own = ctx.keyRef ? getSecretServerSide(ctx.keyRef) : null;
  if (own && own.length > 0) return { apiKey: own, keySource: 'agent-key', user: endUserId(ctx.userId), tags };
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

/** Thrown when LiteLLM rejects a call because a budget is exhausted. */
export class BudgetExceededError extends Error {
  readonly code = 'budget_exceeded';
  readonly status = 402;
  /** LiteLLM's own message, kept for the audit trail. */
  readonly detail: string;
  // NOT a TS parameter property (`constructor(readonly detail: string)`): Node's
  // strip-only type removal rejects those, and the test runner loads .ts directly.
  constructor(detail: string) {
    super('The LLM budget for this key or team is exhausted. Raise the cap in Admin → LLM Gateway.');
    this.name = 'BudgetExceededError';
    this.detail = detail;
  }
}

/**
 * Is this LiteLLM rejection a budget problem? LiteLLM answers 400 with a
 * message rather than a typed code, so the UI would otherwise show a raw 400.
 */
export function isBudgetRejection(status: number, body: string): boolean {
  return (status === 400 || status === 429) && /budget|exceeded.*spend|max_budget/i.test(body);
}

/** How the gateway refused a call — a 4xx the OS must surface, never paper over. */
export type GatewayRejectionCode = 'unauthorized' | 'forbidden' | 'budget_exceeded' | 'bad_request' | 'rate_limited';

/**
 * Thrown when LiteLLM answers an inference call with a 4xx: the key is wrong (401), the model is
 * outside the key's allowlist (403), the budget is spent (400 budget / 429), or the request is
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
