/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    The identifiers of an agent system are plain tokens, never text
 * USER STORY: As the owner I want agent ids, state channel names and tool names to be simple
 *             identifiers, so they can be used as file names, graph node names and object keys in
 *             generated code without any of them ever being able to change what that code does.
 * ARCHITECTURE:
 *   - One check, `identifierProblems(sys)`, used at the store's write chokepoints (`createSystem`,
 *     `writeFile` of `system.yaml`) and again by the module generator before it emits a byte.
 *   - Agent id: `^[a-z0-9][a-z0-9_-]{0,63}$`. Channel: `^[a-z_][a-z0-9_]{0,63}$`. Tool name:
 *     `^[a-z][a-z0-9_]{0,63}$`. Reserved object keys (`__proto__`, `constructor`, `prototype`) and
 *     the module's own state keys (`steps`) are refused. Display text (names, roles, prompts) is
 *     NOT restricted here: it only ever travels as data (`JSON.stringify`) or as file content.
 */
import type { System } from '@tabs/agents/lib/system-schema';
import { AGENT_ID_PATTERN } from '@core/infra/repo-layout';

/**
 * The cap on one agent prompt or memory file: 64 KiB (WP-53b). Why this value: the prompt files
 * are sent on EVERY model call of that agent and summarisation never trims the system prompt, so
 * the cap is what bounds a prompt's share of the window. 64 KiB is about 16k tokens — 12 % of the
 * 131k window of `sovereign-default` — and about 25 times the largest prompt in use today
 * (the live Invoice Reader prompt is ~1.4 KB, read through the OS MCP on 2026-11-20). The git
 * door's 1 MiB per-file limit would allow ~250k tokens per call, i.e. a prompt larger than the window.
 */
export const PROMPT_MAX_BYTES = 64 * 1024;

export const AGENT_ID_RE = new RegExp(`^${AGENT_ID_PATTERN}$`);
export const CHANNEL_RE = /^[a-z_][a-z0-9_]{0,63}$/;
export const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
const RESERVED = new Set(['__proto__', 'constructor', 'prototype', 'steps']);

export function identifierProblems(sys: System): string[] {
  const out: string[] = [];
  const bad = (what: string, v: unknown, re: RegExp) => {
    const s = String(v ?? '');
    if (!re.test(s) || RESERVED.has(s)) out.push(`${what} ${JSON.stringify(s)} is not a plain identifier (${re.source})`);
  };
  for (const a of sys.agents) {
    bad('agent id', a.id, AGENT_ID_RE);
    for (const m of a.members ?? []) bad('supervised member', m, AGENT_ID_RE);
    for (const t of a.tools ?? []) bad('tool', t, TOOL_NAME_RE);
  }
  for (const t of sys.grants.tools) bad('tool', t, TOOL_NAME_RE);
  for (const c of Object.keys(sys.state.channels)) bad('state channel', c, CHANNEL_RE);
  if (sys.entrypoint) bad('entrypoint', sys.entrypoint, AGENT_ID_RE);
  for (const a of sys.agents) {
    for (const [field, text] of [['agent_md', a.agent_md], ['memory_md', a.memory_md]] as const) {
      const bytes = Buffer.byteLength(String(text ?? ''), 'utf8');
      if (bytes > PROMPT_MAX_BYTES) out.push(`agent ${JSON.stringify(a.id)} ${field} is ${bytes} bytes; a prompt may be at most ${PROMPT_MAX_BYTES} bytes`);
    }
  }
  return out;
}
