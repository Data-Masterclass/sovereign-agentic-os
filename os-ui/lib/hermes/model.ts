/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Hermes model plane (hermes-agent-integration-plan.md §5).
 *
 * Hermes 4.3 is the TOOL-CALLING brain for Hermes-runtime agents, served via vLLM
 * BEHIND LiteLLM (so every call is metered, capped, traced, policy-routed). Three
 * size tiers; only the 14B is CPU-feasible on the box, 36B/70B are gated behind
 * the optional GPU pool. Magistral stays the general-reasoning default (routing.ts).
 *
 * Llama-license note: Hermes 4 weights are Llama-3.1-based → Llama 3.1 Community
 * License (source-available, NOT Apache/MIT). Fine for self-hosted internal use;
 * we do NOT bundle weights for redistribution.
 *
 * PURE module: the tiers are templates (the chart renders the vLLM Deployment +
 * the LiteLLM model registration); `validateToolCall` is the schema-adherence
 * check the validation gate exercises.
 */

export type HermesModelTier = {
  /** LiteLLM model_name (the only thing an agent ever names). */
  model: string;
  params: '14B' | '36B' | '70B';
  /** 14B runs on CPU (slow); 36B/70B require the GPU pool. */
  placement: 'cpu' | 'gpu-pool';
  /** Gated OFF unless its placement is available (GPU tiers gated by default). */
  gatedByDefault: boolean;
  note: string;
};

/** The Llama 3.1 Community License applies to the weights (not the MIT runtime). */
export const HERMES_WEIGHTS_LICENSE = 'Llama 3.1 Community License (source-available; self-hosted internal use; do NOT redistribute weights)';

export const HERMES_MODEL_TIERS: HermesModelTier[] = [
  {
    model: 'hermes-4-3-14b',
    params: '14B',
    placement: 'cpu',
    gatedByDefault: false, // the CPU-feasible default tool-calling model
    note: 'CPU-feasible on the m3i.16 (slow, latency-tolerant). Hermes 4.3, schema-adherent tool calling.',
  },
  {
    model: 'hermes-4-3-36b',
    params: '36B',
    placement: 'gpu-pool',
    gatedByDefault: true,
    note: 'Stronger; requires the optional GPU pool. Gated off by default.',
  },
  {
    model: 'hermes-4-70b',
    params: '70B',
    placement: 'gpu-pool',
    gatedByDefault: true,
    note: 'Strongest; FP8 on the GPU pool. Gated off by default.',
  },
];

/** The default tool-calling model_name (CPU tier) — what a fresh profile uses. */
export const DEFAULT_HERMES_MODEL = 'hermes-4-3-14b';

/** Pick a tier by placement availability (no GPU → CPU tier only). */
export function selectHermesModel(opts: { gpuPool: boolean }): HermesModelTier {
  if (opts.gpuPool) {
    return HERMES_MODEL_TIERS.find((t) => t.model === 'hermes-4-3-36b') ?? HERMES_MODEL_TIERS[0];
  }
  return HERMES_MODEL_TIERS.find((t) => t.model === DEFAULT_HERMES_MODEL) ?? HERMES_MODEL_TIERS[0];
}

// ------------------------------------------------- schema-valid tool-call check --

/** A minimal JSON-schema (object) the tool-call arguments must satisfy. */
export type ToolCallSchema = {
  type: 'object';
  properties: Record<string, { type: 'string' | 'number' | 'boolean' | 'object' | 'array' }>;
  required?: string[];
};

export type ToolCall = { name: string; arguments: Record<string, unknown> };

export type ValidationResult = { valid: boolean; errors: string[] };

/**
 * Validate that a model-emitted tool call is schema-valid JSON (Hermes 4.3's key
 * improvement over 3). We check the call names a known tool and its arguments
 * satisfy the tool's input schema (required present, types match). This is the
 * gate item "answers a tool-calling task with schema-valid JSON".
 */
export function validateToolCall(
  call: ToolCall,
  schemas: Record<string, ToolCallSchema>,
): ValidationResult {
  const errors: string[] = [];
  const schema = schemas[call.name];
  if (!schema) return { valid: false, errors: [`unknown tool '${call.name}'`] };
  if (typeof call.arguments !== 'object' || call.arguments === null || Array.isArray(call.arguments)) {
    return { valid: false, errors: ['arguments is not a JSON object'] };
  }
  for (const req of schema.required ?? []) {
    if (!(req in call.arguments)) errors.push(`missing required argument '${req}'`);
  }
  for (const [key, val] of Object.entries(call.arguments)) {
    const prop = schema.properties[key];
    if (!prop) {
      errors.push(`unexpected argument '${key}'`);
      continue;
    }
    if (!typeMatches(val, prop.type)) errors.push(`argument '${key}' should be ${prop.type}`);
  }
  return { valid: errors.length === 0, errors };
}

function typeMatches(val: unknown, type: ToolCallSchema['properties'][string]['type']): boolean {
  switch (type) {
    case 'string':
      return typeof val === 'string';
    case 'number':
      return typeof val === 'number' && Number.isFinite(val);
    case 'boolean':
      return typeof val === 'boolean';
    case 'array':
      return Array.isArray(val);
    case 'object':
      return typeof val === 'object' && val !== null && !Array.isArray(val);
    default:
      return false;
  }
}

/**
 * Parse a raw model completion into a tool call and validate it in one step —
 * the model may emit slightly noisy text around the JSON, so we extract the first
 * balanced JSON object. Returns the parse+validation outcome.
 */
export function parseAndValidateToolCall(
  raw: string,
  schemas: Record<string, ToolCallSchema>,
): ValidationResult & { call?: ToolCall } {
  const jsonText = extractJson(raw);
  if (!jsonText) return { valid: false, errors: ['no JSON object found in completion'] };
  let obj: unknown;
  try {
    obj = JSON.parse(jsonText);
  } catch (e) {
    return { valid: false, errors: [`invalid JSON: ${(e as Error).message}`] };
  }
  if (typeof obj !== 'object' || obj === null) return { valid: false, errors: ['completion is not an object'] };
  const rec = obj as Record<string, unknown>;
  const name = typeof rec.name === 'string' ? rec.name : '';
  const args = (rec.arguments ?? {}) as Record<string, unknown>;
  const call: ToolCall = { name, arguments: args };
  return { ...validateToolCall(call, schemas), call };
}

function extractJson(raw: string): string | null {
  const start = raw.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < raw.length; i++) {
    if (raw[i] === '{') depth++;
    else if (raw[i] === '}') {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}
