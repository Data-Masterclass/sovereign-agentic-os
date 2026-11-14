/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    ACCEPTANCE CHECKS derived from the user stories — the builder's definition of done
 * USER STORY: As the owner whose user stories are well described I want the builder to be scored
 *             against THOSE stories, so a build that compiles but satisfies nothing is not called
 *             a success and the reviewer has something concrete to loop on.
 * ARCHITECTURE:
 *   - PURE. Derivation (`deriveAcceptanceChecks`) and scoring (`scoreAcceptanceChecks`) are
 *     functions of the stories, the generated files and the compile outcome. No store, no fs.
 *   - FOUR kinds, deliberately: `compile` (the real in-process gate), `route` and `render`
 *     (STATIC checks over the generated files — tonight's honest level: the evidence string always
 *     says "static", and jsdom/preview rendering is named backlog, not faked), and `manual`
 *     (listed for the human; never scored pass by a machine).
 *   - `render` is scored off the TYPESCRIPT AST (`symbols.ts`), never off `String.includes`: a
 *     model that writes `// os.records.add` in a comment, or the same text in a string literal or
 *     a JSX text node, must FAIL the check. `route` matches on the file PATH first and on a parsed
 *     IDENTIFIER second, for the same reason.
 *   - HONESTY: a check the harness cannot decide is `unknown` with the reason, never `pass`.
 *     `acceptanceSummary().ok` is true only when every machine-decidable check passed.
 */

import type { GroundingStory, SourceFile } from '@tabs/software/lib/builder/grounding';
import { fileSymbols, importsModule, usesSymbol, type FileSymbols } from '@tabs/software/lib/builder/symbols';

/** How a check is decided. `manual` is for the human; the other three the harness decides. */
export type AcceptanceKind = 'compile' | 'route' | 'render' | 'manual';

export type AcceptanceCheck = {
  /** Stable, derivation-ordered id — `c1`, `c2`, … so a score always names a check. */
  id: string;
  /** `''` for the build-wide compile check. */
  epicId: string;
  storyId: string;
  /** The story title (or `(the whole build)` for the compile check). */
  story: string;
  /** What must be true, in one sentence. */
  check: string;
  kind: AcceptanceKind;
};

export type CheckStatus = 'pass' | 'fail' | 'manual' | 'unknown';

export type CheckScore = {
  id: string;
  kind: AcceptanceKind;
  status: CheckStatus;
  /** Why — always naming HOW it was decided (the file matched, the gate said, static check). */
  evidence: string;
};

/** What the build tool reports back. `gated: false` = the gate could not check this shape. */
export type CompileOutcome = { gated: boolean; ok: boolean; errors: string[]; note?: string };

// -------------------------------------------------------------------- derivation ---

/** Words too generic to identify a story's page; a match on one of these proves nothing. */
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'that', 'this', 'their', 'them', 'they', 'when',
  'want', 'need', 'able', 'user', 'users', 'page', 'view', 'show', 'see', 'can', 'all', 'any',
  'data', 'list', 'new', 'app', 'own', 'one', 'per', 'have', 'has', 'about', 'over', 'each',
  'should', 'would', 'could', 'must', 'will', 'also', 'more', 'than', 'then', 'what', 'which',
]);

/** The distinctive ≥4-character words of a title, lowercased, order-preserved, deduped. */
export function titleTokens(title: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of title.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 4 || STOP_WORDS.has(raw) || seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

/** Verbs that mean the story CAPTURES data — such a story needs a write surface, not just a read. */
const WRITE_VERBS = /\b(add|create|submit|save|record|log|capture|request|register|enter|assign|approve|update|edit|decide|upload)\b/i;

/** True when a story's title or spec lines imply the user must CAPTURE information. */
export function impliesWrite(story: GroundingStory): boolean {
  const text = [story.title, ...story.features, ...story.rules].join(' ');
  return WRITE_VERBS.test(text);
}

/**
 * Derive the acceptance checks from the stories. One build-wide `compile` check, then per story a
 * `route` check (a file exists for it) and a `render` check (that file actually reaches governed
 * data — or the record store, when the story captures data), then one `manual` check per NFR and
 * per rule, because an NFR is exactly the thing a static check must not claim to have verified.
 */
export function deriveAcceptanceChecks(stories: GroundingStory[]): AcceptanceCheck[] {
  const checks: AcceptanceCheck[] = [];
  let n = 0;
  const push = (c: Omit<AcceptanceCheck, 'id'>): void => {
    n += 1;
    checks.push({ id: `c${n}`, ...c });
  };
  push({
    epicId: '',
    storyId: '',
    story: '(the whole build)',
    check: 'The generated tree compiles against the vendored @sovereign-os/ui + @sovereign-os/app-sdk (tsc + bundle).',
    kind: 'compile',
  });
  for (const s of stories) {
    push({
      epicId: s.epicId,
      storyId: s.storyId,
      story: s.title,
      check: `A source file exists that implements "${s.title}".`,
      kind: 'route',
    });
    push({
      epicId: s.epicId,
      storyId: s.storyId,
      story: s.title,
      check: impliesWrite(s)
        ? `That file captures the story's data through os.records (the governed write surface).`
        : `That file reads real governed data through the OS SDK (os.datasets / os.metrics / os.records).`,
      kind: 'render',
    });
    for (const nfr of s.nfrs) {
      push({ epicId: s.epicId, storyId: s.storyId, story: s.title, check: `NFR: ${nfr}`, kind: 'manual' });
    }
    for (const rule of s.rules) {
      push({ epicId: s.epicId, storyId: s.storyId, story: s.title, check: `Rule: ${rule}`, kind: 'manual' });
    }
  }
  return checks;
}

// ----------------------------------------------------------------------- scoring ---

/** App source files a static check looks at — the app's own `src/**`, never the vendored tree. */
function appSources(files: SourceFile[]): SourceFile[] {
  return files.filter((f) => /^src\/.*\.(ts|tsx)$/.test(f.path) && !f.path.startsWith('src/vendor/'));
}

/** The file that best implements a story: an id match wins over a title-token match. */
export function matchStoryFile(story: GroundingStory, files: SourceFile[]): { file: SourceFile; why: string } | null {
  const sources = appSources(files);
  const idNeedle = `${story.epicId}/${story.storyId}`.toLowerCase();
  for (const f of sources) {
    const hay = `${f.path}\n${f.content}`.toLowerCase();
    if (story.storyId.length > 0 && (hay.includes(idNeedle) || f.path.toLowerCase().includes(story.storyId.toLowerCase()))) {
      return { file: f, why: `story id ${idNeedle}` };
    }
  }
  const tokens = titleTokens(story.title);
  for (const f of sources) {
    const path = f.path.toLowerCase();
    const hit = tokens.find((t) => path.includes(t));
    if (hit) return { file: f, why: `path token "${hit}"` };
  }
  // LAST RESORT: a parsed IDENTIFIER (an import specifier, a call callee or a property read) that
  // carries a distinctive word of the title. Deliberately NOT a text search — a comment or a
  // string literal naming the story must not satisfy its route check.
  for (const f of sources) {
    const ids = identifierText(fileSymbols(f.path, f.content));
    const hit = tokens.find((t) => ids.includes(t));
    if (hit) return { file: f, why: `parsed identifier containing "${hit}"` };
  }
  return null;
}

/** Every identifier the AST reported for a file, lowercased and joined — never its raw text. */
function identifierText(symbols: FileSymbols): string {
  return [...symbols.imports, ...symbols.calls, ...symbols.reads].join(' ').toLowerCase();
}

/**
 * The governed SDK surfaces a render check looks for, as DOTTED SYMBOL PATHS matched against the
 * AST. `os` is the conventional name the SDK's own README, the scaffold and every prompt use for
 * `createOsClient()`'s result; the bare `datasets.query` forms catch a destructured client.
 */
const READ_SURFACES = ['os.datasets', 'os.metrics', 'os.records', 'datasets.query', 'metrics.query'];
const WRITE_SURFACES = ['os.records.add', 'os.records.update', 'os.records.remove', 'records.add'];
/** The SDK module itself — importing it is corroborating evidence, never sufficient on its own. */
const SDK_MODULE = '@sovereign-os/app-sdk';

/**
 * Score the checks. `compile` from the gate's own verdict; `route`/`render` by CHEAP STATIC
 * inspection of the generated files, with the evidence string always naming the method; `manual`
 * is returned as `manual` — the harness never marks a human check passed.
 */
export function scoreAcceptanceChecks(
  checks: AcceptanceCheck[],
  stories: GroundingStory[],
  files: SourceFile[],
  compile: CompileOutcome,
): CheckScore[] {
  const byStory = new Map(stories.map((s) => [`${s.epicId}/${s.storyId}`, s]));
  const matches = new Map<string, { file: SourceFile; why: string } | null>();
  for (const s of stories) matches.set(`${s.epicId}/${s.storyId}`, matchStoryFile(s, files));

  return checks.map((c): CheckScore => {
    if (c.kind === 'manual') {
      return { id: c.id, kind: c.kind, status: 'manual', evidence: 'for a human to confirm — the harness does not decide NFRs or business rules' };
    }
    if (c.kind === 'compile') {
      if (!compile.gated) {
        return { id: c.id, kind: c.kind, status: 'unknown', evidence: `compile gate did not check this shape: ${compile.note ?? 'ungated shape'}` };
      }
      return compile.ok
        ? { id: c.id, kind: c.kind, status: 'pass', evidence: 'compile gate (tsc + bundle) clean over the merged tree' }
        : { id: c.id, kind: c.kind, status: 'fail', evidence: `compile gate: ${compile.errors.length} error(s) — ${compile.errors.slice(0, 3).join(' | ')}` };
    }
    const key = `${c.epicId}/${c.storyId}`;
    const story = byStory.get(key);
    const match = matches.get(key) ?? null;
    if (!story) {
      return { id: c.id, kind: c.kind, status: 'unknown', evidence: `static check: no story ${key} in the grounding pack` };
    }
    if (c.kind === 'route') {
      return match
        ? { id: c.id, kind: c.kind, status: 'pass', evidence: `static check: ${match.file.path} matched on ${match.why}` }
        : { id: c.id, kind: c.kind, status: 'fail', evidence: `static check: no src/** file matches story ${key} by id or by a distinctive word of its title` };
    }
    if (!match) {
      return { id: c.id, kind: c.kind, status: 'unknown', evidence: `static check: not decidable — no file was matched for story ${key} (the route check failed first)` };
    }
    const want = impliesWrite(story) ? WRITE_SURFACES : READ_SURFACES;
    const symbols = fileSymbols(match.file.path, match.file.content);
    if (symbols.note) {
      return { id: c.id, kind: c.kind, status: 'unknown', evidence: `static check (AST): ${match.file.path} ${symbols.note}` };
    }
    const found = want.find((w) => usesSymbol(symbols, w));
    if (found) {
      const imported = importsModule(symbols, SDK_MODULE) ? `, importing ${SDK_MODULE}` : '';
      return { id: c.id, kind: c.kind, status: 'pass', evidence: `static check (AST): ${match.file.path} calls ${found}${imported}` };
    }
    return {
      id: c.id,
      kind: c.kind,
      status: 'fail',
      evidence: `static check (AST): ${match.file.path} CALLS none of ${want.join(', ')} — it does not reach governed ${impliesWrite(story) ? 'writes' : 'data'} (a comment or a string naming one does not count)`,
    };
  });
}

export type AcceptanceSummary = {
  /**
   * FALSE when the scorecard was never produced — an all-red build whose tree never compiled, so
   * nothing was scored. Without this, `total: 0 · failed: 0` reads like a clean run (review L-3).
   */
  scored: boolean;
  total: number;
  passed: number;
  failed: number;
  manual: number;
  unknown: number;
  /** True only when the scorecard EXISTS and nothing the harness can decide failed or is unknown. */
  ok: boolean;
};

export function acceptanceSummary(scores: CheckScore[]): AcceptanceSummary {
  const count = (s: CheckStatus): number => scores.filter((x) => x.status === s).length;
  const failed = count('fail');
  const unknown = count('unknown');
  const scored = scores.length > 0;
  return {
    scored,
    total: scores.length,
    passed: count('pass'),
    failed,
    manual: count('manual'),
    unknown,
    ok: scored && failed === 0 && unknown === 0,
  };
}

/**
 * Render the scorecard the reviewer reasons over and the result shows the user. Deterministic;
 * every line carries the evidence, so "it passed" can always be checked.
 */
export function formatAcceptanceReport(checks: AcceptanceCheck[], scores: CheckScore[]): string {
  const byId = new Map(scores.map((s) => [s.id, s]));
  const sum = acceptanceSummary(scores);
  if (!sum.scored) {
    return `Acceptance: NOT SCORED — the build never produced a tree the harness could score against its ${checks.length} derived check(s).`;
  }
  const lines = checks.map((c) => {
    const s = byId.get(c.id);
    const mark = s?.status === 'pass' ? 'PASS' : s?.status === 'fail' ? 'FAIL' : s?.status === 'manual' ? 'MANUAL' : 'UNKNOWN';
    const where = c.storyId ? `${c.epicId}/${c.storyId}` : 'build';
    return `${mark.padEnd(7)} [${c.kind}] ${where}: ${c.check}\n        ${s?.evidence ?? 'not scored'}`;
  });
  return [
    `Acceptance: ${sum.passed} passed · ${sum.failed} failed · ${sum.unknown} unknown · ${sum.manual} for a human (of ${sum.total}).`,
    ...lines,
  ].join('\n');
}

/**
 * The CORRECTIVE feedback a failed scorecard turns into — the exact unmet checks, verbatim, so the
 * next coder turn is grounded in what failed instead of starting over. Manual checks are never
 * fed back as failures (they are not the coder's to satisfy), but they ARE listed as reminders.
 */
export function acceptanceFeedback(checks: AcceptanceCheck[], scores: CheckScore[]): string {
  const byId = new Map(scores.map((s) => [s.id, s]));
  const unmet = checks.filter((c) => {
    const s = byId.get(c.id)?.status;
    return s === 'fail' || s === 'unknown';
  });
  if (unmet.length === 0) return '';
  const lines = unmet.map((c) => `- [${c.kind}] ${c.storyId ? `${c.epicId}/${c.storyId}` : 'build'}: ${c.check}\n  why it did not pass: ${byId.get(c.id)?.evidence ?? 'not scored'}`);
  return [
    `${unmet.length} acceptance check(s) derived from the user stories are not satisfied. Fix EXACTLY these and return the full file set again:`,
    lines.join('\n'),
    'Do not introduce a new dataset id, metric id or column. Do not delete a file that already passes.',
  ].join('\n');
}
