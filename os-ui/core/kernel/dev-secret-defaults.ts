/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       kernel
 * FEATURE:    Refuse development secret defaults in production (defence in depth)
 * USER STORY: As a developer I want a clone-and-run install to work without secrets, and as an
 *             operator I want those development fallbacks never to reach a browser bundle.
 * ARCHITECTURE:
 *   - The ONLY place the development fallbacks of the guarded secrets are spelled out.
 *     `core/kernel/config.ts` uses them as `env()` fallbacks. On the server every value is
 *     exactly the literal config.ts used before, so no server-side value changes
 *     (`dev-secret-defaults.test.ts`).
 *   - Server-only BY CONSTRUCTION: every value is behind `typeof window === 'undefined'`. Next.js
 *     replaces `typeof window` with a constant in each bundle ("object" in the browser build), so
 *     the minifier drops the literal from client chunks even when a client component reaches
 *     config.ts through a shared module. `os-ui/scripts/check-client-bundle-secrets.mjs` scans a
 *     fresh `next build` for every literal and fails CI if one appears.
 */

const SERVER = typeof window === 'undefined';

export const DEV_SECRET_DEFAULTS = {
  /** OS_SESSION_SECRET and OS_MCP_TOKEN_SECRET. */
  sessionSecret: SERVER ? 'dev-only-insecure-session-secret-change-me-in-prod' : '',
  /** AGENT_RUNTIME_TOKEN. */
  agentRuntimeToken: SERVER ? 'dev-only-insecure-agent-runtime-token' : '',
  /** LITELLM_MASTER_KEY (the same literal as `litellmMasterKey` in the chart's values.yaml). */
  litellmMasterKey: SERVER ? 'sk-litellm-local-dev-master' : '',
  /** TERMINAL_BROKER_SECRET. */
  terminalBrokerSecret: SERVER ? 'dev-only-insecure-terminal-secret-change-me' : '',
  // Langfuse has no fallback here: since WP-31 config.ts leaves its keys and login empty.
} as const;
