/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { config } from '@/lib/core/config';
import { getAssistantModel } from '@/lib/platform-admin/models';
import { checkCap } from '@/lib/governance/cost';

/**
 * THE ONE ASSISTANT LLM.
 *
 * A single server helper that every built-in artifact-building assistant calls —
 * Agents build chat, Software build chat, the Big Bets planner, the Knowledge
 * assistant and the Metric agent. It resolves the model an admin chose in
 * Platform Admin → Models & Providers (typically the STACKIT managed LLM) and
 * runs the completion through the GOVERNED LiteLLM gateway (Bearer master key,
 * Langfuse-audited), tagging the caller identity so every assistant turn is
 * attributable.
 *
 * When no assistant model is configured it throws {@link AssistantNotConfiguredError}
 * — an HONEST, admin-actionable error. There is NO silent fake-AI fallback.
 *
 * The transport (`caller`) is injectable so the loop is unit-testable offline
 * without a gateway.
 */

export class AssistantNotConfiguredError extends Error {
  status = 503;
  constructor(
    message = 'The assistant LLM is not configured. A platform admin must register a model (e.g. the STACKIT managed LLM) in Platform Admin → Models & Providers and set it as the assistant.',
  ) {
    super(message);
    this.name = 'AssistantNotConfiguredError';
  }
}

/**
 * Thrown when a governance cost cap (Governance → Cost & limits) would be breached
 * by this completion — the model is NOT called. 402 Payment Required is the honest
 * status: the request is well-formed but the spend ceiling is reached.
 */
export class CostCapExceededError extends Error {
  status = 402;
  constructor(reason: string) {
    super(`Cost cap reached: ${reason}. Raise the cap in Governance → Cost & limits or wait for the period to reset.`);
    this.name = 'CostCapExceededError';
  }
}

/** Resolve the id of the ONE assistant model, or throw the honest error. */
export function resolveAssistantModelId(): string {
  const m = getAssistantModel();
  if (!m) throw new AssistantNotConfiguredError();
  return m.id;
}

export type AssistantMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export type AssistantRequest = {
  model: string;
  messages: AssistantMessage[];
  temperature?: number;
  /** Caller identity, threaded to the gateway for audit attribution. */
  user?: string;
  signal?: AbortSignal;
};

/** A transport that turns one request into the model's text. Injected in tests. */
export type AssistantCaller = (req: AssistantRequest) => Promise<string>;

const LLM_TIMEOUT_MS = Number(process.env.LLM_CHAT_TIMEOUT_MS ?? '') || 90_000;

/** The live caller: POST the governed LiteLLM gateway /v1/chat/completions. */
export function liteLlmAssistantCaller(): AssistantCaller {
  return async (req) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), LLM_TIMEOUT_MS);
    // Chain an external abort signal (caller timeout) into ours.
    if (req.signal) req.signal.addEventListener('abort', () => ctrl.abort(), { once: true });
    let res: Response;
    let text: string;
    try {
      res = await fetch(`${config.litellmUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.litellmMasterKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          model: req.model,
          messages: req.messages,
          temperature: req.temperature ?? 0.2,
          // Caller identity + Langfuse audit tags (the gateway is the governance point).
          ...(req.user ? { user: req.user } : {}),
          metadata: { tags: ['assistant', ...(req.user ? [`user:${req.user}`] : [])] },
        }),
        cache: 'no-store',
        signal: ctrl.signal,
      });
      text = await res.text();
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new Error(`LiteLLM ${res.status}: ${text.slice(0, 300)}`);
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error(`LiteLLM returned non-JSON: ${text.slice(0, 200)}`);
    }
    const choices = (data.choices ?? []) as Array<Record<string, unknown>>;
    const message = (choices[0]?.message ?? {}) as Record<string, unknown>;
    return String(message.content ?? '').trim();
  };
}

/**
 * Run a single completion on the ONE assistant model through the governed gateway.
 * Throws {@link AssistantNotConfiguredError} when no assistant model is configured.
 */
// Tiny probe amount for the pre-call cap check. Self-hosted models cost $0/token,
// so a cap primarily BLOCKS once live LiteLLM spend has been reconciled toward the
// ceiling (Governance cost.reconcileSpendFromLiteLLM). A cap already AT its limit
// blocks the next call; a cap with headroom lets it through.
const CAP_PROBE = 0.01;

/**
 * Enforce governance cost caps for this caller BEFORE the model runs. Checks the
 * most-specific applicable cap (caller's domain, then tenant). Over cap → throws
 * {@link CostCapExceededError} and the transport is never called. No cap → allowed.
 * This is the live enforcement seam for the Governance → Cost & limits caps.
 */
function enforceCostCaps(domains: string[] | undefined): void {
  for (const subject of domains ?? []) {
    const check = checkCap({ scope: 'domain', subject, amount: CAP_PROBE });
    if (!check.allowed) throw new CostCapExceededError(check.reason);
  }
  const tenant = checkCap({ scope: 'tenant', subject: 'tenant', amount: CAP_PROBE });
  if (!tenant.allowed) throw new CostCapExceededError(tenant.reason);
}

export async function assistantComplete(
  messages: AssistantMessage[],
  opts: {
    user?: { id: string; domains?: string[] } | string;
    temperature?: number;
    caller?: AssistantCaller;
    signal?: AbortSignal;
  } = {},
): Promise<{ content: string; model: string }> {
  const model = resolveAssistantModelId();
  const caller = opts.caller ?? liteLlmAssistantCaller();
  const user = typeof opts.user === 'string' ? opts.user : opts.user?.id;
  const domains = typeof opts.user === 'string' ? undefined : opts.user?.domains;
  // Live cost-cap enforcement: an over-cap caller is blocked before spend.
  enforceCostCaps(domains);
  const content = await caller({ model, messages, temperature: opts.temperature, user, signal: opts.signal });
  return { content, model };
}
