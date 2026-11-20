/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The authenticated clone URL the OS PUBLISHES for a repository (WP-51)
 * USER STORY: As an engineer I want every engineering view to give me the real
 *             `git clone https://<os>/git/<repo>.git` — authenticated with my own revocable,
 *             scoped access token — and to say plainly when this deployment serves no git endpoint.
 * ARCHITECTURE:
 *   - Server-side twin of the pure `git-clone.ts`: the URL is `cloneUrl(repo, OS_PUBLIC_URL)`, and
 *     it is published ONLY when the chart rendered the git-http sidecar and its Ingress
 *     (`OS_GIT_HTTP=true`). Otherwise null, and the view states why — never a guessed host.
 *   - The URL carries no credential. Authorization stays where it is: the Ingress `auth-url`
 *     (`/api/git/authenticate`) per request, per user, per repository.
 */
import 'server-only';
import { config } from '@core/kernel/config';
import { cloneUrl } from '@core/infra/git-clone';

export function publishedCloneUrl(
  repo: string,
  env: { base?: string; enabled?: boolean } = {},
): string | null {
  const enabled = env.enabled ?? config.gitHttpEnabled;
  if (!enabled) return null;
  return cloneUrl(repo, env.base ?? config.osPublicUrl);
}
