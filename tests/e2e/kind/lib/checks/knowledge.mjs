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

/** The first hit of the (last) search is the answer chunk, on the given page. */
export function assertTopHitIsAnswer(obs, { answer, page }) {
  const hits = hitsOf(toolOutputs(obs, 'search_files').at(-1));
  check(hits.length > 0, 'langfuse', 'search_files returned hits', 0);
  const top = JSON.stringify(hits[0]);
  check(top.includes(answer), 'langfuse', `rank 1 hit contains "${answer}"`, top.slice(0, 200));
  check(new RegExp(`"page(_no)?"\\s*:\\s*${page}\\b`).test(top), 'langfuse', `rank 1 hit is on page ${page}`, top.slice(0, 200));
}

/** No search hit anywhere contains the answer (DLS: the other user must not see the chunk). */
export function assertChunkNotVisible(obs, { answer }) {
  const outs = toolOutputs(obs, 'search_files');
  for (const out of outs) check(!out.includes(answer), 'langfuse', `search_files output does not contain "${answer}"`, out.slice(0, 200));
}
