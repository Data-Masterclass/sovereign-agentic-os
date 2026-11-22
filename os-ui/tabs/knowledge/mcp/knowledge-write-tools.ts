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
import { exportWorkflowBundle, exportAndValidate } from '@tabs/knowledge/lib/okf-export';
import { importOkfZip } from '@tabs/knowledge/lib/okf-import';
import { zipBundle, OkfZipError, OKF_MAX_UNPACKED_BYTES } from '@tabs/knowledge/lib/okf-zip';
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
import { actingCaller } from '@tabs/knowledge/lib/embed';

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
import { claimsFromUser, delegate } from '@core/kernel/identity';

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

import {
  createPersonalKnowledge,
  findPersonalKnowledgeBySourceKey,
  ensureHydrated as ensurePersonalKnowledgeHydrated,
} from '@tabs/knowledge/lib/personal-store';

/**
 * Make a saved note findable by `search_knowledge` — for its owner only (`chunkNote`). A note
 * already in the index is not embedded again (a repeated call with the same `sourceKey`).
 * Best-effort and honest: the note stands either way, and `searchable` says whether it is indexed.
 */
async function indexSavedNote(
  rec: { id: string; title: string; md: string; domain: string; owner: string; visibility: string; updatedAt: string },
  user: { id: string; domains: string[] },
  already: boolean,
): Promise<{ searchable: boolean; note: string }> {
  const { indexNote } = await import('@tabs/knowledge/lib/index-pipeline');
  const { hasWorkflowUnits } = await import('@tabs/knowledge/lib/index-store');
  if (already && hasWorkflowUnits(rec.id)) return { searchable: true, note: 'Listed in Knowledge → My knowledge, and found by search_knowledge (for you only).' };
  try {
    const r = await indexNote(rec, { userId: user.id, domain: user.domains[0], tab: 'knowledge' });
    return r.units > 0
      ? { searchable: true, note: `Listed in Knowledge → My knowledge, and found by search_knowledge (for you only${r.store === 'memory' ? '; indexed in this process only, the search cluster was unreachable' : ''}).` }
      : { searchable: false, note: 'Listed in Knowledge → My knowledge. The note has no text to index.' };
  } catch (e) {
    return { searchable: false, note: `Listed in Knowledge → My knowledge. It could not be indexed for search_knowledge: ${(e as Error)?.message ?? String(e)}` };
  }
}

/** The largest note body `save_knowledge_note` accepts; a longer document belongs in Files. */
const NOTE_MAX_BYTES = 512 * 1024;

// ============================== KNOWLEDGE ======================================
export const knowledgeWriteTools: McpTool[] = [
  {
    name: 'save_knowledge_note',
    tab: 'knowledge',
    minRole: 'creator',
    description:
      'Save a knowledge NOTE — a titled, free-form markdown document — into YOUR My knowledge, optionally in a folder. This is the entry the Knowledge tab lists under My knowledge (not a workflow: use author_workflow for steps, actors and rules). Purpose: keep a result, a summary or a piece of know-how where you and the agent systems you grant it to can use it. After: grant it (or its folder) to an agent system, or share it with your domain through request_promotion({kind:"personal_knowledge"}). Governance: created AS YOU, Personal and owner-only; sharing is the separate governed promotion. Idempotency: pass `sourceKey` to make the call repeatable — a second call with the same key returns the note you already saved (`already: true`) instead of writing another. Search: the note is indexed so search_knowledge finds it — for YOU only (a Personal note is owner-only in search too); `searchable` says whether indexing worked.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The note’s title.' },
        md: { type: 'string', description: 'The note’s body, as markdown.' },
        folder: { type: 'string', description: 'Optional folder path in My knowledge, e.g. "/results". Created when the first note is saved there.' },
        domain: { type: 'string', description: 'One of YOUR domains; defaults to your first.' },
        sourceKey: { type: 'string', description: 'Optional. A key that identifies this save; repeating the call with it returns the note already saved.' },
      },
      required: ['title', 'md'],
      examples: [{ title: 'Invoice run — 2026-11-19', md: '## Summary\n12 invoices processed.', folder: '/results' }],
    },
    call: async (user, args) => {
      const title = str(args.title).trim();
      if (!title) fail('save_knowledge_note needs a `title`', 400);
      const md = typeof args.md === 'string' ? args.md : '';
      if (!md.trim()) fail('save_knowledge_note needs a non-empty `md` body', 400);
      if (Buffer.byteLength(md, 'utf8') > NOTE_MAX_BYTES) {
        fail(`save_knowledge_note: the body is larger than ${NOTE_MAX_BYTES / 1024} KB — save a long document as a file with upload_file instead`, 400);
      }
      const p = P(user);
      await ensurePersonalKnowledgeHydrated();
      const sourceKey = str(args.sourceKey).trim();
      const existing = sourceKey ? findPersonalKnowledgeBySourceKey(p, sourceKey) : null;
      const rec = existing ?? createPersonalKnowledge(p, {
        title,
        md,
        folder: str(args.folder) || undefined,
        domain: str(args.domain) || undefined,
        sourceKey: sourceKey || undefined,
      });
      return {
        id: rec.id,
        title: rec.title,
        folder: rec.folder,
        domain: rec.domain,
        visibility: rec.visibility,
        ...(existing ? { already: true } : {}),
        ...(await indexSavedNote(rec, user, !!existing)),
      };
    },
  },  {
    name: 'export_okf_bundle',
    tab: 'knowledge',
    minRole: 'creator',
    description:
      'Export a workflow (wf_…) you can see as an OKF (Open Knowledge Format) v0.2 bundle — a portable, human-readable directory of markdown + YAML frontmatter (the interchange format; the retrieval engine is untouched). The bundle is zipped and written as a governed Files-tab artifact (MCP cannot return a zip inline), and this tool returns its file `id` + `deepLink` so you can Download it or share it. Round-trip is lossless for our own artifacts (steps/actors/rules/tacit + tier/owner survive), and conformance is validated on export. Governance: read-scoped on the source workflow; the bundle file is created AS YOU at Personal tier.',
    inputSchema: {
      type: 'object',
      properties: { workflowId: { type: 'string', description: 'The workflow id (wf_…) to export (from list_workflows).' } },
      required: ['workflowId'],
      examples: [{ workflowId: 'wf_ab12cd' }],
    },
    call: async (user, args) => {
      const id = str(args.workflowId).trim();
      if (!id) fail('export_okf_bundle needs a `workflowId`', 400);
      const p = P(user);
      const view = getWorkflow(id, p); // view-scoped; unseeable → not_found
      // Build + validate the bundle (validation runs on every export — decision #7).
      const { bundle, validation } = exportAndValidate(exportWorkflowBundle(view));
      const zip = zipBundle(bundle);
      // Write the zip as a governed Files artifact — identical path to upload_file.
      const name = `${slug(view.title) || 'workflow'}.okf.zip`;
      const asset = createFile(p, {
        name,
        text: `OKF v0.2 export of the “${view.title}” workflow.`,
        bytes: zip.length,
        tags: ['okf', 'knowledge-export'],
        domain: view.domain,
      });
      const key = objectKeyForAsset(asset);
      if (key) {
        await putBlob(key, zip, 'application/zip');
        attachObject(asset.id, p, { contentType: 'application/zip', bytes: zip.length });
      }
      return {
        fileId: asset.id,
        name: asset.name,
        deepLink: asset.deepLink,
        bytes: zip.length,
        files: bundle.files.length,
        conformant: validation.ok,
        notes: validation.notes.map((n) => n.message),
      };
    },
  },  {
    name: 'import_okf_bundle',
    tab: 'knowledge',
    minRole: 'creator',
    description:
      'Import an OKF (Open Knowledge Format) v0.2 bundle (a zip of markdown + YAML frontmatter) into the Knowledge tab. The bundle is validated for conformance, then its concepts land as GOVERNED artifacts at PERSONAL tier with YOU as owner, through the normal author ladder (never a governance bypass) — publish/certify them afterwards as usual. Idempotent: a concept whose `resource` matches an artifact you already own becomes a NEW VERSION (no silent duplicates). Unknown types + unknown fields + broken links are ACCEPTED (an unknown type is kept + shown, mapped to a general knowledge doc); only a truly malformed bundle (unparseable frontmatter, missing `type`) is rejected, with an honest reason. SECURITY: paths are zip-slip-sanitised and hard caps (≤ 50 MB unpacked, ≤ 2,000 files) are enforced. Provide the zip as standard base64 in `base64Content` (~4 MB MCP in-band limit; larger bundles import through the Knowledge tab UI).',
    inputSchema: {
      type: 'object',
      properties: {
        base64Content: { type: 'string', description: "The OKF bundle .zip encoded as standard base64." },
        domain: { type: 'string', description: 'One of YOUR domains to home the imported artifacts in; defaults to your first.' },
      },
      required: ['base64Content'],
      examples: [{ base64Content: 'UEsDBBQAAAAI…' }],
    },
    call: async (user, args) => {
      const b64 = typeof args.base64Content === 'string' ? args.base64Content : '';
      if (!b64) fail('import_okf_bundle needs `base64Content` (the bundle zip as base64)', 400);
      let zip: Buffer;
      try {
        zip = Buffer.from(b64, 'base64');
      } catch {
        return fail('import_okf_bundle: `base64Content` is not valid base64', 400);
      }
      if (zip.length > OKF_MAX_UNPACKED_BYTES) {
        fail(`import_okf_bundle: bundle is ${(zip.length / 1048576).toFixed(1)} MB — over the ${OKF_MAX_UNPACKED_BYTES / 1048576} MB cap`, 400);
      }
      const p = P(user);
      try {
        const result = importOkfZip(zip, p, { domain: str(args.domain) || undefined });
        if (!result.ok) {
          fail(`import_okf_bundle: bundle rejected — ${result.rejected}`, 422);
        }
        return {
          imported: result.imported,
          skipped: result.skipped,
          notes: result.validation.notes.map((n) => n.message),
          count: result.imported.length,
        };
      } catch (e) {
        if (e instanceof OkfZipError) fail(`import_okf_bundle: ${e.message}`, 400);
        throw e;
      }
    },
  },
];

