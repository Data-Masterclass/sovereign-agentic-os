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

// ============================== KNOWLEDGE ======================================
export const knowledgeWriteTools: McpTool[] = [
  {
    name: 'author_knowledge',
    tab: 'knowledge',
    minRole: 'creator',
    description:
      'Author a Personal (draft) knowledge business process (also called: workflow, process workflow, SOP (Standard Operating Procedure)) — the runbook for a task: an optional markdown body, ordered `steps` (each with an actor and optional per-step `tacit` note), process `rules`, an optional `actors` registry, and an optional process-level `tacit` string (the TACIT.md companion — unstructured know-how that resists formalization: the gotchas, the "why", the tribal memory). Actors have five categories — Human · Software · Agent · Customer · Partner — where Customer and Partner are EXTERNAL (outside the organisation). The optional `actors` array lets you describe each actor once (name · category · description) and steps reference them by name; if you omit it, a registry is derived from the steps automatically. Same governed store as the Knowledge tab. Publish it later with `publish_knowledge`.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Business process title, e.g. "Refund handling".' },
        domain: { type: 'string', description: 'One of YOUR domains; defaults to your first.' },
        markdown: { type: 'string', description: 'Optional free markdown body (context/prose).' },
        steps: {
          type: 'array',
          description: 'Ordered steps.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              actor: {
                type: 'string',
                enum: ['Human', 'Software', 'Agent', 'Customer', 'Partner'],
                description: 'Actor category. Customer and Partner are EXTERNAL (outside the organisation).',
              },
              actor_name: { type: 'string', description: 'Actor name; matches an `actors[].name` when a registry is supplied.' },
              inputs: { type: 'array', items: { type: 'string' } },
              outputs: { type: 'array', items: { type: 'string' } },
              tacit: {
                type: 'string',
                description:
                  'Per-step tacit note — the inline know-how for this step: gotchas, edge cases, undocumented nuances. Stored as a `> tacit:` blockquote in the workflow.md and indexed as a separate retrieval unit.',
              },
            },
            required: ['title'],
          },
        },
        actors: {
          type: 'array',
          description:
            'Optional actor registry — describe each actor once so steps can reference it by name. Five categories: Human · Software · Agent · Customer · Partner (Customer and Partner are external). Omit to derive a registry from the steps automatically.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'e.g. "Loan Officer", "Salesforce API", "Campaign Optimizer".' },
              category: { type: 'string', enum: ['Human', 'Software', 'Agent', 'Customer', 'Partner'] },
              description: { type: 'string', description: 'One line on this actor\'s role — applies to every category, e.g. "Salesforce API — nightly REST ingestion".' },
            },
            required: ['name', 'category'],
          },
        },
        rules: {
          type: 'array',
          description: 'Business process decision rules.',
          items: { type: 'object', properties: { text: { type: 'string' }, hard: { type: 'boolean' } }, required: ['text'] },
        },
        tacit: {
          type: 'string',
          description:
            'Process-level tacit knowledge (the sibling TACIT.md). Use this for unstructured know-how that resists formalization — the gotchas, the "why behind the why", institutional memory, cultural nuances that don\'t fit into steps or rules. Markdown is fine; headings split it into separately-retrievable chunks. Per-step inline notes go in `steps[].tacit` instead.',
        },
      },
      required: ['title'],
      examples: [
        {
          title: 'Refund handling',
          domain: 'support',
          actors: [
            { name: 'Support Agent', category: 'Human', description: 'Front-line agent who verifies the order.' },
            { name: 'Billing System', category: 'Software', description: 'Issues the refund via the payments API.' },
            { name: 'Customer', category: 'Customer', description: 'Requests the refund (external).' },
          ],
          steps: [
            { title: 'Request refund', actor: 'Customer', actor_name: 'Customer', outputs: ['Refund request'] },
            { title: 'Verify order', actor: 'Human', actor_name: 'Support Agent', outputs: ['Verified order'], tacit: 'Check section 4 — the date field is frequently missed by new agents.' },
            { title: 'Issue refund', actor: 'Software', actor_name: 'Billing System', inputs: ['Verified order'] },
          ],
          rules: [{ text: 'Refunds over 500 EUR need a manager', hard: true }],
          tacit: '## Edge cases\nHigh-value refunds (> 1 000 EUR) route to the finance team even on weekends — the on-call number is in the finance Notion.\n\n## Cultural note\nThe support team uses "RT" as shorthand for "refund ticket" in Slack.',
        },
      ],
    },
    call: async (user, args) => {
      const title = str(args.title).trim();
      if (!title) fail('author_knowledge needs a `title`', 400);
      const p = P(user);
      const rec = createWorkflow(p, { title, domain: str(args.domain) || undefined });
      const body = str(args.markdown);
      const steps = mapSteps(args.steps);
      const rules = mapRules(args.rules);
      const declaredActors = mapActors(args.actors);
      // Registry = declared actors (with descriptions) merged with the distinct
      // (category, name) pairs found in the steps, so both explicit and implied
      // actors are captured.
      const actors = deriveActors(steps, declaredActors);
      if (body || steps.length || rules.length || actors.length) {
        const view = getWorkflow(rec.id, p);
        const w: Workflow = {
          ...view.workflow,
          steps: steps.length ? steps : view.workflow.steps,
          rules: rules.length ? rules : view.workflow.rules,
          actors: actors.length ? actors : view.workflow.actors,
        };
        // serializeWorkflow emits frontmatter + step blocks (including > tacit: blockquotes
        // for any step with a tacit note); splice the prose body back in right after the
        // frontmatter so it round-trips through the store.
        let md = serializeWorkflow(w);
        if (body) md = md.replace(/^(---\n[\s\S]*?\n---\n\n)/, `$1${body}\n\n`);
        updateWorkflow(rec.id, p, { md });
      }
      // Workflow-level tacit doc (sibling TACIT.md) — stored separately from the
      // workflow.md so it can be versioned, compressed, and chunked independently.
      const tacit = str(args.tacit).trim();
      if (tacit) updateTacit(rec.id, p, tacit);
      return { id: rec.id, title: rec.title, domain: rec.domain, status: rec.status, visibility: rec.visibility };
    },
  },
  {
    name: 'publish_knowledge',
    tab: 'knowledge',
    minRole: 'domain_admin',
    description:
      'Publish a draft business process My → Domain (draft→live) and re-index it for retrieval. Domain-admin+ only (the My→Domain approval gate). This is the "approve half" of the ladder: the flip runs THROUGH the governance effect seam (no direct publish back door). Idempotency: publishing an already-live business process returns a `conflict`.',
    inputSchema: {
      type: 'object',
      properties: { workflowId: { type: 'string', description: 'Draft business process id to publish.' } },
      required: ['workflowId'],
      examples: [{ workflowId: 'wf_ab12cd' }],
    },
    call: async (user, args) => {
      const id = str(args.workflowId).trim();
      if (!id) fail('publish_knowledge needs a `workflowId`', 400);
      const p = P(user);
      // Route the flip through the ONE effect seam (never publishWorkflow directly).
      // Intent is PUBLISH (rung 1): a mismatch (already-Shared workflow) is a typed
      // conflict, not a silent certify-to-marketplace.
      await promoteThroughSeam('knowledge', id, user, { rung: 'promote' });
      const rec = getWorkflow(id, p);
      try {
        await indexWorkflow(rec.workflow, { owner: rec.owner, tacit: rec.tacit, updatedAt: rec.updatedAt });
        await indexDomain(getDomainKnowledge(rec.domain));
      } catch {
        /* indexing is best-effort; publish already succeeded */
      }
      return { id: rec.id, status: rec.status, visibility: rec.visibility, publishedBy: rec.publishedBy };
    },
  },
  {
    name: 'index_knowledge',
    tab: 'knowledge',
    minRole: 'creator',
    description:
      'Re-run the indexing pipeline (unit-chunk → embed → hybrid index) for a business process you can see + its domain card, so `search_knowledge` returns it. Idempotent — safe to re-run.',
    inputSchema: {
      type: 'object',
      properties: { workflowId: { type: 'string', description: 'Business process id to (re)index.' } },
      required: ['workflowId'],
      examples: [{ workflowId: 'wf_ab12cd' }],
    },
    call: async (user, args) => {
      const id = str(args.workflowId).trim();
      if (!id) fail('index_knowledge needs a `workflowId`', 400);
      const p = P(user);
      const view = getWorkflow(id, p);
      const workflow = await indexWorkflow(view.workflow, { owner: view.owner, tacit: view.tacit, updatedAt: view.updatedAt });
      const domain = await indexDomain(getDomainKnowledge(view.domain));
      return { workflow, domain };
    },
  },
  {
    name: 'retire_knowledge',
    tab: 'knowledge',
    minRole: 'creator',
    description:
      'RETIRE a knowledge business process you can edit — the Knowledge tab’s lifecycle: `archive` (the default: reversible soft-hide, retains the record + history, unarchive with author_knowledge’s sibling flow) or `delete` (PHYSICAL + irreversible: removes the record, its version history, and purges its indexed units from OpenSearch + the offline mirror so it stops being retrievable). Same governed store the Knowledge tab + `/api/knowledge/workflows/[id]` call. LINEAGE-AWARE: blocked with a typed 409 if any App or Agent system still consumes it (never orphan a live dependency) — remove those uses first. Role gate (edit scope, re-checked in-lib): the OWNER may retire their own Personal/unshared business process; a SHARED/domain business process needs a same-domain Builder+ (the Knowledge edit gate). Physical `delete` additionally refuses a still-published (`live`) business process — archive/unpublish it first (mirrors the store). Idempotency: retiring a missing business process is a typed not_found.',
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: { type: 'string', description: 'The knowledge business process id to retire.' },
        action: {
          type: 'string',
          enum: ['archive', 'delete'],
          description: 'archive = reversible soft-hide (default); delete = physical, irreversible removal + index purge.',
        },
      },
      required: ['workflowId'],
      examples: [
        { workflowId: 'wf_ab12cd' },
        { workflowId: 'wf_ab12cd', action: 'delete' },
      ],
    },
    call: async (user, args) => {
      const id = str(args.workflowId).trim();
      if (!id) fail('retire_knowledge needs a `workflowId`', 400);
      const action = str(args.action).trim() || 'archive';
      if (action !== 'archive' && action !== 'delete') {
        fail("retire_knowledge `action` must be 'archive' or 'delete'", 400);
      }
      const p = P(user);
      // View-scope + existence guard first (typed 403/404) so a lineage/role message
      // never leaks a workflow the caller can't even see.
      const view = getWorkflow(id, p);
      // LINEAGE GUARD (mirrors the app-delete dependentsOf check): refuse to orphan a
      // live consumer. Runs for BOTH archive and delete — retiring an in-use workflow,
      // reversibly or not, breaks the consumers' context handover.
      const consumers = await knowledgeConsumers(id, p);
      if (consumers.length > 0) {
        const names = consumers.map((c) => `${c.by} (${c.kind})`).join(', ');
        fail(`retire blocked — this workflow is still consumed by: ${names}. Remove those uses first.`, 409);
      }
      if (action === 'archive') {
        const rec = archiveWorkflow(id, p); // edit-gated in-lib (owner or same-domain Builder+)
        return { id: rec.id, title: rec.title, action: 'archive', archived: rec.archived, reversible: true };
      }
      // PHYSICAL delete: edit-gated + refuses a live workflow in-lib. On success, purge
      // the indexed units so a deleted workflow stops being retrievable (best-effort +
      // honest — the record is already gone; report if the index purge couldn't run).
      deleteWorkflow(id, p);
      const indexPurged = await purgeKnowledgeUnits(id);
      return { id, title: view.title, action: 'delete', deleted: true, indexPurged, reversible: false };
    },
  },
];

