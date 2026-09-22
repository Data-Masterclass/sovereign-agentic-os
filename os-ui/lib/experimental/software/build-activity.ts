/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * BUILD-STAGE ACTIVITY FEED — pure mappers.
 *
 * The Stage-3 Build run streams every governed tool step to the client as it
 * executes. These helpers turn a raw `AgenticStep` ({ tool, args, result, isError })
 * into ONE plain-language line a human can read — never raw JSON. The raw tool I/O
 * is kept alongside (surfaced behind a "show details" affordance for Builders), so
 * this is display sugar, not a data drop.
 *
 * PURE + side-effect-free so it unit-tests under the repo's `node --test` runner
 * and can be imported by both the streaming route (server) and the client feed.
 */

/** One line in the live activity feed. */
export type ActivityLine = {
  /** The governed tool that ran (for the "show details" affordance + icon). */
  tool: string;
  /** The human-readable line, e.g. "Read 12 files". */
  text: string;
  /** True when the step errored — the feed renders it as a warning, not a done. */
  isError: boolean;
};

/** The step shape the agent loop emits (mirrors AgenticStep, decoupled for purity). */
export type ActivityStep = {
  tool: string;
  args: Record<string, unknown>;
  result: string;
  isError: boolean;
};

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) if (typeof v === 'string' && v.trim()) return v.trim();
  return undefined;
}

/**
 * How many files a commit-shaped call is writing, read from its args. Supports the
 * two governed shapes: a `files: [{path,content}]` array, or a single `path`.
 */
function commitFileCount(args: Record<string, unknown>): number {
  const files = asArray(args.files);
  if (files.length > 0) return files.length;
  return typeof args.path === 'string' && args.path.trim() ? 1 : 0;
}

/**
 * Short, reason-only tail of an error result. The raw result may be JSON or a long
 * "Error: …" string; we keep the first line, trimmed, capped so the feed stays calm.
 */
export function errorReason(result: string): string {
  const firstLine = (result ?? '').split('\n')[0].replace(/^Error:\s*/i, '').trim();
  const capped = firstLine.length > 140 ? `${firstLine.slice(0, 140)}…` : firstLine;
  return capped || 'unknown error';
}

/**
 * The COMPILE-GATE line for a `commit` step, or null when the step carries no gate
 * outcome. The gate runs INSIDE commitToApp (verify-before-commit), so it is not its
 * own tool call — this reads the outcome the server recorded on the commit result
 * ("compile check ✓ / skipped (ungated shape)" in the step detail; "commit rejected:
 * N compile error(s)" in a gate rejection) and renders it as its OWN feed step, in
 * the existing activity-line language. Emitted BEFORE the commit line by the route.
 */
export function gateLineFromStep(step: ActivityStep): ActivityLine | null {
  if (step.tool !== 'commit') return null;
  const result = step.result ?? '';
  if (step.isError) {
    const m = /commit rejected: (\d+) compile error/.exec(result);
    if (m) return { tool: step.tool, text: `compile check ✗ ${m[1]} error${m[1] === '1' ? '' : 's'}`, isError: true };
    return null; // a non-gate commit failure — the ⚠ commit line names it
  }
  if (result.includes('compile check ✓')) return { tool: step.tool, text: 'compile check ✓', isError: false };
  if (result.includes('compile check skipped (ungated shape)')) {
    return { tool: step.tool, text: 'compile check skipped (ungated shape)', isError: false };
  }
  return null;
}

/**
 * Map ONE governed tool step to a single human-readable activity line. Driven by the
 * tool NAME + its args (robust — never depends on the exact JSON result body). An
 * errored step always renders as a warning line with the real reason, never a fake
 * "done"; the retry that follows is simply the next step in the stream.
 */
export function toolCallToLine(step: ActivityStep): ActivityLine {
  const { tool, args, result, isError } = step;
  const line = (text: string): ActivityLine => ({ tool, text, isError });

  if (isError) return line(`⚠ ${tool} failed: ${errorReason(result)}`);

  switch (tool) {
    case 'commit':
    case 'commit_agent_files': {
      const n = commitFileCount(args);
      return line(n > 0 ? `Committed ${n} file${n === 1 ? '' : 's'}` : 'Committed changes');
    }
    case 'read_app_files': {
      const path = firstString(args.path);
      if (path) return line(`Read ${path}`);
      return line('Read the app files');
    }
    case 'search_files':
      return line('Searched the app files');
    case 'get_software':
    case 'list_software':
      return line('Read the app details');
    case 'get_software_status':
      return line('Checked build status');
    case 'start_preview':
      return line('Provisioning preview…');
    case 'request_deploy':
      return line('Filed deploy review — approve in Policies & Approvals');
    case 'whoami':
    case 'list_capabilities':
    case 'get_guide':
      return line('Checked what it can do here');
    default: {
      // Unknown tool: a readable fallback that never dumps JSON — humanize the name.
      const humanized = tool.replace(/_/g, ' ');
      return line(`Ran ${humanized}`);
    }
  }
}

/** A segment of the persistent Build ▸ Preview ▸ Deploy status rail. */
export type RailSegment = {
  label: string;
  /** Value shown after the label, e.g. "provisioning", "live", "none". */
  value: string;
  /** Tone drives the pip color: neutral = not started, active = in flight, ok = done. */
  tone: 'neutral' | 'active' | 'ok';
};

/**
 * Derive the honest Build ▸ Preview ▸ Deploy status rail from the app's live
 * state — the SAME fields the Build stage already reads. It never fabricates a
 * "live" it can't see: Preview is `live` ONLY when a previewUrl is actually served,
 * and Deploy reflects the real gate state (none/requested→in-review/live). PURE.
 */
export function buildStatusRail(app: {
  pipeline?: Record<string, string>;
  repo?: { seeded?: string[] };
  deploy?: { state?: string; previewUrl?: string | null; reviewCardId?: string | null; releases?: number };
}): RailSegment[] {
  const pipeline = app.pipeline ?? {};
  const deploy = app.deploy ?? {};
  const committed = pipeline.forgejo === 'ok' || (app.repo?.seeded?.length ?? 0) > 0;

  // Repo — committed once the scaffold/commit landed.
  const repo: RailSegment = committed
    ? { label: 'Repo', value: 'committed', tone: 'ok' }
    : { label: 'Repo', value: 'none', tone: 'neutral' };

  // Preview — honest: live only when a URL is actually served.
  let preview: RailSegment;
  if (deploy.previewUrl) preview = { label: 'Preview', value: 'live', tone: 'ok' };
  else if (deploy.state === 'preview') preview = { label: 'Preview', value: 'provisioning', tone: 'active' };
  else preview = { label: 'Preview', value: 'none', tone: 'neutral' };

  // Deploy — the review gate; a release count means it went live.
  let dep: RailSegment;
  if ((deploy.releases ?? 0) > 0 || deploy.state === 'live') dep = { label: 'Deploy', value: 'live', tone: 'ok' };
  else if (deploy.state === 'review' || deploy.reviewCardId) dep = { label: 'Deploy', value: 'in-review', tone: 'active' };
  else dep = { label: 'Deploy', value: 'none', tone: 'neutral' };

  return [repo, preview, dep];
}

/** Net lines added / removed across a changeset (each side counted separately). PURE. */
function lineDelta(changes: { before: string; after: string }[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const c of changes) {
    const beforeLines = c.before ? c.before.split('\n').length : 0;
    const afterLines = c.after ? c.after.split('\n').length : 0;
    const delta = afterLines - beforeLines;
    if (delta > 0) added += delta;
    else removed += -delta;
  }
  return { added, removed };
}

/**
 * The final activity line summarizing a completed commit changeset (real before/after
 * file counts + net line delta), e.g. "Committed 3 files (+120 −8)". Empty changeset
 * yields null (the run wrote nothing — the feed says so elsewhere).
 */
export function committedSummaryLine(
  appName: string,
  changes: { before: string; after: string }[],
): string | null {
  if (!changes || changes.length === 0) return null;
  const { added, removed } = lineDelta(changes);
  const n = changes.length;
  return `Committed ${n} file${n === 1 ? '' : 's'} to ${appName} (+${added} −${removed})`;
}

/** A concrete, human-readable outcome of a Build turn — "what was actually built". */
export type BuildOutcome = {
  /** Number of files the commit touched. */
  fileCount: number;
  /** The touched file paths (for a legible "cause → effect" list). */
  files: string[];
  /** Net lines added / removed across the changeset. */
  added: number;
  removed: number;
  /** A one-line summary, e.g. "3 files changed (+120 −8)". */
  headline: string;
};

/**
 * Summarize a completed Build changeset into a concrete outcome the UI can show
 * next to the status rail — files changed (count + names) and the net line delta.
 * Returns null for an empty changeset (nothing was built). PURE.
 */
export function buildOutcome(
  changes: { path: string; before: string; after: string }[],
): BuildOutcome | null {
  if (!changes || changes.length === 0) return null;
  const { added, removed } = lineDelta(changes);
  const files = changes.map((c) => c.path);
  const n = files.length;
  return {
    fileCount: n,
    files,
    added,
    removed,
    headline: `${n} file${n === 1 ? '' : 's'} changed (+${added} −${removed})`,
  };
}
