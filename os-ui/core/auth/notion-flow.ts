/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Notion OAuth flow store — hold the PKCE verifier between authorize and callback
 * USER STORY: As a user connecting Notion I want the consent round-trip to stay bound to my
 *             browser session so that nobody else can complete it.
 * ARCHITECTURE:
 *   - Server-only, in-process map pinned on `globalThis`, keyed by the signed-state nonce.
 *     Written by the Notion authorize route, read once by the callback route.
 *   - Entries are single-use (deleted on redeem) and expire after 10 minutes; the verifier is
 *     never placed in the URL, the state or a client response.
 *   - Nothing is persisted: a flow that outlives a pod restart fails and the user clicks Connect again.
 */
import 'server-only';
import type { NotionClientReg } from '@core/auth/notion-mcp';

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
