/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The credential and attribution a model call carries. One helper,
 *             so every caller wires the same header the same way — and so the
 *             LiteLLM master key can never reach the run path.
 *
 * USER STORY: As a platform admin I set a USD cap and a model allowlist on the
 *             agents' key and they actually bind, because runs use that key and
 *             not an unlimited master credential.
 *             As a finance owner I can ask LiteLLM what one person, one domain
 *             or one agent spent, because every call is tagged and carries an
 *             end-user id.
 *             As a security reviewer I can see in one file which credential the
 *             run path uses, and that there is no code path from a run to the
 *             master key.
 *
 * ARCHITECTURE:
 *   Mirrors `core/infra/service-bearer.ts`: one shared helper rather than a
 *   header assembled per call site. Two call sites use it — the agent runtime
 *   (`core/runtime/runtime.ts`) and the assistant path
 *   (`core/runtime/complete.ts`).
 *
 *   The master key stays for ADMIN reads and writes (`litellm-admin.ts`,
 *   `litellm-write.ts`) because those operate on the gateway itself. It is
 *   never a run credential, and that separation is what the `MODEL-KEY` gate
 *   test pins down.
 *
 *   FAIL CLOSED: with no scoped key configured this returns `apiKey: ''` and
 *   the caller must refuse to run. Falling back to the master key would make a
 *   misconfiguration silently unlimited, which is the failure mode the cap
 *   exists to prevent.
 *
 *   Attribution rides along as LiteLLM's own `user` field plus request tags.
 *   The tag vocabulary (`domain:`, `agent:`, `tab:`) is the one the gateway
 *   mirror reads back in `tabs/admin/lib/gateway-mirror.ts`; the two must stay
 *   in step, which is why the prefixes live in one exported constant.
 */
import 'server-only';
import { config } from '@core/kernel/config';

/** Who and what a model call is for. `domain` is required: spend is per domain. */
export type CallerContext = {
  userId: string;
  domain: string;
  /** The agent system making the call, when a run is in flight. */
  systemId?: string;
  /** The tab the call originated from, for per-surface cost. */
  tab?: string;
};

export type CallerCredential = {
  /** Bearer value. EMPTY means "no scoped credential" — the caller must refuse. */
  apiKey: string;
  /** LiteLLM `user` — becomes `end_user` in its spend ledger. */
  user: string;
  /** LiteLLM request tags, the vocabulary the gateway mirror reads back. */
  tags: string[];
};

/** The tag prefixes the mirror buckets by. Keep in step with gateway-mirror. */
export const TAG_DOMAIN = 'domain:';
export const TAG_AGENT = 'agent:';
export const TAG_TAB = 'tab:';

/** LiteLLM end-user ids are namespaced so OS ids never collide with others'. */
export function endUserId(userId: string): string {
  return `os-${userId}`;
}

/**
 * The credential and attribution for one model call.
 *
 * Deliberately NOT a fallback chain ending in the master key: either a scoped
 * key is configured or the caller refuses. A silently unlimited run is worse
 * than a run that fails loudly on a misconfiguration.
 */
export function callerCredential(ctx: CallerContext): CallerCredential {
  const tags = [`${TAG_DOMAIN}${ctx.domain}`];
  if (ctx.systemId) tags.push(`${TAG_AGENT}${ctx.systemId}`);
  if (ctx.tab) tags.push(`${TAG_TAB}${ctx.tab}`);
  return { apiKey: config.litellmAgentKey, user: endUserId(ctx.userId), tags };
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
