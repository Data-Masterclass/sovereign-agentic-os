/**
 * FEATURE:    Liveness probe for the platform.
 * USER STORY: As the platform I want a cheap endpoint that says the process is up.
 * ARCHITECTURE: No OS call, no identity: a probe must work when the OS is down.
 */
export function GET(): Response {
  return Response.json({ ok: true });
}
