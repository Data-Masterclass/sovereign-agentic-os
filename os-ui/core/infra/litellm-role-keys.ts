/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       core / infra
 * FEATURE:    The two LiteLLM key calls the role-key migration needs: read one key by token id, set its models.
 * USER STORY: As an operator the keys minted before the role names keep working after an upgrade.
 * ARCHITECTURE: `GET /key/info?key=<token id>` and `POST /key/update {key, models}` — LiteLLM's documented key API,
 *   addressed by TOKEN ID (the SHA-256 of the key; the value itself is never sent). `/key/update` carries `models`
 *   only, so nothing else on the key changes. Admin calls with the master key through the one admin client
 *   (`litellm-admin.ts` / `litellm-write.ts`). A key the gateway does not hold reads as null; anything else that
 *   fails is thrown, so an unreadable gateway is "could not check", never "no such key". Server-only.
 */
import 'server-only';
import { adminGet } from '@core/infra/litellm-admin';
import { adminPost } from '@core/infra/litellm-write';

/** What the migration needs from the gateway: read one key (by token id), set its models. */
export type RoleKeyClient = {
  /** The key with this token id (its alias and model list); null when the gateway holds no such key. */
  keyInfo(tokenId: string): Promise<{ alias: string | null; models: string[] } | null>;
  /** Set the key's model list (`/key/update` with `models` only). */
  addKeyModels(tokenId: string, models: string[]): Promise<void>;
};

type KeyInfoBody = { info?: { key_alias?: unknown; models?: unknown } };

export function realRoleKeyClient(): RoleKeyClient {
  return {
    async keyInfo(tokenId) {
      const r = await adminGet<KeyInfoBody>(`/key/info?key=${encodeURIComponent(tokenId)}`, 8000);
      if (!r.ok) {
        if (/^HTTP (404|401|400)\b/.test(r.error)) return null;
        throw new Error(`LiteLLM /key/info failed (${r.error}) — could not read the key, nothing was changed`);
      }
      const info = r.data.info;
      if (!info) return null;
      return {
        alias: typeof info.key_alias === 'string' ? info.key_alias : null,
        models: Array.isArray(info.models) ? info.models.filter((m): m is string => typeof m === 'string') : [],
      };
    },
    async addKeyModels(tokenId, models) {
      const r = await adminPost('/key/update', { key: tokenId, models }, 8000);
      if (!r.ok) throw new Error(`LiteLLM /key/update failed (${r.error}) — the key keeps its previous models`);
    },
  };
}
