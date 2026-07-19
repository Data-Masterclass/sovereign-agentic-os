/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { AppEpic } from '@/lib/software/apps';
import type { ScaffoldFile } from '@/lib/software/model';

/**
 * Design-stage export/import — the PURE core behind three governed Design actions:
 * push EPICs/stories to Jira, hand code off to a GitHub connection, and seed a
 * Claude-generated frontend into the app repo. No `server-only`, no secrets, no
 * network — every side effect lives in the routes that call these; this module is
 * just the mapping + validation, so it unit-tests against plain data.
 *
 * Governance is UNCHANGED and enforced upstream: the routes call the SAME
 * `callConnectionTool` gate every other connection write passes (Jira/GitHub writes
 * are Write-approval), and the frontend seed goes through `commitToApp`. We never
 * hold a raw token here — we only shape the arguments those governed calls take.
 */

/** One Jira issue to create, in the order it must be created (epic before its stories). */
export type JiraIssuePlan = {
  /** Stable key back to the source epic/story so the route can report created keys. */
  ref: { epicId: string; storyId?: string };
  issueType: 'Epic' | 'Story';
  summary: string;
  description: string;
};

/** Fold a story's "As a … I want … so that …" + acceptance into a plain description. */
function storyDescription(title: string, asA: string, iWant: string, soThat: string, acceptance: string): string {
  const lines: string[] = [];
  if (asA || iWant || soThat) {
    lines.push(`As a ${asA || '…'}, I want ${iWant || '…'} so that ${soThat || '…'}.`);
  }
  if (acceptance.trim()) lines.push('', `Acceptance: ${acceptance.trim()}`);
  return lines.join('\n').trim() || title;
}

/**
 * Map the Design epics into an ordered Jira issue plan: each EPIC becomes an `Epic`
 * issue, each of its stories a `Story` issue. Epics with an empty title are skipped
 * (nothing to file); a story with no title falls back to the epic title so it is
 * never a blank summary. The order is epic-then-its-stories so the route can create
 * the epic first and (optionally) reference its key when creating the children.
 */
export function planJiraIssues(epics: AppEpic[]): JiraIssuePlan[] {
  const plan: JiraIssuePlan[] = [];
  for (const e of epics) {
    const epicTitle = (e.title ?? '').trim();
    if (!epicTitle) continue; // nothing to file for a blank epic
    plan.push({
      ref: { epicId: e.id },
      issueType: 'Epic',
      summary: epicTitle,
      description: (e.description ?? '').trim(),
    });
    for (const s of e.stories ?? []) {
      const summary = (s.title ?? '').trim() || epicTitle;
      plan.push({
        ref: { epicId: e.id, storyId: s.id },
        issueType: 'Story',
        summary,
        description: storyDescription(summary, s.asA ?? '', s.iWant ?? '', s.soThat ?? '', s.acceptance ?? ''),
      });
    }
  }
  return plan;
}

/**
 * A connection reference as it appears in the app's context grants + the visible
 * connection list. Only the fields the picker needs — pure, no `Connection` import.
 */
export type ConnRef = { id: string; template: string };

/**
 * Pick the connection to use for a template (`atlassian` / `github`): prefer one the
 * app was explicitly GRANTED (so the app uses its own governed context), else fall
 * back to the first visible connection of that template. Returns null when the user
 * has none — the route then surfaces an honest "connect X first" message rather than
 * a fake success.
 */
export function pickConnectionForTemplate(
  template: string,
  grantedIds: string[],
  visible: ConnRef[],
): ConnRef | null {
  const ofTemplate = visible.filter((c) => c.template === template);
  const grantedSet = new Set(grantedIds);
  return ofTemplate.find((c) => grantedSet.has(c.id)) ?? ofTemplate[0] ?? null;
}

// ------------------------------------------------------ Claude-design import ----

/** A validated import: either a set of files to seed, or an honest rejection reason. */
export type ImportValidation =
  | { ok: true; files: ScaffoldFile[] }
  | { ok: false; reason: string };

/** Looks like frontend markup/JS (a heuristic, so we don't seed arbitrary prose). */
function looksLikeFrontend(code: string): boolean {
  const c = code;
  return (
    /<[a-zA-Z][\s\S]*>/.test(c) || // any HTML/JSX tag
    /\b(import|export)\b/.test(c) || // ES module
    /\bfunction\b|\=>|\bconst\b|\bReact\b/.test(c) // JS/React
  );
}

/**
 * Validate a pasted Claude design and turn it into the app files to seed. Accepts
 * either raw CODE or a URL (the route resolves a URL to text before calling this).
 * The seeded path is chosen from the shape: an HTML document seeds `src/index.html`;
 * anything React/JS seeds `src/App.tsx` (the vite-os entry the AI build then refines).
 * Honest: empty or non-frontend input is REJECTED with a reason, never fabricated.
 */
export function validateFrontendImport(raw: string): ImportValidation {
  const code = (raw ?? '').trim();
  if (!code) return { ok: false, reason: 'Paste the Claude design code (or a URL) first.' };
  if (code.length > 500_000) return { ok: false, reason: 'That design is too large to seed (over 500 KB).' };
  if (!looksLikeFrontend(code)) {
    return { ok: false, reason: 'That does not look like frontend code (no HTML/JSX/JS found).' };
  }
  const isHtmlDoc = /<!doctype html|<html[\s>]/i.test(code);
  const path = isHtmlDoc ? 'src/index.html' : 'src/App.tsx';
  return { ok: true, files: [{ path, content: code.endsWith('\n') ? code : `${code}\n` }] };
}
