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
import { KNOWLEDGE_NOTE_MAX_BYTES } from '@core/runtime/chat-attachments';
import { queryRun, authorize, workflowWriteTestGate, workflowWriteDecision, workflowFacts, type WorkflowFacts, type WorkflowOp } from '@core/infra/governed';
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
  listWorkflows,
  archiveWorkflow,
  deleteWorkflow,
} from '@tabs/knowledge/lib/store';
import { exportWorkflowBundle, exportAndValidate } from '@tabs/knowledge/lib/okf-export';
import { importOkfZip, planWorkflowWrites } from '@tabs/knowledge/lib/okf-import';
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
import { withLifecycleArg, lifecycleView } from '@core/mcp/list-args';
import { NO_ARGS, idArg } from '@core/mcp/experimental/discovery-common';
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
  createPersonalKnowledgeFiled,
  findPersonalKnowledgeBySourceKey,
  updatePersonalKnowledge,
  ensureHydrated as ensurePersonalKnowledgeHydrated,
} from '@tabs/knowledge/lib/personal-store';
import { folderRowWarning } from '@core/folders/index';

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
/** One owner of the cap: the chat attachment door applies the same limit to an attached .md note. */
const NOTE_MAX_BYTES = KNOWLEDGE_NOTE_MAX_BYTES;

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
        refresh: { type: 'boolean', description: 'Optional, with `sourceKey`: when the key matches a note you already saved, replace its title and body (kept in its version history) instead of returning it unchanged. Used to re-import a source.' },
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
      const refreshed = !!existing && args.refresh === true;
      if (existing && refreshed) updatePersonalKnowledge(existing.id, p, { title, md });
      const filed = existing ? null : createPersonalKnowledgeFiled(p, {
        title,
        md,
        folder: str(args.folder) || undefined,
        domain: str(args.domain) || undefined,
        sourceKey: sourceKey || undefined,
      });
      const rec = existing ?? filed!.record;
      // The note is saved either way; a folder row the registry refused is said, not hidden.
      const folderWarning = folderRowWarning(filed?.folderRow);
      return {
        ...(folderWarning ? { folderWarning: `The note is saved. ${folderWarning}` } : {}),
        id: rec.id,
        title: rec.title,
        folder: rec.folder,
        domain: rec.domain,
        visibility: rec.visibility,
        ...(existing && !refreshed ? { already: true } : {}),
        ...(refreshed ? { updated: true } : {}),
        ...(await indexSavedNote(rec, user, !!existing && !refreshed)),
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
        // Every WORKFLOW concept is its own write, put through the policy with its REAL op (a concept that
        // matches a workflow you can edit is an `update`; any other a `create`); a refusal skips that one.
        const domain = str(args.domain) || undefined;
        const refusals = new Map<string, string>();
        for (const w of planWorkflowWrites(zip, p)) {
          const facts = w.op === 'update' ? workflowFacts(getWorkflow(w.workflowId, p)) : { id: '', tier: 'personal' as const, owner: user.id, domain: domain || user.domains[0] || '' };
          if (!(await workflowWriteAllowed(user, w.op, facts))) refusals.set(w.path, `refused by policy (workflow ${w.op}): the policy engine did not allow it, or did not answer — nothing was changed`);
        }
        const result = importOkfZip(zip, p, { domain, refuse: (path) => refusals.get(path) });
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

// ============================== WORKFLOWS ======================================
// The Workflows tab's tools (`tab: 'workflows'`). They live in this module because it already holds
// the workflow store's imports; the module split by tab is follow-up work (the glue ratchet keys its
// baseline by file, and moving them out would add cross-tab imports). A workflow is NOT a knowledge
// note: see `@core/mcp/deprecated-aliases` for the four old `*_knowledge` names of these tools.
/**
 * THE OPA DOOR for a workflow write (`agentic.authz.workflow_write`), asked BEFORE the store is touched.
 * Fail-CLOSED: an OPA that is unreachable or answers an error denies (the write branch of `authorize`
 * ignores OPA_FAIL_OPEN). The store's own gates remain the inner authority.
 *
 * Test seam: see `workflowWriteTestGate` (under `node --test` only).
 */
async function workflowWriteAllowed(user: CurrentUser, op: WorkflowOp, wf: WorkflowFacts): Promise<boolean> {
  const gate = workflowWriteTestGate();
  if (gate) return Boolean(await gate(op, user, wf));
  return (await authorize(`user:${user.id}`, 'workflow.write', workflowWriteDecision(user, op, wf))).allowed;
}
async function requireWorkflowWrite(user: CurrentUser, op: WorkflowOp, wf: WorkflowFacts, tool: string): Promise<void> {
  if (!(await workflowWriteAllowed(user, op, wf))) fail(`${tool} was refused by policy (workflow ${op}): the policy engine did not allow it, or did not answer — nothing was changed`, 403);
}
const factsOf = workflowFacts;

export const workflowWriteTools: McpTool[] = [
  {
    name: 'author_workflow',
    tab: 'workflows',
    minRole: 'creator',
    description:
      'Author a Personal (draft) WORKFLOW (also called: process workflow, SOP (Standard Operating Procedure)) — the documentation of a business process, the runbook for a task: an optional markdown body, ordered `steps` (each with an actor and optional per-step `tacit` note), process `rules`, an optional `actors` registry, and an optional process-level `tacit` string (the TACIT.md companion — unstructured know-how that resists formalization: the gotchas, the "why", the tribal memory). Actors have five categories — Human · Software · Agent · Customer · Partner — where Customer and Partner are EXTERNAL (outside the organisation). The optional `actors` array lets you describe each actor once (name · category · description) and steps reference them by name; if you omit it, a registry is derived from the steps automatically. Same governed store as the Workflows tab. A workflow is NOT a knowledge note: to save a report, an answer or any free-form text, use `save_knowledge_note` instead. Before: list_workflows (extend before duplicating). After: index_workflow; share via request_promotion({kind:"workflow"}) — a domain admin approves (publish_workflow). Governance: created AS YOU in My scope, no approval.',
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
              prompt: {
                type: 'string',
                maxLength: 65536,
                description:
                  'For an `Agent` actor: its LONG prompt (markdown, multi-line, max 64 KiB). It becomes the head of that agent\'s AGENT.md when an agent system is scaffolded from this process, with the steps assigned to the actor appended automatically — so write the actor\'s identity, judgement and tone here, not the step mechanics. It is emitted inside an explicit author-supplied region; it cannot forge the generated sections that follow it.',
              },
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
      if (!title) fail('author_workflow needs a `title`', 400);
      const p = P(user);
      await requireWorkflowWrite(user, 'create', { id: '', tier: 'personal', owner: user.id, domain: str(args.domain) || user.domains[0] || '' }, 'author_workflow');
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
    name: 'publish_workflow',
    tab: 'workflows',
    minRole: 'domain_admin',
    description:
      'Publish a draft workflow My → Domain (draft→live) and re-index it for retrieval. Domain-admin+ only (the My→Domain approval gate). This is the "approve half" of the ladder: the flip runs THROUGH the governance effect seam (no direct publish back door). Before: get_workflow (a creator files request_promotion({kind:"workflow"}) instead). Governance: domain_admin+ in the workflow’s domain. Idempotency: publishing an already-live workflow returns a `conflict`.',
    inputSchema: {
      type: 'object',
      properties: { workflowId: { type: 'string', description: 'Draft workflow id (wf_…) to publish.' } },
      required: ['workflowId'],
      examples: [{ workflowId: 'wf_ab12cd' }],
    },
    call: async (user, args) => {
      const id = str(args.workflowId).trim();
      if (!id) fail('publish_workflow needs a `workflowId`', 400);
      const p = P(user);
      await requireWorkflowWrite(user, 'publish', factsOf(getWorkflow(id, p)), 'publish_workflow'); // view-scope first, then the policy
      // Route the flip through the ONE effect seam (never publishWorkflow directly).
      // Intent is PUBLISH (rung 1): a mismatch (already-Shared workflow) is a typed
      // conflict, not a silent certify-to-marketplace.
      await promoteThroughSeam('knowledge', id, user, { rung: 'promote' });
      const rec = getWorkflow(id, p);
      try {
        // A27: the embed calls bill the PUBLISHER, not `user os-system`.
        const caller = actingCaller(user.id, rec.domain);
        await indexWorkflow(rec.workflow, { owner: rec.owner, tacit: rec.tacit, updatedAt: rec.updatedAt, caller });
        await indexDomain(getDomainKnowledge(rec.domain), caller);
      } catch {
        /* indexing is best-effort; publish already succeeded */
      }
      return { id: rec.id, status: rec.status, visibility: rec.visibility, publishedBy: rec.publishedBy };
    },
  },
  {
    name: 'index_workflow',
    tab: 'workflows',
    minRole: 'creator',
    description:
      'Re-run the indexing pipeline (unit-chunk → embed → hybrid index) for a workflow you can see + its domain card, so `search_knowledge` can return its text. Governance: read-scoped on the workflow; runs AS you. Idempotent — safe to re-run.',
    inputSchema: {
      type: 'object',
      properties: { workflowId: { type: 'string', description: 'Workflow id (wf_…) to (re)index.' } },
      required: ['workflowId'],
      examples: [{ workflowId: 'wf_ab12cd' }],
    },
    call: async (user, args) => {
      const id = str(args.workflowId).trim();
      if (!id) fail('index_workflow needs a `workflowId`', 400);
      const p = P(user);
      const view = getWorkflow(id, p);
      await requireWorkflowWrite(user, 'index', factsOf(view), 'index_workflow');
      // A27: the embed calls bill the caller who asked for the re-index.
      const caller = actingCaller(user.id, view.domain);
      const workflow = await indexWorkflow(view.workflow, { owner: view.owner, tacit: view.tacit, updatedAt: view.updatedAt, caller });
      const domain = await indexDomain(getDomainKnowledge(view.domain), caller);
      return { workflow, domain };
    },
  },
  {
    name: 'retire_workflow',
    tab: 'workflows',
    minRole: 'creator',
    description:
      'RETIRE a workflow you can edit — the Workflows tab’s lifecycle: `archive` (the default: reversible soft-hide, retains the record + history) or `delete` (PHYSICAL + irreversible: removes the record, its version history, and purges its indexed units from OpenSearch + the offline mirror so it stops being retrievable). Same governed store the Workflows tab + `/api/knowledge/workflows/[id]` call. LINEAGE-AWARE: blocked with a typed 409 if any App or Agent system still consumes it (never orphan a live dependency) — remove those uses first. Role gate (edit scope, re-checked in-lib): the OWNER may retire their own Personal/unshared workflow; a SHARED/domain workflow needs a same-domain Builder+. Physical `delete` additionally refuses a still-published (`live`) workflow — archive/unpublish it first (mirrors the store). Idempotency: retiring a missing workflow is a typed not_found.',
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: { type: 'string', description: 'The workflow id (wf_…) to retire.' },
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
      if (!id) fail('retire_workflow needs a `workflowId`', 400);
      const action = str(args.action).trim() || 'archive';
      if (action !== 'archive' && action !== 'delete') {
        fail("retire_workflow `action` must be 'archive' or 'delete'", 400);
      }
      const p = P(user);
      // View-scope + existence guard first (typed 403/404) so a lineage/role message
      // never leaks a workflow the caller can't even see.
      const view = getWorkflow(id, p);
      await requireWorkflowWrite(user, 'retire', factsOf(view), 'retire_workflow');
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

export const workflowReadTools: McpTool[] = [
  {
    name: 'list_workflows',
    tab: 'workflows',
    minRole: 'creator',
    description:
      'List the workflows you can see — the documented business processes of the Workflows tab — My · Domain · Company. Path: DISCOVERY for the Workflows golden path. Before: whoami. After: get_workflow. Governance: read-only, DLS-scoped.',
    inputSchema: withLifecycleArg(NO_ARGS),
    // The lifecycle pin kind stays `knowledge`: it is the persisted spelling of the pins already
    // written for these ids (`live/knowledge/wf_…`); a rename would orphan them.
    call: async (user, args) => lifecycleView('knowledge', args, listWorkflows(P(user))),
  },
  {
    name: 'get_workflow',
    tab: 'workflows',
    minRole: 'creator',
    description:
      'Read one workflow you can see — steps, actors, rules, tacit note, status. Returns `knowledgeLinks: { links: [{id,title}], unresolved: [{href,label}] }` — the first-class references from THIS workflow to OTHER documents, so you can walk a certified bundle deterministically instead of re-searching; unresolvable links are flagged, not dropped. Path: DISCOVERY for the Workflows golden path. Before: list_workflows. After: index_workflow or (Domain admin) publish_workflow. Governance: read-only; an unseeable id → not_found.',
    inputSchema: idArg('workflowId', 'Workflow id (wf_…) from list_workflows.'),
    call: async (user, args) => {
      const id = str(args.workflowId).trim();
      if (!id) fail('get_workflow needs a `workflowId`', 400);
      return getWorkflow(id, P(user));
    },
  },
];
