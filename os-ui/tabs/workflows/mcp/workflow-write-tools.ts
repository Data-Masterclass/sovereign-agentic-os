/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        workflows
 * FEATURE:    The Workflows tab's MCP tools — author, list, read, index, publish and retire a WORKFLOW
 * USER STORY: As an agent or an AI client I want a workflow (the documentation of a business process:
 *             steps + actors) to be its own artifact with its own tools, so that "save this report as
 *             knowledge" can never create a workflow, and "document this process" can never create a
 *             knowledge note.
 * ARCHITECTURE:
 *   - A workflow (`wf_…`) lives in the workflow store (`@tabs/knowledge/lib/store`, `createWorkflow`);
 *     a knowledge note (`pk_…`) lives in the personal-knowledge store. They are two artifacts. The
 *     Workflows tab shows the first; the Knowledge tab shows the second (`save_knowledge_note`).
 *   - Thin adapters over the SAME governed lib functions the Workflows tab and `/api/knowledge/workflows`
 *     call, as the caller's identity — OPA, DLS, audit and the role ladder apply unchanged.
 *   - These tools used to be named `author_knowledge`, `index_knowledge`, `publish_knowledge`,
 *     `retire_knowledge`, `list_knowledge`, `get_knowledge`. The four write names still work for one
 *     release (`@core/mcp/deprecated-aliases`); `list_knowledge` / `get_knowledge` now serve knowledge
 *     notes only.
 *   - Persisted keys keep their historical spelling (approval kind `knowledge`, lifecycle pin kind
 *     `knowledge`, OPA `knowledge` resources): renaming them would orphan stored approvals and pins.
 */
import 'server-only';
import type { McpTool } from '@core/mcp/server';
import { withLifecycleArg, lifecycleView } from '@core/mcp/list-args';
import { P, fail, str, mapSteps, mapRules, mapActors } from '@core/mcp/write-common';
import { NO_ARGS, idArg } from '@core/mcp/experimental/discovery-common';
import {
  createWorkflow,
  updateWorkflow,
  updateTacit,
  getWorkflow,
  listWorkflows,
  getDomainKnowledge,
  archiveWorkflow,
  deleteWorkflow,
} from '@tabs/knowledge/lib/store';
import { knowledgeConsumers } from '@tabs/knowledge/lib/consumers';
import { promoteThroughSeam } from '@core/policy/ladder';
import { serializeWorkflow, deriveActors, type Workflow } from '@tabs/knowledge/lib/schema';
import { indexWorkflow, indexDomain, purgeKnowledgeUnits } from '@tabs/knowledge/lib/index-pipeline';
import { actingCaller } from '@tabs/knowledge/lib/embed';

export const workflowWriteTools: McpTool[] = [
  {
    name: 'author_workflow',
    tab: 'workflows',
    minRole: 'creator',
    description:
      'Author a Personal (draft) WORKFLOW (also called: process workflow, SOP (Standard Operating Procedure)) — the documentation of a business process, the runbook for a task: an optional markdown body, ordered `steps` (each with an actor and optional per-step `tacit` note), process `rules`, an optional `actors` registry, and an optional process-level `tacit` string (the TACIT.md companion — unstructured know-how that resists formalization: the gotchas, the "why", the tribal memory). Actors have five categories — Human · Software · Agent · Customer · Partner — where Customer and Partner are EXTERNAL (outside the organisation). The optional `actors` array lets you describe each actor once (name · category · description) and steps reference them by name; if you omit it, a registry is derived from the steps automatically. Same governed store as the Workflows tab. A workflow is NOT a knowledge note: to save a report, an answer or any free-form text, use `save_knowledge_note` instead. Publish a workflow later with `publish_workflow`.',
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
      'Publish a draft workflow My → Domain (draft→live) and re-index it for retrieval. Domain-admin+ only (the My→Domain approval gate). This is the "approve half" of the ladder: the flip runs THROUGH the governance effect seam (no direct publish back door). Idempotency: publishing an already-live workflow returns a `conflict`.',
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
      'Re-run the indexing pipeline (unit-chunk → embed → hybrid index) for a workflow you can see + its domain card, so `search_knowledge` can return its text. Idempotent — safe to re-run.',
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
