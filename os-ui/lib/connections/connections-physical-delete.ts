/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { Connection } from './schema.ts';
import type { SecretRef } from '../secrets.ts';

/**
 * PHYSICAL cleanup for a connection DELETE (never for archive — archive is a reversible
 * registry-only soft-hide; the vault secret + OAuth token are KEPT so a restore
 * reconnects with no re-auth).
 *
 * THE ONE RULE is that the credential lives in the VAULT (`lib/secrets`), never in the
 * record — so deleting the record alone leaves a live credential (and, for OAuth
 * connections, a usable access/refresh token) behind in Secrets Manager. That is a
 * "deleted" connection whose secret can still be injected. DELETE must therefore PURGE
 * the vault:
 *
 *   • `c.secretRef` — the credential AND (for a Drive/Notion OAuth connection) the stored
 *     token set, which `storeTokens` writes under the SAME ref. Deleting it forgets/
 *     revokes the token locally (the token can no longer be resolved or refreshed).
 *   • `{ name: c.secretRef.name, key: 'mcp-client' }` — a Notion hosted-MCP connection
 *     ALSO stores its registered OAuth client under a sibling key; purge it too.
 *
 * Archive keeps every vault entry. Pure planning + injected `deleteSecret`, so the plan
 * and the honest report fold are unit-testable without a vault; the store injects the
 * real `deleteSecret`. Mirrors `lib/data/physical-delete`.
 */

/** The sibling vault ref a Notion MCP connection stores its client registration under. */
const NOTION_MCP_KEY = 'mcp-client';

export type VaultTarget = { ref: SecretRef; label: string };

/** Every vault entry this connection owns: its credential/token ref, plus the Notion
 *  MCP client-registration ref when the connection is a Notion hosted-MCP connection. */
export function purgePlan(c: Connection): VaultTarget[] {
  const out: VaultTarget[] = [{ ref: c.secretRef, label: 'credential/oauth-token' }];
  if (c.template === 'notion-mcp') {
    out.push({ ref: { name: c.secretRef.name, key: NOTION_MCP_KEY }, label: 'notion-mcp-client' });
  }
  return out;
}

export type PhysicalTarget = { target: string; ok: boolean; reason: string };
export type PhysicalDeleteReport = { recordDeleted: boolean; physical: PhysicalTarget[] };

/** Whether a secret exists (so the report can honestly say "was already absent"). */
export type HasSecretFn = (ref: SecretRef) => boolean;
/** Purge one vault entry. Injected for testability. */
export type DeleteSecretFn = (ref: SecretRef) => void;

/**
 * Purge every planned vault entry, best-effort per target: a failure never blocks the
 * others, and every miss is reported honestly with its reason. The delete of the
 * registry record stands regardless — the leftover secret is never silent.
 */
export function purgeConnectionSecrets(
  c: Connection,
  hasSecret: HasSecretFn,
  deleteSecret: DeleteSecretFn,
): PhysicalTarget[] {
  const out: PhysicalTarget[] = [];
  for (const t of purgePlan(c)) {
    const label = `${t.label} (${t.ref.name}/${t.ref.key})`;
    try {
      const existed = hasSecret(t.ref);
      deleteSecret(t.ref);
      out.push({
        target: label,
        ok: existed,
        reason: existed ? 'purged from Secrets Manager' : 'no secret stored under this ref',
      });
    } catch (e) {
      out.push({ target: label, ok: false, reason: (e as Error).message || 'purge failed' });
    }
  }
  return out;
}
