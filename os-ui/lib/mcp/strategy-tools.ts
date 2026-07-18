/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/core/auth';
import type { McpTool, JsonSchema } from './server';

// --- The EXACT governed lib fns the Strategy UI + /api/strategy routes call ----
import {
  listPillars,
  getPillar,
  createPillar,
  updatePillar,
  setValueMetric,
  setHeadlineTarget,
  linkBet,
  unlinkBet,
  addValueEntry,
  archivePillar,
  unarchivePillar,
  deletePillar,
  promotePillar,
  demotePillar,
  restorePillarVersion,
} from '@/lib/strategy/pillars';
import { rollupForPillar, valueHistory } from '@/lib/strategy/value-rollup';
import { snapshotHistory } from '@/lib/strategy/snapshots';
import { recentStrategyAudit } from '@/lib/strategy/audit';
import {
  canEditPillar,
  METRIC_TYPES,
  HORIZONS,
  type PillarScope,
  type ValueMode,
  type MetricType,
  type Horizon,
} from '@/lib/strategy';
import { STUB_BET_CATALOGUE } from '@/lib/strategy/bets-bridge';

/**
 * THE STRATEGY MCP SURFACE (mcp-v2 P2). Six THIN wrappers over the SAME governed
 * `lib/strategy/*` functions the Strategy tab + `/api/strategy/*` routes call,
 * under the caller's delegated identity — so `canView/canCreate/canEditPillar`,
 * the RLS-scoped value roll-up, and the Langfuse strategy audit apply UNCHANGED.
 * No new engine, no forked logic: identity comes from the session, the role floor
 * is re-checked in `handleRpc`, and each lib fn is the real authority.
 *
 * HONESTY: `link_bet_to_pillar` validates the betId against the STUB bet
 * catalogue (`STUB_BET_CATALOGUE` via bets-bridge) — the SAME stub the UI links
 * against today; real Big Bet ids resolve when the bridge lands. The tool says so.
 */

const VALID_BET_IDS = STUB_BET_CATALOGUE.map((b) => b.id);

function fail(message: string, status: number): never {
  const e = new Error(message) as Error & { status?: number };
  e.status = status;
  throw e;
}
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

// ================================ READ =========================================
export const strategyReadTools: McpTool[] = [
  {
    name: 'list_pillars',
    tab: 'strategy',
    minRole: 'creator',
    description:
      'List the strategy pillars you can see (tenant pillars + your own domain pillars). Purpose: step 1 of the Strategy golden path — the value spine the whole org rolls up to. Before: whoami. After: get_pillar for one pillar’s value + rollup, or (Builder) create_pillar only if nothing fits. Governance: read-only, scoped by canViewPillar per row — a pillar in a domain you are not in never appears.',
    inputSchema: { type: 'object', properties: {}, examples: [{}] },
    call: async (user) => listPillars(user),
  },
  {
    name: 'get_pillar',
    tab: 'strategy',
    minRole: 'creator',
    description:
      'Read ONE strategy pillar you can see: its value metric + how the number is kept (describe/governed/manual), the RLS-scoped value roll-up (total distributed down to contributing bets, masked to YOUR entitled domains), the value history series, and the recent audit tail. Purpose: the read-back half of the Strategy golden path — read the real, RLS-correct value instead of assuming. Before: list_pillars. After: record_value_entry / link_bet_to_pillar (Builder). Governance: read-only; a pillar you cannot view is a typed forbidden/not_found (no existence leak), and per-bet values you are not entitled to are masked to null by the roll-up.',
    inputSchema: {
      type: 'object',
      properties: { pillarId: { type: 'string', description: 'Pillar id from list_pillars.' } },
      required: ['pillarId'],
      examples: [{ pillarId: 'pillar_ab12cd3' }],
    },
    call: async (user, args) => {
      const id = str(args.pillarId).trim();
      if (!id) fail('get_pillar needs a `pillarId` (from list_pillars)', 400);
      const pillar = await getPillar(user, id); // canViewPillar guard (403/404)
      const rollup = await rollupForPillar(pillar, user); // RLS-scoped to this caller
      return {
        pillar,
        rollup,
        history: valueHistory(pillar, snapshotHistory(pillar.id)),
        audit: recentStrategyAudit(pillar.id, 25),
        canEdit: canEditPillar(user, pillar),
      };
    },
  },
];

// ================================ WRITE ========================================
const VALUE_MODES: ValueMode[] = ['describe', 'governed', 'manual'];

export const strategyWriteTools: McpTool[] = [
  {
    name: 'create_pillar',
    tab: 'strategy',
    minRole: 'creator',
    description:
      'Create a strategy pillar (a personal/My, domain, or tenant/Company value spine), optionally describing its value metric up front. Purpose: frame the strategy the org rolls up to. Before: list_pillars (reuse first). After: link_bet_to_pillar to attach real bets, record_value_entry to track value, promote_pillar to raise its tier. Governance: canCreatePillar re-gates in-lib — a PERSONAL (My) pillar is open to any user in a domain they belong to; a DOMAIN pillar needs a Builder/Admin IN that domain; a TENANT pillar needs a platform Admin. A creator asking for domain/tenant is refused (forbidden) — create it My-scope (scope "personal") and hand off a promote to Domain.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Pillar name.' },
        description: { type: 'string', description: 'One-line what this pillar is about.' },
        scope: { type: 'string', enum: ['personal', 'domain', 'tenant'], description: 'personal (My — any user) · domain (Builder+) · tenant (Admin). Default: personal (My) — always start in My, then promote_pillar up the ladder.' },
        domain: { type: 'string', description: 'For a domain/personal pillar: one of YOUR domains (defaults to your first). A personal pillar keeps it as its home for a later My→Domain promote.' },
        valueMetric: {
          type: 'object',
          description: 'Optional value-metric description up front (mode starts "describe").',
          properties: { name: { type: 'string' }, description: { type: 'string' } },
        },
      },
      required: ['name'],
      examples: [
        { name: 'My retention focus', scope: 'personal', domain: 'sales' },
        { name: 'Grow Net Revenue Retention', scope: 'domain', domain: 'sales' },
        { name: 'Company value', scope: 'tenant', valueMetric: { name: 'ARR', description: 'Annual recurring revenue' } },
      ],
    },
    call: async (user, args) => {
      const name = str(args.name).trim();
      if (!name) fail('create_pillar needs a `name`', 400);
      const rawScope = str(args.scope);
      // Default to My (personal) — always start in My, then promote up the ladder.
      const scope = (rawScope === 'tenant' ? 'tenant' : rawScope === 'domain' ? 'domain' : 'personal') as PillarScope;
      const vm = args.valueMetric as { name?: unknown; description?: unknown } | undefined;
      return createPillar(user, {
        name,
        description: str(args.description) || '',
        scope,
        domain: str(args.domain) || undefined,
        valueMetric:
          vm && (vm.name || vm.description)
            ? { name: str(vm.name), description: str(vm.description) }
            : undefined,
      });
    },
  },
  {
    name: 'update_pillar',
    tab: 'strategy',
    minRole: 'builder',
    description:
      'Patch a pillar you can edit: its name/description, and/or its value-metric name + one-liner + mode (describe · governed [a Cube metric set up in Metrics] · manual [monthly entries]). Purpose: refine the pillar’s framing or how its value number is kept. Before: get_pillar. After: record_value_entry (manual mode) or link_bet_to_pillar. Governance: canEditPillar re-gates — a Builder for a domain pillar, an Admin for a tenant pillar; a creator or out-of-domain builder is refused (forbidden). Wraps updatePillar (name/description) + setValueMetric (value metric).',
    inputSchema: {
      type: 'object',
      properties: {
        pillarId: { type: 'string', description: 'Pillar id from list_pillars.' },
        name: { type: 'string', description: 'New pillar name.' },
        description: { type: 'string', description: 'New description.' },
        valueMetric: {
          type: 'object',
          description: 'Value-metric patch: name, description, mode, and/or metricType.',
          properties: {
            name: { type: 'string' },
            description: { type: 'string' },
            mode: { type: 'string', enum: ['describe', 'governed', 'manual'], description: 'How the value number is kept.' },
            metricType: { type: 'string', enum: METRIC_TYPES as string[], description: 'Headline value-metric type (drives target formatting).' },
            customUnit: { type: 'string', description: 'For metricType=custom: unit label (e.g. tickets).' },
            customMonetary: { type: 'boolean', description: 'For metricType=custom: whether it is monetary (→ tenant currency).' },
          },
        },
      },
      required: ['pillarId'],
      examples: [
        { pillarId: 'pillar_ab12cd3', description: 'Revised framing for FY26.' },
        { pillarId: 'pillar_ab12cd3', valueMetric: { name: 'NRR', mode: 'manual' } },
        { pillarId: 'pillar_ab12cd3', valueMetric: { metricType: 'time-back-hours' } },
      ],
    },
    call: async (user, args) => {
      const id = str(args.pillarId).trim();
      if (!id) fail('update_pillar needs a `pillarId`', 400);
      const hasCore = args.name !== undefined || args.description !== undefined;
      const vm = args.valueMetric as
        | { name?: unknown; description?: unknown; mode?: unknown; metricType?: unknown; customUnit?: unknown; customMonetary?: unknown }
        | undefined;
      if (!hasCore && !vm) fail('update_pillar needs at least `name`, `description`, or `valueMetric`', 400);
      let pillar;
      if (hasCore) {
        pillar = await updatePillar(user, id, {
          name: args.name !== undefined ? str(args.name) : undefined,
          description: args.description !== undefined ? str(args.description) : undefined,
        });
      }
      if (vm) {
        const mode = VALUE_MODES.includes(str(vm.mode) as ValueMode) ? (str(vm.mode) as ValueMode) : undefined;
        const metricType = METRIC_TYPES.includes(str(vm.metricType) as MetricType) ? (str(vm.metricType) as MetricType) : undefined;
        pillar = await setValueMetric(user, id, {
          name: vm.name !== undefined ? str(vm.name) : undefined,
          description: vm.description !== undefined ? str(vm.description) : undefined,
          mode,
          metricType,
          customUnit: vm.customUnit !== undefined ? str(vm.customUnit) : undefined,
          customMonetary: vm.customMonetary !== undefined ? Boolean(vm.customMonetary) : undefined,
        });
      }
      return pillar;
    },
  },
  {
    name: 'link_bet_to_pillar',
    tab: 'strategy',
    minRole: 'builder',
    description:
      'Link (or unlink) a Big Bet to a pillar, so the bet contributes to the pillar’s value roll-up (shares re-normalise so they reconcile). Purpose: connect an initiative to the strategy it moves. Before: get_pillar. After: get_pillar to see the bet in the roll-up. Governance: canEditPillar re-gates (Builder domain / Admin tenant). HONESTY: the betId is validated against the STUB bet catalogue (bets-bridge) — the SAME stub the UI links against today; real Big Bet ids resolve when the bridge lands. An unknown bet is a typed not_found.',
    inputSchema: {
      type: 'object',
      properties: {
        pillarId: { type: 'string', description: 'Pillar id from list_pillars.' },
        betId: { type: 'string', description: `Big Bet id — currently one of the stub catalogue: ${VALID_BET_IDS.join(', ')}.` },
        action: { type: 'string', enum: ['link', 'unlink'], description: 'Default: link.' },
      },
      required: ['pillarId', 'betId'],
      examples: [{ pillarId: 'pillar_ab12cd3', betId: VALID_BET_IDS[0] ?? 'bet_stub', action: 'link' }],
    },
    call: async (user, args) => {
      const id = str(args.pillarId).trim();
      const betId = str(args.betId).trim();
      if (!id) fail('link_bet_to_pillar needs a `pillarId`', 400);
      if (!betId) fail('link_bet_to_pillar needs a `betId`', 400);
      return str(args.action) === 'unlink' ? unlinkBet(user, id, betId) : linkBet(user, id, betId);
    },
  },
  {
    name: 'record_value_entry',
    tab: 'strategy',
    minRole: 'builder',
    description:
      'Record a manual monthly value for a pillar’s value metric (switches the metric to manual mode). The newest entry is the headline total; the series feeds the value-history chart; re-entering a month replaces it. Purpose: track realized value on a pillar whose number is kept by hand. Before: get_pillar. After: get_pillar to read the updated roll-up + history. Governance: canEditPillar re-gates (Builder domain / Admin tenant); a creator is refused (forbidden).',
    inputSchema: {
      type: 'object',
      properties: {
        pillarId: { type: 'string', description: 'Pillar id from list_pillars.' },
        value: { type: 'number', description: 'The value for the month (e.g. EUR).' },
        month: { type: 'string', description: 'Optional YYYY-MM (defaults to the current month).' },
      },
      required: ['pillarId', 'value'],
      examples: [{ pillarId: 'pillar_ab12cd3', value: 2400000, month: '2026-06' }],
    },
    call: async (user, args) => {
      const id = str(args.pillarId).trim();
      if (!id) fail('record_value_entry needs a `pillarId`', 400);
      const value = Number(args.value);
      if (!Number.isFinite(value)) fail('record_value_entry needs a numeric `value`', 400);
      const month = str(args.month).trim() || undefined;
      return addValueEntry(user, id, { value, month });
    },
  },
  {
    name: 'set_pillar_target',
    tab: 'strategy',
    minRole: 'builder',
    description:
      'Set a pillar’s HEADLINE target — the card’s big number: a target `value` measured by a `metricType` (ebit · revenue · time-back-hours · risks-mitigated · custom) over a `horizon` (year-end · 6/12/24/36-month). The server derives the end date (year-end = Dec 31 this year; N-month = today + N months) and stamps the metricType onto the value metric so the total formats to match (monetary → the tenant currency set in Admin; hours → "h"; risks → count). The "so far" figure flows from record_value_entry / the governed value. Before: get_pillar. After: record_value_entry to report progress, get_pillar to read it back. Governance: canEditPillar re-gates (Builder domain / Admin tenant); a creator is refused (forbidden).',
    inputSchema: {
      type: 'object',
      properties: {
        pillarId: { type: 'string', description: 'Pillar id from list_pillars.' },
        value: { type: 'number', description: 'The target value (e.g. 2500000 for €2.5M, or 1200 hours).' },
        metricType: { type: 'string', enum: METRIC_TYPES as string[], description: 'What the number measures. Default: ebit.' },
        horizon: { type: 'string', enum: HORIZONS as string[], description: 'Target horizon. Default: year-end (Dec 31 this year).' },
      },
      required: ['pillarId', 'value'],
      examples: [
        { pillarId: 'pillar_ab12cd3', value: 2500000, metricType: 'ebit', horizon: 'year-end' },
        { pillarId: 'pillar_ab12cd3', value: 1200, metricType: 'time-back-hours', horizon: '12-month' },
      ],
    },
    call: async (user, args) => {
      const id = str(args.pillarId).trim();
      if (!id) fail('set_pillar_target needs a `pillarId`', 400);
      const value = Number(args.value);
      if (!Number.isFinite(value)) fail('set_pillar_target needs a numeric `value`', 400);
      const metricType = METRIC_TYPES.includes(str(args.metricType) as MetricType)
        ? (str(args.metricType) as MetricType)
        : 'ebit';
      const horizon = HORIZONS.includes(str(args.horizon) as Horizon)
        ? (str(args.horizon) as Horizon)
        : 'year-end';
      return setHeadlineTarget(user, id, { value, metricType, horizon });
    },
  },
  // ----------------------------- lifecycle -------------------------------------
  // The SAME reversible archive → restore-or-delete + promote-ladder + version
  // history the Strategy tab exposes, each a THIN wrapper over the store's own
  // edit/promote gate (canEditPillar / canPromotePillar). No new role floor is
  // invented here — the visibility floor is `builder` (the write floor), and the
  // store re-gates: a My pillar's owner (any role) still edits/archives their own.
  {
    name: 'archive_pillar',
    tab: 'strategy',
    minRole: 'builder',
    description:
      'Archive a pillar you can edit — a reversible soft-hide that removes it from the working list (retained + restorable). Purpose: retire a pillar without destroying its history. Before: get_pillar. After: unarchive_pillar to bring it back, or delete_pillar once archived. Governance: canEditPillar re-gates in-lib (a My pillar → its owner; a Domain pillar → a Builder in that domain; a Company pillar → an Admin). A creator or out-of-domain builder is refused (forbidden).',
    inputSchema: {
      type: 'object',
      properties: { pillarId: { type: 'string', description: 'Pillar id from list_pillars.' } },
      required: ['pillarId'],
      examples: [{ pillarId: 'pillar_ab12cd3' }],
    },
    call: async (user, args) => {
      const id = str(args.pillarId).trim();
      if (!id) fail('archive_pillar needs a `pillarId`', 400);
      return archivePillar(user, id);
    },
  },
  {
    name: 'unarchive_pillar',
    tab: 'strategy',
    minRole: 'builder',
    description:
      'Restore an archived pillar back into the working list. Purpose: undo an archive. Before: list_pillars (archived pillars are hidden from the default list — the owner/editor knows the id). After: get_pillar. Governance: canEditPillar re-gates in-lib exactly like archive_pillar.',
    inputSchema: {
      type: 'object',
      properties: { pillarId: { type: 'string', description: 'Pillar id (an archived pillar you can edit).' } },
      required: ['pillarId'],
      examples: [{ pillarId: 'pillar_ab12cd3' }],
    },
    call: async (user, args) => {
      const id = str(args.pillarId).trim();
      if (!id) fail('unarchive_pillar needs a `pillarId`', 400);
      return unarchivePillar(user, id);
    },
  },
  {
    name: 'delete_pillar',
    tab: 'strategy',
    minRole: 'builder',
    description:
      'Physically delete a pillar + its version history (edit-scoped, IRREVERSIBLE). Purpose: permanently remove a pillar you no longer need. Before: archive_pillar (the OS lifecycle reaches delete via archive), and unlink any bets. Safe-by-default: a pillar that still has LINKED bets is BLOCKED (conflict/409) — unlink them first (they live on in the Big Bets tab); a delete never strands or destroys the bets that deliver it. Governance: canEditPillar re-gates in-lib.',
    inputSchema: {
      type: 'object',
      properties: { pillarId: { type: 'string', description: 'Pillar id to permanently delete (unlink its bets first).' } },
      required: ['pillarId'],
      examples: [{ pillarId: 'pillar_ab12cd3' }],
    },
    call: async (user, args) => {
      const id = str(args.pillarId).trim();
      if (!id) fail('delete_pillar needs a `pillarId`', 400);
      await deletePillar(user, id);
      return { deleted: true, pillarId: id };
    },
  },
  {
    name: 'promote_pillar',
    tab: 'strategy',
    minRole: 'builder',
    description:
      'Promote a pillar ONE tier up the ladder My (personal) → Domain → Company (tenant), mirroring the OS promote ladder. Purpose: widen a pillar’s reach once it is proven. Before: get_pillar. After: get_pillar to read the new scope. Governance: canPromotePillar re-gates in-lib — the OWNER (or an Admin) initiates; promoting TO Domain needs a Builder+ in the owning domain, promoting TO Company needs an Admin. Already at Company → bad_request. A pillar promoted to Company re-homes to the tenant scope.',
    inputSchema: {
      type: 'object',
      properties: { pillarId: { type: 'string', description: 'Pillar id from list_pillars.' } },
      required: ['pillarId'],
      examples: [{ pillarId: 'pillar_ab12cd3' }],
    },
    call: async (user, args) => {
      const id = str(args.pillarId).trim();
      if (!id) fail('promote_pillar needs a `pillarId`', 400);
      return promotePillar(user, id);
    },
  },
  {
    name: 'demote_pillar',
    tab: 'strategy',
    minRole: 'builder',
    description:
      'Demote (revoke sharing on) a pillar ONE tier DOWN the ladder Company (tenant) → Domain → My (personal) — the mirror of promote_pillar. Purpose: narrow a pillar’s reach (unshare) without deleting it. Before: get_pillar. After: get_pillar to read the new scope. Governance: canDemotePillar re-gates in-lib (the SAME gates as the OS artifact demote ladder) — revoking FROM Company needs an Admin; unsharing FROM Domain needs the owner, an in-domain Builder+, or an Admin. Already at My → bad_request. Revoking from Company re-homes it into the acting Admin’s first domain.',
    inputSchema: {
      type: 'object',
      properties: { pillarId: { type: 'string', description: 'Pillar id from list_pillars.' } },
      required: ['pillarId'],
      examples: [{ pillarId: 'pillar_ab12cd3' }],
    },
    call: async (user, args) => {
      const id = str(args.pillarId).trim();
      if (!id) fail('demote_pillar needs a `pillarId`', 400);
      return demotePillar(user, id);
    },
  },
  {
    name: 'restore_pillar_version',
    tab: 'strategy',
    minRole: 'builder',
    description:
      'Restore a prior version of a pillar’s editable content (name, description, value metric, targets, archived flag). Restore is itself reversible — the current state is snapshotted first. Purpose: roll a pillar back to an earlier framing. Before: get_pillar (the audit tail lists versions; each version has a number). After: get_pillar to read the restored content. Governance: canEditPillar re-gates in-lib. Scope/domain/linked bets are governed relationships and are NOT moved by a restore (so a restore can never bypass the promote gate).',
    inputSchema: {
      type: 'object',
      properties: {
        pillarId: { type: 'string', description: 'Pillar id from list_pillars.' },
        versionId: { type: 'number', description: 'The version number to restore.' },
      },
      required: ['pillarId', 'versionId'],
      examples: [{ pillarId: 'pillar_ab12cd3', versionId: 2 }],
    },
    call: async (user, args) => {
      const id = str(args.pillarId).trim();
      if (!id) fail('restore_pillar_version needs a `pillarId`', 400);
      const version = Number(args.versionId);
      if (!Number.isInteger(version)) fail('restore_pillar_version needs an integer `versionId`', 400);
      return restorePillarVersion(user, id, version);
    },
  },
];

export const STRATEGY_TOOLS: McpTool[] = [...strategyReadTools, ...strategyWriteTools];
