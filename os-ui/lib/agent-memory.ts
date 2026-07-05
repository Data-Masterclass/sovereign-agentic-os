/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { osMirror } from '@/lib/os-mirror';

/**
 * Agent memory (golden path §6) — short-term + long-term, domain-scoped.
 *
 *   • Short-term (working): per-thread message history + scratchpad. Models the
 *     LangGraph checkpointer (Valkey for ephemeral session state). Here it is an
 *     in-process TTL map — ephemeral, NOT a system of record.
 *   • Long-term (durable): semantic/episodic facts persisted across conversations.
 *     Models Supabase records + OpenSearch embeddings. Here: an in-process store
 *     with a best-effort write-through to an OpenSearch index, so a real deploy is
 *     durable while a laptop keeps working. PROPOSE-THEN-STORE: a fact is proposed
 *     with provenance + retention, never silently accreted; promotion into the
 *     curated `MEMORY.md` set is a Creator/Builder step (the `curated` flag).
 *
 * Memory NEVER crosses domains: every read/write is keyed by `{domain, agent}`.
 */

const TTL_MS = 1000 * 60 * 60; // 1h working-memory TTL (end-of-conversation in prod)

export type Turn = { role: 'user' | 'assistant'; content: string; at: string };

type Thread = { threadId: string; domain: string; agent: string; turns: Turn[]; touched: number };

export type MemoryKind = 'semantic' | 'episodic' | 'procedural';

export type MemoryFact = {
  id: string;
  domain: string;
  agent: string;
  kind: MemoryKind;
  text: string;
  provenance: string; // where it came from (thread id / tool / human)
  curated: boolean; // promoted into MEMORY.md (human-reviewed trusted set)
  retentionDays: number;
  createdAt: string;
};

/**
 * State pinned to `globalThis` — the Next App Router bundles each route handler
 * separately, so a module-scoped Map would give every route its own empty copy
 * (a fact proposed by one route would be invisible to another). Pinning makes the
 * working-memory + long-term stores true singletons and survives dev HMR.
 */
type MemoryState = { threads: Map<string, Thread>; facts: Map<string, MemoryFact>; factHydration: Promise<void> | null };
const STATE_KEY = Symbol.for('soa.agent-memory.state');
function state(): MemoryState {
  const g = globalThis as unknown as Record<symbol, MemoryState | undefined>;
  if (!g[STATE_KEY]) g[STATE_KEY] = { threads: new Map(), facts: new Map(), factHydration: null };
  return g[STATE_KEY]!;
}
const threads = state().threads;
const facts = state().facts;

function now(): string {
  return new Date().toISOString();
}
function id(p: string): string {
  return `${p}_${Math.random().toString(36).slice(2, 9)}`;
}
function key(domain: string, agent: string, threadId: string): string {
  return `${domain}::${agent}::${threadId}`;
}

function reap(): void {
  const cutoff = Date.now() - TTL_MS;
  for (const [k, t] of threads) if (t.touched < cutoff) threads.delete(k);
}

// ----------------------------------------------------------- Short-term (Valkey) --

/** Load the working memory for a thread (creating it on first use). */
export function getThread(domain: string, agent: string, threadId: string): Turn[] {
  reap();
  const t = threads.get(key(domain, agent, threadId));
  return t ? t.turns : [];
}

/** Append a turn to working memory (the checkpointer write). */
export function appendTurn(domain: string, agent: string, threadId: string, turn: Omit<Turn, 'at'>): void {
  const k = key(domain, agent, threadId);
  const existing = threads.get(k) ?? { threadId, domain, agent, turns: [], touched: Date.now() };
  existing.turns.push({ ...turn, at: now() });
  existing.turns = existing.turns.slice(-30);
  existing.touched = Date.now();
  threads.set(k, existing);
}

// ------------------------------------------------------------- Long-term (durable) --

// Shared durable-mirror core (lib/os-mirror.ts): first write probes the cluster
// and CREATES the index when missing. Best-effort; in-process store is
// authoritative locally.
const mirror = osMirror({ index: 'os-agent-memory' });

export async function ensureHydrated(): Promise<void> {
  const s = state();
  if (!s.factHydration) s.factHydration = hydrateFacts();
  return s.factHydration;
}

async function hydrateFacts(): Promise<void> {
  const s = state();
  const docs = (await mirror.hydrate(5000)) ?? [];
  for (const f of docs as MemoryFact[]) {
    // Threads are ephemeral (TTL 1h) — skip thread docs if any leaked in.
    // Only restore MemoryFact docs (they have the `kind` field).
    if (f && f.id && f.kind && !s.facts.has(f.id)) s.facts.set(f.id, f);
  }
}

async function writeThrough(f: MemoryFact): Promise<void> {
  mirror.writeThrough(f.id, f);
}

/** Propose-then-store a long-term fact with provenance + retention (§6). */
export function proposeFact(input: {
  domain: string;
  agent: string;
  kind: MemoryKind;
  text: string;
  provenance: string;
  retentionDays?: number;
}): MemoryFact {
  const f: MemoryFact = {
    id: id('mem'),
    domain: input.domain,
    agent: input.agent,
    kind: input.kind,
    text: input.text.trim(),
    provenance: input.provenance,
    curated: false,
    retentionDays: input.retentionDays ?? 90,
    createdAt: now(),
  };
  facts.set(f.id, f);
  void writeThrough(f);
  return f;
}

/** Promote a stored fact into the curated MEMORY.md trusted set (Creator/Builder). */
export function curateFact(factId: string): MemoryFact | null {
  const f = facts.get(factId);
  if (!f) return null;
  f.curated = true;
  void writeThrough(f);
  return f;
}

/** List long-term facts for an agent — STRICTLY domain-scoped (never crosses). */
export function listFacts(domain: string, agent: string): MemoryFact[] {
  return [...facts.values()]
    .filter((f) => f.domain === domain && f.agent === agent)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** The recalled long-term context the agent injects this turn (curated first). */
export function recall(domain: string, agent: string, max = 5): MemoryFact[] {
  const all = listFacts(domain, agent);
  const curated = all.filter((f) => f.curated);
  const rest = all.filter((f) => !f.curated);
  return [...curated, ...rest].slice(0, max);
}

export function __resetMemory(): void {
  const s = state();
  s.threads.clear();
  s.facts.clear();
  s.factHydration = null;
  mirror.__reset();
}
