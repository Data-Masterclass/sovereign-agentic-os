/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Run ids — the LangGraph thread id of one agent run, unguessable
 * USER STORY: As the platform I want every run id minted from a cryptographically random UUID so a
 *             user who may run one system can never guess (and therefore never resume or read) the
 *             thread of another user's run on the shared checkpointer — a run id is a capability.
 * ARCHITECTURE:
 *   - One function, `newRunId()` → `run_<uuid v4>` (122 random bits via `crypto.randomUUID`).
 *     Lives in the kernel because the Agents store, the run route, the scheduler AND the MCP
 *     agent tools (core/mcp) mint run ids — a kernel module must not reach into a tab for it.
 *   - The former `tabs/agents/lib/store.ts` implementation (~31 random bits + a timestamp
 *     suffix) was guessable; it now re-exports this function (review of A1, finding H1/L5).
 */
import { randomUUID } from 'node:crypto';

/** Mint a run id — the LangGraph thread id of one run. Unguessable by construction. */
export function newRunId(): string {
  return `run_${randomUUID()}`;
}

/** Shape check for a run id minted by {@link newRunId} (a legacy `run_<base36>` id also passes). */
export function isRunId(value: unknown): value is string {
  return typeof value === 'string' && /^run_[A-Za-z0-9-]{8,64}$/.test(value);
}
