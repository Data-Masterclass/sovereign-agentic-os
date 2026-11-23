/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       core / runtime
 * FEATURE:    A reasoning model that spent its whole output budget thinking is not an "empty reply".
 * USER STORY: As a user of a reasoning model (thinking always on) I get my answer, or the exact
 *             reason there is none, instead of "the model returned nothing".
 * ARCHITECTURE:
 *   - A reasoning model writes its thinking as `reasoning_content` and counts it against `max_tokens`
 *     (OpenAI chat-completions; LiteLLM passes `reasoning_content` through,
 *     https://docs.litellm.ai/docs/reasoning_content). With a tight `max_tokens` the reply is
 *     `finish_reason: "length"`, `content: ""`, all tokens in the reasoning.
 *   - `withReasoningRetry` wraps an `LlmCall`: on exactly that shape it asks ONCE more with `reasoning_effort: low`
 *     (a runaway model needs to think less; a bigger cap alone does not cure it) and, only when the cap was
 *     tight (below the normal output reserve), a larger `max_tokens` (four times, never above the reserve or the
 *     model's max output); if the retry is exhausted too, or nothing is left to change, it throws
 *     {@link ReasoningBudgetExhaustedError} naming the reasoning tokens, the role and the model.
 *   - It is applied in the ONE model caller (`liteLlmCaller`) and in the assistant caller
 *     (`complete.ts`), so the chat loop, `runtime.ts`, `escalate.ts` and the agent graph all get it.
 *   - Not touched: a length stop WITH content (kept, marked cut off by the engine), a tool call cut off
 *     (the engine's own retry), and an empty reply from a model that did not reason (the engine's nudge).
 */
import type { LlmCall, LlmCompletion, LlmRequest, ReasoningEffort } from '@core/runtime/agentic';
import { modelContext, outputCeiling } from '@core/models/context-windows';
import { catalogLimit } from '@core/models/model-limits';

/** The retry asks for this many times the budget that was exhausted. */
export const REASONING_RETRY_FACTOR = 4;

/** `finish_reason: length`, nothing said, nothing called, and reasoning present. */
export function isReasoningExhausted(c: Pick<LlmCompletion, 'content' | 'toolCalls' | 'finishReason' | 'reasoning'>): boolean {
  return c.finishReason === 'length' && !c.content.trim() && c.toolCalls.length === 0 && c.reasoning !== undefined;
}

export class ReasoningBudgetExhaustedError extends Error {
  readonly code = 'reasoning_budget_exhausted';
  readonly reasoningTokens: number;
  readonly role: string;
  readonly model: string;
  readonly maxTokens?: number;
  constructor(reasoningTokens: number, role: string, model: string, maxTokens?: number) {
    super(`the model spent its whole output budget on reasoning (${reasoningTokens} tokens); raise the output limit for ${role}/${model}`);
    this.name = 'ReasoningBudgetExhaustedError';
    this.reasoningTokens = reasoningTokens;
    this.role = role;
    this.model = model;
    this.maxTokens = maxTokens;
  }
}

/** The reasoning tokens the reply reports; else what the output usage says; else a ~4 chars/token estimate of the text. */
export function reasoningTokensOf(c: LlmCompletion): number {
  return c.usage?.reasoning ?? c.usage?.output ?? Math.ceil((c.reasoning?.chars ?? 0) / 4);
}

export function withReasoningRetry(call: LlmCall): LlmCall {
  return async (req: LlmRequest) => {
    const first = await call(req);
    if (!isReasoningExhausted(first)) return first;
    const ctx = modelContext(req.model);
    const ceiling = outputCeiling(req.model);
    const target = catalogLimit(req.model)?.target ?? req.model;
    const spent = reasoningTokensOf(first);
    const used = req.maxTokens && req.maxTokens > 0 ? req.maxTokens : undefined;
    // A RUNAWAY (the model used its normal budget and was still thinking) is cured by thinking LESS, not by
    // a bigger cap: one retry at `low` effort, same cap. A TIGHT cap (below the normal output reserve) is
    // first raised toward that reserve (four times, never past it), together with the lower effort.
    const effort: ReasoningEffort | undefined = req.reasoningEffort === 'low' ? undefined : 'low';
    const tight = used === undefined || used < ctx.reservedOutput;
    const next = used === undefined ? ceiling : tight ? Math.min(ceiling, ctx.reservedOutput, used * REASONING_RETRY_FACTOR) : used;
    // Nothing left to change (already `low`, already at the biggest cap): the precise failure at once.
    if (effort === undefined && next <= (used ?? 0)) throw new ReasoningBudgetExhaustedError(spent, req.model, target, used);
    const second = await call({ ...req, maxTokens: next, ...(effort ? { reasoningEffort: effort } : {}) });
    if (isReasoningExhausted(second)) throw new ReasoningBudgetExhaustedError(reasoningTokensOf(second), req.model, target, next);
    return { ...second, retry: { reason: 'reasoning_exhausted', maxTokens: next, ...(effort ? { reasoningEffort: effort } : {}), firstReasoningTokens: spent } };
  };
}

/**
 * `reasoning_effort` per KIND of step, so bounded work does not reason as long as the plan or the report:
 * ACT steps (bounded tool work) low, the PLAN and the FINAL report medium (or high). Env, rendered by the
 * chart from `osUI.reasoningEffort` ({act, plan, final}):
 *   MODEL_REASONING_EFFORT_ACT, MODEL_REASONING_EFFORT_PLAN, MODEL_REASONING_EFFORT_FINAL.
 * Each is OFF unless set: LiteLLM 1.109 forwards the parameter unchanged to an OpenAI-compatible provider
 * (proved in `reasoning-budget.e2e.test.ts`), but whether the MODEL honours it is the provider's decision,
 * and a provider that rejects it would reject every call. Values: low, medium, high; anything else is
 * ignored with a warning.
 */
export type ReasoningEfforts = { act?: ReasoningEffort; plan?: ReasoningEffort; final?: ReasoningEffort };
const warnedEfforts = new Set<string>();
function parseEffort(name: string, raw: string | undefined): ReasoningEffort | undefined {
  const v = (raw ?? '').trim().toLowerCase();
  if (!v) return undefined;
  if (v === 'low' || v === 'medium' || v === 'high') return v;
  if (!warnedEfforts.has(`${name}=${v}`)) {
    warnedEfforts.add(`${name}=${v}`);
    console.warn(`[models] ${name}=${JSON.stringify(raw)} is not "low", "medium" or "high"; reasoning_effort is not sent for that step kind.`);
  }
  return undefined;
}
export function configuredReasoningEfforts(env: Record<string, string | undefined> = process.env): ReasoningEfforts {
  const act = parseEffort('MODEL_REASONING_EFFORT_ACT', env.MODEL_REASONING_EFFORT_ACT);
  const plan = parseEffort('MODEL_REASONING_EFFORT_PLAN', env.MODEL_REASONING_EFFORT_PLAN);
  const final = parseEffort('MODEL_REASONING_EFFORT_FINAL', env.MODEL_REASONING_EFFORT_FINAL);
  return { ...(act ? { act } : {}), ...(plan ? { plan } : {}), ...(final ? { final } : {}) };
}

/**
 * The efforts for the WORKER role in an agent run: `MODEL_REASONING_EFFORT_WORKER_ACT` / `_PLAN` / `_FINAL` (chart
 * `osUI.reasoningEffortWorker`), each falling back to the role-free value above. The worker is a reasoning model
 * that honours `reasoning_effort`; the strong role keeps the role-free values.
 */
export function configuredWorkerReasoningEfforts(env: Record<string, string | undefined> = process.env): ReasoningEfforts {
  const base = configuredReasoningEfforts(env);
  const act = parseEffort('MODEL_REASONING_EFFORT_WORKER_ACT', env.MODEL_REASONING_EFFORT_WORKER_ACT) ?? base.act;
  const plan = parseEffort('MODEL_REASONING_EFFORT_WORKER_PLAN', env.MODEL_REASONING_EFFORT_WORKER_PLAN) ?? base.plan;
  const final = parseEffort('MODEL_REASONING_EFFORT_WORKER_FINAL', env.MODEL_REASONING_EFFORT_WORKER_FINAL) ?? base.final;
  return { ...(act ? { act } : {}), ...(plan ? { plan } : {}), ...(final ? { final } : {}) };
}

/**
 * The sampling temperature an agent run uses for a role: `MODEL_TEMPERATURE_WORKER` / `MODEL_TEMPERATURE_STRONG`
 * (chart `osUI.modelTemperature`), else 0.2 — the value every agent call used before. OpenAI's guidance for its
 * open-weight reasoning models (the worker's default family) is temperature 1.0; the chart sets that for the worker.
 */
export function configuredRoleTemperature(role: 'worker' | 'strong', env: Record<string, string | undefined> = process.env): number {
  const raw = ((role === 'worker' ? env.MODEL_TEMPERATURE_WORKER : env.MODEL_TEMPERATURE_STRONG) ?? '').trim();
  if (!raw) return 0.2;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0 && n <= 2) return n;
  console.warn(`[models] MODEL_TEMPERATURE_${role.toUpperCase()}=${JSON.stringify(raw)} is not a number from 0 to 2; using 0.2.`);
  return 0.2;
}
