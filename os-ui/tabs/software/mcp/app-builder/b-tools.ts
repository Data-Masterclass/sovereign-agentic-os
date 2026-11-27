/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder - workstream B MCP tools (classifier, build loop, lights, post-hoc proposals)
 * USER STORY: As an MCP client I want every App Builder action of workstream B to have an MCP twin of its UI action,
 *             governed exactly like the UI.
 * ARCHITECTURE:
 *   - EXTENSION POINT created empty by W0; owned by workstream B.
 *   - `bTools` (index.ts wraps each with the App Builder guard: flag off ⇒ `app_builder_disabled`):
 *       `propose_requirement(appId, text, prefer?)`   classify a requirement and open a diff card (a write: OPA
 *                                                     `authorize()`, then the app's visibility; nothing in git changes).
 *       `decide_requirement(appId, proposalId, decision, rev?, change?, classification?, reason?)` approve (one commit,
 *                                                     `OS-Source: mcp`, `OS-Proposal`), edit or reject a card; the app's
 *                                                     edit scope; refused at agent-run doors (AGENT_FORBIDDEN_TOOLS):
 *                                                     a person agrees a requirement, never an unattended run.
 *       `list_requirement_proposals(appId, status?)`  the cards, with rev, unreviewed set and lights (a read).
 *   - `bHandlers`, for `templateVersion: 2` apps only with the flag on (index.ts `routeToAppBuilder`):
 *       `build_software`  the target must be AGREED with no pending card; returns the criterion refs, the tagging rule
 *                         and the failing test scaffolds to commit FIRST (test first, spec section 5).
 *       `verify_software` the story lights and statuses from the latest finished run.
 *       `push_app_files`  code needs `story` (an agreed story without a pending card, whose criteria already have tagged
 *                         tests: storyWriteGate); the commit message carries `[US-n]`; docs-only pushes need none.
 *     All requirement and story text is DATA for the classifier and the builder, never instructions to a tool.
 */
import type { McpTool } from '@core/mcp/server';
import type { CurrentUser } from '@core/kernel/auth';
import type { AppBuilderHandler } from '@tabs/software/mcp/app-builder/types';
import { authorize } from '@core/infra/governed';
import { withStatus, type App } from '@tabs/software/lib/apps';
import type { Classification, SpecChange, SpecProposal } from '@tabs/software/lib/app-builder-contracts';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Existence first (the X7 convention: an app the caller cannot see is `not_found`), then OPA. */
async function opa(user: CurrentUser, what: string, appId: string): Promise<void> {
  const { resolveSpecApp } = await import('@tabs/software/lib/stories/store');
  await resolveSpecApp(appId, user, 'view');
  const decision = await authorize(`user:${user.id}`, 'software_checks');
  if (!decision.allowed) throw withStatus(new Error(`OPA refused ${what} (${decision.policy})`), 403);
}

export const bTools: McpTool[] = [
  {
    name: 'propose_requirement',
    description:
      "App Builder: turn ONE new requirement (plain words, any language) into a DIFF CARD for an App Builder app: the OS classifies it as refine-story, refine-epic, new-story or new-epic against the app's living spec and proposes the exact story/epic file change (ids are assigned by the OS). NOTHING changes in git, code or tests until someone who can edit the app approves the card with decide_requirement. The requirement text is treated as data. Returns the card with its `rev`. A typed `classifier_unavailable` means the model could not classify; write the story in the Stories view instead.",
    minRole: 'creator',
    tab: 'software',
    inputSchema: {
      type: 'object',
      properties: {
        appId: { type: 'string', description: 'App id from list_software (an app created from nextjs-web@2).' },
        text: { type: 'string', description: 'The requirement, at most 4000 characters.' },
        prefer: { type: 'string', enum: ['refine-story', 'refine-epic', 'new-story', 'new-epic'], description: 'Optional: ask for this classification.' },
      },
      required: ['appId', 'text'],
      examples: [{ appId: 'app_ab12cd', text: 'An order without lines must be refused with a clear message.' }],
    },
    call: async (user, args) => {
      await opa(user, 'proposing a requirement', str(args.appId));
      const { proposeRequirement } = await import('@tabs/software/lib/stories/proposals');
      return proposeRequirement(user, str(args.appId), { text: str(args.text), source: 'mcp', ...(args.prefer !== undefined ? { prefer: str(args.prefer) } : {}) });
    },
  },
  {
    name: 'decide_requirement',
    description:
      "App Builder: decide a diff card of an App Builder app. `approve` commits the card's story/epic files in ONE commit (OS-Source: mcp, OS-Proposal: <id>) and marks its stories agreed — only then may build_software change their code and tests; a post-hoc card (from a git push) is already in git, so approving it records the approval and clears the app's unreviewed changes. `edit` replaces the card's files or classification (needs `rev`). `reject` needs a `reason`; a rejected post-hoc change keeps blocking Domain/Company go-live until a revert commit. Pass the card's `rev` (from propose_requirement or list_requirement_proposals): a card changed since answers 409. Anyone who can edit the app may decide.",
    minRole: 'creator',
    tab: 'software',
    inputSchema: {
      type: 'object',
      properties: {
        appId: { type: 'string', description: 'App id from list_software.' },
        proposalId: { type: 'string', description: 'The card id (prop_…).' },
        decision: { type: 'string', enum: ['approve', 'edit', 'reject'] },
        rev: { type: 'string', description: 'The rev of the card you read (required for edit).' },
        change: { type: 'object', description: 'edit: { writes: [{ path: "stories/EP-1-…/US-3-….md", content }], deletes: [], summary }.' },
        classification: { type: 'string', enum: ['refine-story', 'refine-epic', 'new-story', 'new-epic'] },
        reason: { type: 'string', description: 'reject: why (at most 500 characters).' },
      },
      required: ['appId', 'proposalId', 'decision'],
      examples: [{ appId: 'app_ab12cd', proposalId: 'prop_x1', decision: 'approve', rev: '0123456789abcdef' }],
    },
    call: async (user, args) => {
      await opa(user, 'deciding a requirement', str(args.appId));
      const { decideProposal } = await import('@tabs/software/lib/stories/proposals');
      return decideProposal(str(args.appId), str(args.proposalId), user, str(args.decision) as 'approve' | 'reject' | 'edit', {
        ...(args.rev !== undefined ? { rev: str(args.rev) } : {}),
        ...(args.reason !== undefined ? { reason: str(args.reason) } : {}),
        ...(args.change !== undefined ? { change: args.change as SpecChange } : {}),
        ...(args.classification !== undefined ? { classification: str(args.classification) as Classification } : {}),
        via: 'mcp',
      });
    },
  },
  {
    name: 'list_requirement_proposals',
    description:
      "App Builder: the diff cards of an App Builder app, newest first: pending, approved, rejected and superseded requirement proposals, including post-hoc cards from git pushes (story files changed outside the OS, and 'change without a story'), each with its `rev`; plus `unreviewed` (the cards that block Domain/Company go-live) and the story lights. Read-only; the same visibility rule as the app.",
    minRole: 'creator',
    tab: 'software',
    inputSchema: {
      type: 'object',
      properties: {
        appId: { type: 'string', description: 'App id from list_software.' },
        status: { type: 'string', enum: ['pending', 'approved', 'rejected', 'superseded'] },
      },
      required: ['appId'],
      examples: [{ appId: 'app_ab12cd', status: 'pending' }],
    },
    call: async (user, args) => {
      const { listProposals } = await import('@tabs/software/lib/stories/proposals');
      const status = args.status === undefined ? undefined : (str(args.status) as SpecProposal['status']);
      if (status && !['pending', 'approved', 'rejected', 'superseded'].includes(status)) throw withStatus(new Error('status must be pending, approved, rejected or superseded'), 400);
      const out = await listProposals(str(args.appId), user, status ? { status } : {});
      const { refreshStoryLights } = await import('@tabs/software/lib/stories/lights');
      return { ...out, lights: (await refreshStoryLights(out.appId))?.stories ?? {} };
    },
  },
];

// ------------------------------------------------------------- v2 handlers ---

/** The stories a build/verify target names (story id, epic id, or the whole app). */
function targetStoryIds(args: Record<string, unknown>, spec: { stories: { id: string; epic: string }[] }): string[] {
  const t = (args.target && typeof args.target === 'object' ? args.target : {}) as Record<string, unknown>;
  const story = str(t.storyId) || str(args.story);
  const epic = str(t.epicId) || str(args.epic);
  if (story) return [story];
  if (epic) return spec.stories.filter((s) => s.epic === epic).map((s) => s.id);
  return spec.stories.map((s) => s.id);
}

async function committedTree(app: App): Promise<{ path: string; content: string }[]> {
  const { getSnapshot, hydrateSnapshot } = await import('@tabs/software/lib/snapshot');
  await hydrateSnapshot(app.id);
  return (getSnapshot(app.id) ?? []).map((f) => ({ path: String(f.path), content: String(f.content ?? '') }));
}

const buildSoftware: AppBuilderHandler = async (user, args, app) => {
  const { resolveSpecApp, readSpecOf } = await import('@tabs/software/lib/stories/store');
  const { storyWriteGate } = await import('@tabs/software/lib/builder/tools');
  const { CRITERIA_TAGGING_RULE, criteriaTestFile, untaggedCriteria } = await import('@tabs/software/lib/builder/criteria-tests');
  const target = await resolveSpecApp(app.id, user, 'view');
  const { spec } = await readSpecOf(target);
  const ids = targetStoryIds(args, spec);
  if (ids.length === 0) throw withStatus(new Error(`${app.name} has no stories yet: propose a requirement (propose_requirement) and approve its diff card first`), 409);
  const named = Boolean((args.target && typeof args.target === 'object') || args.story || args.epic);
  const buildable = named ? ids : ids.filter((id) => storyWriteGate(spec, target.proposals, [id]) === null);
  if (buildable.length === 0) throw withStatus(new Error(`no story of ${app.name} is agreed without a pending diff card; approve a card first`), 409);
  for (const id of buildable) {
    const why = storyWriteGate(spec, target.proposals, [id]);
    if (why) throw withStatus(new Error(why), 409);
  }
  const tree = await committedTree(target);
  const stories = buildable.map((id) => spec.stories.find((s) => s.id === id)!);
  return {
    stage: 'build',
    kind: 'app-builder',
    appId: app.id,
    stories: stories.map((s) => ({ id: s.id, title: s.title, path: s.path, criteria: s.criteria.map((c) => ({ ref: `${s.id}/${c.id}`, title: c.title, given: c.given, when: c.when, then: c.then })) })),
    testsFirst: stories.filter((s) => s.criteria.length > 0 && untaggedCriteria(s, tree).length > 0).map((s) => criteriaTestFile(s)),
    taggingRule: CRITERIA_TAGGING_RULE,
    next:
      'First commit the testsFirst files (push_app_files with story set to the story id), unchanged except for real test bodies; then write the code with push_app_files (story set, so the commit carries [US-n]) until the checks are green. A story is built only when its tagged tests pass in a green run; verify_software shows the lights.',
  };
};

const verifySoftware: AppBuilderHandler = async (user, args, app) => {
  const { resolveSpecApp, readSpecOf } = await import('@tabs/software/lib/stories/store');
  const { lightsOfApp } = await import('@tabs/software/lib/stories/lights');
  const { refreshStoryLights } = await import('@tabs/software/lib/stories/lights');
  const target = await resolveSpecApp(app.id, user, 'view');
  const { spec } = await readSpecOf(target);
  await refreshStoryLights(target.id);
  const view = lightsOfApp(spec, target);
  const ids = new Set(targetStoryIds(args, spec));
  const stories = Object.fromEntries(Object.entries(view.stories).filter(([id]) => ids.has(id)));
  return {
    stage: 'test',
    kind: 'app-builder',
    appId: app.id,
    evidenceSha: view.sha,
    truncated: view.truncated,
    stories,
    untested: Object.values(stories).flatMap((s) => s.criteria.filter((c) => c.state === 'untested').map((c) => c.ref)),
    failing: Object.values(stories).flatMap((s) => s.criteria.filter((c) => c.state === 'fail').map((c) => c.ref)),
    note: view.sha ? 'Lights come from the criteria result of the latest finished check run; a story is verified only on the release running in Dev.' : 'No finished check run has a criteria result yet: every story is untested.',
  };
};

const pushAppFilesV2: AppBuilderHandler = async (user, args, app) => {
  const files = Array.isArray(args.files) ? (args.files as { path: string; content: string }[]) : [];
  const { pushAppFiles } = await import('@tabs/software/lib/push-app-files');
  const { isSpecOrDocPath } = await import('@tabs/software/lib/stories/story-ref');
  const { withStoryRefs } = await import('@tabs/software/lib/builder/loop');
  const story = str(args.story);
  const code = files.filter((f) => f && typeof f.path === 'string' && !isSpecOrDocPath(f.path));
  if (code.length > 0) {
    const { resolveSpecApp, readSpecOf } = await import('@tabs/software/lib/stories/store');
    const { storyWriteGate } = await import('@tabs/software/lib/builder/tools');
    const target = await resolveSpecApp(app.id, user, 'edit');
    const { spec } = await readSpecOf(target);
    const why = storyWriteGate(spec, target.proposals, story ? [story] : [], { incoming: files, tree: await committedTree(target) });
    if (why) throw withStatus(new Error(why), 409);
  }
  return pushAppFiles({ appId: app.id, files, message: withStoryRefs(str(args.message), story ? [story] : []), surface: 'mcp:push_app_files' }, user);
};

export const bHandlers: Record<string, AppBuilderHandler> = {
  build_software: buildSoftware,
  verify_software: verifySoftware,
  push_app_files: pushAppFilesV2,
};
