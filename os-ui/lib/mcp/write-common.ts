/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/core/auth';
import type { Role } from '@/lib/core/session';
import type { ColumnDoc } from '@/lib/data';
import { claimsFromUser, delegate } from '@/lib/data/identity';
import {
  ACTOR_TYPES,
  type WorkflowStep,
  type WorkflowRule,
  type ActorType,
  type Actor,
} from '@/lib/knowledge/schema';

export type Principal = { id: string; domains: string[]; role: Role };
export const P = (u: CurrentUser): Principal => ({ id: u.id, domains: u.domains, role: u.role });

/** Mint a delegated token directly from the MCP user (already authenticated via MCP session).
 *  Unlike `delegatedToken` in `lib/infra/identity-server`, this does NOT call requireUser()
 *  (which reads from the HTTP session via next/headers) — the MCP user IS the authenticated
 *  identity, so we delegate directly. R2 is preserved: the token carries the caller's sub. */
export function mcpToken(user: CurrentUser, scope: 'personal' | 'domain' | 'marketplace' = 'domain') {
  return delegate(claimsFromUser({ id: user.id, domains: user.domains, role: user.role }), scope);
}

export function fail(message: string, status: number): never {
  const e = new Error(message) as Error & { status?: number };
  e.status = status;
  throw e;
}

export const str = (v: unknown): string => (typeof v === 'string' ? v : '');
export const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
export const bool = (v: unknown): boolean => v === true;
export const strArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => str(x).trim()).filter(Boolean) : [];

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
}
export const rand = (): string => Math.random().toString(36).slice(2, 8);
export const defaultGoLive = (): string => new Date(Date.now() + 56 * 86400000).toISOString().slice(0, 10);

/** MCP in-band ingest cap (~2 MB) — bigger files go through the UI's streaming upload. */
export const INGEST_MAX_BYTES = 2 * 1024 * 1024;

export function colDocs(v: unknown): ColumnDoc[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((c) => (typeof c === 'object' && c ? (c as Record<string, unknown>) : {}))
    .map((c) => ({ name: str(c.name).trim(), description: str(c.description) }))
    .filter((c) => c.name);
}

export function mapSteps(v: unknown): WorkflowStep[] {
  if (!Array.isArray(v)) return [];
  const actors: ActorType[] = ['Human', 'Software', 'Agent', 'Customer', 'Partner'];
  return v
    .map((s) => (typeof s === 'object' && s ? (s as Record<string, unknown>) : {}))
    .map((s, i): WorkflowStep => {
      const actor = actors.includes(str(s.actor) as ActorType) ? (str(s.actor) as ActorType) : 'Human';
      return {
        id: slug(str(s.id) || str(s.title) || `step-${i + 1}`),
        title: str(s.title).trim() || `Step ${i + 1}`,
        actor,
        actor_name: str(s.actor_name).trim(),
        inputs: strArr(s.inputs),
        outputs: strArr(s.outputs),
        links: [],
        rules: [],
        tacit: str(s.tacit).trim(),
      };
    })
    .filter((s) => s.title);
}

export function mapRules(v: unknown): WorkflowRule[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((r) => (typeof r === 'object' && r ? (r as Record<string, unknown>) : { text: str(r) }))
    .map((r, i): WorkflowRule => ({
      id: slug(str(r.id) || `r${i + 1}`),
      text: str(r.text).trim(),
      hard: bool(r.hard),
      scope: r.scope === 'step' ? 'step' : 'workflow',
    }))
    .filter((r) => r.text);
}

export function mapActors(v: unknown): Actor[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((a) => (typeof a === 'object' && a ? (a as Record<string, unknown>) : {}))
    .map((a): Actor | null => {
      const name = str(a.name).trim();
      const category = ACTOR_TYPES.includes(str(a.category) as ActorType) ? (str(a.category) as ActorType) : 'Human';
      if (!name) return null;
      const actor: Actor = { name, category };
      if (str(a.description).trim()) actor.description = str(a.description).trim();
      return actor;
    })
    .filter((a): a is Actor => a !== null);
}

export function normFiles(args: Record<string, unknown>): { path: string; content: string }[] {
  const list = Array.isArray(args.files)
    ? (args.files as unknown[])
    : args.path !== undefined
      ? [{ path: args.path, content: args.content }]
      : [];
  return list
    .map((f) => (typeof f === 'object' && f ? (f as Record<string, unknown>) : {}))
    .map((f) => ({ path: str(f.path).trim(), content: str(f.content) }))
    .filter((f) => f.path);
}
