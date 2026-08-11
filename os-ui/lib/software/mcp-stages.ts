/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * THE STAGED MCP SURFACE (pure) — how the Platform MCP mirrors the UI's five-stage
 * Software flow (Define App → Design Epics → Choose Context → Build App → Test & Publish,
 * 0.6.105) for an EXTERNAL agent.
 *
 * An external agent (Claude / Codex) IS the model. So the Build and Test tools do not
 * run an internal LLM — they hand the agent the EXACT SAME governed directive + grounded
 * context the UI's build-chat route assembles (mode directive · Define context · the
 * target's spec · code-structure convention · the committed files), enforce the same
 * gates (design-before-build, tier), then the agent walks the identical governed path
 * (author code → `commit` → `start_preview` → `request_deploy`). This module is pure so
 * the gate + directive assembly are unit-testable without a repo or a model.
 *
 * NOTHING here duplicates build/test LOGIC — it REUSES the UI's own pure pieces
 * (`modeDirective`, `BUILD_PRINCIPLES`, `CODE_STRUCTURE_CONVENTION`, `modelRoleForMode`,
 * `defineContextBlock`, `specPromptLines`, `deriveStoryChecklist`, `everyStoryHasSpec`).
 */

import type { App, AppEpic, AppStory } from '@/lib/software/apps';
import type { BuildTarget } from '@/lib/software/build-target';
import { targetLabel, type TargetEpic } from '@/lib/software/build-target';
import {
  modeDirective,
  modelRoleForMode,
  tierNote,
  type ChatRunMode,
} from '@/lib/software/chat-modes';
import { defineContextBlock, specPromptLines } from '@/lib/software/define-context';
import {
  deriveStoryChecklist,
  everyStoryHasSpec,
  specHasContent,
  type StorySpec,
} from '@/lib/software/story-spec';

/** Coerce an arbitrary `target` arg into a valid BuildTarget (default: whole app). */
export function asBuildTarget(v: unknown): BuildTarget {
  if (!v || typeof v !== 'object') return { kind: 'app' };
  const t = v as Record<string, unknown>;
  const epicId = typeof t.epicId === 'string' ? t.epicId : '';
  const storyId = typeof t.storyId === 'string' ? t.storyId : '';
  if (t.kind === 'story' && epicId && storyId) return { kind: 'story', epicId, storyId };
  if (t.kind === 'epic' && epicId) return { kind: 'epic', epicId };
  // Be forgiving: infer the kind from the ids present (some clients omit `kind`).
  if (epicId && storyId) return { kind: 'story', epicId, storyId };
  if (epicId) return { kind: 'epic', epicId };
  return { kind: 'app' };
}

/** The epics in the minimal `TargetEpic` shape the label derivation needs. */
export function targetEpics(app: App): TargetEpic[] {
  return (app.epics ?? []).map((e) => ({ id: e.id, title: e.title, stories: e.stories.map((s) => ({ id: s.id, title: s.title })) }));
}

/** The stories the target covers (one story, an epic's stories, or the whole app). */
export function storiesInTarget(app: App, target: BuildTarget): { epic: AppEpic; story: AppStory }[] {
  const epics = app.epics ?? [];
  const out: { epic: AppEpic; story: AppStory }[] = [];
  for (const epic of epics) {
    for (const story of epic.stories) {
      if (target.kind === 'app') out.push({ epic, story });
      else if (target.kind === 'epic' && epic.id === target.epicId) out.push({ epic, story });
      else if (target.kind === 'story' && epic.id === target.epicId && story.id === target.storyId) out.push({ epic, story });
    }
  }
  return out;
}

/** A resolved target — the same shape the UI passes into `appContext`, plus whether it exists. */
export type ResolvedTarget = {
  target: BuildTarget;
  label: string;
  /** The stories the target scopes to (empty when a story/epic id does not resolve). */
  stories: { epic: AppEpic; story: AppStory }[];
  /** True when the target names an epic/story that does not exist on the app. */
  notFound: boolean;
};

export function resolveTarget(app: App, target: BuildTarget): ResolvedTarget {
  const stories = storiesInTarget(app, target);
  const label = targetLabel(targetEpics(app), target);
  // A named epic/story that resolves to zero stories does not exist (whole-app never "not found").
  const notFound = target.kind !== 'app' && stories.length === 0;
  return { target, label, stories, notFound };
}

// ------------------------------------------------------ design-before-build gate --

export type BuildGate =
  | { ok: true }
  | { ok: false; reason: string; unspecified: { epicId: string; storyId: string; title: string }[] };

/**
 * THE DESIGN-BEFORE-BUILD GATE (the SAME rule the UI enforces via `everyStoryHasSpec`
 * / a per-story spec): a story may only be BUILT once its Design spec is authored. For
 * a story/epic target every in-scope story must carry a spec; for the whole app EVERY
 * story must (mirrors the Design-stage completion check). Returns the unspecified
 * stories so the agent knows exactly what to `design_software` first.
 */
export function buildGate(app: App, target: BuildTarget): BuildGate {
  const scope = storiesInTarget(app, target);
  if (target.kind === 'app') {
    // Whole-app build requires the SAME design-completeness the UI's Build stage needs.
    if (everyStoryHasSpec((app.epics ?? []).map((e) => ({ stories: e.stories })))) return { ok: true };
  }
  const unspecified = scope
    .filter(({ story }) => !specHasContent(story.spec))
    .map(({ epic, story }) => ({ epicId: epic.id, storyId: story.id, title: story.title }));
  if (unspecified.length === 0 && scope.length > 0) return { ok: true };
  return {
    ok: false,
    reason:
      scope.length === 0
        ? 'No user stories to build — author epics + stories first with design_software.'
        : `Design-before-build gate: ${unspecified.length} story/stories have no Design spec. Author their features/NFRs/rules with design_software, then build.`,
    unspecified,
  };
}

// ------------------------------------------------------------------ directives --

/** One story rendered for a directive (its user-story sentence + spec lines). */
function storyLines(epic: AppEpic, story: AppStory): string[] {
  const acceptance = story.acceptance ? `Acceptance: ${story.acceptance}` : '';
  return [
    `EPIC ${epic.title || '(untitled)'} › Story ${story.title || '(untitled)'}`,
    `As a ${story.asA || '…'}, I want ${story.iWant || '…'}, so that ${story.soThat || '…'}.`,
    acceptance,
    ...specPromptLines(story.spec as StorySpec | undefined),
  ].filter(Boolean);
}

/**
 * The governed directive block for a Build or Test run over a target — the SAME
 * mode directive + Define context + target spec + code-structure convention the UI's
 * build-chat route assembles, so an external agent builds/verifies IDENTICALLY. `mode`
 * is 'build' (Build stage) or 'test' (Test stage); the tier note is derived, not set.
 */
export function stageDirective(
  app: App,
  target: BuildTarget,
  mode: 'build' | 'test',
  grantedContext = '',
): string {
  const resolved = resolveTarget(app, target);
  const lines: string[] = [
    defineContextBlock(app),
    // The REAL granted context (data schema / knowledge / metrics / files / connections),
    // resolved DLS-scoped as the caller by the tool, so an external agent builds/verifies
    // against the real data plane — exact column names + members, never invented. Empty ⇒ skip.
    ...(grantedContext ? ['', grantedContext] : []),
    '',
    ...modeDirective(mode as ChatRunMode, app.id),
    '',
    `## Target: ${resolved.label}`,
  ];
  for (const { epic, story } of resolved.stories) lines.push('', ...storyLines(epic, story));
  lines.push(
    '',
    `## Model tier: ${tierNote(modelRoleForMode(mode as ChatRunMode))}`,
    mode === 'build'
      ? 'Author the code, then call `commit` with this appId to write it (re-parsed on every commit), then `start_preview` / `request_deploy` for the governed publish gate.'
      : 'Read the COMMITTED code for this scope (get_software / read_app_files) and report PASS/FAIL per the five dimensions; every shortfall becomes one dimension-tagged refinement.',
  );
  return lines.join('\n');
}

// --------------------------------------------------------------- built-vs-pending --

/** An honest per-story checklist roll-up for a target (built iff the story is `done`). */
export type TargetProgress = {
  label: string;
  stories: {
    epicId: string;
    storyId: string;
    title: string;
    status: 'todo' | 'building' | 'done';
    built: number;
    total: number;
  }[];
  storiesBuilt: number;
  storiesTotal: number;
  itemsBuilt: number;
  itemsTotal: number;
};

/**
 * Honest built-vs-pending for a target — reuses `deriveStoryChecklist` so an item counts
 * built ONLY when its story is `done` (a Build run committed for it); never fake-ticked.
 */
export function targetProgress(app: App, target: BuildTarget): TargetProgress {
  const resolved = resolveTarget(app, target);
  const stories = resolved.stories.map(({ epic, story }) => {
    const c = deriveStoryChecklist({ spec: story.spec, status: story.status });
    return {
      epicId: epic.id,
      storyId: story.id,
      title: story.title,
      status: (story.status ?? 'todo') as 'todo' | 'building' | 'done',
      built: c.built,
      total: c.total,
    };
  });
  return {
    label: resolved.label,
    stories,
    storiesBuilt: stories.filter((s) => s.status === 'done').length,
    storiesTotal: stories.length,
    itemsBuilt: stories.reduce((n, s) => n + s.built, 0),
    itemsTotal: stories.reduce((n, s) => n + s.total, 0),
  };
}
