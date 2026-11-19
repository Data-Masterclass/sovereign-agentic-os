/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The confirmation gate's plumbing — every executor handed to the agentic harness has
 *             passed through a NAMED gate.
 * USER STORY: As the owner I want a write the assistant initiates to wait for my confirmation, and
 *             I want that enforced by code rather than by a sentence in a prompt — so the harness
 *             must not be able to receive an executor whose author never chose a gate.
 * ARCHITECTURE:
 *   - GROUNDWORK. Today every production caller chooses `ungatedInteractive`, which passes every
 *     call straight through: behaviour is unchanged, and nothing parks. Later PRs replace those
 *     call sites one by one; `confirm-gate.test.ts` pins the exact list so it can only shrink.
 *   - Pure: no `server-only`, no store, no transport. The confirmation store is reached through an
 *     injected {@link ConfirmationPort}, so this module and its tests need no backend.
 *   - `runAgentic` takes a {@link GatedToolExecutor}. The brand is a compile-time property (a
 *     plain `ToolExecutor` does not type-check); the constructors also stamp the kind on the
 *     function so a trace or a test can read which gate an executor came out of.
 *   - The EXTERNAL MCP door is not behind this and must never be: a signed-in person's own MCP
 *     client reaches `handleRpc` directly. `core/mcp/server.ts` and `http.ts` import neither this
 *     module nor the store (pinned by test).
 */
import type { ToolExecutor, ToolOutcome, PendingToolCall } from '@core/runtime/agentic';
import { needsUserConfirm } from '@core/mcp/tool-classes';

export type GateKind = 'user-confirm' | 'engine-held' | 'read-only' | 'ungated-interactive';

/** Type-level brand. Declared, never exported and never assigned: only a constructor here can mint it. */
declare const GATED: unique symbol;

/**
 * A tool executor that came out of one of the gate constructors below. This — not `ToolExecutor`
 * — is what `runAgentic` accepts.
 */
export type GatedToolExecutor = ((name: string, args: Record<string, unknown>) => Promise<ToolOutcome>) & {
  readonly [GATED]: GateKind;
};

const GATE_KIND = Symbol.for('soa.confirm-gate.kind');

function brand(fn: (name: string, args: Record<string, unknown>) => Promise<ToolOutcome>, kind: GateKind): GatedToolExecutor {
  Object.defineProperty(fn, GATE_KIND, { value: kind, enumerable: false, writable: false });
  return fn as GatedToolExecutor;
}

/** Which gate an executor came out of, or null for a function no constructor here produced. */
export function gateKindOf(fn: unknown): GateKind | null {
  if (typeof fn !== 'function') return null;
  const kind = (fn as unknown as Record<symbol, unknown>)[GATE_KIND];
  return kind === 'user-confirm' || kind === 'engine-held' || kind === 'read-only' || kind === 'ungated-interactive' ? kind : null;
}

/** Where the conversation is happening. A confirmation is bound to it and is not valid elsewhere. */
export type ConfirmSurface = 'ask' | `tab:${string}` | `app-chat:${string}` | 'team';

export type ConfirmContext = {
  /** The present, signed-in user — the only person who can confirm what this gate parks. */
  userId: string;
  conversationId: string;
  surface: ConfirmSurface;
  /** The turn's trace id, carried onto the confirmation for the audit trail. */
  traceId?: string;
  /**
   * Tools this SURFACE does not offer at all, whatever the user would confirm: name → the reason,
   * or null when the tool is open here. Asked first, so a closed tool is refused rather than
   * parked — offering a confirmation for something the surface will never run would be a lie.
   */
  closed?: (tool: string) => string | null;
};

/** What the gate needs from the confirmation store. Injected — the gate never imports the store. */
export type ConfirmationPort = {
  /** Record a pending confirmation for this exact call and return its handle. */
  create(request: {
    userId: string;
    conversationId: string;
    surface: ConfirmSurface;
    tool: string;
    args: Record<string, unknown>;
    traceId?: string;
  }): PendingToolCall | Promise<PendingToolCall>;
  /**
   * Has the user allowed this tool for THIS conversation ("Allow for this conversation")? Optional:
   * a port without it never allows. The store only ever answers true for a tool in its
   * `SESSION_ALLOWABLE_TOOLS` set.
   */
  sessionAllows?(request: { userId: string; conversationId: string; tool: string }): boolean | Promise<boolean>;
};

/** A refusal in the same `{ error: { code, reason } }` shape the agent executor's refusals use. */
function refusal(code: string, reason: string): ToolOutcome {
  return { text: JSON.stringify({ error: { code, reason } }), isError: true };
}

/** The tool-result text of a parked call. States what did NOT happen, in the model's own channel. */
export function parkedText(tool: string): string {
  return (
    `NOT EXECUTED: '${tool}' awaits the user's confirmation. Nothing was changed. ` +
    'Do not say or imply that it was done.'
  );
}

/**
 * THE USER-CONFIRM GATE. Per call:
 *   1. a tool the surface has closed          → typed refusal (`surface_closed`), `inner` not called;
 *   2. a confirm-free tool (`needsUserConfirm` false) → `inner`;
 *   3. a tool the user allowed for this conversation  → `inner`;
 *   4. anything else                          → `inner` is NOT called; a pending confirmation is
 *      created through `port` and a PARKED outcome returned.
 * Fail-closed at every step: an unknown tool needs confirmation (2); a port that cannot answer
 * "allowed?" is treated as "no" (3); a port that cannot record the confirmation yields a refusal,
 * never an execution (4).
 */
export function userConfirmGate(inner: ToolExecutor, ctx: ConfirmContext, port: ConfirmationPort): GatedToolExecutor {
  return brand(async (name, args) => {
    const closedReason = ctx.closed?.(name) ?? null;
    if (closedReason) return refusal('surface_closed', closedReason);

    if (!needsUserConfirm(name)) return inner(name, args);

    let allowed = false;
    try {
      allowed = (await port.sessionAllows?.({ userId: ctx.userId, conversationId: ctx.conversationId, tool: name })) === true;
    } catch {
      allowed = false;
    }
    if (allowed) return inner(name, args);

    let pending: PendingToolCall;
    try {
      pending = await port.create({
        userId: ctx.userId,
        conversationId: ctx.conversationId,
        surface: ctx.surface,
        tool: name,
        args,
        ...(ctx.traceId ? { traceId: ctx.traceId } : {}),
      });
    } catch (e) {
      return refusal(
        'confirmation_unavailable',
        `'${name}' needs the user's confirmation and the confirmation could not be recorded (${(e as Error).message}). It was NOT executed.`,
      );
    }
    return { text: parkedText(name), isError: false, parked: pending };
  }, 'user-confirm');
}

/**
 * MARKER for the agent-system ENGINE path, whose executor (`grantedToolExecutor`) already refuses
 * and holds on its own (`hold.ts`, `AGENT_FORBIDDEN_TOOLS`): a second person decides there, on an
 * approval card, and the run parks on a graph interrupt. Passes every call through unchanged —
 * the name records that the hold exists elsewhere, it does not add one.
 */
export function engineHeldGate(inner: ToolExecutor): GatedToolExecutor {
  return brand((name, args) => inner(name, args), 'engine-held');
}

/** Runs confirm-free tools only; everything else is refused, never parked and never executed. */
export function readOnlyGate(inner: ToolExecutor): GatedToolExecutor {
  return brand(async (name, args) => {
    if (needsUserConfirm(name)) {
      return refusal('read_only', `'${name}' is not available here: this surface runs read-only tools only. It was NOT executed.`);
    }
    return inner(name, args);
  }, 'read-only');
}

/**
 * EXPLICIT PASS-THROUGH — today's behaviour, named. An interactive assistant whose tool calls run
 * as the present user with NO structural confirmation step. Every use is a known gap, which is
 * why it has a name that can be searched for: `confirm-gate.test.ts` pins the exact call sites,
 * and the list is meant to reach zero.
 */
export function ungatedInteractive(inner: ToolExecutor): GatedToolExecutor {
  return brand((name, args) => inner(name, args), 'ungated-interactive');
}
