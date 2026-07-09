/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/auth';
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
} from '@/lib/strategy/model';
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
    minRole: 'builder',
    description:
      'Create a strategy pillar (a tenant or domain value spine), optionally describing its value metric up front. Purpose: frame the strategy the org rolls up to. Before: list_pillars (reuse first). After: link_bet_to_pillar to attach real bets, record_value_entry to track value. Governance: canCreatePillar re-gates in-lib — a DOMAIN pillar needs a Builder/Admin IN that domain; a TENANT pillar needs a platform Admin. A creator is refused (forbidden).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Pillar name.' },
        description: { type: 'string', description: 'One-line what this pillar is about.' },
        scope: { type: 'string', enum: ['tenant', 'domain'], description: 'tenant (Admin) or domain (Builder+). Default: domain.' },
        domain: { type: 'string', description: 'For a domain pillar: one of YOUR domains (defaults to your first).' },
        valueMetric: {
          type: 'object',
          description: 'Optional value-metric description up front (mode starts "describe").',
          properties: { name: { type: 'string' }, description: { type: 'string' } },
        },
      },
      required: ['name'],
      examples: [
        { name: 'Grow Net Revenue Retention', scope: 'domain', domain: 'sales' },
        { name: 'Company value', scope: 'tenant', valueMetric: { name: 'ARR', description: 'Annual recurring revenue' } },
      ],
    },
    call: async (user, args) => {
      const name = str(args.name).trim();
      if (!name) fail('create_pillar needs a `name`', 400);
      const scope = (str(args.scope) === 'tenant' ? 'tenant' : 'domain') as PillarScope;
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
];

export const STRATEGY_TOOLS: McpTool[] = [...strategyReadTools, ...strategyWriteTools];
