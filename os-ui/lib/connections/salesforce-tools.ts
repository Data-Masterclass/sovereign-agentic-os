/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { Connection, ConnectionTool, CapabilityMode } from '@/lib/connections/schema';
import { config } from '@/lib/core/config';
import { isOperationalTemplate } from '@/lib/connections/operational-platform';
import { fetchWithBackoff } from '@/lib/connections/retry';
import { allActiveExposures, entityActionKey, type ExposureSet } from '@/lib/connections/exposures';
import { allActiveAdoptions, adoptionCovers, type ActionAdoption } from '@/lib/connections/action-adoptions';
import {
  salesforceConnFrom,
  sfToken,
  sfGetRecord,
  sfCreateRecord,
  sfUpdateRecord,
  buildSearchSoql,
  safeSObjectName,
  type SfConn,
} from '@/lib/connections/salesforce';

/**
 * ENTITY-GENERIC SALESFORCE ACTION TOOLS (operational-system-connections.md, Phase 3).
 *
 * Five tools replace the hardcoded per-object preset (read_account / update_opportunity_amount):
 *   • sf_get_record   { object, id, fields? }              — Read
 *   • sf_search       { object, where?, term?, fields?, limit? } — Read, bounded (LIMIT ≤ 200,
 *                                                             result carries `truncated`)
 *   • sf_create_record{ object, values }                    — Write-approval
 *   • sf_update_record{ object, id, values }                — Write-approval (Write-bounded via
 *                                                             the connection's argConstraints)
 *   • sf_delete_record{ object, id }                        — Blocked (registered, never callable)
 *
 * Every arg is validated (safeSObjectName + record-id shape); SOQL is built server-side from
 * validated parts (buildSearchSoql) — raw user input is NEVER interpolated into SOQL.
 *
 * THE FOUR-LAYER FAIL-CLOSED INTERSECTION. An action tool is exposed/callable for a domain
 * principal ONLY at the intersection of:
 *   1. capability profile  — the tool's mode (get/search=Read, create/update=Write-approval,
 *      delete=Blocked; bounded-write via argConstraints),
 *   2. exposure actions    — a non-revoked exposure of this connection granting that entity's
 *      action (create/update additionally needs the exposure's `writeApproved`),
 *   3. domain adoption     — a non-revoked adoption of that entity's actions by the connection's
 *      domain, and
 *   4. agent/app grant     — the restrict-only per-agent grant (enforced by the existing gate).
 * With the flag OFF, or no exposure, or no adoption ⇒ the tool is invisible AND uncallable.
 * Recomputed per call over the live stores — no cache outlives a revoke at any layer.
 */

/** The five action tool names (stable identifiers the gate + UI key on). */
export const SF_ACTION_TOOLS = {
  get: 'sf_get_record',
  search: 'sf_search',
  create: 'sf_create_record',
  update: 'sf_update_record',
  delete: 'sf_delete_record',
} as const;

export type SfActionToolName = (typeof SF_ACTION_TOOLS)[keyof typeof SF_ACTION_TOOLS];

const ACTION_TOOL_NAMES = new Set<string>(Object.values(SF_ACTION_TOOLS));

/** True when a tool name is one of the entity-generic Salesforce action tools. */
export function isSalesforceActionTool(tool: string): boolean {
  return ACTION_TOOL_NAMES.has(tool);
}

/** The action KIND (exposure-actions key) a tool maps to — or null for delete (never
 *  an exposure action; it is Blocked regardless). */
export function actionKindFor(tool: string): 'read' | 'search' | 'create' | 'update' | null {
  switch (tool) {
    case SF_ACTION_TOOLS.get: return 'read';
    case SF_ACTION_TOOLS.search: return 'search';
    case SF_ACTION_TOOLS.create: return 'create';
    case SF_ACTION_TOOLS.update: return 'update';
    default: return null; // delete
  }
}

/** The BASE capability mode for each action tool (before the argConstraints bound). */
function baseModeFor(tool: string): CapabilityMode {
  switch (tool) {
    case SF_ACTION_TOOLS.get:
    case SF_ACTION_TOOLS.search:
      return 'Read';
    case SF_ACTION_TOOLS.create:
    case SF_ACTION_TOOLS.update:
      return 'Write-approval';
    default:
      return 'Blocked'; // sf_delete_record
  }
}

/** The static ConnectionTool definitions for the five action tools (for descriptions/
 *  display + the Blocked delete). Modes here are the BASE modes; the live per-entity
 *  intersection decides which are actually exposed. */
export function salesforceActionToolDefs(): ConnectionTool[] {
  return [
    { name: SF_ACTION_TOOLS.get, description: 'Read one Salesforce record by object + id (read).', write: false, mode: 'Read' },
    { name: SF_ACTION_TOOLS.search, description: 'Search a Salesforce object (bounded SOQL, truncated-flagged) (read).', write: false, mode: 'Read' },
    { name: SF_ACTION_TOOLS.create, description: 'Create a Salesforce record (write — held for approval).', write: true, mode: 'Write-approval' },
    { name: SF_ACTION_TOOLS.update, description: 'Update a Salesforce record (write — held for approval).', write: true, mode: 'Write-approval' },
    { name: SF_ACTION_TOOLS.delete, description: 'Delete a Salesforce record (write — Blocked).', write: true, mode: 'Blocked' },
  ];
}

/** True when the operational-action surface is active for a connection: the flag is on
 *  AND the connection is an operational (Salesforce/Kajabi) source. */
export function operationalActionsActive(c: Connection): boolean {
  return config.operationalActionsEnabled && isOperationalTemplate(c.template);
}

/**
 * The RESULT of one intersection decision for a (connection, tool, object) triple:
 * `mode` is the effective capability mode (or null when NOT exposed at all — fail
 * closed). `reason` explains an absent grant honestly (for the deny trace).
 */
export type ActionDecision = { mode: CapabilityMode; reason: string } | { mode: null; reason: string };

/**
 * COMPUTE THE INTERSECTION for one action-tool call, freshly over the live stores.
 * This is the verbatim core of the four-layer contract. `object` is the entity the
 * call targets (from the tool args). Returns the effective mode, or `{mode:null}` when
 * ANY layer withholds it (fail closed). Pure over the passed-in exposures/adoptions so
 * the caller loads them once per call (no cache outlives a revoke).
 */
export function decideActionTool(
  c: Connection,
  tool: string,
  object: string,
  exposures: ExposureSet[],
  adoptions: ActionAdoption[],
  callerDomains: string[],
): ActionDecision {
  // Layer 0: flag + operational source. Off ⇒ inert.
  if (!operationalActionsActive(c)) {
    return { mode: null, reason: 'operational action tools are not enabled' };
  }
  // Delete is Blocked regardless of every other layer (registered, never callable).
  if (tool === SF_ACTION_TOOLS.delete) {
    return { mode: 'Blocked', reason: 'delete is Blocked' };
  }
  const kind = actionKindFor(tool);
  if (!kind) return { mode: null, reason: `unknown action tool ${tool}` };

  let entityKey: string;
  try {
    entityKey = entityActionKey(safeSObjectName(object));
  } catch {
    return { mode: null, reason: 'action call is missing a valid object' };
  }

  // Layers 2+3 are keyed on the CALLER'S domains, NOT the connection's (C4). A connection
  // in Sales exposed to Commerce arms a COMMERCE caller (exposure grant = `e.domains ∩
  // callerDomains ≠ ∅`); adoption is checked for the caller domain that the exposure
  // targets. Keying on `c.domain` made cross-domain exposure impossible — the flagship
  // consent flow was dead. Create/update additionally require the exposure's `writeApproved`.
  const caller = new Set(callerDomains);
  const wantsWrite = kind === 'create' || kind === 'update';
  const relevant = exposures.filter((e) => {
    if (e.revoked || e.connectionId !== c.id) return false;
    if (!e.domains.some((d) => caller.has(d))) return false;
    const grant = e.actions?.[entityKey];
    if (!grant || !grant[kind]) return false;
    if (wantsWrite && !e.writeApproved) return false;
    return true;
  });
  if (relevant.length === 0) {
    return { mode: null, reason: `no exposure grants ${kind} on ${entityKey} to any of the caller's domains` };
  }

  // Layer 3: domain adoption — a caller domain the exposure targets must have adopted this
  // entity's actions for at least one relevant exposure. Fail closed with no adoption (an
  // un-adopted caller domain is denied).
  const adopted = relevant.some((e) =>
    e.domains.some((d) => caller.has(d) && adoptionCovers(adoptions, e.id, d, entityKey)),
  );
  if (!adopted) {
    return { mode: null, reason: `no caller domain has adopted ${entityKey} actions on this exposure` };
  }

  // Layer 1: the capability mode. Read/search auto-allow; create/update are Write-
  // approval, OR Write-bounded when the connection sets a bounded update constraint
  // (argConstraints) on this tool — matching the existing bounded-write machinery.
  const mode = effectiveMode(c, tool);
  return { mode, reason: `${kind} on ${entityKey} — granted (exposure + adoption)` };
}

/** The effective capability mode for an action tool, honoring a Write-bounded variant:
 *  when the connection carries an `update` tool with a `maxAmount` argConstraint the
 *  update tool becomes Write-bounded (amount ≤ bound), else its base mode. */
function effectiveMode(c: Connection, tool: string): CapabilityMode {
  const base = baseModeFor(tool);
  if (tool === SF_ACTION_TOOLS.update) {
    const override = c.tools.find((t) => t.name === tool);
    if (override && override.mode === 'Write-bounded' && override.limits?.maxAmount !== undefined) {
      return 'Write-bounded';
    }
  }
  return base;
}

/** The bounded-write limits for an action tool, if the connection set them (so the
 *  gate can enforce amount ≤ maxAmount on a bounded update). */
export function actionToolLimits(c: Connection, tool: string): { maxAmount?: number; boundArg?: string } | undefined {
  if (tool !== SF_ACTION_TOOLS.update) return undefined;
  const override = c.tools.find((t) => t.name === tool);
  if (override?.mode === 'Write-bounded' && override.limits?.maxAmount !== undefined) {
    return { maxAmount: override.limits.maxAmount, boundArg: 'amount' };
  }
  return undefined;
}

/**
 * The action tools EXPOSED for a connection right now — the intersection over EVERY
 * entity any exposure grants + the domain adopts. Used by the tool-listing surface
 * (`exposedConnectionTools`) so an unexposed/unadopted action tool never appears.
 * Loads the stores once. Delete is never listed (Blocked). Read tools list when read
 * or search is granted+adopted; write tools list when create/update is granted (with
 * `writeApproved`) + adopted.
 */
export async function exposedActionTools(c: Connection, callerDomains: string[]): Promise<string[]> {
  if (!operationalActionsActive(c)) return [];
  const caller = new Set(callerDomains);
  const [exposures, adoptions] = await Promise.all([allActiveExposures(), allActiveAdoptions()]);
  const out = new Set<string>();
  for (const e of exposures) {
    // Grant listing is keyed on the CALLER'S domains (C4): a Sales connection exposed to
    // Commerce lists its action tools for a Commerce caller, not for a Sales one.
    if (e.revoked || e.connectionId !== c.id) continue;
    const targeted = e.domains.filter((d) => caller.has(d));
    if (targeted.length === 0) continue;
    for (const [entityKey, grant] of Object.entries(e.actions ?? {})) {
      if (!targeted.some((d) => adoptionCovers(adoptions, e.id, d, entityKey))) continue;
      if (grant.read) out.add(SF_ACTION_TOOLS.get);
      if (grant.search) out.add(SF_ACTION_TOOLS.search);
      if (grant.create && e.writeApproved) out.add(SF_ACTION_TOOLS.create);
      if (grant.update && e.writeApproved) out.add(SF_ACTION_TOOLS.update);
    }
  }
  return [...out];
}

// -------------------------------------------------------------- executor --------

/** The service-account identity label every action result carries (decision 1). */
export const SERVICE_ACCOUNT_LABEL = 'as the integration account — records it cannot see are absent';

/** Wrap a Salesforce client with a backoff-retrying fetch (429/503 honored, honest
 *  reason passed through by the client's own 429 handling). */
function actionConn(c: Connection): SfConn {
  const conn = salesforceConnFrom(c);
  const base = conn.fetchImpl;
  const retrying: SfConn['fetchImpl'] = (url, init) =>
    fetchWithBackoff(String(url), init ?? {}, (u, i) => base(u, i));
  return { ...conn, fetchImpl: retrying };
}

/**
 * Execute one ALREADY-ALLOWED Salesforce action tool against the real REST API. The
 * governance gate (intersection + Read/Write-approval/Blocked) has already passed
 * UPSTREAM in `callConnectionTool`. NEVER throws — every failure degrades to
 * `{ ok:false, reason }`. The secret is dereferenced server-side inside the client and
 * never logged/returned. Every envelope carries the service-account identity label.
 */
export async function executeSalesforceAction(
  c: Connection,
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const label = { asServiceAccount: true as const, identity: SERVICE_ACCOUNT_LABEL };
  const fail = (reason: string) => ({ connection: c.name, ok: false as const, reason, ...label });
  const object = String(args.object ?? '');
  if (!object) return fail('missing object');

  const conn = actionConn(c);
  const token = await sfToken(conn);
  if (!token.ok) return fail(token.reason);

  try {
    switch (tool) {
      case SF_ACTION_TOOLS.get: {
        const idArg = String(args.id ?? '');
        if (!idArg) return fail('sf_get_record needs an id');
        const fields = Array.isArray(args.fields) ? (args.fields as unknown[]).map(String) : undefined;
        const r = await sfGetRecord(conn, token.data, object, idArg, fields);
        return r.ok ? { connection: c.name, ok: true, record: r.data, ...label } : fail(r.reason);
      }
      case SF_ACTION_TOOLS.search: {
        const where = Array.isArray(args.where)
          ? (args.where as unknown[])
              .map((w) => w as { field?: unknown; value?: unknown })
              .filter((w) => w && w.field !== undefined && w.value !== undefined)
              .map((w) => ({ field: String(w.field), value: String(w.value) }))
          : undefined;
        const fields = Array.isArray(args.fields) ? (args.fields as unknown[]).map(String) : [];
        const term = args.term !== undefined ? String(args.term) : undefined;
        const limit = args.limit !== undefined ? Number(args.limit) : undefined;
        const { soql, limit: effLimit } = buildSearchSoql({ object, fields, where, term, limit });
        const { sfQuery } = await import('@/lib/connections/salesforce');
        const page = await sfQuery(conn, token.data, soql);
        if (!page.ok) return fail(page.reason);
        const records = (page.data.records ?? []).map((r) => {
          const { attributes: _a, ...rest } = r as Record<string, unknown> & { attributes?: unknown };
          return rest;
        });
        return {
          connection: c.name,
          ok: true,
          records,
          // The page is FULL to the enforced limit ⇒ more rows may exist beyond it.
          truncated: records.length >= effLimit,
          ...label,
        };
      }
      case SF_ACTION_TOOLS.create: {
        const values = (args.values && typeof args.values === 'object') ? (args.values as Record<string, unknown>) : {};
        const r = await sfCreateRecord(conn, token.data, object, values);
        return r.ok ? { connection: c.name, ok: true, id: r.data.id, ...label } : fail(r.reason);
      }
      case SF_ACTION_TOOLS.update: {
        const idArg = String(args.id ?? '');
        if (!idArg) return fail('sf_update_record needs an id');
        const values = (args.values && typeof args.values === 'object') ? (args.values as Record<string, unknown>) : {};
        const r = await sfUpdateRecord(conn, token.data, object, idArg, values);
        return r.ok ? { connection: c.name, ok: true, id: r.data.id, ...label } : fail(r.reason);
      }
      case SF_ACTION_TOOLS.delete:
        return fail('delete is Blocked');
      default:
        return fail(`Unknown Salesforce action tool: ${tool}`);
    }
  } catch (err) {
    // Defensive: the client never throws, but a bad-name validation does — surface it.
    return fail(err instanceof Error ? err.message : 'Salesforce action failed');
  }
}
