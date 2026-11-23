/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    A boot migration adds the role names to the keys the OS owns, so keys minted before the switch keep working
 *             (the shared key: all three; a system key: the roles its agents run on, `agentRoles`).
 * USER STORY: As an operator I upgrade to the role names and every agent system and the shared agent key can
 *             call sovereign-strong / -worker / -embedding at once, with no rebuild — and nothing else about a key moves.
 * ARCHITECTURE:
 *   - ADDS ONLY. A key's `models` become what it had plus the roles it lacks. The write is LiteLLM's documented
 *     `/key/update` addressed by token id with `models` and nothing else, so the key value, budget, limits and
 *     metadata are untouched. A key that already has the roles is not written (idempotent). `dryRun` returns the
 *     same plan and writes nothing.
 *   - OWNED KEYS ONLY. (1) the shared agent key — the one whose VALUE the OS holds (`LITELLM_AGENT_KEY`), found by
 *     its token id, never by alias; (2) each registered system's key whose token is the one the OS stored (the
 *     same "ours" test as the key reconcile). A key under an `os-<id>` alias that is some other token, a key no
 *     registry knows, and an unrestricted key (an empty model list means every model) are left alone and reported.
 *   - AUDITED per changed key (`gateway.key.reconcile`). A gateway or registry that cannot be read writes nothing.
 *   - The key reconcile (`key-reconcile.ts`) tolerates the deprecated old names a key still holds (`keyDrift`),
 *     so after this migration it sees no drift.
 *   - Runs at boot (`instrumentation.ts`, `AGENT_KEY_ROLE_MIGRATION=apply|dry-run|off`, default apply); the same
 *     plan is previewable through `POST /api/platform-admin/models/roles/keys {"dryRun": true}`.
 */
import 'server-only';
import { record as auditRecord } from '@core/policy/audit';
import { systemKeyAlias, tokenIdOf, tryOpenSystemKey, type SystemKeyJournal, type SystemKeyStore, type Kek } from '@core/infra/agent-system-keys';
import { parseSystem } from '@tabs/agents/lib/system-schema';
import { agentRoles } from '@tabs/agents/lib/build/live';
import { ROLE_NAMES } from '@core/models/role-names';
import type { RoleKeyClient } from '@core/infra/litellm-role-keys';
export type { RoleKeyClient };

export type MigrationSystem = { id: string; domain: string; owner: string; yaml: string };

export type RoleKeyMigrationIo = {
  /** The existing systems, or null when the registry cannot be trusted (not hydrated). */
  systems: () => Promise<MigrationSystem[] | null>;
  deps: { keys: { store: SystemKeyStore; journal?: SystemKeyJournal; kek: () => Kek; retireGraceSeconds?: number }; litellm: RoleKeyClient };
  /** The shared agent key's VALUE as the OS holds it ('' = the OS holds none). */
  sharedKey: string;
  log?: (line: string) => void;
  audit?: typeof auditRecord;
};

export type RoleKeyMigrationResult = {
  ok: boolean;
  dryRun: boolean;
  /** Keys that got (or, in a dry run, would get) roles. */
  changed: { subject: string; add: string[] }[];
  /** Keys looked at and left alone, with the reason. */
  skipped: { subject: string; why: string }[];
  errors: string[];
};

const SHARED = 'shared agent key';

export async function migrateRoleKeys(io: RoleKeyMigrationIo, opts: { dryRun?: boolean; actor?: string } = {}): Promise<RoleKeyMigrationResult> {
  const dryRun = opts.dryRun === true;
  const log = io.log ?? ((l: string) => console.info(`[role-key-migration] ${l}`));
  const write = io.audit ?? auditRecord;
  const out: RoleKeyMigrationResult = { ok: true, dryRun, changed: [], skipped: [], errors: [] };
  const gw = io.deps.litellm;

  const ensure = async (subject: string, tokenId: string, domain: string, roles: readonly string[], alias?: string): Promise<void> => {
    let found: { alias: string | null; models: string[] } | null;
    try {
      found = await gw.keyInfo(tokenId);
    } catch (e) {
      out.ok = false; out.errors.push(`${subject}: ${(e as Error).message}`);
      return;
    }
    if (found === null) { out.skipped.push({ subject, why: alias ? 'the gateway holds no key with the token the OS stored for this system — a key under that alias, if any, is not the key the OS stored: left alone' : 'the gateway holds no such key' }); return; }
    if (alias && found.alias !== alias) { out.skipped.push({ subject, why: `the key with the stored token is named '${found.alias ?? 'none'}', not '${alias}': it is not the key the OS stored for this system: left alone` }); return; }
    const have = found.models;
    if (have.length === 0) { out.skipped.push({ subject, why: 'the key is unrestricted (no model list = every model): nothing to add' }); return; }
    const add = roles.filter((r) => !have.includes(r));
    if (add.length === 0) return;
    if (!dryRun) {
      try {
        await gw.addKeyModels(tokenId, [...have, ...add]);
      } catch (e) {
        out.ok = false; out.errors.push(`${subject}: ${(e as Error).message}`);
        return;
      }
      write({
        actor: opts.actor ?? 'system:os-ui',
        action: 'gateway.key.reconcile',
        subject,
        domain,
        reason: 'the OS added the role names this key needs to the key it owns, so a role remap needs no key rebuild (nothing was removed; the key value is unchanged)',
        detail: { outcome: 'roles-added', added: add },
      });
      log(`added ${add.join(', ')} to '${subject}'`);
    }
    out.changed.push({ subject, add: [...add] });
  };

  // The shared key serves every role; a system key only the roles its agents run on (`agentRoles`, the same list the
  // Build keys and the reconcile compares) — adding the others would only turn into drift.
  if (io.sharedKey) await ensure(SHARED, tokenIdOf(io.sharedKey), 'platform', ROLE_NAMES);

  let systems: MigrationSystem[] | null;
  try {
    systems = await io.systems();
  } catch (e) {
    systems = null;
    out.errors.push(`registry: ${(e as Error).message}`);
  }
  if (systems === null) {
    out.ok = false;
    if (out.errors.length === 0) out.errors.push('the agent registry has not hydrated yet: no system key was looked at');
    return out;
  }
  for (const s of systems) {
    const alias = systemKeyAlias(s.id);
    try {
      const record = await io.deps.keys.store.get(s.id);
      if (!record) { out.skipped.push({ subject: alias, why: 'not built: the OS stored no key for this system' }); continue; }
      const stored = tryOpenSystemKey(record, io.deps.keys.kek());
      if (!stored.ok) { out.skipped.push({ subject: alias, why: 'the stored key cannot be read here: left alone' }); continue; }
      await ensure(alias, record.tokenId, s.domain, agentRoles(parseSystem(s.yaml)), alias);
    } catch (e) {
      out.ok = false; out.errors.push(`${alias}: ${(e as Error).message}`);
    }
  }
  log(`${dryRun ? 'dry run: ' : ''}${out.changed.length} key(s) ${dryRun ? 'would get' : 'got'} the role names, ${out.skipped.length} left alone, ${out.errors.length} error(s)`);
  return out;
}
