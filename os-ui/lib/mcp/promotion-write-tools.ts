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

// ============================== PROMOTION (split) =============================
// The GOVERNED separation-of-duties seam, matching the UI: a creator FILES a
// promotion request (enqueued into the shared approvals queue); a Builder/Admin
// in the domain APPLIES it. One tool pair spans datasets + files (extraTabs), so
// both the data and files per-tab lenses expose it.
export const promotionTools: McpTool[] = [
  {
    name: 'request_promotion',
    tab: 'data',
    extraTabs: ['files'],
    minRole: 'creator',
    description:
      'FILE a rung-1 promotion request (My → a governed DOMAIN asset) for ANY ownable artifact: a dataset, file, knowledge workflow, connection, dashboard, model, app or agent system. Path: the promote step of every tab’s golden path — the ONE governed ladder. Before: create + document the artifact (creating in My scope needs no approval; only this promotion up a scope is gated). After: a domain admin (or tenant admin) in the domain runs `decide_approval` (or `approve_promotion` for dataset/file). Governance: OWNER-ONLY trigger — edit rights are not enough; it does NOT promote, it enqueues the governed request and returns the pending handle. Certification (Domain → Company) is the separate `request_certification`. Idempotency: filing while a request is pending returns the existing handle.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['dataset', 'file', 'knowledge', 'connection', 'dashboard', 'model', 'app', 'agent_system'], description: 'What to promote (you must OWN it).' },
        id: { type: 'string', description: 'The artifact id you own and have documented.' },
        visibility: { type: 'string', description: 'Requested asset visibility (dataset/file only; default domain).' },
        grants: { type: 'array', description: 'Optional explicit policy grants (dataset/file only; else a domain read grant).' },
      },
      required: ['kind', 'id'],
      examples: [{ kind: 'dataset', id: 'ds_ab12cd', visibility: 'domain' }, { kind: 'knowledge', id: 'wf_ab12cd' }, { kind: 'connection', id: 'conn_ab12cd' }],
    },
    call: async (user, args) => {
      const kind = str(args.kind).trim();
      const id = str(args.id).trim();
      if (!id) fail('request_promotion needs an `id`', 400);

      // The formerly-DIRECT ladder kinds (knowledge/connection/dashboard/model/app/
      // agent_system) file through the ONE ladder seam — owner-only, effect applied
      // on approval.
      if (isLadderKind(kind)) {
        const approval = await fileArtifactPromotion(kind as LadderKind, id, user);
        return pendingHandle(approval, { artifactKind: kind, target: approval.detail, domain: approval.domain });
      }
      if (kind !== 'dataset' && kind !== 'file') {
        fail('request_promotion needs `kind` = dataset | file | knowledge | connection | dashboard | model | app | agent_system', 400);
      }
      const p = P(user);
      const opts = {
        visibility: (str(args.visibility) as DataVisibility) || undefined,
        grants: (args.grants as Grant[]) || undefined,
      };
      const approvalKind = kind === 'dataset' ? 'dataset_promote' : 'file_promote';
      // Don't file a duplicate pending request for the same asset.
      const existing = enqueueDedup(approvalKind, id);
      if (existing) return pendingHandle(existing, { artifactKind: kind, target: existing.detail, domain: existing.domain, already: true });

      if (kind === 'dataset') {
        const req: PromotionRequest = requestDatasetPromotion(id, p, opts);
        const approval = enqueue({
          kind: 'dataset_promote',
          title: `Promote “${req.datasetName}” to a data asset`,
          detail: `${user.id} requests promoting ${req.datasetName} into ${req.target} (visibility: ${req.visibility}). A domain admin must approve.`,
          agent: user.id,
          domain: req.domain,
          requestedBy: user.id,
          tool: 'data_promote',
          payload: req as unknown as Record<string, unknown>,
          approverRole: 'domain_admin',
        });
        return pendingHandle(approval, { artifactKind: kind, target: req.target, domain: req.domain });
      }
      const req: FilePromotionRequest = requestFilePromotion(id, p, opts);
      const approval = enqueue({
        kind: 'file_promote',
        title: `Share “${req.fileName}” with the ${req.domain} domain`,
        detail: `${user.id} requests promoting ${req.fileName} into ${req.target} (visibility: ${req.visibility}). A domain admin must approve.`,
        agent: user.id,
        domain: req.domain,
        requestedBy: user.id,
        tool: 'file_promote',
        payload: req as unknown as Record<string, unknown>,
        approverRole: 'domain_admin',
      });
      return pendingHandle(approval, { artifactKind: kind, target: req.target, domain: req.domain });
    },
  },
  {
    name: 'approve_promotion',
    tab: 'data',
    extraTabs: ['files'],
    minRole: 'domain_admin',
    description:
      'APPLY a filed promotion request (dataset or file) — the Domain-admin/Admin half of the split. Path: the approve step of the Data/Files golden paths. Before: a creator filed `request_promotion`. Governance: domain_admin+ AND in the asset’s domain (both re-checked in-lib); a creator/builder is refused with a typed forbidden. Idempotency: an already-decided request returns a `conflict`.',
    inputSchema: {
      type: 'object',
      properties: { approvalId: { type: 'string', description: 'The approval id from request_promotion.' } },
      required: ['approvalId'],
      examples: [{ approvalId: 'apr_ab12cd34' }],
    },
    call: async (user, args) => {
      const approvalId = str(args.approvalId).trim();
      if (!approvalId) fail('approve_promotion needs an `approvalId`', 400);
      const approval = getApproval(approvalId);
      if (!approval) fail('Promotion request not found', 404);
      if (approval.status !== 'pending') fail(`Already ${approval.status}`, 409);
      if (approval.kind !== 'dataset_promote' && approval.kind !== 'file_promote') {
        fail('approve_promotion only applies dataset/file promotions', 400);
      }
      const p = P(user);
      // Apply BEFORE recording the decision so a blocked gate leaves it pending.
      let applied: unknown;
      if (approval.kind === 'dataset_promote') {
        // T8: the promotion is PHYSICAL — the promote adapter-set runs as the
        // APPROVING Builder (this caller) and the tier flips only on ✓. A failed
        // materialization surfaces the real error and leaves the request pending.
        const out = await publishPromotionLive(approval.payload as unknown as PromotionRequest, p);
        if (!out.ok) fail(`Physical publish failed (tier unchanged): ${out.error}`, 502);
        applied = out.dataset;
      } else {
        applied = applyApprovedFilePromotion(approval.payload as unknown as FilePromotionRequest, p);
      }
      decide(approvalId, 'approve', user.id);
      return { approved: true, kind: approval.kind, approvalId, asset: applied };
    },
  },
];

/** Return the existing pending promotion approval for this asset id, or null. */
function enqueueDedup(kind: 'dataset_promote' | 'file_promote', assetId: string) {
  // Mirror the UI: avoid a duplicate pending request for the same asset.
  return (
    listApprovals({ status: 'pending' }).find((a) => {
      if (a.kind !== kind) return false;
      const pid = kind === 'dataset_promote' ? (a.payload?.datasetId as string) : (a.payload?.fileId as string);
      return pid === assetId;
    }) ?? null
  );
}

