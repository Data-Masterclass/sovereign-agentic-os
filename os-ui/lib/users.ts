/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import 'server-only';
import { config } from '@/lib/config';
import type { Role } from '@/lib/session';

/**
 * User directory — the seam Ory replaces later. Admins create/manage users here
 * (Platform → Users). Each user belongs to one OR MORE domains and carries a
 * role (participant | builder | admin). Persistence mirrors the artifact store:
 * an authoritative in-process cache (so it works with no cluster) plus a
 * best-effort OpenSearch mirror ("os-users") for durability in a real deploy.
 *
 * Passwords are stored in-cluster only and never leave the server. This is a
 * pragmatic teaching credential store, NOT production IAM.
 */

export type StoredUser = {
  id: string;
  name: string;
  password: string;
  domains: string[];
  role: Role;
};

export type PublicUser = Omit<StoredUser, 'password'>;

let cache: Map<string, StoredUser> | null = null;
let osHealthy = false;

const DEFAULT_USERS: StoredUser[] = [
  { id: 'amir', name: 'Amir Hassan', password: 'sales', domains: ['sales'], role: 'participant' },
  { id: 'bea', name: 'Bea Brooks', password: 'sales', domains: ['sales'], role: 'builder' },
  { id: 'sara', name: 'Sara Novak', password: 'sales', domains: ['sales'], role: 'admin' },
  { id: 'kenji', name: 'Kenji Watanabe', password: 'finance', domains: ['finance'], role: 'participant' },
  { id: 'maria', name: 'Maria Lopez', password: 'finance', domains: ['finance'], role: 'admin' },
  { id: 'sam', name: 'Sam Rivera', password: 'demo', domains: ['sales', 'finance'], role: 'builder' },
  { id: 'admin', name: 'Platform Admin', password: 'admin', domains: ['sales', 'finance', 'platform'], role: 'admin' },
];

function loadSeed(): StoredUser[] {
  if (!config.usersSeed) return DEFAULT_USERS;
  try {
    const parsed = JSON.parse(config.usersSeed);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed.map((u: Record<string, unknown>) => ({
        id: String(u.id),
        name: String(u.name ?? u.id),
        password: String(u.password ?? ''),
        domains: Array.isArray(u.domains)
          ? u.domains.map(String)
          : u.domain
            ? [String(u.domain)]
            : ['default'],
        role: (['participant', 'builder', 'admin'].includes(String(u.role)) ? u.role : 'participant') as Role,
      }));
    }
  } catch {
    /* fall through */
  }
  return DEFAULT_USERS;
}

async function osFetch(path: string, init?: RequestInit): Promise<Response | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);
  try {
    return await fetch(`${config.opensearchUrl}${path}`, {
      ...init,
      signal: ctrl.signal,
      cache: 'no-store',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...(init?.headers ?? {}) },
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function writeThrough(u: StoredUser): void {
  if (!osHealthy) return;
  void osFetch(`/os-users/_doc/${u.id}?refresh=true`, { method: 'PUT', body: JSON.stringify(u) });
}

async function getCache(): Promise<Map<string, StoredUser>> {
  if (cache) return cache;
  const map = new Map<string, StoredUser>();
  const ping = await osFetch('/os-users/_count');
  if (ping && ping.ok) {
    osHealthy = true;
    const res = await osFetch('/os-users/_search?size=1000', {
      method: 'POST',
      body: JSON.stringify({ query: { match_all: {} } }),
    });
    if (res && res.ok) {
      const data = (await res.json()) as { hits?: { hits?: { _source: StoredUser }[] } };
      for (const h of data?.hits?.hits ?? []) map.set(h._source.id, h._source);
    }
    if (map.size === 0) for (const u of loadSeed()) { map.set(u.id, u); writeThrough(u); }
  } else {
    osHealthy = false;
    for (const u of loadSeed()) map.set(u.id, u);
  }
  cache = map;
  return map;
}

function publicOf(u: StoredUser): PublicUser {
  const { password: _pw, ...rest } = u;
  void _pw;
  return rest;
}

function err(message: string, status: number): Error {
  const e = new Error(message);
  (e as Error & { status?: number }).status = status;
  return e;
}

export async function authenticate(username: string, password: string): Promise<PublicUser | null> {
  const map = await getCache();
  const u = [...map.values()].find((x) => x.id.toLowerCase() === username.trim().toLowerCase());
  if (!u || u.password !== password) return null;
  return publicOf(u);
}

export async function listUsers(): Promise<PublicUser[]> {
  const map = await getCache();
  return [...map.values()].map(publicOf).sort((a, b) => a.id.localeCompare(b.id));
}

/** Public roster for the sign-in helper (ids + domains/role only). */
export async function roster(): Promise<PublicUser[]> {
  return listUsers();
}

export async function createUser(input: {
  id: string;
  name?: string;
  password: string;
  domains: string[];
  role: Role;
}): Promise<PublicUser> {
  const map = await getCache();
  const id = input.id.trim().toLowerCase();
  if (!id) throw err('A username is required', 400);
  if (map.has(id)) throw err('That username already exists', 409);
  if (!input.password) throw err('A password is required', 400);
  if (!input.domains?.length) throw err('At least one domain is required', 400);
  const u: StoredUser = {
    id,
    name: input.name?.trim() || id,
    password: input.password,
    domains: input.domains,
    role: input.role,
  };
  map.set(id, u);
  writeThrough(u);
  return publicOf(u);
}

export async function updateUser(
  id: string,
  patch: { name?: string; password?: string; domains?: string[]; role?: Role },
): Promise<PublicUser> {
  const map = await getCache();
  const u = map.get(id);
  if (!u) throw err('User not found', 404);
  if (patch.name !== undefined) u.name = patch.name.trim() || u.id;
  if (patch.password) u.password = patch.password;
  if (patch.domains?.length) u.domains = patch.domains;
  if (patch.role) u.role = patch.role;
  map.set(id, u);
  writeThrough(u);
  return publicOf(u);
}

export async function deleteUser(id: string): Promise<void> {
  const map = await getCache();
  if (!map.has(id)) return;
  map.delete(id);
  if (osHealthy) void osFetch(`/os-users/_doc/${id}?refresh=true`, { method: 'DELETE' });
}

/** Distinct domains across all users — drives domain pickers. */
export async function knownDomains(): Promise<string[]> {
  const map = await getCache();
  const set = new Set<string>();
  for (const u of map.values()) for (const d of u.domains) set.add(d);
  return [...set].sort();
}
