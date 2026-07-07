/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { NotionClientReg } from './notion-mcp.ts';

/**
 * Short-lived, server-side store for an in-flight Notion MCP OAuth flow — the PKCE
 * verifier + the registered client, keyed by the flow's signed-state NONCE. It
 * exists ONLY between authorize (mint) and callback (redeem): the PKCE verifier is
 * a secret that must survive the redirect to Notion and back WITHOUT ever being
 * placed in the URL, the signed state, or any client response. It never leaves the
 * server, is single-use (deleted on redeem), and self-expires after 10 minutes.
 *
 * In-process + globalThis-pinned (same pattern as the OAuth stores). A flow that
 * outlives a pod roll simply fails CSRF and the user re-clicks Connect — no secret
 * is persisted anywhere durable.
 */

export type NotionPendingFlow = {
  connectionId: string;
  userId: string;
  verifier: string;
  reg: NotionClientReg;
  redirectUri: string;
  createdAt: number; // epoch seconds
};

const TTL_SECONDS = 60 * 10;
const KEY = Symbol.for('soa.notion.oauth.flows');

function store(): Map<string, NotionPendingFlow> {
  const g = globalThis as unknown as Record<symbol, Map<string, NotionPendingFlow> | undefined>;
  if (!g[KEY]) g[KEY] = new Map();
  return g[KEY]!;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function sweep(): void {
  const cutoff = nowSec() - TTL_SECONDS;
  const s = store();
  for (const [k, v] of s) if (v.createdAt < cutoff) s.delete(k);
}

/** Record a pending flow under its state nonce (mint at authorize time). */
export function putPendingFlow(nonce: string, flow: Omit<NotionPendingFlow, 'createdAt'>): void {
  sweep();
  store().set(nonce, { ...flow, createdAt: nowSec() });
}

/** Consume the pending flow (single-use): returns it and deletes it. */
export function takePendingFlow(nonce: string): NotionPendingFlow | null {
  sweep();
  const s = store();
  const f = s.get(nonce);
  if (!f) return null;
  s.delete(nonce);
  if (f.createdAt < nowSec() - TTL_SECONDS) return null;
  return f;
}

export function _reset(): void {
  store().clear();
}
