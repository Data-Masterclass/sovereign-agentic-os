/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       kernel
 * FEATURE:    App Builder (W0) - the one switch, and the typed refusal every new route and tool gives while it is off
 * USER STORY: As the owner I want merged App Builder code to change nothing in prod until I turn it on, and I want
 *             a caller that reaches a new route or MCP tool while it is off to get a clear, typed answer
 *             (`app_builder_disabled`), never a half-working feature.
 * ARCHITECTURE:
 *   - The flag is `config.appBuilderEnabled` (SOFTWARE_APP_BUILDER=on, rendered only when the chart's
 *     `softwareRunner.environments.enabled` is true). Kernel, because the Dev/Prod labels (workstream F, core/ui)
 *     and the Software tab both read it.
 *   - `appBuilderGuard()` returns the refusal (or null when on) for code that wants to branch;
 *     `assertAppBuilderEnabled()` throws it (status 403, `code: 'app_builder_disabled'`), which the MCP dispatcher
 *     maps to a typed `{ code, reason, hint }` (core/mcp/server.ts `structuredError`);
 *     `appBuilderDisabledResponse()` is the same refusal as an HTTP response for an API route.
 */
import { config } from '@core/kernel/config';

export const APP_BUILDER_DISABLED = 'app_builder_disabled';
export const APP_BUILDER_DISABLED_REASON = 'The App Builder is not enabled on this installation.';
export const APP_BUILDER_DISABLED_HINT =
  'An operator turns it on with the chart value softwareRunner.environments.enabled. Until then, use the existing Software builder.';

export type AppBuilderRefusal = { code: typeof APP_BUILDER_DISABLED; reason: string; hint: string };

export function appBuilderEnabled(): boolean {
  return config.appBuilderEnabled;
}

/** null when the App Builder is on, else the typed refusal. */
export function appBuilderGuard(): AppBuilderRefusal | null {
  return appBuilderEnabled() ? null : { code: APP_BUILDER_DISABLED, reason: APP_BUILDER_DISABLED_REASON, hint: APP_BUILDER_DISABLED_HINT };
}

export class AppBuilderDisabledError extends Error {
  readonly code = APP_BUILDER_DISABLED;
  readonly status = 403;
  readonly hint = APP_BUILDER_DISABLED_HINT;
  constructor() {
    super(APP_BUILDER_DISABLED_REASON);
    this.name = 'AppBuilderDisabledError';
  }
}

export function isAppBuilderDisabled(e: unknown): boolean {
  return (e as { code?: unknown } | null)?.code === APP_BUILDER_DISABLED;
}

/** Throws the typed refusal when the App Builder is off. */
export function assertAppBuilderEnabled(): void {
  if (!appBuilderEnabled()) throw new AppBuilderDisabledError();
}

/** The refusal as an API response (403, JSON `{ error, code, reason, hint }`), or null when the App Builder is on. */
export function appBuilderDisabledResponse(): Response | null {
  const r = appBuilderGuard();
  return r ? Response.json({ error: r.reason, ...r }, { status: 403 }) : null;
}
