/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       acceptance harness (tests/e2e/kind)
 * FEATURE:    AT-a's judgements over Langfuse TOOL observations, as pure functions
 * USER STORY: As the verifier I want the "u123 finds the answer at rank 1" and "u999 sees nothing"
 *             judgements to be testable without a cluster, so a reader bug that hides tool output can
 *             never make them pass vacuously.
 * ARCHITECTURE:
 *   - Input: observations as the Langfuse v2 Observations API returns them (input/output are raw
 *     strings, present only when the `io` group was requested). Every function throws when a TOOL
 *     observation it needs has no `output` field, or when no such observation exists.
 *   - Used by journeys/journey-a-knowledge.e2e.mjs and tested in selftest/journey-framework.test.mjs.
 */
import { ioText } from '../records/langfuse.mjs';
import { check } from '../journey.mjs';

/** Raw output strings of every TOOL observation called `name`; at least one must exist. */
export function toolOutputs(obs, name) {
  const tools = obs.filter((o) => o.type === 'TOOL' && o.name === name);
  check(tools.length > 0, 'langfuse', `a TOOL observation ${name}`, obs.map((o) => `${o.type}:${o.name}`));
  return tools.map((o) => ioText(o, 'output'));
}

/** The ordered hits in a search tool's output (JSON array, or an object holding one). */
export function hitsOf(output) {
  let v;
  try { v = JSON.parse(output); } catch { check(false, 'langfuse', 'search_files output is JSON', output.slice(0, 200)); }
  const arr = Array.isArray(v) ? v : v.hits ?? v.results ?? v.items ?? null;
  check(Array.isArray(arr), 'langfuse', 'search_files output holds an ordered list of hits', output.slice(0, 200));
  return arr;
}

/**
 * Top-N of the hybrid result. The designed search fuses BM25 and k-NN with reciprocal rank fusion
 * (RRF, k=60): a chunk found ONLY by k-NN at rank 1 scores 1/61 = 0.0164, while a distractor found by
 * BOTH lists scores about 1/61 + 1/62 = 0.0325 and ranks above it. Fused rank 1 is therefore not a
 * property of correct retrieval; presence in the top N is. Rank 1 is demanded of the k-NN list alone
 * (assertFirstIsAnswer on the k-NN sub-query, a3.3).
 */
export const TOP_N = Number(process.env.E2E_TOP_N ?? 5);
export function assertAnswerInTopN(obs, { answer, page, n = TOP_N }) {
  const hits = hitsOf(toolOutputs(obs, 'search_files').at(-1));
  const top = hits.slice(0, n).map((h) => JSON.stringify(h));
  const at = top.findIndex((t) => t.includes(answer) && new RegExp(`"page(_no)?"\\s*:\\s*${page}\\b`).test(t));
  check(at >= 0, 'langfuse', `the page-${page} hit containing "${answer}" is within the top ${n} hits`, top.map((t) => t.slice(0, 60)));
  return at + 1;
}

/** The first of an ordered list of hits (tool hits or OpenSearch `_source`s) contains the answer. */
export function assertFirstIsAnswer(hits, { answer, list }) {
  check(hits.length > 0, 'opensearch', `${list} returned hits`, 0);
  const first = JSON.stringify(hits[0]);
  check(first.includes(answer), 'opensearch', `rank 1 of the ${list} contains "${answer}"`, first.slice(0, 200));
}

/** Reciprocal rank fusion as OpenSearch's score-ranker-processor defines it (rank_constant k). */
export function rrfFuse(lists, k = 60) {
  const score = new Map();
  for (const list of lists) list.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + 1 / (k + i + 1)));
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id, s]) => ({ id, score: s }));
}

/** No search hit anywhere contains the answer (DLS: the other user must not see the chunk). */
export function assertChunkNotVisible(obs, { answer }) {
  const outs = toolOutputs(obs, 'search_files');
  for (const out of outs) check(!out.includes(answer), 'langfuse', `search_files output does not contain "${answer}"`, out.slice(0, 200));
}
