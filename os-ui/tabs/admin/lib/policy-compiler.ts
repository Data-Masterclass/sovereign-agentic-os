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
 * `compile()` is pure (unit-testable). `publish()` writes the grant map to OPA
 * through the one grants publisher and is honest when OPA is unreachable — the
 * compiled view still renders.
 */
import { publishGrantsDocument } from '@core/policy/opa-reconcile';

export type Role = 'creator' | 'builder' | 'domain_admin' | 'admin';

export type CompileUser = { id: string; role: Role; domains: string[]; active?: boolean };
export type CompileDomain = { id: string; archived?: boolean; layers?: { ml?: boolean } };
export type CompileInput = {
  tenant: string;
  users: CompileUser[];
  domains: CompileDomain[];
  egressAllowlist: string[];
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
  creator: ['metrics', 'query', 'software_checks'],
  // builder: + promote to Shared, request external connection writes, workbench.
  builder: ['metrics', 'query', 'software_checks', 'promote', 'connection_write_request', 'workbench'],
  // domain_admin: builder's grants + domain-scoped user administration. NO
  // platform surfaces ('admin', models.manage, egress.curate, backups.restore
  // stay platform-admin-only) — the route tier re-scopes user_admin to the
  // caller's own domain(s).
  domain_admin: ['metrics', 'query', 'software_checks', 'promote', 'connection_write_request', 'workbench', 'user_admin', 'membership_admin'],
  // admin: + platform management surfaces (still OPA-gated, default-deny).
  admin: [
    'metrics',
    'query',
    'software_checks',
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
 * Publish the compiled grant map as OPA's `grants` document (`PUT /v1/data/grants`) through the
 * ONE grants publisher (`core/policy/opa-reconcile.ts publishGrantsDocument`), which unions in the
 * runtime grants other paths own (agent systems, approved access requests) so this whole-document
 * replace never drops them. The same function restores the document after an OPA restart.
 * A failure is returned as `opa-unreachable` with the real reason — the compiled view still renders.
 */
export async function publish(compiled: CompiledPolicy): Promise<PublishResult> {
  const r = await publishGrantsDocument(compiled.grants);
  if (!r.ok) return { status: 'opa-unreachable', detail: r.detail };
  return { status: 'published', detail: `bundle ${compiled.bundle.version} (${r.principals} principals)` };
}

export async function compileAndPublish(input: CompileInput): Promise<{ compiled: CompiledPolicy; publish: PublishResult }> {
  const compiled = compile(input);
  const result = await publish(compiled);
  return { compiled, publish: result };
}
