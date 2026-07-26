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

// ============================== SOFTWARE =======================================
export const softwareWriteTools: McpTool[] = [
  {
    name: 'set_app_design',
    tab: 'software',
    minRole: 'creator',
    description:
      "Set or update the app's Define/Design fields: `purpose` (stated intent, ≤2000 chars), `epics` (Design epics + user stories), and `grants` (governed context grants — Connections · Data · Knowledge · Files · Metrics at read-only | read-propose | read-write). Each field is optional; unset fields are untouched. Governance: owner, owning-domain admin, or platform admin only — same edit scope as the UI PATCH (`patchAppDesign`). Grants are capability metadata (id + access level), never raw credentials. Before: list_software / get_software (need the appId). After: get_software to read the updated design back.",
    inputSchema: {
      type: 'object',
      description: 'Patch the Define/Design surfaces of an app you may edit. All patch fields except appId are optional.',
      properties: {
        appId: { type: 'string', description: 'App id from list_software.' },
        purpose: { type: 'string', description: "The app's stated purpose (Define stage), ≤2000 chars." },
        epics: {
          type: 'array',
          description: 'Design epics. Each groups user stories under technical/UX/governance requirements.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              title: { type: 'string' },
              description: { type: 'string' },
              requirements: {
                type: 'object',
                properties: {
                  technical: { type: 'string' },
                  ux: { type: 'string' },
                  governance: { type: 'string' },
                },
              },
              stories: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    title: { type: 'string' },
                    asA: { type: 'string' },
                    iWant: { type: 'string' },
                    soThat: { type: 'string' },
                    acceptance: { type: 'string' },
                  },
                  required: ['id', 'title', 'asA', 'iWant', 'soThat'],
                },
              },
            },
            required: ['id', 'title'],
          },
        },
        grants: {
          type: 'object',
          description:
            'Governed context grants: which OS artifacts this app may access and at what level. Each kind maps to { id, access } entries. Grants are capability metadata — never raw credentials.',
          properties: {
            connections: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, access: { type: 'string', enum: ['read-only', 'read-propose', 'read-write'] } }, required: ['id', 'access'] } },
            data:        { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, access: { type: 'string', enum: ['read-only', 'read-propose', 'read-write'] } }, required: ['id', 'access'] } },
            knowledge:   { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, access: { type: 'string', enum: ['read-only', 'read-propose', 'read-write'] } }, required: ['id', 'access'] } },
            files:       { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, access: { type: 'string', enum: ['read-only', 'read-propose', 'read-write'] } }, required: ['id', 'access'] } },
            metrics:     { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, access: { type: 'string', enum: ['read-only', 'read-propose', 'read-write'] } }, required: ['id', 'access'] } },
          },
        },
      },
      required: ['appId'],
      examples: [
        { appId: 'app_ab12cd', purpose: 'Track and resolve customer support tickets in real time.' },
        {
          appId: 'app_ab12cd',
          epics: [{
            id: 'epic_1', title: 'Ticket triage',
            description: 'Auto-prioritise incoming tickets',
            requirements: { technical: 'ML classifier', ux: 'Simple inbox view', governance: 'No PII in logs' },
            stories: [{ id: 'story_1', title: 'Auto-label', asA: 'Support agent', iWant: 'tickets labelled on arrival', soThat: 'I can triage faster', acceptance: 'Label appears within 5 s' }],
          }],
        },
        { appId: 'app_ab12cd', grants: { connections: [{ id: 'conn_xyz', access: 'read-only' }], data: [], knowledge: [], files: [], metrics: [] } },
      ],
    },
    call: async (user, args) => {
      const appId = str(args.appId).trim();
      if (!appId) fail('set_app_design needs an `appId` (from list_software)', 400);
      // Confirm visibility before patching (patchAppDesign also checks, but an
      // explicit view-gate here gives a typed not_found on an invisible app id).
      await getAppForUser(appId, user);
      return patchAppDesign(appId, user, {
        purpose: args.purpose !== undefined ? str(args.purpose) : undefined,
        epics: args.epics !== undefined ? (args.epics as AppEpic[]) : undefined,
        grants: args.grants !== undefined ? normalizeContextGrants(args.grants) : undefined,
      });
    },
  },
];
