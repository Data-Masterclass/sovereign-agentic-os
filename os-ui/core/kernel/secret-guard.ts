/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       kernel
 * FEATURE:    Refuse development secret defaults in production (defence in depth)
 * USER STORY: As an operator I want os-ui and the run worker to refuse to start in production
 *             when a secret they depend on is missing or still holds a development default that
 *             is published in this repository, so a misconfigured install fails loudly at boot
 *             instead of running with a key anyone can read.
 * ARCHITECTURE:
 *   - Per PROCESS, the secrets it actually reads (the worker's env deliberately carries no admin
 *     secret — `soa.osUI.runEnv` — so it is never asked for one):
 *       os-ui         LITELLM_MASTER_KEY, AGENT_RUNTIME_TOKEN, OS_SESSION_SECRET,
 *                     OS_MCP_TOKEN_SECRET (falls back to OS_SESSION_SECRET, as config.ts does),
 *                     LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, and TERMINAL_BROKER_SECRET when
 *                     TERMINAL_ENABLED=true (nothing reads it otherwise);
 *       os-ui-worker  AGENT_RUNTIME_TOKEN, LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY.
 *   - Reads `process.env` directly, NOT `config`: config fills a missing value with its
 *     development fallback, which would hide "missing".
 *   - The public defaults are known here ONLY as SHA-256 digests (`PUBLIC_DEFAULT_SHA256`). A
 *     candidate is hashed in-process and compared to every digest with `timingSafeEqual`; no
 *     early exit, no value in any message or log line — only the variable NAME and the reason.
 *     `secret-guard.test.ts` pins each digest to the literal in dev-secret-defaults.ts and in
 *     the chart's values.yaml, and `scripts/lib/check-secrets-not-defaults.py` (the deploy
 *     preflight) carries the same digests; a test keeps the two tables equal.
 *   - "Production" is `NODE_ENV === 'production'`, as for the existing session guard (the live
 *     deploy runs `OS_PROFILE=local` with a production build). `next build` is skipped
 *     (NEXT_PHASE=phase-production-build). A LAPTOP install (chart profile `local` with no
 *     Ingress) renders the development defaults on purpose and is marked by the chart with
 *     `OS_ALLOW_PUBLIC_DEV_SECRETS=laptop`: there a default is reported as a warning, a MISSING
 *     secret still refuses, and OS_SESSION_SECRET / OS_MCP_TOKEN_SECRET are never exempt (the
 *     chart generates those per install).
 */
import { createHash, timingSafeEqual } from 'node:crypto';

export type GuardedProcess = 'os-ui' | 'os-ui-worker';

/** SHA-256 (hex) of every public development default, by the variable that may carry it. */
export const PUBLIC_DEFAULT_SHA256: Readonly<Record<string, readonly string[]>> = Object.freeze({
  // core/kernel/dev-secret-defaults.ts `litellmMasterKey`; values.yaml `litellmMasterKey`
  LITELLM_MASTER_KEY: ['fadab17377ea25a99066f93f487fea827a9257e914131fa56bc92b84c520f5be'],
  // dev-secret-defaults.ts `agentRuntimeToken`; values.yaml `agentRuntime.token`
  AGENT_RUNTIME_TOKEN: [
    '5d1730f0c23376d8e689f46b3160fbc409fd0e4c05186cef32013a618dd2bcc0',
    '5ea8c27ca270109bb957d4b54b08e0adc2f8711df077efb0d59cc4b017db336b',
  ],
  // dev-secret-defaults.ts `sessionSecret`
  OS_SESSION_SECRET: ['1397c0247256fdc8a257687a2e12674e6e65adfe04025e3c7ebbbc4c9e9a1dfc'],
  OS_MCP_TOKEN_SECRET: ['1397c0247256fdc8a257687a2e12674e6e65adfe04025e3c7ebbbc4c9e9a1dfc'],
  // dev-secret-defaults.ts `terminalBrokerSecret`
  TERMINAL_BROKER_SECRET: ['020d317d047f4634439f77e23c67439639d4914fc0ad686b811403043118f9bd'],
  // values.yaml `langfuseInit` (config.ts has no Langfuse fallback since WP-31)
  LANGFUSE_PUBLIC_KEY: ['8ad181a220c5109ff0115e85250a33e13ba5f5cabcddb2f758f979f716724f6b'],
  LANGFUSE_SECRET_KEY: ['aef69d589a481ddf96a3a68a4996c4c3f40be57ecd3bb12fe071dbc522ab9c28'],
});

/** Secrets whose public default no install may run with, laptop or not. */
const NEVER_EXEMPT = new Set(['OS_SESSION_SECRET', 'OS_MCP_TOKEN_SECRET']);

export type SecretProblem = { name: string; reason: 'missing' | 'public-default' };

/** Thrown at boot; names the variables and the reason, never a value. */
export class InsecureProductionSecretError extends Error {
  readonly problems: readonly SecretProblem[];
  constructor(processName: GuardedProcess, problems: readonly SecretProblem[]) {
    const list = problems.map((p) => `${p.name} (${p.reason === 'missing' ? 'missing' : 'equals a public development default'})`).join(', ');
    super(
      `${processName}: refusing to boot in production — ${list}. ` +
        'Set a strong, unique value for each (see docs/ops/secret-rotation.md).',
    );
    this.name = 'InsecureProductionSecretError';
    this.problems = problems;
  }
}

const sha256 = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

/** Constant-time: is `value` one of the public defaults known for `name`? Compares every digest. */
export function isPublicDefault(name: string, value: string): boolean {
  const known = PUBLIC_DEFAULT_SHA256[name] ?? [];
  const candidate = sha256(value);
  let hit = false;
  for (const hex of known) {
    const eq = timingSafeEqual(candidate, Buffer.from(hex, 'hex'));
    hit = hit || eq;
  }
  return hit;
}

/** The variables a process depends on, given its environment. */
export function guardedSecretsFor(processName: GuardedProcess, env: NodeJS.ProcessEnv): string[] {
  if (processName === 'os-ui-worker') return ['AGENT_RUNTIME_TOKEN', 'LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY'];
  const names = ['LITELLM_MASTER_KEY', 'AGENT_RUNTIME_TOKEN', 'OS_SESSION_SECRET', 'OS_MCP_TOKEN_SECRET', 'LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY'];
  if (env.TERMINAL_ENABLED === 'true') names.push('TERMINAL_BROKER_SECRET');
  return names;
}

/** The value the process will use for `name` (OS_MCP_TOKEN_SECRET falls back as config.ts does). */
function effective(name: string, env: NodeJS.ProcessEnv): string {
  const v = env[name] ?? '';
  if (name === 'OS_MCP_TOKEN_SECRET' && v === '') return env.OS_SESSION_SECRET ?? '';
  return v;
}

/** Every problem, in a stable order. Pure — no NODE_ENV logic. */
export function findSecretProblems(processName: GuardedProcess, env: NodeJS.ProcessEnv): SecretProblem[] {
  const out: SecretProblem[] = [];
  for (const name of guardedSecretsFor(processName, env)) {
    const v = effective(name, env);
    if (v === '') out.push({ name, reason: 'missing' });
    else if (isPublicDefault(name, v)) out.push({ name, reason: 'public-default' });
  }
  return out;
}

/**
 * Boot-time FAIL-CLOSED guard. Throws `InsecureProductionSecretError` under a production runtime
 * when a guarded secret is missing or equals a public development default; a no-op in
 * development and during `next build`. On a chart-marked laptop install a public default (but
 * not a missing value, and never the session/MCP secret) is downgraded to a warning.
 */
export function assertProductionSecrets(
  processName: GuardedProcess,
  env: NodeJS.ProcessEnv = process.env,
  warn: (msg: string) => void = (m) => console.warn(m),
): void {
  if (env.NODE_ENV !== 'production') return;
  if (env.NEXT_PHASE === 'phase-production-build') return;
  const laptop = env.OS_ALLOW_PUBLIC_DEV_SECRETS === 'laptop';
  const problems = findSecretProblems(processName, env).filter((p) => {
    if (laptop && p.reason === 'public-default' && !NEVER_EXEMPT.has(p.name)) {
      warn(`[${processName}] ${p.name} equals a public development default — accepted only because this is a laptop install (OS_ALLOW_PUBLIC_DEV_SECRETS=laptop)`);
      return false;
    }
    return true;
  });
  if (problems.length > 0) throw new InsecureProductionSecretError(processName, problems);
}
