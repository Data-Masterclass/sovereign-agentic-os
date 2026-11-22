/**
 * FEATURE:    The app's ONE door to the Sovereign OS (identity, data, agents), server side.
 * USER STORY: As the owner of this app I want every read, write and agent call to run as the
 *             signed-in user and be checked by the OS (OPA), so this app never decides access itself.
 * ARCHITECTURE:
 *   - A thin facade over the vendored `@sovereign-os/app-sdk` (`os.whoami`, `os.datasets`,
 *     `os.records`, `os.agents`). Every SDK call hits an OS route that is OPA-checked and
 *     row-filtered; a refusal arrives as `Forbidden` and is passed on, never turned into a success.
 *   - Identity is DELEGATED: the browser's OS session cookie is forwarded as received. The app holds
 *     no key, no password and no service identity of its own.
 *   - There is no `can(user, action)` here, on purpose. Access is decided by the OS or not at all.
 *   - This file is the only place allowed to touch cookies or headers; policy/app-rules.rego enforces it.
 */
import {
  createOsClient,
  Forbidden,
  NotAuthenticated,
  OsError,
  type OsClient,
  type WhoAmI,
} from '@sovereign-os/app-sdk';

export type OsEnv = { OS_BASE_URL?: string; APP_SLUG?: string };

/** An OS client acting as the caller whose request this is. */
export function osFor(request: Request, env: OsEnv = process.env, fetchImpl: typeof fetch = fetch): OsClient {
  const baseUrl = env.OS_BASE_URL ?? '';
  if (!baseUrl) throw new OsError('OS_BASE_URL is not set: the app cannot reach the OS.', 0);
  const cookie = request.headers.get('cookie') ?? '';
  const withSession: typeof fetch = (input, init) =>
    fetchImpl(input, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), ...(cookie ? { cookie } : {}) } });
  return createOsClient({ baseUrl, appSlug: env.APP_SLUG ?? '', fetch: withSession });
}

/** The signed-in user, or a thrown NotAuthenticated. */
export async function requireUser(os: OsClient): Promise<NonNullable<WhoAmI['user']>> {
  const who = await os.whoami();
  if (!who.user) throw new NotAuthenticated();
  return who.user;
}

/** Map an SDK error to the HTTP answer the OS meant: 401, 403 with its reason, 502 otherwise. */
export function errorResponse(e: unknown): Response {
  if (e instanceof NotAuthenticated) return Response.json({ error: 'not_signed_in' }, { status: 401 });
  if (e instanceof Forbidden) return Response.json({ error: 'forbidden', reason: e.message }, { status: 403 });
  if (e instanceof OsError) return Response.json({ error: 'os_error', reason: e.message }, { status: 502 });
  throw e;
}

/** Run a route handler body as the caller; every SDK refusal becomes its honest HTTP answer. */
export async function asCaller(
  request: Request,
  body: (os: OsClient, user: NonNullable<WhoAmI['user']>) => Promise<Response>,
  deps: { env?: OsEnv; fetch?: typeof fetch } = {},
): Promise<Response> {
  try {
    const os = osFor(request, deps.env, deps.fetch);
    return await body(os, await requireUser(os));
  } catch (e) {
    return errorResponse(e);
  }
}
