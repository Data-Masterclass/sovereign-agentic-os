/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/core/auth';
import type { McpTool, JsonSchema } from './server';
import {
  P, mcpToken, fail, str, num, bool, strArr, slug, rand, defaultGoLive,
  colDocs, mapSteps, mapRules, mapActors, normFiles,
  type Principal,
} from './write-common';

// --- Governed lib functions (the EXACT same the UI + /api routes call) ---------
import {
  createDataset,
  buildVersion,
  setDocs as setDatasetDocs,
  requestPromotion as requestDatasetPromotion,
  getDataset,
  archiveDataset,
  deleteDataset,
  defineMeasure,
  buildGoldJoin as commitGoldJoin,
  addCheck,
  builtLayerFqn,
  type PromotionRequest,
} from '@/lib/data/store';
import { runQualityChecks } from '@/lib/data/dq-run';
import { DATA_CHECK_RULES, type DataCheckRule } from '@/lib/data';
import { queryRun } from '@/lib/infra/governed';
import { publishPromotionLive } from '@/lib/data/publish-server';
import { enqueue, getApproval, decide, listApprovals } from '@/lib/governance/approvals';
import { canBuildStage, canPassThrough, stageArtifact } from '@/lib/data/panels';
import { scaffoldCubeYaml } from '@/lib/data/metrics';
import { ingestAndRegisterBronze } from '@/lib/data/ingest';
import { buildStage, commitLayerVersion } from '@/lib/data/build/server';
import {
  silverPlan,
  goldJoinPlan,
  goldMeasureToCube,
  CAST_TYPES,
  type TransformOp,
  type ResolvedJoin,
  type GoldDimension,
  type GoldMeasure,
  type JoinType,
} from '@/lib/data/transform';
import { assetTarget } from '@/lib/data/store-fqn';
import type { ExecuteIdentity } from '@/lib/infra/governed';
import type { Layer, Quality, DataVisibility, Grant, ColumnDoc, DatasetUpstream } from '@/lib/data';
import { measureFromForm, measureMember, type MetricForm, type GuidedFilter, type GuidedWindow } from '@/lib/metrics/model';
import type { MeasureType } from '@/lib/data/metrics';
import { buildMetric } from '@/lib/metrics/build/server';
import { exploreMetric } from '@/lib/metrics/build/explore-server';
import type { Granularity } from '@/lib/metrics/explorer';
import { getMetric } from '@/lib/metrics/store';
import { governMetric, canPromote as canPromoteMetric } from '@/lib/metrics/governance';
import { transition as transitionDataset } from '@/lib/data/store';

import {
  createWorkflow,
  updateWorkflow,
  updateTacit,
  getWorkflow,
  getDomainKnowledge,
  archiveWorkflow,
  deleteWorkflow,
} from '@/lib/knowledge/store';
import { knowledgeConsumers } from '@/lib/knowledge/consumers';
import { fileArtifactPromotion, promoteThroughSeam, isLadderKind, type LadderKind } from '@/lib/governance/ladder';
import { pendingHandle } from '@/lib/mcp/pending';
import {
  serializeWorkflow,
  deriveActors,
  ACTOR_TYPES,
  type Workflow,
  type WorkflowStep,
  type WorkflowRule,
  type ActorType,
  type Actor,
} from '@/lib/knowledge/schema';
import { indexWorkflow, indexDomain, purgeKnowledgeUnits } from '@/lib/knowledge/index-pipeline';

import {
  createFile,
  setDocs as setFileDocs,
  attachObject,
  objectKeyForAsset,
  requestPromotion as requestFilePromotion,
  applyApprovedFilePromotion,
  type FilePromotionRequest,
} from '@/lib/files/store';
import { reindexFile } from '@/lib/files/pipeline-server';
import { putBlob } from '@/lib/files/object-store';
import type { Sensitivity } from '@/lib/files/asset-schema';

import { saveDashboard } from '@/lib/dashboards/store';
import { fromTiles, type ChartSpec } from '@/lib/dashboards/model';
import { claimsFromUser, delegate } from '@/lib/data/identity';

import {
  createBet,
  getBet,
  updateBet,
  addComponent,
  archiveBet,
  unarchiveBet,
  deleteBet,
  restoreBetVersion,
  setBetWorkflow,
  wireComponents,
  unwireComponents,
  canEdit as canEditBet,
  type CreateBetInput,
} from '@/lib/bigbets/store';
import { getPillar } from '@/lib/strategy/pillars';
import { deriveBetName, INTERPLAY_RELATIONS, type BigBet, type InterplayRelation, type Tab as BetTab, type ValueBasis } from '@/lib/bigbets';
import { resolveLinkedComponent } from '@/lib/bigbets/attach-server';

import {
  createSystem,
  writeFile as writeAgentFile,
  getSystemForEdit,
  getSystemForRun,
} from '@/lib/agents/store';
import { isTemplateKey } from '@/lib/agents/templates';
import { buildSystem } from '@/lib/agents/build/server';

import { patchAppDesign, getAppForUser, type AppEpic } from '@/lib/software/apps';
import { normalizeContextGrants } from '@/lib/core/context-grants';

// =============================== BIG BETS =====================================
export const bigbetWriteTools: McpTool[] = [
  {
    name: 'create_big_bet',
    tab: 'bigbets',
    minRole: 'creator',
    description:
      'Frame a Big Bet (also called: initiative, strategic investment, project) — an initiative roadmap over real OS components — under a REAL strategy pillar it rolls up to. A creator files a draft; a Builder/Admin owns an active bet (cross-domain bets are Admin-only). Same governed store as the Big Bets tab. Containment: `pillarId` is REQUIRED and re-resolved through canViewPillar FIRST — a pillar you cannot see is a typed not_found/forbidden, so a bet can never be filed under an unseen pillar. Before: list_pillars (pick the pillar this bet delivers). After: attach_component to hang real artifacts, get_big_bet to read the derived status back.',
    inputSchema: {
      type: 'object',
      properties: {
        problem: { type: 'string', description: 'The problem statement (the bet’s name is derived from it unless `name` given).' },
        pillarId: { type: 'string', description: 'The strategy pillar this bet rolls up to (REQUIRED, from list_pillars — must be one you can view).' },
        owner: { type: 'string', description: 'Who owns the problem (goes into the problem statement’s "who").' },
        solution: { type: 'string', description: 'Optional solution idea.' },
        metricId: { type: 'string', description: 'Optional north-star metric id to associate.' },
        targetValue: { type: 'number', description: 'Value target.' },
        goLive: { type: 'string', description: 'Planned go-live YYYY-MM-DD (default +8 weeks).' },
        domain: { type: 'string', description: 'One of YOUR domains; defaults to your first.' },
        name: { type: 'string', description: 'Optional explicit display name.' },
      },
      required: ['problem', 'pillarId'],
      examples: [{ problem: 'Churn is rising among SMB accounts', pillarId: 'pillar_ab12cd3', owner: 'ben', solution: 'Proactive health-score outreach', targetValue: 250000 }],
    },
    call: async (user, args) => {
      const problem = str(args.problem).trim();
      if (!problem) fail('create_big_bet needs a `problem` statement', 400);
      const pillarId = str(args.pillarId).trim();
      if (!pillarId) fail('create_big_bet needs a `pillarId` (from list_pillars)', 400);
      // Containment: re-resolve the pillar through its own canViewPillar gate
      // FIRST — an id you cannot see is a typed not_found/forbidden.
      await getPillar(user, pillarId);
      const metricId = str(args.metricId).trim();
      const input: CreateBetInput = {
        name: str(args.name).trim() || deriveBetName(problem),
        problem: { who: str(args.owner), need: problem, obstacle: '', impact: '' },
        solution: str(args.solution) || undefined,
        pillarId,
        metricId: metricId || undefined,
        targetValue: num(args.targetValue),
        goLive: str(args.goLive) || defaultGoLive(),
        domain: str(args.domain) || undefined,
      };
      const bet = createBet(P(user), input);
      return { id: bet.id, name: bet.name, status: bet.status };
    },
  },
  {
    name: 'attach_component',
    tab: 'bigbets',
    minRole: 'creator',
    description:
      'ATTACH a real OS component — a dataset, a dashboard or an agent system — to a Big Bet you may edit. The bet records a REFERENCE (id · planned-ready date · weight), never a copy; progress is then DERIVED from the component’s real lifecycle. Purpose: the operate half of the Big Bets golden path — a bet over real running artifacts, not a slide. Before: create_big_bet (or list_big_bets), and the component must exist — pick it from list_datasets / list_dashboards / list_agent_systems. After: get_big_bet to read the roadmap + derived status back. Governance: runs AS YOU — the bet edit gate is the store’s own (the owner edits; cross-domain bets are Admin-only), and EVERY component id is re-resolved through its own tab’s canView gate FIRST: an id you cannot see is a typed not_found/forbidden, so a forged id can never attach an unseen component. Idempotency: re-attaching the same artifact adds a second roadmap reference — check get_big_bet first.',
    inputSchema: {
      type: 'object',
      properties: {
        betId: { type: 'string', description: 'The Big Bet to attach to (from list_big_bets).' },
        kind: { type: 'string', enum: ['dataset', 'dashboard', 'agent-system'], description: 'What kind of component the id names.' },
        id: { type: 'string', description: 'The component id — a dataset id, dashboard id or agent-system id YOU can see.' },
        plannedReady: { type: 'string', description: 'Planned-ready date yyyy-mm-dd (default: +4 weeks).' },
        start: { type: 'string', description: 'Optional start date yyyy-mm-dd (default: today).' },
        weight: { type: 'number', description: 'Optional manual allocation weight 0–100 (when the bet allocates manually).' },
      },
      required: ['betId', 'kind', 'id'],
      examples: [{ betId: 'bet_ab12cd34', kind: 'dashboard', id: 'dash_sales_overview_ab12cd', plannedReady: '2026-09-01' }],
    },
    call: async (user, args) => {
      const betId = str(args.betId).trim();
      if (!betId) fail('attach_component needs a `betId` (from list_big_bets)', 400);
      const id = str(args.id).trim();
      if (!id) fail('attach_component needs the component `id`', 400);
      const kind = str(args.kind);
      if (!['dataset', 'dashboard', 'agent-system'].includes(kind)) {
        fail('attach_component needs `kind` = "dataset" | "dashboard" | "agent-system"', 400);
      }
      const p = P(user);
      // Edit gate FIRST (the store's own rule) — no side effect on a forbidden bet.
      const bet = getBet(betId, p); // view guard (403/404)
      if (!canEditBet(bet, p)) fail('Not permitted to edit this bet', 403);

      // Re-resolve the component through ITS OWN canView gate (shared helper) — a
      // forged/unseen id is a typed not_found/forbidden BEFORE anything is attached.
      // Map the legacy kind names to their tab: dataset→data, agent-system→agent.
      const LEGACY_TAB: Record<string, BetTab> = { dataset: 'data', dashboard: 'dashboard', 'agent-system': 'agent' };
      const art = await resolveLinkedComponent(LEGACY_TAB[kind], id, user);
      const plannedReady = str(args.plannedReady).trim() || new Date(Date.now() + 28 * 86400000).toISOString().slice(0, 10);
      const { ref } = addComponent(betId, { ...p, kind: 'human' }, {
        tab: art.tab,
        artifactId: art.id,
        plannedReady,
        start: str(args.start).trim() || undefined,
        weight: typeof args.weight === 'number' ? args.weight : undefined,
      });
      return { betId, refId: ref.id, artifactId: ref.artifactId, tab: ref.tab, title: art.title, plannedReady: ref.plannedReady, origin: ref.origin };
    },
  },
  // ---- SOLUTION BLUEPRINT (the runtime interplay graph over a bet's components) --
  // The anchor workflow + typed interplay edges the Design canvas renders. Distinct
  // from the roadmap dependsOn (build order) — these describe how the FINISHED pieces
  // work together at run time. All three are edit-gated in the store (the owner edits;
  // cross-domain bets are Admin-only), no new role floor invented.
  {
    name: 'attach_bet_component',
    tab: 'bigbets',
    minRole: 'creator',
    description:
      'ATTACH any of the NINE kinds of real OS component to a Big Bet you may edit — a dataset, dashboard, agent system, knowledge workflow, metric, file, ML model, software app or connection. Superset of `attach_component` (which handles dataset/dashboard/agent only). The bet records a REFERENCE (id · planned-ready date), never a copy; progress is DERIVED from the component’s real lifecycle. Purpose: build out the solution in the Big Bets Design wizard — the anchor workflow (attach a `knowledge` kind, then set_bet_workflow), the solution components (agent/software/ml/dashboard) and the context (data/metric/knowledge/files/connection). Before: the component must exist — pick it from the matching list_* tool. After: wire_bet_components to draw the interplay, get_bet_solution to read the blueprint back. Governance: runs AS YOU — the bet edit gate is the store’s own, and EVERY component id is re-resolved through its OWN tab’s canView gate FIRST (an id you cannot see is a typed not_found/forbidden), so a forged id can never attach an unseen component. Idempotency: re-attaching the same artifact adds a second reference — check get_bet_solution first.',
    inputSchema: {
      type: 'object',
      properties: {
        betId: { type: 'string', description: 'The Big Bet to attach to (from list_big_bets).' },
        kind: { type: 'string', enum: ['data', 'metric', 'dashboard', 'software', 'agent', 'ml', 'knowledge', 'files', 'connection'], description: 'Which tab the component id lives in.' },
        id: { type: 'string', description: 'The component id YOU can see (a dataset/dashboard/agent/knowledge/metric/file/model/app/connection id).' },
        plannedReady: { type: 'string', description: 'Planned-ready date yyyy-mm-dd (default: +4 weeks).' },
        start: { type: 'string', description: 'Optional start date yyyy-mm-dd (default: today).' },
        weight: { type: 'number', description: 'Optional manual allocation weight 0–100.' },
      },
      required: ['betId', 'kind', 'id'],
      examples: [
        { betId: 'bet_ab12cd34', kind: 'knowledge', id: 'wf_ab12cd', plannedReady: '2026-09-01' },
        { betId: 'bet_ab12cd34', kind: 'software', id: 'app_ab12cd' },
      ],
    },
    call: async (user, args) => {
      const betId = str(args.betId).trim();
      if (!betId) fail('attach_bet_component needs a `betId` (from list_big_bets)', 400);
      const id = str(args.id).trim();
      if (!id) fail('attach_bet_component needs the component `id`', 400);
      const kind = str(args.kind) as BetTab;
      const KINDS: BetTab[] = ['data', 'metric', 'dashboard', 'software', 'agent', 'ml', 'knowledge', 'files', 'connection'];
      if (!KINDS.includes(kind)) fail(`attach_bet_component needs \`kind\` = ${KINDS.join(' | ')}`, 400);
      const p = P(user);
      // Edit gate FIRST (the store's own rule) — no side effect on a forbidden bet.
      const bet = getBet(betId, p); // view guard (403/404)
      if (!canEditBet(bet, p)) fail('Not permitted to edit this bet', 403);
      // Re-resolve through the component's OWN canView gate (all 9 kinds).
      const art = await resolveLinkedComponent(kind, id, user);
      const plannedReady = str(args.plannedReady).trim() || new Date(Date.now() + 28 * 86400000).toISOString().slice(0, 10);
      const { ref } = addComponent(betId, { ...p, kind: 'human' }, {
        tab: art.tab,
        artifactId: art.id,
        plannedReady,
        start: str(args.start).trim() || undefined,
        weight: typeof args.weight === 'number' ? args.weight : undefined,
      });
      return { betId, refId: ref.id, artifactId: ref.artifactId, tab: ref.tab, title: art.title, plannedReady: ref.plannedReady, origin: ref.origin };
    },
  },
  {
    name: 'set_bet_workflow',
    tab: 'bigbets',
    minRole: 'creator',
    description:
      'Set (or move, or clear) a Big Bet’s ANCHOR WORKFLOW — the single knowledge/workflow component that anchors the solution blueprint. Invariant enforced in the store: EXACTLY ONE component may be the anchor, and it MUST be a `knowledge` (workflow) component already attached to the bet (attach it with attach_bet_component kind:"knowledge" first). Pass its ComponentRef id OR the underlying workflow artifact id; pass none (or empty) to CLEAR the anchor. Purpose: step 1 of the Big Bets Design wizard. After: attach solution components + wire_bet_components. Governance: runs AS YOU through the SAME store edit gate as the Big Bets tab (the owner edits their bet; cross-domain bets are Admin-only) — an unseen id is a typed not_found/forbidden; a non-knowledge anchor is a typed bad_request.',
    inputSchema: {
      type: 'object',
      properties: {
        betId: { type: 'string', description: 'The Big Bet to set the anchor on (from list_big_bets).' },
        refId: { type: 'string', description: 'The anchor’s ComponentRef id (from get_bet_solution) OR the workflow artifact id. Omit/empty to CLEAR the anchor.' },
      },
      required: ['betId'],
      examples: [{ betId: 'bet_ab12cd34', refId: 'ref_ab12cd' }, { betId: 'bet_ab12cd34' }],
    },
    call: async (user, args) => {
      const betId = str(args.betId).trim();
      if (!betId) fail('set_bet_workflow needs a `betId` (from list_big_bets)', 400);
      const refId = str(args.refId).trim() || undefined;
      setBetWorkflow(betId, refId, P(user)); // store edit gate + single-anchor + knowledge invariant
      return { betId, anchorCleared: !refId, ...(refId ? { anchorRefOrArtifact: refId } : {}) };
    },
  },
  {
    name: 'wire_bet_components',
    tab: 'bigbets',
    minRole: 'creator',
    description:
      'WIRE a typed interplay edge between two of a Big Bet’s attached components — how the FINISHED pieces work together at run time (a dashboard `consumes` a metric; an agent `triggers` a workflow; a model `feeds` a dashboard). Distinct from the roadmap’s build-order dependsOn — a separate graph with separate semantics. `from`/`to` are ComponentRef ids (from get_bet_solution), never artifact ids; `relation` ∈ consumes | produces | triggers | feeds | monitors. Purpose: step 2 of the Big Bets Design wizard — draw the solution interplay canvas. Governance: runs AS YOU through the SAME store edit gate as the Big Bets tab. Validation (in-store): both refs must be on THIS bet (else not_found), no self-edge (bad_request), a valid relation (bad_request) and no duplicate edge (same from/to/relation → conflict).',
    inputSchema: {
      type: 'object',
      properties: {
        betId: { type: 'string', description: 'The Big Bet whose components to wire (from list_big_bets).' },
        from: { type: 'string', description: 'Source ComponentRef id (from get_bet_solution).' },
        to: { type: 'string', description: 'Target ComponentRef id (from get_bet_solution).' },
        relation: { type: 'string', enum: [...INTERPLAY_RELATIONS], description: 'The interplay relation.' },
      },
      required: ['betId', 'from', 'to', 'relation'],
      examples: [{ betId: 'bet_ab12cd34', from: 'ref_data1', to: 'ref_agent1', relation: 'feeds' }],
    },
    call: async (user, args) => {
      const betId = str(args.betId).trim();
      if (!betId) fail('wire_bet_components needs a `betId` (from list_big_bets)', 400);
      const from = str(args.from).trim();
      const to = str(args.to).trim();
      if (!from || !to) fail('wire_bet_components needs `from` and `to` ComponentRef ids (from get_bet_solution)', 400);
      const relation = str(args.relation) as InterplayRelation;
      if (!INTERPLAY_RELATIONS.includes(relation)) {
        fail(`wire_bet_components needs \`relation\` = ${INTERPLAY_RELATIONS.join(' | ')}`, 400);
      }
      const { edge } = wireComponents(betId, from, to, relation, P(user)); // store edit gate + validation
      return { betId, edgeId: edge.id, from: edge.from, to: edge.to, relation: edge.relation };
    },
  },
  {
    name: 'unwire_bet_components',
    tab: 'bigbets',
    minRole: 'creator',
    description:
      'REMOVE an interplay edge from a Big Bet’s solution blueprint by its edge id (from get_bet_solution). The inverse of wire_bet_components — the components themselves stay attached; only the interplay edge is dropped. Governance: runs AS YOU through the SAME store edit gate as the Big Bets tab (the owner edits their bet; cross-domain bets are Admin-only). Idempotency: an unknown edge id is a typed not_found.',
    inputSchema: {
      type: 'object',
      properties: {
        betId: { type: 'string', description: 'The Big Bet whose edge to remove (from list_big_bets).' },
        edgeId: { type: 'string', description: 'The interplay edge id to remove (from get_bet_solution).' },
      },
      required: ['betId', 'edgeId'],
      examples: [{ betId: 'bet_ab12cd34', edgeId: 'edge_ab12cd' }],
    },
    call: async (user, args) => {
      const betId = str(args.betId).trim();
      if (!betId) fail('unwire_bet_components needs a `betId` (from list_big_bets)', 400);
      const edgeId = str(args.edgeId).trim();
      if (!edgeId) fail('unwire_bet_components needs an `edgeId` (from get_bet_solution)', 400);
      unwireComponents(betId, edgeId, P(user)); // store edit gate + 404 on unknown edge
      return { betId, edgeId, removed: true };
    },
  },
  {
    name: 'update_big_bet',
    tab: 'bigbets',
    minRole: 'creator',
    description:
      'UPDATE a Big Bet you may edit — the solution idea, status (draft | active | shipped | archived), the € target, the go-live date, the value basis, the owner-declared REALIZED value, or the name. Progress itself is DERIVED from the attached components’ real lifecycle and can never be hand-set here — read it back with get_big_bet. Purpose: the iterate half of the Big Bets golden path. Before: create_big_bet / get_big_bet. After: get_big_bet to read the derived state + realized value back. Governance: runs AS YOU through the SAME store gate as the Big Bets tab (the owner edits their bet — a creator their draft; cross-domain bets are Admin-only; no new role floors invented here). An unseen id is a typed not_found/forbidden. Honesty: a `realizedValue` is recorded as the owner-declared value and only counts when the bet’s value basis is `owner-declared` — the response says so when it is not.',
    inputSchema: {
      type: 'object',
      properties: {
        betId: { type: 'string', description: 'The Big Bet to update (from list_big_bets).' },
        solution: { type: 'string', description: 'The solution idea (how the bet realizes its value).' },
        status: { type: 'string', enum: ['draft', 'active', 'shipped', 'archived'], description: 'Bet lifecycle status.' },
        targetValue: { type: 'number', description: 'The € value target.' },
        realizedValue: { type: 'number', description: 'Owner-declared realized € value (counts under basis owner-declared).' },
        valueBasis: { type: 'string', enum: ['uplift', 'absolute', 'owner-declared'], description: 'How realized value is resolved (default uplift-over-baseline).' },
        goLive: { type: 'string', description: 'Planned go-live yyyy-mm-dd.' },
        name: { type: 'string', description: 'Display name.' },
      },
      required: ['betId'],
      examples: [{ betId: 'bet_ab12cd34', status: 'active', solution: 'Proactive health-score outreach', valueBasis: 'owner-declared', realizedValue: 120000 }],
    },
    call: async (user, args) => {
      const betId = str(args.betId).trim();
      if (!betId) fail('update_big_bet needs a `betId` (from list_big_bets)', 400);
      const patch: Partial<Pick<BigBet, 'name' | 'solution' | 'targetValue' | 'goLive' | 'valueBasis' | 'ownerDeclaredValue' | 'status'>> = {};
      if (typeof args.solution === 'string') patch.solution = args.solution.trim() || undefined;
      if (typeof args.name === 'string' && args.name.trim()) patch.name = args.name.trim();
      if (typeof args.targetValue === 'number' && Number.isFinite(args.targetValue)) patch.targetValue = args.targetValue;
      if (typeof args.realizedValue === 'number' && Number.isFinite(args.realizedValue)) patch.ownerDeclaredValue = args.realizedValue;
      if (typeof args.goLive === 'string' && args.goLive.trim()) patch.goLive = args.goLive.trim();
      if (args.status !== undefined) {
        const status = str(args.status);
        if (!['draft', 'active', 'shipped', 'archived'].includes(status)) {
          fail('status must be draft | active | shipped | archived', 400);
        }
        patch.status = status as BigBet['status'];
      }
      if (args.valueBasis !== undefined) {
        const basis = str(args.valueBasis);
        if (!['uplift', 'absolute', 'owner-declared'].includes(basis)) {
          fail('valueBasis must be uplift | absolute | owner-declared', 400);
        }
        patch.valueBasis = basis as ValueBasis;
      }
      if (Object.keys(patch).length === 0) {
        fail('update_big_bet needs at least one field to update (solution, status, targetValue, realizedValue, valueBasis, goLive, name)', 400);
      }
      const bet = updateBet(betId, P(user), patch); // the store's own edit gate (403/404)
      return {
        id: bet.id,
        status: bet.status,
        solution: bet.solution ?? null,
        targetValue: bet.targetValue,
        ownerDeclaredValue: bet.ownerDeclaredValue ?? null,
        valueBasis: bet.valueBasis,
        goLive: bet.goLive,
        updatedAt: bet.updatedAt,
        ...(patch.ownerDeclaredValue !== undefined && bet.valueBasis !== 'owner-declared'
          ? { note: `realizedValue is recorded as the owner-declared value, but this bet resolves value by "${bet.valueBasis}" — set valueBasis: "owner-declared" for it to count.` }
          : {}),
      };
    },
  },
  // ---- Big Bet LIFECYCLE (archive · unarchive · delete · restore) ------------
  // Distinct from update_big_bet's `status:'archived'` (a status FIELD): these
  // are the true lifecycle transitions, each wrapping the real store fn behind
  // its own edit gate (canEdit — the owner edits their bet; cross-domain bets
  // are Admin-only). No new role floor is invented — the write floor is creator.
  {
    name: 'archive_big_bet',
    tab: 'bigbets',
    minRole: 'creator',
    description:
      'Archive a Big Bet you may edit — a reversible soft-hide that removes it from the working list (retained + restorable). Purpose: retire a bet without destroying its roadmap or history. Before: get_big_bet. After: unarchive_big_bet to bring it back, or delete_big_bet to remove it for good. Governance: runs AS YOU through the SAME store edit gate as the Big Bets tab (the owner edits their bet; cross-domain bets are Admin-only) — an unseen id is a typed not_found/forbidden. Note: distinct from update_big_bet with status:"archived" (a status field); this is the lifecycle transition and is audited as bet.archive.',
    inputSchema: {
      type: 'object',
      properties: { betId: { type: 'string', description: 'The Big Bet to archive (from list_big_bets).' } },
      required: ['betId'],
      examples: [{ betId: 'bet_ab12cd34' }],
    },
    call: async (user, args) => {
      const betId = str(args.betId).trim();
      if (!betId) fail('archive_big_bet needs a `betId` (from list_big_bets)', 400);
      const bet = archiveBet(betId, P(user));
      return { id: bet.id, status: bet.status, updatedAt: bet.updatedAt };
    },
  },
  {
    name: 'unarchive_big_bet',
    tab: 'bigbets',
    minRole: 'creator',
    description:
      'Restore an archived Big Bet back into the working list (returns it to active). Purpose: undo an archive. Before: list_big_bets with includeArchived (archived bets are hidden from the default list — the owner/Admin knows the id). After: get_big_bet to read the roadmap back. Governance: runs AS YOU through the SAME store edit gate as archive_big_bet (the owner edits their bet; cross-domain bets are Admin-only) — an unseen id is a typed not_found/forbidden.',
    inputSchema: {
      type: 'object',
      properties: { betId: { type: 'string', description: 'The archived Big Bet to restore (from list_big_bets, includeArchived).' } },
      required: ['betId'],
      examples: [{ betId: 'bet_ab12cd34' }],
    },
    call: async (user, args) => {
      const betId = str(args.betId).trim();
      if (!betId) fail('unarchive_big_bet needs a `betId` (from list_big_bets)', 400);
      const bet = unarchiveBet(betId, P(user));
      return { id: bet.id, status: bet.status, updatedAt: bet.updatedAt };
    },
  },
  {
    name: 'delete_big_bet',
    tab: 'bigbets',
    minRole: 'creator',
    description:
      'Physically delete a Big Bet + its version history (edit-scoped, IRREVERSIBLE). Purpose: permanently remove a bet you no longer need. Before: archive_big_bet (the OS lifecycle reaches delete via archive) — the attached component REFERENCES are dropped with the bet, but the components themselves (datasets, dashboards, agent systems) live on in their own tabs; a delete never destroys the artifacts a bet points at. Governance: runs AS YOU through the SAME store edit gate as the Big Bets tab (the owner edits their bet; cross-domain bets are Admin-only) — an unseen id is a typed not_found/forbidden.',
    inputSchema: {
      type: 'object',
      properties: { betId: { type: 'string', description: 'The Big Bet to permanently delete (from list_big_bets).' } },
      required: ['betId'],
      examples: [{ betId: 'bet_ab12cd34' }],
    },
    call: async (user, args) => {
      const betId = str(args.betId).trim();
      if (!betId) fail('delete_big_bet needs a `betId` (from list_big_bets)', 400);
      deleteBet(betId, P(user));
      return { deleted: true, betId };
    },
  },
  {
    name: 'restore_big_bet_version',
    tab: 'bigbets',
    minRole: 'creator',
    description:
      'Restore a prior version of a Big Bet’s editable content (name, problem, solution, target value, go-live, value basis, allocation, members, status, solution blueprint). Restore is itself reversible — the CURRENT state is snapshotted as a new version first, THEN the chosen version is applied. Purpose: roll a bet back to an earlier framing. Before: get_big_bet (the audit tail lists versions; each has a number). After: get_big_bet to read the restored content back. Governance: runs AS YOU through the SAME store edit gate as the Big Bets tab (the owner edits their bet; cross-domain bets are Admin-only) — an unseen id is a typed not_found/forbidden; an unknown version is a typed not_found.',
    inputSchema: {
      type: 'object',
      properties: {
        betId: { type: 'string', description: 'The Big Bet to restore (from list_big_bets).' },
        versionId: { type: 'number', description: 'The version number to restore (from get_big_bet’s version history).' },
      },
      required: ['betId', 'versionId'],
      examples: [{ betId: 'bet_ab12cd34', versionId: 2 }],
    },
    call: async (user, args) => {
      const betId = str(args.betId).trim();
      if (!betId) fail('restore_big_bet_version needs a `betId` (from list_big_bets)', 400);
      const version = Number(args.versionId);
      if (!Number.isInteger(version)) fail('restore_big_bet_version needs an integer `versionId`', 400);
      const bet = restoreBetVersion(betId, P(user), version);
      return { id: bet.id, name: bet.name, status: bet.status, updatedAt: bet.updatedAt };
    },
  },
];

