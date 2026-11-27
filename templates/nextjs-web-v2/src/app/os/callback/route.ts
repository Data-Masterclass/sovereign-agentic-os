/**
 * FEATURE:    The return from OS sign-in: turn the one-time code into this user's app session.
 * USER STORY: As a user I come back from signing in to the OS and I am signed in to the app.
 * ARCHITECTURE: Thin: `completeSignIn` (src/lib/os/session.ts) checks state, exchanges the code with the PKCE verifier
 *               server-to-server, checks the nonce and sets the host-only session cookie. Platform-owned flow:
 *               do not change it; never log the URL of this route (it carries the one-time code).
 */
import { completeSignIn, errorResponse } from '@/lib/os';

export async function GET(request: Request): Promise<Response> {
  try {
    return await completeSignIn(request);
  } catch (e) {
    return errorResponse(e);
  }
}
