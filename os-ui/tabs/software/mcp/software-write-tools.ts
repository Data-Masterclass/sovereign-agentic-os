/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@core/kernel/auth';
import type { McpTool, JsonSchema } from '@core/mcp/server';
import {
  P, mcpToken, fail, str, num, bool, strArr, slug, rand, defaultGoLive,
  colDocs, mapSteps, mapRules, mapActors, normFiles,
  type Principal,
} from '@core/mcp/write-common';

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
} from '@tabs/data/lib/store';
import { runQualityChecks } from '@tabs/data/lib/dq-run';
import { DATA_CHECK_RULES, type DataCheckRule } from '@tabs/data/lib/index';
import { queryRun } from '@core/infra/governed';
import { publishPromotionLive } from '@tabs/data/lib/publish-server';
import { enqueue, getApproval, decide, listApprovals } from '@core/policy/approvals';
import { canBuildStage, canPassThrough, stageArtifact } from '@tabs/data/lib/panels';
import { ingestAndRegisterBronze } from '@tabs/data/lib/ingest';
import { buildStage, commitLayerVersion } from '@tabs/data/lib/build/server';
import {
  silverPlan,
  goldJoinPlan,
  goldMeasureToModel,
  CAST_TYPES,
  type TransformOp,
  type ResolvedJoin,
  type GoldDimension,
  type GoldMeasure,
  type JoinType,
} from '@tabs/data/lib/transform';
import { assetTarget } from '@tabs/data/lib/store-fqn';
import type { ExecuteIdentity } from '@core/infra/governed';
import type { Layer, Quality, DataVisibility, Grant, ColumnDoc, DatasetUpstream } from '@tabs/data/lib/index';
import { measureFromForm, measureMember, type MetricForm, type GuidedFilter, type GuidedWindow } from '@tabs/metrics/lib/model';
import type { MeasureType } from '@tabs/data/lib/metrics';
import { buildMetric } from '@tabs/metrics/lib/build/server';
import { exploreMetric } from '@tabs/metrics/lib/build/explore-server';
import type { Granularity } from '@tabs/metrics/lib/explorer';
import { getMetric } from '@tabs/metrics/lib/store';
import { governMetric, canPromote as canPromoteMetric } from '@tabs/metrics/lib/governance';
import { transition as transitionDataset } from '@tabs/data/lib/store';

import {
  createWorkflow,
  updateWorkflow,
  updateTacit,
  getWorkflow,
  getDomainKnowledge,
  archiveWorkflow,
  deleteWorkflow,
} from '@tabs/knowledge/lib/store';
import { knowledgeConsumers } from '@tabs/knowledge/lib/consumers';
import { fileArtifactPromotion, promoteThroughSeam, isLadderKind, type LadderKind } from '@core/policy/ladder';
import { pendingHandle } from '@core/mcp/pending';
import {
  serializeWorkflow,
  deriveActors,
  ACTOR_TYPES,
  type Workflow,
  type WorkflowStep,
  type WorkflowRule,
  type ActorType,
  type Actor,
} from '@tabs/knowledge/lib/schema';
import { indexWorkflow, indexDomain, purgeKnowledgeUnits } from '@tabs/knowledge/lib/index-pipeline';

import {
  createFile,
  setDocs as setFileDocs,
  attachObject,
  objectKeyForAsset,
  requestPromotion as requestFilePromotion,
  applyApprovedFilePromotion,
  type FilePromotionRequest,
} from '@tabs/files/lib/store';
import { reindexFile } from '@tabs/files/lib/pipeline-server';
import { putBlob } from '@tabs/files/lib/object-store';
import type { Sensitivity } from '@tabs/files/lib/asset-schema';

import { saveDashboard } from '@tabs/dashboards/lib/store';
import { fromTiles, type ChartSpec } from '@tabs/dashboards/lib/model';
import { claimsFromUser, delegate } from '@tabs/data/lib/identity';

import {
  createSystem,
  writeFile as writeAgentFile,
  getSystemForEdit,
  getSystemForRun,
} from '@tabs/agents/lib/store';
import { isTemplateKey } from '@tabs/agents/lib/templates';
import { buildSystem } from '@tabs/agents/lib/build/server';

import { patchAppDesign, getAppForUser, type AppEpic } from '@tabs/software/lib/apps';
import { normalizeContextGrants } from '@core/kernel/context-grants';

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
