/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       runtime
 * FEATURE:    The names and definitions of the two lead tools: `delegate_to_worker` (strong leads) and `escalate_to_strong` (the worker leads)
 * USER STORY: As the owner I want the chat, the agent engine and the builder to offer the SAME two tools by the same name.
 * ARCHITECTURE: pure data (no server-only, no model call), so the engine can import it. The behaviour lives in `delegate.ts`.
 */
import type { ToolSpec } from '@core/runtime/agentic';

/** The most output tokens one delegation may ask for. */
export const MAX_WORKER_OUTPUT_TOKENS = 4_000;

export const ESCALATE_TOOL = 'escalate_to_strong';
export const ESCALATE_TOOL_SPEC: ToolSpec = {
  name: ESCALATE_TOOL,
  description:
    'Hand this task to the strong model when you judge it too hard for you (multi-step planning, subtle judgement, anything you are unsure about). ' +
    'The strong model takes over for the rest of the turn. Say why in `reason`.',
  inputSchema: { type: 'object', properties: { reason: { type: 'string', description: 'Why the task is too hard.' } }, required: ['reason'] },
};


export const DELEGATE_TOOL = 'delegate_to_worker';
export const PRESETS = ['summarise_tool_result', 'extract_fields'] as const;
export type Preset = (typeof PRESETS)[number];

export const DELEGATE_TOOL_SPEC: ToolSpec = {
  name: DELEGATE_TOOL,
  description:
    'Hand a clearly defined, read-only sub-task to the cheap worker model and get a validated JSON answer back. ' +
    'You decide when, and you write the instruction and the JSON schema of the answer. The worker sees ONLY the ' +
    'earlier tool results you reference, has no tools, and cannot write or decide anything. Good for: condensing a long ' +
    'tool result, extracting fields, classifying, formatting a table. Never use it to plan, choose tools or write.',
  inputSchema: {
    type: 'object',
    properties: {
      instruction: { type: 'string', description: 'The task, in plain words. Optional when a preset is chosen.' },
      input_refs: { type: 'array', items: { type: 'string' }, description: 'Earlier results of this turn to hand over, as "last", "tool:<tool name>" (its latest result) or "step:N" (1 = the first tool call of the turn).' },
      output_schema: { type: 'object', description: 'JSON schema (type "object") of the answer. REQUIRED unless a preset is chosen.' },
      max_tokens: { type: 'integer', description: `Cap on the worker's answer (default 1000, at most ${MAX_WORKER_OUTPUT_TOKENS}).` },
      preset: { type: 'string', enum: [...PRESETS], description: 'A ready-made delegation: summarise_tool_result, or extract_fields (needs output_schema).' },
    },
    required: ['input_refs'],
  },
};

