/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * Plain "Instructions" ⇄ AGENT.md round-trip for Simple mode.
 *
 * Developer mode edits `agents[].agent_md` as raw Markdown in Monaco (projected to
 * the `agents/<id>/AGENT.md` file). Simple mode wants to show a NON-technical
 * builder just the instructions in a normal textarea — without the leading
 * `# <title>` heading Developer-mode templates carry. This module splits an
 * optional leading H1 from the body and reassembles it, so:
 *
 *   parseAgentMd(agent_md)  → { heading, body }   // body is what the textarea shows
 *   serializeAgentMd(heading, newBody) → agent_md // exact same file Developer sees
 *
 * The critical property is LOSSLESS round-tripping: for any `agent_md`,
 * `serializeAgentMd(...parse) === agent_md`. Pure, no deps — shared by the Simple
 * builder and its unit tests.
 */

export type ParsedAgentMd = {
  /** The leading `# Title` line verbatim (including the `#`), or '' if none. */
  heading: string;
  /** Everything after the heading line (or the whole doc if there was no heading). */
  body: string;
  /** Newline(s) that separated the heading from the body, preserved for round-trip. */
  gap: string;
};

/**
 * Split an AGENT.md into an optional leading H1 heading and the remaining body.
 * A "heading" is a first line that starts with `# ` (single hash — a level-1
 * title). Anything else (no heading, or a `##` sub-heading first) yields an empty
 * heading and the whole text as body, so nothing is ever lost.
 */
export function parseAgentMd(agentMd: string): ParsedAgentMd {
  const text = agentMd ?? '';
  // Match a leading `# ...` line, then the newline gap, then the rest.
  const m = /^(#[^#\n][^\n]*)(\n+)([\s\S]*)$/.exec(text);
  if (m) return { heading: m[1], body: m[3], gap: m[2] };
  // A heading that is the ONLY line (no trailing newline / no body).
  const only = /^(#[^#\n][^\n]*)$/.exec(text);
  if (only) return { heading: only[1], body: '', gap: '' };
  return { heading: '', body: text, gap: '' };
}

/**
 * Reassemble an AGENT.md from a heading and a (possibly edited) body. When the
 * original had a heading, its exact newline gap is reused; when there was none,
 * the body is returned as-is. Guarantees `serialize(parse(x)) === x`.
 */
export function serializeAgentMd(parsed: ParsedAgentMd, body: string): string {
  if (!parsed.heading) return body;
  return `${parsed.heading}${parsed.gap}${body}`;
}

/**
 * Convenience: swap in a new instructions body, keeping the original heading/gap.
 * Returns the full `agent_md` string to write back into the system.
 */
export function setInstructions(agentMd: string, newBody: string): string {
  const parsed = parseAgentMd(agentMd);
  return serializeAgentMd(parsed, newBody);
}

/** The instructions body a Simple-mode textarea should show for an agent. */
export function instructionsOf(agentMd: string): string {
  return parseAgentMd(agentMd).body;
}
