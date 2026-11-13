/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    The agentic builder's PROMPTS and reply parsers — planner, coder, reviewer
 * USER STORY: As the engineer fixing the builder harness I want each node's frame and each reply
 *             parser to be pure and tested, so a prompt regression is a failing test and not a
 *             worse app discovered three weeks later.
 * ARCHITECTURE:
 *   - PURE. Three prompt builders and two tolerant parsers. No model client, no store.
 *   - The coder returns ONE JSON object `{ "files": [{ "path", "content" }] }`; the parser uses
 *     the shared tolerant `parseJsonReply` (reasoning models wrap JSON in prose — the known
 *     landmine `generate.ts` already documents) and then validates the shape strictly.
 *   - PATH DISCIPLINE is enforced here, not hoped for: a path outside the app's own `src/**`,
 *     `public/**`, `index.html` or `package.json`, an absolute path, or any `..` segment is
 *     REJECTED with a reason, so a coder turn can never write into the vendored tree or escape
 *     the app. The reasons are fed back as corrective text.
 */

import { parseJsonReply } from '@core/runtime/json-reply';
import type { AcceptanceCheck } from '@tabs/software/lib/builder/acceptance';
import type { SourceFile } from '@tabs/software/lib/builder/grounding';

/** The system frame every builder node shares: who it is and what the OS guarantees. */
export const BUILDER_SYSTEM_PREAMBLE = [
  'You are the Sovereign Agentic OS app builder. You build a real, compiling Vite + React app that',
  'reads and writes GOVERNED data as the signed-in user. Everything you are told below about the',
  'datasets, the metrics, the SDK and the UI package is EXTRACTED FROM THE SOURCE the compiler will',
  'check your code against — it is not advice, it is the contract.',
].join('\n');

function checklist(checks: AcceptanceCheck[]): string {
  return checks
    .map((c) => `- [${c.kind}] ${c.storyId ? `${c.epicId}/${c.storyId}` : 'build'}: ${c.check}`)
    .join('\n');
}

/** The PLANNER turn: one plan, from the grounding pack, against the acceptance checks. */
export function plannerPrompt(grounding: string, checks: AcceptanceCheck[]): { system: string; user: string } {
  return {
    system: [
      BUILDER_SYSTEM_PREAMBLE,
      '',
      'You are the PLANNER. Produce a SHORT, concrete build plan and nothing else:',
      '1. the files to write, with their exact paths under src/;',
      '2. for each file, which user story it satisfies and which granted dataset/metric it reads;',
      '3. where the write surface (os.records) is used, when a story captures data;',
      '4. the smallest design that satisfies every acceptance check below.',
      'Do NOT write code. Do NOT invent a dataset id, metric id or column name.',
    ].join('\n'),
    user: [grounding, '', 'ACCEPTANCE CHECKS your plan must satisfy:', checklist(checks), '', 'Write the plan now.'].join('\n'),
  };
}

/** The CODER turn: the whole changeset as JSON, grounded in the plan and the last failures. */
export function coderPrompt(input: {
  grounding: string;
  plan: string;
  checks: AcceptanceCheck[];
  prior: SourceFile[];
  feedback: string | null;
}): { system: string; user: string } {
  const system = [
    BUILDER_SYSTEM_PREAMBLE,
    '',
    'You are the CODER. Return ONE JSON object and nothing else:',
    '  { "files": [ { "path": "src/...", "content": "<the complete file>" } ] }',
    '',
    'HARD RULES — breaking any of these wastes the whole turn:',
    '1. No prose, no markdown fences, no comments outside the JSON.',
    '2. Every file is COMPLETE and runnable. Never a placeholder, a TODO or an elision.',
    '3. Paths are app-relative and live under src/ (or public/, index.html, package.json).',
    '   Never an absolute path, never "..", never vendor/ or node_modules/.',
    '4. Import the SDK as `@sovereign-os/app-sdk` and the UI as `@sovereign-os/ui`. Use ONLY the',
    '   exports and props listed in the brief — a hallucinated member is a compile error.',
    '5. Reference ONLY the dataset ids, metric ids and column names listed in the brief.',
    '6. Give every fetch an honest loading, empty and error state.',
    '7. Return the FULL set of files you want to land, not a diff.',
  ].join('\n');
  const parts = [input.grounding, '', 'THE PLAN:', input.plan, '', 'ACCEPTANCE CHECKS:', checklist(input.checks)];
  if (input.prior.length > 0) {
    parts.push('', `FILES ALREADY COMMITTED (your files are merged over these): ${input.prior.map((f) => f.path).join(', ')}`);
  }
  if (input.feedback) {
    parts.push(
      '',
      'YOUR PREVIOUS ATTEMPT WAS REJECTED. This is the exact, machine-produced reason. Fix precisely',
      'these and return the full file set again:',
      input.feedback,
    );
  }
  parts.push('', 'Return the JSON now.');
  return { system, user: parts.join('\n') };
}

/** The REVIEWER turn: score the stories, decide loop or stop. */
export function reviewerPrompt(input: { report: string; compileText: string }): { system: string; user: string } {
  return {
    system: [
      BUILDER_SYSTEM_PREAMBLE,
      '',
      'You are the REVIEWER. You are shown a machine-produced scorecard of the acceptance checks',
      'derived from the user stories, plus the compile result. Decide whether the build is DONE.',
      'Answer in exactly this shape:',
      '  VERDICT: PASS|REVISE',
      '  NOTES:',
      '  - <one actionable note per line, only for things the scorecard does not already say>',
      'PASS only when every machine-decidable check passed. A check marked MANUAL is for a human and',
      'is not yours to pass or fail. Never pass a scorecard with a FAIL or an UNKNOWN on it.',
    ].join('\n'),
    user: [input.compileText, '', input.report, '', 'Give your verdict now.'].join('\n'),
  };
}

// ----------------------------------------------------------------- reply parsing ---

/** Paths a coder turn may write. Everything else is refused with a reason. */
const ALLOWED_ROOTS = ['src/', 'public/'];
const ALLOWED_EXACT = ['index.html', 'package.json'];

/** Why a proposed path was refused, or null when it is acceptable. */
export function pathRefusal(path: string): string | null {
  if (typeof path !== 'string' || path.trim().length === 0) return 'empty path';
  const p = path.trim();
  if (p.startsWith('/')) return `absolute path "${p}" — paths are app-relative`;
  if (p.split('/').includes('..')) return `"${p}" escapes the app tree`;
  if (p.startsWith('vendor/') || p.includes('node_modules/')) return `"${p}" is inside the vendored tree, which the OS owns`;
  if (ALLOWED_EXACT.includes(p)) return null;
  if (ALLOWED_ROOTS.some((r) => p.startsWith(r))) return null;
  return `"${p}" is outside src/, public/, index.html and package.json`;
}

export type CoderParse =
  | { ok: true; files: SourceFile[]; refused: string[] }
  | { ok: false; reason: string };

/**
 * Recover the coder's file set from a (possibly prose-wrapped) reply, then validate the shape and
 * the paths strictly. Refused paths are DROPPED and reported in `refused`, so the loop can feed
 * the reasons back instead of failing the whole turn on one bad path.
 */
export function parseCoderReply(raw: string): CoderParse {
  const obj = parseJsonReply(raw);
  if (obj === null || typeof obj !== 'object') return { ok: false, reason: 'the coder did not return a JSON object' };
  const list = (obj as { files?: unknown }).files;
  if (!Array.isArray(list)) return { ok: false, reason: 'the coder\'s JSON has no `files` array' };
  const files: SourceFile[] = [];
  const refused: string[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') {
      refused.push('a files[] entry was not an object');
      continue;
    }
    const { path, content } = entry as { path?: unknown; content?: unknown };
    const refusal = pathRefusal(typeof path === 'string' ? path : '');
    if (refusal) {
      refused.push(refusal);
      continue;
    }
    if (typeof content !== 'string' || content.length === 0) {
      refused.push(`"${String(path)}" has no content — every file must be complete`);
      continue;
    }
    const p = (path as string).trim();
    if (seen.has(p)) {
      refused.push(`"${p}" appeared twice — the later copy was kept`);
      files.splice(
        files.findIndex((f) => f.path === p),
        1,
      );
    }
    seen.add(p);
    files.push({ path: p, content });
  }
  if (files.length === 0) {
    return { ok: false, reason: refused.length > 0 ? `no usable file in the reply: ${refused.join('; ')}` : 'the coder returned an empty files array' };
  }
  return { ok: true, files, refused };
}

export type ReviewParse = { verdict: 'pass' | 'revise'; notes: string[] };

/**
 * Parse the reviewer's reply. FAIL-SAFE: anything that is not an explicit PASS is a REVISE, so an
 * unparseable reviewer turn loops rather than shipping. The notes are the `- ` lines.
 */
export function parseReviewReply(raw: string): ReviewParse {
  const verdict = /VERDICT\s*:\s*PASS\b/i.test(raw) ? 'pass' : 'revise';
  const notes = raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- ') || l.startsWith('* '))
    .map((l) => l.slice(2).trim())
    .filter((l) => l.length > 0);
  return { verdict, notes };
}
