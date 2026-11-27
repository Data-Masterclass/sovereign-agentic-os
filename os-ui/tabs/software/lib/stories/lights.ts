/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder B - one test light per story, and the story's displayed status, from build evidence only
 * USER STORY: As a business user I want each story to show green, partly tested or untested after every build, with
 *             the criteria behind it, and to see a story as built or verified only because its tests prove it.
 * ARCHITECTURE:
 *   - Spec section 5. PURE derivations over the parsed living spec and the `criteria` result of the latest finished
 *     check run (`CheckRecord.criteria`, written by the platform's factory-gates.mjs as the Tekton result `criteria`
 *     and parsed with `parseCriteriaResult`, never read from logs):
 *       green    = the story has criteria, every criterion has at least one tagged test, and none failed;
 *       partial  = some criteria covered, or any tagged test failed, or the result was TRUNCATED (never green);
 *       untested = no tagged test for any criterion (also: a story with no criteria, or no result at all).
 *   - STATUS is split (spec 3.1): `draft | agreed` come from the file (a human decision); `built` = agreed, light green
 *     and the run that produced it is green; `verified` = built on the sha of the release currently running in Dev. A
 *     refined criterion has no test yet, so the light drops to partial and the status back to agreed — no bot commits a
 *     status, so a regression lowers it automatically.
 *   - `refreshStoryLights(appId)` (the one writer of `App.stories.lights`, under A's spec lock, only on change) is called
 *     by `verify_software` and C2's check recording; reads (`readStoryLights`) never write.
 */
import type { CheckRecord } from '@tabs/software/lib/check-record';
import type {
  AppRelease,
  CriteriaResults,
  CriterionRef,
  LivingSpec,
  StoryDoc,
  StoryId,
  StoryLight,
  StoryStatus,
} from '@tabs/software/lib/app-builder-contracts';

/** The Tekton result size the platform writes at most (bytes); a larger result is written as the truncated marker. */
export const CRITERIA_RESULT_MAX_BYTES = 3584;
const REF_RE = /^US-[1-9][0-9]{0,5}\/AC-[1-9][0-9]{0,5}$/;

export type CriteriaParse = { ok: true; result: CriteriaResults } | { ok: false; reason: string };

/**
 * Parse the raw `criteria` result (C2 calls this when it records a run). Anything that is not a v1 result is a typed
 * refusal: the caller records NO criteria (a missing result is "no evidence", never "all passed"). Counts must be
 * non-negative integers; one bad entry refuses the whole result.
 */
export function parseCriteriaResult(raw: string | null | undefined): CriteriaParse {
  if (typeof raw !== 'string' || raw.length === 0) return { ok: false, reason: 'no criteria result' };
  if (raw.length > CRITERIA_RESULT_MAX_BYTES * 2) return { ok: false, reason: 'the criteria result is larger than a Tekton result can be' };
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch (e) {
    return { ok: false, reason: `the criteria result is not JSON (${e instanceof Error ? e.message.slice(0, 80) : 'parse error'})` };
  }
  if (!v || typeof v !== 'object' || (v as { v?: unknown }).v !== 1) return { ok: false, reason: 'the criteria result is not version 1' };
  const o = v as { truncated?: unknown; results?: unknown };
  if (o.truncated === true) return { ok: true, result: { v: 1, truncated: true, results: {} } };
  if (!o.results || typeof o.results !== 'object' || Array.isArray(o.results)) return { ok: false, reason: 'the criteria result has no results object' };
  const results: CriteriaResults['results'] = {};
  for (const [ref, c] of Object.entries(o.results as Record<string, unknown>)) {
    if (!REF_RE.test(ref) || !c || typeof c !== 'object') return { ok: false, reason: `'${ref.slice(0, 40)}' is not a criterion ref with counts` };
    const { pass, fail } = c as { pass?: unknown; fail?: unknown };
    if (!Number.isInteger(pass) || !Number.isInteger(fail) || (pass as number) < 0 || (fail as number) < 0) return { ok: false, reason: `the counts of ${ref} are not non-negative integers` };
    results[ref as CriterionRef] = { pass: pass as number, fail: fail as number };
  }
  return { ok: true, result: { v: 1, results } };
}

export type CriterionState = 'pass' | 'fail' | 'untested';
export type StoryLightDetail = {
  light: StoryLight;
  criteria: { ref: CriterionRef; state: CriterionState; pass: number; fail: number }[];
  /** Why the light is not green, in a machine-stable word: `no-criteria` | `no-result` | `truncated` | `failing` | `uncovered`. */
  reason?: 'no-criteria' | 'no-result' | 'truncated' | 'failing' | 'uncovered';
};

/** The refs a story's criteria must be proven by. */
export function criterionRefsOf(story: Pick<StoryDoc, 'id' | 'criteria'>): CriterionRef[] {
  return story.criteria.map((c) => `${story.id}/${c.id}` as CriterionRef);
}

/** The light of one story from one criteria result (spec section 5). */
export function storyLight(story: Pick<StoryDoc, 'id' | 'criteria'>, criteria: CriteriaResults | null | undefined): StoryLightDetail {
  const refs = criterionRefsOf(story);
  const rows = refs.map((ref) => {
    const c = criteria && !criteria.truncated ? criteria.results[ref] : undefined;
    const pass = c?.pass ?? 0;
    const fail = c?.fail ?? 0;
    const state: CriterionState = fail > 0 ? 'fail' : pass > 0 ? 'pass' : 'untested';
    return { ref, state, pass, fail };
  });
  if (refs.length === 0) return { light: 'untested', criteria: rows, reason: 'no-criteria' };
  if (!criteria) return { light: 'untested', criteria: rows, reason: 'no-result' };
  if (criteria.truncated) return { light: 'partial', criteria: rows, reason: 'truncated' };
  const covered = rows.filter((r) => r.state !== 'untested').length;
  if (covered === 0) return { light: 'untested', criteria: rows, reason: 'uncovered' };
  if (rows.some((r) => r.state === 'fail')) return { light: 'partial', criteria: rows, reason: 'failing' };
  if (covered < rows.length) return { light: 'partial', criteria: rows, reason: 'uncovered' };
  return { light: 'green', criteria: rows };
}

/** `storyLights(spec, criteria?)`: every story's light. */
export function storyLights(spec: Pick<LivingSpec, 'stories'>, criteria?: CriteriaResults | null): Record<StoryId, StoryLightDetail> {
  const out = {} as Record<StoryId, StoryLightDetail>;
  for (const s of spec.stories) out[s.id] = storyLight(s, criteria ?? null);
  return out;
}

export type StatusEvidence = {
  /** The run the criteria came from finished green (every gate passed). */
  green: boolean;
  /** That run's sha is the sha of the release currently running in Dev. */
  inDev: boolean;
};

/** `storyStatus(story, light, evidence)`: draft → agreed → built → verified (built/verified derived, spec 5). */
export function storyStatus(story: Pick<StoryDoc, 'state'>, light: StoryLight, evidence: StatusEvidence): StoryStatus {
  if (story.state !== 'agreed') return 'draft';
  if (light !== 'green' || !evidence.green) return 'agreed';
  return evidence.inDev ? 'verified' : 'built';
}

/** The record the lights read: the given head's record when a head is known, else the newest FINISHED record. */
export function evidenceRecord(checks: CheckRecord[] | undefined, headSha?: string | null): CheckRecord | null {
  const list = checks ?? [];
  if (headSha) return list.find((r) => r.sha === headSha && r.status === 'finished') ?? null;
  return list.find((r) => r.status === 'finished') ?? null;
}

/** True when every check of a finished record passed and it carries no engine error. */
export function recordIsGreen(rec: CheckRecord | null): boolean {
  return !!rec && rec.status === 'finished' && !rec.error && rec.checks.length > 0 && rec.checks.every((c) => c.status === 'pass');
}

/** The sha of the newest running Dev release (workstream C2's records), or null. */
export function devReleaseSha(releases: AppRelease[] | undefined): string | null {
  const dev = (releases ?? []).filter((r) => r.env === 'dev' && !r.slot && r.state === 'running');
  dev.sort((a, b) => b.at.localeCompare(a.at));
  return dev[0]?.sha ?? null;
}

export type StoryEvidenceView = {
  sha: string | null;
  truncated: boolean;
  stories: Record<StoryId, StoryLightDetail & { status: StoryStatus }>;
};

/** Lights and statuses of every story of an app, from its records (pure; `headSha` when the caller knows it). */
export function lightsOfApp(
  spec: Pick<LivingSpec, 'stories'>,
  app: { checks?: CheckRecord[]; releases?: AppRelease[] },
  headSha?: string | null,
): StoryEvidenceView {
  const rec = evidenceRecord(app.checks, headSha);
  const criteria = rec?.criteria ?? null;
  const evidence: StatusEvidence = { green: recordIsGreen(rec), inDev: !!rec && rec.sha === devReleaseSha(app.releases) };
  const lights = storyLights(spec, criteria);
  const stories = {} as StoryEvidenceView['stories'];
  for (const s of spec.stories) stories[s.id] = { ...lights[s.id], status: storyStatus(s, lights[s.id].light, evidence) };
  return { sha: rec?.sha ?? null, truncated: !!criteria?.truncated, stories };
}

/**
 * Re-derive `App.stories.lights` from the app's records and persist ONLY when it changed. Server-side; the app store is
 * imported lazily so this module stays pure for its importers. The write happens under A's spec lock (the `stories`
 * field's writer) on a FRESH read of the record, and `persistApp` sends only the fields that changed, so it never puts
 * back a stale copy of anything else. Called by `verify_software` and by C2 after it records a run — never by a GET
 * (reads use the pure `lightsOfApp`).
 */
export async function refreshStoryLights(appId: string): Promise<StoryEvidenceView | null> {
  const { getAppByIdInternal, persistApp } = await import('@tabs/software/lib/apps');
  const { withSpecLock } = await import('@tabs/software/lib/stories/store');
  const first = await getAppByIdInternal(appId);
  if (!first?.stories) return null;
  return withSpecLock(first, async () => {
    const app = await getAppByIdInternal(appId);
    if (!app?.stories) return null;
    const view = lightsOfApp(app.stories.index, app);
    const next = Object.fromEntries(Object.entries(view.stories).map(([id, s]) => [id, s.light])) as Record<StoryId, StoryLight>;
    if (JSON.stringify(next) !== JSON.stringify(app.stories.lights ?? {})) {
      app.stories = { ...app.stories, lights: next };
      await persistApp(app);
    }
    return view;
  });
}

/** The lights of an app as a read (no write): for the proposals GET and `list_requirement_proposals`. */
export async function readStoryLights(appId: string): Promise<StoryEvidenceView | null> {
  const { getAppByIdInternal } = await import('@tabs/software/lib/apps');
  const app = await getAppByIdInternal(appId);
  return app?.stories ? lightsOfApp(app.stories.index, app) : null;
}
