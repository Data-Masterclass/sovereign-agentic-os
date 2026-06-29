/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { type IR } from '../langgraph-compile.ts';
import { type Effect } from '../gateway.ts';

/**
 * The HTTP contract between the os-ui LangGraph build adapter / Run path and the
 * shared Python `agent-runtime` service (Approach A). The TS `compile()` stays the
 * single source of graph semantics: the adapter compiles `system.yaml` → {@link IR}
 * in TS and POSTs that IR to the runtime `/reload`; the runtime is a generic IR
 * interpreter, never a second compiler. A manual Run is a synchronous
 * os-ui → runtime `/run`.
 *
 * Per-run isolation guards (locked decisions): a `recursionLimit` bounds graph
 * steps and a `timeoutMs` bounds wall-clock; the runtime authorizes every tool
 * call under the principal `os-<systemId>[:node]` so OPA scopes each system.
 *
 * This module is PURE (no network, no server-only) so the adapter, the Run path
 * and the unit tests share the same request shapes.
 */

export const RUNTIME_DEFAULTS = {
  /** Bounds graph steps so a mis-wired cycle can't run unbounded (LangGraph recursion_limit). */
  recursionLimit: 25,
  /** Wall-clock bound on a single Run (ms). */
  timeoutMs: 60_000,
} as const;

/** POST {runtime}/reload — register the compiled graph for a system. */
export type ReloadRequest = { systemId: string; ir: IR };
export type ReloadResponse = {
  ok: boolean;
  systemId: string;
  nodes: number;
  entrypoint: string;
  error?: string;
};

/** POST {runtime}/run — one synchronous test/manual invocation of a system. */
export type RunRequest = {
  systemId: string;
  prompt: string;
  recursionLimit: number;
  timeoutMs: number;
  /** Sub-agent ids toggled off in a running system (skipped by the interpreter). */
  disabledAgents: string[];
};

/** One governed tool call the interpreter made during a Run (mirrors run-graph RunStep). */
export type RunStepWire = { node: string; tool: string; effect: Effect; ran: boolean };

export type RunResponse = {
  ok: boolean;
  reachedEnd: boolean;
  path: string[];
  steps: RunStepWire[];
  traces: number;
  /** The model's final text (mock-model in kind). */
  output?: string;
  error?: string;
};

/**
 * The runtime → os-ui GOVERNED TOOL endpoint contract. The runtime holds NO
 * resource creds and NO OPA/Langfuse access of its own — every tool call funnels
 * back through this os-ui endpoint, which reuses `lib/agent-governed` authorize +
 * trace. This is the chokepoint that makes the gateway invariant real (creds +
 * Cilium egress, not honor-system).
 */
export type GovernedToolRequest = {
  systemId: string;
  node: string;
  tool: string;
  args: Record<string, unknown>;
  /**
   * Advisory read/write flag, recorded in the trace for audit. The hold/deny is
   * enforced by OPA (a Write-approval tool resolves to `requires_approval`), not by
   * this flag — a write is held by policy regardless of it.
   */
  write?: boolean;
};
export type GovernedToolResponse = {
  effect: Effect;
  reason: string;
  output?: unknown;
};

/** Scope a system (and optionally a node) to its OPA principal: `os-<id>[:node]`. */
export function principalFor(systemId: string, node?: string): string {
  return node ? `os-${systemId}:${node}` : `os-${systemId}`;
}

export function reloadRequest(systemId: string, ir: IR): ReloadRequest {
  return { systemId, ir };
}

export function runRequest(
  systemId: string,
  prompt: string,
  opts: { recursionLimit?: number; timeoutMs?: number; disabledAgents?: string[] } = {},
): RunRequest {
  return {
    systemId,
    prompt,
    recursionLimit: opts.recursionLimit ?? RUNTIME_DEFAULTS.recursionLimit,
    timeoutMs: opts.timeoutMs ?? RUNTIME_DEFAULTS.timeoutMs,
    disabledAgents: opts.disabledAgents ?? [],
  };
}
