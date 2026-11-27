/**
 * FEATURE:    Start signing in through the OS.
 * USER STORY: As a user who is not signed in to the app I am sent to the OS to sign in, and come back where I was.
 * ARCHITECTURE: Thin: `beginSignIn` (src/lib/os/session.ts) remembers state, nonce and the PKCE verifier in a
 *               short-lived host-only cookie and redirects to the OS app-login endpoint. Platform-owned flow.
 */
import { beginSignIn, errorResponse } from '@/lib/os';

export async function GET(request: Request): Promise<Response> {
  try {
    return await beginSignIn(request);
  } catch (e) {
    return errorResponse(e);
  }
}
