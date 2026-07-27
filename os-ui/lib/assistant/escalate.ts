/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { roleModel, standardFirstEscalationEnabled } from '@/lib/models/roles';
import { assistantComplete, type AssistantMessage, type AssistantCaller } from './complete.ts';

/**
 * STANDARD-FIRST ESCALATION — the ONE cost-routing helper (Cost routing wave).
 *
 * For a surface whose output is STRICTLY VALIDATED before use, run the STANDARD
 * model first and escalate to the REASONING model ONLY when the standard answer
 * fails validation (or the standard call throws). One escalation, then the honest
 * outcome — the caller's own downstream validator still decides usability, so this
 * NEVER weakens a quality gate: the worst case is one wasted cheap call before the
 * same reasoning answer the surface used to make directly.
 *
 * WHY it's safe by construction: the `validate` predicate is the SAME check the
 * surface already applies to the model's output (real-schema candidate parsing, a
 * guard-validated fix expression, a JSON-shape guard). A standard answer that
 * passes it is, by definition, as usable as a reasoning one; a standard answer that
 * fails it is discarded and re-asked on reasoning — no bad output can slip through.
 *
 * ADMIN OVERRIDE: the single admin switch `standardFirstEscalation` (Platform Admin
 * settings, default ON) decides whether escalation is attempted at all. OFF pins the
 * surface to the reasoning tier directly — the pre-cost-routing behaviour — so an
 * admin who wants premium-always keeps it with one toggle. The role→alias pins still
 * decide WHICH concrete model each tier resolves to (an admin who re-points the
 * `standard` role re-points every standard-first call with it).
 *
 * ATTRIBUTION: the returned `model` is the model that ACTUALLY answered (standard on
 * a first-pass success, reasoning after an escalation), so Monitoring costs attribute
 * to the tier that really ran — every escalation is honestly traced through the same
 * audited `assistantComplete` gateway path (Langfuse-tagged, cost-cap enforced).
 *
 * NOT for: the agent PLAN phase or free-form open-ended surfaces that have no
 * validator to gate on — those stay on the reasoning tier directly (they never call
 * this helper). Pass a real `validate` or don't use it.
 */

export type EscalationResult = { content: string; model: string; escalated: boolean };

export type EscalationOpts = {
  /** Caller identity threaded to the audited, cost-capped gateway. */
  user?: { id: string; domains?: string[] } | string;
  /**
   * The quality gate. Given the model's raw text, return true iff it is USABLE by
   * the surface — the SAME validation the surface applies downstream. A false (or a
   * thrown predicate) triggers exactly one escalation to the reasoning tier.
   */
  validate: (content: string) => boolean;
  temperature?: number;
  /** Injected transport for tests (defaults to the live governed LiteLLM caller). */
  caller?: AssistantCaller;
  signal?: AbortSignal;
  /**
   * Explicit tier aliases (defaults: the admin-resolved `standard` / `reasoning`
   * role models). Tests pin these; production leaves them so admin role overrides
   * still decide the concrete alias each tier runs on.
   */
  standardModel?: string;
  reasoningModel?: string;
};

/** Did the predicate accept this text? A throwing predicate counts as a rejection. */
function accepts(validate: (c: string) => boolean, content: string): boolean {
  try {
    return validate(content);
  } catch {
    return false;
  }
}

/**
 * Run one completion STANDARD-FIRST, escalating to REASONING exactly once on a failed
 * (or thrown) standard attempt, and validate again. Returns the content, the model
 * that actually answered, and whether an escalation happened.
 *
 * Behaviour:
 *   • Escalation OFF (admin) OR standard===reasoning (same alias) → a single call on
 *     the reasoning tier, unchanged from the pre-cost-routing surface.
 *   • Escalation ON → standard call; if it passes `validate`, return it (escalated:
 *     false). If it fails validation OR throws, one reasoning call; return THAT result
 *     (escalated: true) whether or not it passes — the caller's downstream validator
 *     produces the honest failure, exactly as it did before, but now only after the
 *     cheap tier was given its chance.
 *   • Standard throws AND reasoning throws → the reasoning error propagates (the
 *     surface degrades exactly as a single reasoning call would have).
 *
 * The reasoning call is what the surface used to do directly, so an escalated result
 * is never worse than the old behaviour; a first-pass standard success is the win.
 */
export async function completeWithEscalation(
  messages: AssistantMessage[],
  opts: EscalationOpts,
): Promise<EscalationResult> {
  const reasoningModel = opts.reasoningModel ?? roleModel('reasoning');
  const standardModel = opts.standardModel ?? roleModel('standard');
  const base = {
    user: opts.user,
    temperature: opts.temperature,
    caller: opts.caller,
    signal: opts.signal,
  } as const;

  // Admin OFF, or the two tiers resolve to the SAME alias (nothing to save) → the
  // straight reasoning call, exactly as the surface behaved before cost routing.
  if (!standardFirstEscalationEnabled() || standardModel === reasoningModel) {
    const r = await assistantComplete(messages, { ...base, model: reasoningModel });
    return { content: r.content, model: r.model, escalated: false };
  }

  // STANDARD FIRST. A usable cheap answer wins outright.
  try {
    const first = await assistantComplete(messages, { ...base, model: standardModel });
    if (accepts(opts.validate, first.content)) {
      return { content: first.content, model: first.model, escalated: false };
    }
  } catch {
    /* standard tier unusable (unreachable/over-cap/etc) → fall through to escalate */
  }

  // ESCALATE ONCE to reasoning. Its result stands (validated or not) — the surface's
  // own downstream check turns an unusable reasoning answer into the honest failure,
  // just as it did when reasoning was called directly.
  const esc = await assistantComplete(messages, { ...base, model: reasoningModel });
  return { content: esc.content, model: esc.model, escalated: true };
}
