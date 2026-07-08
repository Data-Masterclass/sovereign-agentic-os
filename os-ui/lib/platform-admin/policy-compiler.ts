/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
/**
 * The policy compiler — ONE identity/structure source → OPA grants.
 *
 * Platform Admin AUTHORS structure (users, roles, domain layers, egress
 * allowlist, model access); the compiler turns it into the principal→tool grant
 * map OPA enforces and Governance VIEWS. This is the coupling the briefing
 * insists on: "Platform Admin configures, Governance enforces/sees" — setting a
 * right here is not a governance bypass because it compiles to the SAME OPA the
 * rest of the platform checks (`lib/governed.ts authorize()` →
 * `/v1/data/agentic/authz/allow`, with the grant data at `/v1/data/grants`).
 *
 * Mapping follows `data-policy-compiler.md`:
 *  - low-cardinality attributes (role, domain, region) are encoded as GROUPS;
 *  - each principal gets the tools its role + domain layers permit;
 *  - the egress allowlist compiles to an `egress_allow` resource list;
 *  - model access + caps ride along in the bundle metadata.
 *
 * `compile()` is pure (unit-testable). `publish()` best-effort PUTs the grant
 * map to OPA and is honest when OPA is unreachable (offline kind) — the compiled
 * view still renders so the teaching flow works.
 */
import { config } from '../config.ts';

export type Role = 'creator' | 'builder' | 'domain_admin' | 'admin';

export type CompileUser = { id: string; role: Role; domains: string[]; active?: boolean };
export type CompileDomain = { id: string; archived?: boolean; layers?: { ml?: boolean } };
export type CompileInput = {
  tenant: string;
  users: CompileUser[];
  domains: CompileDomain[];
  egressAllowlist: string[];
  /** model id → enabled; disabled models are not grantable. */
  models?: Record<string, boolean>;
  bundleVersion?: string;
};

export type CompiledPolicy = {
  tenant: string;
  /** principal (`user:<id>` / `domain:<id>`) → sorted, de-duped tool grants. */
  grants: Record<string, string[]>;
  /** Compiled egress allowlist (the `egress_allow` resource). */
  egressAllow: string[];
  bundle: {
    version: string;
    generatedAt: string;
    principals: number;
    tools: string[];
  };
};

const BASE_BY_ROLE: Record<Role, string[]> = {
  // creator (base role): read governed data via the two governed tools.
  // The precise grant-set is a Governance policy decision flagged for human review before publish.
  creator: ['metrics', 'query'],
  // builder: + promote to Shared, request external connection writes, workbench.
  builder: ['metrics', 'query', 'promote', 'connection_write_request', 'workbench'],
  // domain_admin: builder's grants + domain-scoped user administration. NO
  // platform surfaces ('admin', models.manage, egress.curate, backups.restore
  // stay platform-admin-only) — the route tier re-scopes user_admin to the
  // caller's own domain(s).
  domain_admin: ['metrics', 'query', 'promote', 'connection_write_request', 'workbench', 'user_admin', 'membership_admin'],
  // admin: + platform management surfaces (still OPA-gated, default-deny).
  admin: [
    'metrics',
    'query',
    'promote',
    'connection_write_request',
    'workbench',
    'admin',
    'models.manage',
    'egress.curate',
    'backups.restore',
  ],
};

function uniqSort(xs: string[]): string[] {
  return [...new Set(xs)].sort();
}

/** Pure compile: structure → grant map + egress allow + bundle metadata. */
export function compile(input: CompileInput): CompiledPolicy {
  const grants: Record<string, string[]> = {};

  for (const u of input.users) {
    if (u.active === false) continue; // deactivated users grant nothing
    const tools = [...BASE_BY_ROLE[u.role]];
    // Domain layer grants: only domains the user belongs to AND that are active.
    for (const d of input.domains) {
      if (d.archived || !u.domains.includes(d.id)) continue;
      if (d.layers?.ml) tools.push('ml');
    }
    grants[`user:${u.id}`] = uniqSort(tools);
  }

  for (const d of input.domains) {
    if (d.archived) continue;
    const tools = ['metrics', 'query'];
    if (d.layers?.ml) tools.push('ml');
    grants[`domain:${d.id}`] = uniqSort(tools);
  }

  const egressAllow = uniqSort(input.egressAllowlist.map((h) => h.trim().toLowerCase()).filter(Boolean));
  const tools = uniqSort(Object.values(grants).flat());

  return {
    tenant: input.tenant,
    grants,
    egressAllow,
    bundle: {
      version: input.bundleVersion ?? `pc-${new Date().toISOString().slice(0, 10)}`,
      generatedAt: new Date().toISOString(),
      principals: Object.keys(grants).length,
      tools,
    },
  };
}

export type PublishResult = { status: 'published' | 'opa-unreachable'; detail: string };

/**
 * Best-effort publish of the compiled grant map to OPA's data document
 * (`PUT /v1/data/grants`). OPA hot-reloads it; Governance's policy view then
 * reflects the new rights. Offline (kind, OPA off) we return `opa-unreachable`
 * so the UI is honest — the compiled view still renders from `compile()`.
 */
export async function publish(compiled: CompiledPolicy): Promise<PublishResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);
  try {
    const res = await fetch(`${config.opaUrl}/v1/data/grants`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      cache: 'no-store',
      signal: ctrl.signal,
      body: JSON.stringify(compiled.grants),
    });
    if (!res.ok) return { status: 'opa-unreachable', detail: `OPA ${res.status}` };
    return { status: 'published', detail: `bundle ${compiled.bundle.version}` };
  } catch {
    return { status: 'opa-unreachable', detail: 'OPA not reachable (offline kind) — compiled offline' };
  } finally {
    clearTimeout(timer);
  }
}

export async function compileAndPublish(input: CompileInput): Promise<{ compiled: CompiledPolicy; publish: PublishResult }> {
  const compiled = compile(input);
  const result = await publish(compiled);
  return { compiled, publish: result };
}
