/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * The Evaluate phase's LLM-JUDGE — pure, model-agnostic scoring logic. It builds a
 * strict rubric prompt from the run's final output, the system's task Description
 * and any granted-workflow tacit knowledge, sends it to an INJECTED completion
 * function (the route wires the ONE assistant/standard model via `assistantComplete`),
 * then parses the model's JSON into three 1–5 scores with a short why.
 *
 * Framework-free and transport-free so it is trivially unit-testable offline: the
 * test injects a `complete` that returns a canned JSON string; the route injects the
 * governed gateway. No new model client is invented here.
 */

export type JudgeInput = {
  /** The team's final output — the artifact being judged. */
  output: string;
  /** The system's task Description (its stated purpose / success criteria in prose). */
  description: string;
  /** Optional tacit knowledge from a granted workflow (success criteria captured there). */
  tacitKnowledge?: string;
};

export type JudgeDimension = 'clarity' | 'grounding' | 'actionability';

export type JudgeScore = {
  dimension: JudgeDimension;
  /** 1–5, clamped. */
  score: number;
  why: string;
};

export type JudgeResult = { scores: JudgeScore[]; overall: number };

/** A single-completion transport: messages in → assistant text out. Injected in tests. */
export type JudgeComplete = (messages: { role: 'system' | 'user'; content: string }[]) => Promise<string>;

const DIMENSIONS: { key: JudgeDimension; label: string; question: string }[] = [
  { key: 'clarity', label: 'Clarity', question: 'Is the output clear, well-structured and easy to follow?' },
  { key: 'grounding', label: 'Grounding', question: 'Are claims grounded in evidence, not invented? Does it stay honest about gaps?' },
  { key: 'actionability', label: 'Actionability', question: 'Does it give a concrete, usable next step or answer — not just analysis?' },
];

const SYSTEM_PROMPT =
  'You are a strict but fair evaluator of an AI agent team\'s output. ' +
  'Score ONLY on the evidence given. Return STRICT JSON and nothing else.';

/** Build the judge messages from the run output + the system's task Description (+ tacit knowledge). */
export function buildJudgePrompt(input: JudgeInput): { role: 'system' | 'user'; content: string }[] {
  const rubric = DIMENSIONS.map((d) => `- ${d.label} (1-5): ${d.question}`).join('\n');
  const tacit = input.tacitKnowledge?.trim()
    ? `\n\nTACIT SUCCESS CRITERIA (from a granted workflow — weigh these):\n${input.tacitKnowledge.trim()}`
    : '';
  const user =
    `TASK DESCRIPTION (what this team is meant to do):\n${input.description.trim() || '(none given)'}` +
    tacit +
    `\n\nTEAM OUTPUT TO JUDGE:\n${input.output.trim() || '(empty)'}` +
    `\n\nScore each dimension 1-5 with a one-sentence reason:\n${rubric}` +
    `\n\nReturn STRICT JSON exactly of the form:\n` +
    `{"clarity":{"score":N,"why":"..."},"grounding":{"score":N,"why":"..."},"actionability":{"score":N,"why":"..."}}`;
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

/** Clamp any number-ish value into the integer 1–5 range (default 1 on garbage). */
function clampScore(v: unknown): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 1;
  return Math.min(5, Math.max(1, n));
}

/** Pull the first JSON object out of a model reply (tolerates ```json fences / prose). */
function extractJson(raw: string): Record<string, unknown> {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) throw new Error('The judge did not return JSON.');
  const slice = raw.slice(start, end + 1);
  return JSON.parse(slice) as Record<string, unknown>;
}

/** Parse the model's JSON reply into three clamped scores + an averaged overall. */
export function parseJudgeReply(raw: string): JudgeResult {
  const obj = extractJson(raw);
  const scores: JudgeScore[] = DIMENSIONS.map((d) => {
    const cell = (obj[d.key] ?? {}) as Record<string, unknown>;
    return {
      dimension: d.key,
      score: clampScore(cell.score),
      why: typeof cell.why === 'string' && cell.why.trim() ? cell.why.trim() : '(no reason given)',
    };
  });
  const overall = Math.round((scores.reduce((s, x) => s + x.score, 0) / scores.length) * 10) / 10;
  return { scores, overall };
}

/** Run the full judge: build the prompt, call the injected model, parse the reply. */
export async function judgeRun(input: JudgeInput, complete: JudgeComplete): Promise<JudgeResult> {
  const raw = await complete(buildJudgePrompt(input));
  return parseJudgeReply(raw);
}

/** The human label for a dimension (for the UI + tests). */
export function dimensionLabel(d: JudgeDimension): string {
  return DIMENSIONS.find((x) => x.key === d)?.label ?? d;
}
