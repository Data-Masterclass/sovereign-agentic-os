/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    App Builder - the name rules of an app's env variables and secrets (one definition for server and UI)
 * USER STORY: As an app builder I see at once in the Env panel why a name is refused, by the same rule the server applies.
 * ARCHITECTURE: Pure and client-safe (no Node import): `env-secrets.ts` enforces it on every write, `EnvPanel` shows it
 *               while typing. Returns a CODE, not text, so the UI renders it in the user's language.
 */
export const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
/** Set by the platform: the database connection (PG*), the OS (OS_*), the app's identity (APP_*), Kubernetes; and the
 *  dynamic loader (LD_*: LD_PRELOAD and friends load code into the process). */
export const RESERVED_PREFIXES = ['PG', 'OS_', 'APP_', 'KUBERNETES_', 'LD_'] as const;
/** Names the runtime image or Node owns, and the ones that would silently turn off TLS checks or reroute traffic. */
export const RESERVED_NAMES = [
  'PORT', 'HOSTNAME', 'HOME', 'PATH', 'NODE_ENV', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED',
  'NEXT_TELEMETRY_DISABLED', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
] as const;

export type EnvNameProblem = { code: 'pattern' } | { code: 'prefix'; prefix: string } | { code: 'reserved'; name: string };

/** Null when an author may set `name`; else why not. */
export function envNameProblem(name: string): EnvNameProblem | null {
  if (!ENV_NAME_RE.test(name)) return { code: 'pattern' };
  const prefix = RESERVED_PREFIXES.find((x) => name.startsWith(x));
  if (prefix) return { code: 'prefix', prefix };
  if ((RESERVED_NAMES as readonly string[]).includes(name)) return { code: 'reserved', name };
  return null;
}
