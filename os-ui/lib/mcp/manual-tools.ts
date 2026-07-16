/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/core/auth';
import type { Role } from '@/lib/core/session';
import type { McpTool } from './server';

// --- The EXACT governed store fns the Operating Model tab + its API routes call --
import {
  getManual,
  updateManual,
  listManualVersions,
  restoreManualVersion,
} from '@/lib/knowledge/store';
import { type ManualScope } from '@/lib/knowledge/manual';

/**
 * THE OPERATING MODEL MCP SURFACE. Four THIN wrappers over the SAME governed
 * `lib/knowledge/store` manual functions the Operating Model tab + its `/api`
 * routes call, under the caller's delegated identity. The model comes in three
 * scopes, each keyed + governed differently by `resolveManual` (lib/knowledge/manual.ts):
 *
 *   • my      — a PERSONAL operating model, one per user.  Read + edit: OWNER only.
 *   • domain  — the per-domain operating model.             Read: everyone in-domain.
 *                                                           Edit: domain_admin+ / owner.
 *   • company — the tenant-wide operating model.            Read: everyone.
 *                                                           Edit: platform Admin only.
 *
 * The per-scope view/edit gate is enforced INSIDE the store via `resolveManual`
 * (`canView` / `canEdit`) — never trusted from the client. A read floors at
 * `creator`; an edit/restore floors at `creator` too (a user always owns their My
 * operating model), and the store refuses a Domain/Company edit the caller isn't
 * entitled to with a typed `forbidden`. Version history + restore reuse the shared
 * version log, identical for all three scopes.
 */

const MANUAL_SCOPES: ManualScope[] = ['my', 'domain', 'company'];

function fail(message: string, status: number): never {
  const e = new Error(message) as Error & { status?: number };
  e.status = status;
  throw e;
}
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
type Principal = { id: string; domains: string[]; role: Role };
const P = (u: CurrentUser): Principal => ({ id: u.id, domains: u.domains, role: u.role });

function scopeOf(v: unknown): ManualScope {
  const s = str(v).trim();
  if (!MANUAL_SCOPES.includes(s as ManualScope)) {
    fail('`scope` must be one of: my | domain | company', 400);
  }
  return s as ManualScope;
}

const SCOPE_PROP = {
  type: 'string' as const,
  enum: MANUAL_SCOPES as string[],
  description: 'Which manual: my (personal, owner-only) · domain (your domain — everyone reads, domain_admin+ edits) · company (tenant-wide — everyone reads, Admin edits).',
};

export const MANUAL_TOOLS: McpTool[] = [
  {
    name: 'get_operating_manual',
    tab: 'operating-manual',
    minRole: 'creator',
    description:
      'Read an Operating Model at one scope — its guided sections (general · strategy · business · organization · architecture · data · glossary). Purpose: the canonical "how we operate" card that grounds a domain or the whole org. Before: whoami (to know your domains). After: update_operating_manual to edit (if you may). Governance: view is per-scope via resolveManual — a My operating model is your own; a Domain model is readable by anyone in that domain; the Company model by everyone. A scope you cannot view is a typed forbidden.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: SCOPE_PROP,
        domain: { type: 'string', description: 'For scope=domain: one of YOUR domains (defaults to your first).' },
      },
      required: ['scope'],
      examples: [{ scope: 'my' }, { scope: 'domain', domain: 'sales' }, { scope: 'company' }],
    },
    call: async (user, args) => {
      const scope = scopeOf(args.scope);
      const domain = str(args.domain).trim() || undefined;
      return getManual(scope, P(user), domain);
    },
  },
  {
    name: 'update_operating_manual',
    tab: 'operating-manual',
    minRole: 'creator',
    description:
      'Edit an Operating Model at one scope by patching its guided sections (general · strategy · business · organization · architecture · data · glossary). Only the sections you pass are changed; a no-op save creates no version churn. Purpose: keep the "how we operate" card current. Before: get_operating_manual (read the current sections + their ids). After: get_operating_manual to read it back. Governance: edit is per-scope via resolveManual and enforced server-side — My = the owner (any role); Domain = a domain_admin of that domain (or the owner); Company = a platform Admin. Anyone else is refused (forbidden). Section ids are fixed: general · strategy · business · organization · architecture · data · glossary.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: SCOPE_PROP,
        domain: { type: 'string', description: 'For scope=domain: one of YOUR domains (defaults to your first).' },
        sections: {
          type: 'array',
          description: 'The sections to overwrite. Each is { id, content }; id ∈ general | strategy | business | organization | architecture | data | glossary.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'general | strategy | business | organization | architecture | data | glossary' },
              content: { type: 'string', description: 'The new markdown content for this section.' },
            },
            required: ['id', 'content'],
          },
        },
      },
      required: ['scope', 'sections'],
      examples: [
        { scope: 'my', sections: [{ id: 'strategy', content: 'Ship the Q3 retention playbook.' }] },
        { scope: 'domain', domain: 'sales', sections: [{ id: 'general', content: 'The Sales domain owns pipeline → close.' }] },
      ],
    },
    call: async (user, args) => {
      const scope = scopeOf(args.scope);
      const domain = str(args.domain).trim() || undefined;
      const raw = Array.isArray(args.sections) ? args.sections : [];
      const sections = raw
        .map((s) => (typeof s === 'object' && s ? (s as Record<string, unknown>) : {}))
        .map((s) => ({ id: str(s.id).trim(), content: str(s.content) }))
        .filter((s) => s.id);
      if (sections.length === 0) fail('update_operating_manual needs at least one `sections` entry ({ id, content })', 400);
      return updateManual(scope, P(user), { sections }, domain);
    },
  },
  {
    name: 'list_operating_manual_versions',
    tab: 'operating-manual',
    minRole: 'creator',
    description:
      'List the version history of an Operating Model at one scope (newest first) — every edit is snapshotted, so you can see what changed and restore. Purpose: audit + pick a version to roll back to. Before: get_operating_manual. After: restore_operating_manual_version with a chosen version number. Governance: view is per-scope via resolveManual (same as get_operating_manual) — a scope you cannot view is a typed forbidden.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: SCOPE_PROP,
        domain: { type: 'string', description: 'For scope=domain: one of YOUR domains (defaults to your first).' },
      },
      required: ['scope'],
      examples: [{ scope: 'domain', domain: 'sales' }, { scope: 'my' }],
    },
    call: async (user, args) => {
      const scope = scopeOf(args.scope);
      const domain = str(args.domain).trim() || undefined;
      return listManualVersions(scope, P(user), domain);
    },
  },
  {
    name: 'restore_operating_manual_version',
    tab: 'operating-manual',
    minRole: 'creator',
    description:
      'Restore a prior version of an Operating Model at one scope. Restore is itself reversible — the current card is snapshotted first, then the chosen version\'s sections are applied. Purpose: roll the operating model back to an earlier state. Before: list_operating_manual_versions (to get the version number). After: get_operating_manual to read the restored card. Governance: edit is per-scope via resolveManual and enforced server-side (My = owner; Domain = domain_admin+ / owner; Company = Admin) — anyone else is refused (forbidden).',
    inputSchema: {
      type: 'object',
      properties: {
        scope: SCOPE_PROP,
        domain: { type: 'string', description: 'For scope=domain: one of YOUR domains (defaults to your first).' },
        versionId: { type: 'number', description: 'The version number to restore (from list_operating_manual_versions).' },
      },
      required: ['scope', 'versionId'],
      examples: [{ scope: 'domain', domain: 'sales', versionId: 2 }, { scope: 'my', versionId: 1 }],
    },
    call: async (user, args) => {
      const scope = scopeOf(args.scope);
      const domain = str(args.domain).trim() || undefined;
      const version = Number(args.versionId);
      if (!Number.isInteger(version)) fail('restore_operating_manual_version needs an integer `versionId`', 400);
      return restoreManualVersion(scope, P(user), version, domain);
    },
  },
];
