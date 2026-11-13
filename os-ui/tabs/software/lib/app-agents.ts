/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    The app → agent contract: the SDK's `os.agents.*` reaches the SAME doors as the user
 * USER STORY: As a reviewer I want to be able to prove, from a test, that a vibe-engineered app
 *             calling an OS agent goes through the identical route the UI posts to — so it cannot
 *             be a second code path, a service principal or a key of the app's own (night-2 S7).
 * ARCHITECTURE:
 *   - The route builders live in the SDK (`@core/app-sdk/agents`) because the SDK is VENDORED into
 *     every app as source and must stay dependency-free. This module is the SERVER-SIDE statement
 *     of what those doors are, so a unit test can assert the SDK's paths equal the OS's own route
 *     files — the thing that would silently drift if each side wrote its own string.
 *   - `APP_AGENT_DOORS` names, for each SDK call, the route file that serves it and the governed
 *     function behind it. A test walks it and asserts the file exists on disk; a renamed or
 *     deleted route therefore FAILS rather than leaving the SDK pointing at a 404.
 *   - No identity of its own: every door is same-origin with the ambient `soa_session`, so the
 *     signed-in user is the principal and RLS/OPA apply unchanged. There is deliberately NO
 *     app-scoped run endpoint here — adding one is how this stops being the user's door.
 */
import 'server-only';
import { agentRunPath, agentRunStreamPath, AGENT_DECIDE_PATH } from '@core/app-sdk/agents';

export type AppAgentDoor = {
  /** The SDK call that uses it. */
  sdk: 'os.agents.run' | 'os.agents.get' | 'os.agents.decide';
  /** The path, built the way the SDK builds it. */
  path: string;
  /** The route file (relative to `os-ui/`) that serves it — the UI's own door. */
  route: string;
  /** The governed function the route delegates to. */
  governedBy: string;
  method: 'GET' | 'POST';
};

/**
 * The three doors, with the probe values a test uses. `enqueueRun` is named explicitly: it is the
 * single run-service entry the UI route, the MCP `run_agent_system` and the scheduler all file
 * through, and it is what makes "the same door as the user" literally true.
 */
export function appAgentDoors(systemId = 'sys_probe', runId = 'run_probe'): AppAgentDoor[] {
  return [
    {
      sdk: 'os.agents.run',
      path: agentRunPath(systemId),
      route: 'app/api/agents/systems/[id]/run/route.ts',
      governedBy: 'enqueueRun',
      method: 'POST',
    },
    {
      sdk: 'os.agents.get',
      path: agentRunStreamPath(systemId, runId),
      route: 'app/api/agents/systems/[id]/run/stream/route.ts',
      governedBy: 'tailRunEvents + assertRunVisible',
      method: 'GET',
    },
    {
      sdk: 'os.agents.decide',
      path: AGENT_DECIDE_PATH,
      route: 'app/api/governance/approvals/route.ts',
      governedBy: 'decide + canApprove + applyEffect',
      method: 'POST',
    },
  ];
}

/**
 * Identity invariant, asserted by the triangle test: an app→OS call carries NO principal of its
 * own. These are the things that must NEVER appear on the app's side of the bridge.
 */
export const FORBIDDEN_APP_CREDENTIAL_FIELDS = [
  'authorization',
  'apiKey',
  'api_key',
  'token',
  'bearer',
  'servicePrincipal',
  'service_principal',
  'clientSecret',
] as const;

/** Does this request init smuggle a credential? Pure; the triangle test's negative assertion. */
export function carriesOwnCredential(init: { headers?: Record<string, string>; body?: unknown }): boolean {
  const headerKeys = Object.keys(init.headers ?? {}).map((k) => k.toLowerCase());
  if (headerKeys.some((k) => FORBIDDEN_APP_CREDENTIAL_FIELDS.some((f) => k === f.toLowerCase()))) return true;
  const body = init.body;
  if (!body || typeof body !== 'object') return false;
  const keys = Object.keys(body as Record<string, unknown>).map((k) => k.toLowerCase());
  return keys.some((k) => FORBIDDEN_APP_CREDENTIAL_FIELDS.some((f) => k === f.toLowerCase()));
}
