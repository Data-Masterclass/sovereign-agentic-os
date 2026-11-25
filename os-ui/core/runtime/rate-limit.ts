/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       runtime (shared by the agent engine and the OS chat)
 * FEATURE:    Wait out a model RATE LIMIT instead of failing the agent or the chat turn
 * USER STORY: As the owner of an agent system I want a run that hits the gateway's
 *             tokens-per-minute limit to WAIT until the limit resets and carry on — and to tell me
 *             it is waiting — instead of failing a node on a condition that clears by itself a few
 *             seconds later. And when the BUDGET is spent I want it to stop at once and say so,
 *             because no amount of waiting brings a budget back.
 *             As a chat user I want the same short wait (a few seconds, then a plain "the model is
 *             busy" sentence) instead of the gateway's raw error.
 * ARCHITECTURE:
 *   - Lives in core/runtime because both the agent engine (`tabs/agents/lib/engine/build-graph.ts`)
 *     and the kernel's chat loop (`core/runtime/agent-loop.ts`) use it; the kernel may not import a tab.
 *   - PURE and transport-free: it wraps any `LlmCall`. The clock, the sleep and the jitter are
 *     injectable, so the tests run in microseconds with a fake caller.
 *   - TWO KINDS OF 429. LiteLLM answers both a rate limit (requests/tokens per minute — resets on
 *     its own) and an exhausted budget (resets only when the budget period rolls over or an admin
 *     raises it) with 429. Only the first is retried. A budget rejection is recognised by the typed
 *     error the LiteLLM caller throws (`code: 'budget_exceeded'`) or, for any other caller, by the
 *     gateway's own wording.
 *   - HOW LONG. In order: the caller's `retryAfterSeconds` (the `Retry-After` header, when the
 *     caller exposes it), else the gateway's "Limit resets at: <UTC time>", else a fixed back-off.
 *     An OVERLOADED provider (503 "overloaded" / 529) is treated like a rate limit: it clears by
 *     itself, so it is waited out the same way.
 *     Plus a little jitter so runs that hit the limit together do not all come back in the same
 *     millisecond. The wait is CAPPED and the number of retries is BOUNDED — a run never hangs on a
 *     limit that does not clear. An interactive caller can also cap the TOTAL wait
 *     (`maxTotalWaitMs`): a wait the gateway says is longer than what is left is not attempted
 *     early — the caller gives up at once, so a Retry-After is never undercut.
 *   - The SAME request is sent again: nothing is re-planned and no tool is re-run, so a retry adds
 *     exactly one model call and no side effect. A call whose answer had already begun to stream
 *     (`onToken` fired) is never re-sent.
 */
import type { LlmCall } from '@core/runtime/agentic';

/** Retries after the first attempt (so at most `1 + DEFAULT_RATE_LIMIT_RETRIES` calls). */
export const DEFAULT_RATE_LIMIT_RETRIES = 3;
/** The longest ONE wait, in milliseconds. A per-minute limit resets within 60 s; the rest is slack. */
export const DEFAULT_RATE_LIMIT_MAX_WAIT_MS = 75_000;
/**
 * The chat's budget (Home chat and the Ask-the-OS drawer): a person is watching, so at most two
 * short retries and about 20 s of waiting in total, then a plain "the model is busy" sentence.
 */
export const CHAT_RATE_LIMIT_RETRY = {
  retries: 2,
  maxWaitMs: 15_000,
  maxTotalWaitMs: 20_000,
  backoffMs: [2_000, 6_000],
} as const satisfies Pick<RateLimitRetryOptions, 'retries' | 'maxWaitMs' | 'maxTotalWaitMs' | 'backoffMs'>;

/** Back-off used when the gateway says neither when the limit resets nor how long to wait. */
const FALLBACK_WAITS_MS = [5_000, 15_000, 30_000];
const MIN_WAIT_MS = 1_000;

export type GatewayLimitKind = 'rate-limit' | 'budget';

type ErrorLike = { message?: unknown; name?: unknown; code?: unknown; status?: unknown; detail?: unknown; retryAfterSeconds?: unknown };

function textOf(e: unknown): string {
  const x = (e ?? {}) as ErrorLike;
  return `${typeof x.message === 'string' ? x.message : String(e)} ${typeof x.detail === 'string' ? x.detail : ''}`;
}

const BUDGET_WORDING = /budget|exceeded.*spend|max_budget/i;
/** A provider that is temporarily over capacity — clears by itself like a rate limit. */
const OVERLOADED_WORDING = /overload|over capacity|temporarily unavailable/i;

function isOverloaded(x: ErrorLike, text: string): boolean {
  if (x.status === 529 || /\bLiteLLM 529\b/.test(text)) return true;
  const is503 = x.status === 503 || /\bLiteLLM 503\b/.test(text);
  return is503 && OVERLOADED_WORDING.test(text);
}

/**
 * What kind of gateway limit an error is, or null when it is not one. A budget rejection wins
 * over a rate limit: LiteLLM uses 429 for both, and retrying a spent budget only wastes a minute.
 */
export function classifyGatewayLimit(e: unknown): GatewayLimitKind | null {
  const x = (e ?? {}) as ErrorLike;
  const text = textOf(e);
  if (x.code === 'budget_exceeded' || x.name === 'BudgetExceededError') return 'budget';
  const is429 = x.status === 429 || x.code === 'rate_limited' || /\bLiteLLM 429\b/.test(text) || /rate ?limit/i.test(text);
  if (!is429) return isOverloaded(x, text) ? 'rate-limit' : null;
  return BUDGET_WORDING.test(text) ? 'budget' : 'rate-limit';
}

/** The moment the gateway says the limit resets ("Limit resets at: 2026-11-19 17:20:00 UTC"), as epoch ms. */
export function parseLimitReset(text: string): number | null {
  const m = /Limit resets at:\s*(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d+)?\s*(?:UTC|Z|\+00:00)?/i.exec(text);
  if (!m) return null;
  const at = Date.parse(`${m[1]}T${m[2]}Z`);
  return Number.isFinite(at) ? at : null;
}

/** "tokens per minute (limit 200000)" — the part of the gateway's message a person can act on. */
export function describeLimit(text: string): string {
  const type = /Limit type:\s*([a-z_]+)/i.exec(text)?.[1]?.toLowerCase();
  const limit = /Current limit:\s*(\d+)/i.exec(text)?.[1];
  const what = type === 'tokens' ? 'tokens per minute' : type === 'requests' ? 'requests per minute' : type ? `${type} limit` : '';
  if (what && limit) return `${what} (limit ${Number(limit).toLocaleString('en-US')})`;
  return what;
}

export type WaitPlan = {
  waitMs: number;
  source: 'retry-after' | 'limit-reset' | 'backoff';
  capped: boolean;
  /** The wait the gateway asked for (jitter included) before the per-wait cap. */
  wantedMs: number;
};

/**
 * How long to wait before attempt `attempt` (1-based retry number). Never below one second,
 * never above `maxWaitMs` — jitter included.
 */
export function planWait(
  e: unknown,
  attempt: number,
  opts: { now: number; maxWaitMs?: number; jitterMs?: number; backoffMs?: readonly number[] },
): WaitPlan {
  const max = Math.max(MIN_WAIT_MS, opts.maxWaitMs ?? DEFAULT_RATE_LIMIT_MAX_WAIT_MS);
  const jitter = Math.max(0, opts.jitterMs ?? 0);
  const x = (e ?? {}) as ErrorLike;
  let base: number;
  let source: WaitPlan['source'];
  const retryAfter = typeof x.retryAfterSeconds === 'number' && Number.isFinite(x.retryAfterSeconds) && x.retryAfterSeconds > 0 ? x.retryAfterSeconds : null;
  const resetAt = parseLimitReset(textOf(e));
  if (retryAfter !== null) {
    base = retryAfter * 1000;
    source = 'retry-after';
  } else if (resetAt !== null && resetAt > opts.now) {
    base = resetAt - opts.now;
    source = 'limit-reset';
  } else {
    const steps = opts.backoffMs && opts.backoffMs.length > 0 ? opts.backoffMs : FALLBACK_WAITS_MS;
    base = steps[Math.min(attempt, steps.length) - 1] ?? steps[steps.length - 1];
    source = 'backoff';
  }
  const wanted = Math.max(MIN_WAIT_MS, Math.ceil(base + jitter));
  return { waitMs: Math.min(wanted, max), source, capped: wanted > max, wantedMs: wanted };
}

/** What a node shows while it waits. */
export type RateLimitWait = {
  /** 1-based retry number. */
  attempt: number;
  maxAttempts: number;
  waitMs: number;
  /** A plain sentence for the run's activity line. */
  message: string;
};

export function waitMessage(waitMs: number, attempt: number, maxAttempts: number, limit: string): string {
  const seconds = Math.max(1, Math.round(waitMs / 1000));
  return `Waiting ${seconds} s for the model rate limit to reset${limit ? ` — ${limit}` : ''} (retry ${attempt} of ${maxAttempts})`;
}

/** Thrown when the rate limit did not clear within the bounded retries. `cause` is the gateway's last answer. */
export class RateLimitNotClearedError extends Error {
  readonly code = 'rate_limited';
  readonly status = 429;
  readonly waitedMs: number;
  readonly retries: number;
  constructor(retries: number, waitedMs: number, limit: string, cause: unknown) {
    super(
      `The model rate limit did not clear after ${retries} wait${retries === 1 ? '' : 's'} (${Math.round(waitedMs / 1000)} s in total)` +
        `${limit ? ` — ${limit}` : ''}. Nothing was lost: run it again in a minute, or ask an admin to raise the rate limit of the key this system runs on.`,
    );
    this.name = 'RateLimitNotClearedError';
    this.retries = retries;
    this.waitedMs = waitedMs;
    (this as { cause?: unknown }).cause = cause;
  }
}

/** Thrown for a spent budget when the caller did not already throw its own typed, plain error. */
export class ModelBudgetSpentError extends Error {
  readonly code = 'budget_exceeded';
  readonly status = 402;
  constructor(cause: unknown) {
    super(
      'The model budget of the key this system runs on is used up, so the run stopped. Waiting does not help: ' +
        'the budget comes back when its period resets, or when an admin raises it (Admin → LLM Gateway; for a system\'s own key, raise the cap and press Rebuild).',
    );
    this.name = 'ModelBudgetSpentError';
    (this as { cause?: unknown }).cause = cause;
  }
}

export type RateLimitRetryOptions = {
  /** Retries after the first attempt. Default {@link DEFAULT_RATE_LIMIT_RETRIES}. */
  retries?: number;
  /** Cap on ONE wait. Default {@link DEFAULT_RATE_LIMIT_MAX_WAIT_MS}. */
  maxWaitMs?: number;
  /**
   * Cap on ALL waits together (an interactive caller). When the next wait the gateway asks for
   * would take the total past it, the retry gives up AT ONCE with {@link RateLimitNotClearedError}
   * rather than re-sending before the gateway said it may. Default: no total cap.
   */
  maxTotalWaitMs?: number;
  /** Back-off steps when the gateway says neither Retry-After nor a reset time. Default 5 s, 15 s, 30 s. */
  backoffMs?: readonly number[];
  /** Told BEFORE each wait — the node turns it into a run event. */
  onWait?: (wait: RateLimitWait) => void;
  /** Aborting ends the wait and rethrows the gateway's error. */
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Extra milliseconds added to a wait. Default: random 250–1500. */
  jitter?: () => number;
};

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * Wrap a model caller so a RATE-LIMIT 429 waits for the reset and re-sends the same request.
 * A budget rejection, and every other error, is thrown straight through (a budget one as a plain
 * sentence). Bounded: at most `retries` waits, each at most `maxWaitMs`.
 */
export function withRateLimitRetry(inner: LlmCall, opts: RateLimitRetryOptions = {}): LlmCall {
  const retries = Math.max(0, opts.retries ?? DEFAULT_RATE_LIMIT_RETRIES);
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? defaultSleep;
  const jitter = opts.jitter ?? (() => 250 + Math.floor(Math.random() * 1250));
  return async (req) => {
    let waited = 0;
    for (let attempt = 0; ; attempt += 1) {
      // An answer that had begun to stream is never sent again: the user has already seen part of it.
      let streamed = false;
      const sent = req.onToken ? { ...req, onToken: (t: string) => { streamed = true; req.onToken?.(t); } } : req;
      try {
        return await inner(sent);
      } catch (e) {
        if (streamed) throw e;
        const kind = classifyGatewayLimit(e);
        if (kind === 'budget') {
          // The caller's own typed budget error already reads plainly; anything else gets one.
          if ((e as ErrorLike)?.code === 'budget_exceeded') throw e;
          throw new ModelBudgetSpentError(e);
        }
        if (kind !== 'rate-limit') throw e;
        const limit = describeLimit(textOf(e));
        if (attempt >= retries) {
          if (retries === 0) throw e;
          throw new RateLimitNotClearedError(retries, waited, limit, e);
        }
        if (opts.signal?.aborted) throw e;
        const plan = planWait(e, attempt + 1, { now: now(), maxWaitMs: opts.maxWaitMs, jitterMs: jitter(), backoffMs: opts.backoffMs });
        if (opts.maxTotalWaitMs !== undefined && waited + plan.wantedMs > opts.maxTotalWaitMs) {
          throw new RateLimitNotClearedError(attempt, waited, limit, e);
        }
        opts.onWait?.({ attempt: attempt + 1, maxAttempts: retries, waitMs: plan.waitMs, message: waitMessage(plan.waitMs, attempt + 1, retries, limit) });
        await sleep(plan.waitMs, opts.signal);
        waited += plan.waitMs;
        if (opts.signal?.aborted) throw e;
      }
    }
  };
}
