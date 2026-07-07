/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { currentUser } from '@/lib/auth';
import { config } from '@/lib/config';
import { storeNotionConnection } from '@/lib/connections';
import { exchangeNotionCode } from '@/lib/oauth/notion-mcp';
import { verifyState, nonceMatches, OAUTH_STATE_COOKIE } from '@/lib/oauth/state';
import { publicBaseUrl } from '@/lib/oauth/redirect';
import { takePendingFlow } from '@/lib/oauth/notion-flow';

export const dynamic = 'force-dynamic';

/**
 * Notion MCP OAuth redirect callback. Verifies the CSRF-signed `state` against the
 * double-submit nonce cookie AND the logged-in user, redeems the single-use PKCE
 * flow, exchanges the code SERVER-SIDE for the token set, and persists it (+ the
 * registered client) on the connection's secret ref. Never renders the code,
 * tokens, or any secret; lands back on the Connections tab with a status flag.
 */
function landing(base: string, params: Record<string, string>): NextResponse {
  const to = new URL(`${base}/connections`);
  for (const [k, v] of Object.entries(params)) to.searchParams.set(k, v);
  const res = NextResponse.redirect(to.toString());
  res.cookies.delete(OAUTH_STATE_COOKIE);
  return res;
}

export async function GET(req: Request) {
  const base = publicBaseUrl(req.url);
  const url = new URL(req.url);

  const providerError = url.searchParams.get('error');
  if (providerError) return landing(base, { notion_error: providerError });

  const code = url.searchParams.get('code') ?? '';
  const stateToken = url.searchParams.get('state') ?? '';
  if (!code || !stateToken) return landing(base, { notion_error: 'missing_code_or_state' });

  const state = await verifyState(stateToken, config.sessionSecret);
  const cookieNonce = req.headers.get('cookie')?.match(new RegExp(`${OAUTH_STATE_COOKIE}=([^;]+)`))?.[1];
  if (!state || state.provider !== 'notion' || !nonceMatches(state.nonce, cookieNonce)) {
    return landing(base, { notion_error: 'invalid_state' });
  }

  const user = await currentUser();
  if (!user || user.id !== state.userId) return landing(base, { notion_error: 'session_mismatch' });

  // Single-use redeem of the server-side PKCE flow (carries the verifier + client).
  const flow = takePendingFlow(state.nonce);
  if (!flow || flow.connectionId !== state.connectionId || flow.userId !== state.userId) {
    return landing(base, { notion_error: 'flow_expired' });
  }

  try {
    const tokens = await exchangeNotionCode(flow.reg, { code, redirectUri: flow.redirectUri, codeVerifier: flow.verifier });
    await storeNotionConnection(state.connectionId, state.userId, tokens, flow.reg); // tokens → Secrets Manager only
    return landing(base, { notion_connected: '1' });
  } catch {
    // Never surface the code/tokens; a coarse reason is enough for the UI.
    return landing(base, { notion_error: 'exchange_failed' });
  }
}
