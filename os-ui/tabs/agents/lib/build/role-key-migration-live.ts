/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    The real wiring of the role-key migration: this registry, this gateway, this key store.
 * USER STORY: As an operator the keys minted before the role names keep working after an upgrade, without a rebuild.
 * ARCHITECTURE: the logic is `role-key-migration.ts`; here the registry is hydrated first (a registry that has not
 *   hydrated is "could not check", never "no systems"), the gateway is the real admin client, and the shared key's
 *   value is `LITELLM_AGENT_KEY`. Web process only (it needs the gateway's master key).
 */
import 'server-only';
import { config } from '@core/kernel/config';
import { deploymentKek, durableSystemKeyStore, durableSystemKeyJournal } from '@core/infra/agent-system-keys';
import { migrateRoleKeys, type RoleKeyMigrationResult } from '@tabs/agents/lib/build/role-key-migration';
import { realRoleKeyClient } from '@core/infra/litellm-role-keys';

export async function migrateRoleKeysLive(opts: { dryRun?: boolean; actor?: string } = {}): Promise<RoleKeyMigrationResult> {
  const { ensureHydrated, listSystemsForKeyMigration } = await import('@tabs/agents/lib/store');
  return migrateRoleKeys(
    {
      systems: async () => {
        await ensureHydrated();
        return listSystemsForKeyMigration();
      },
      deps: { keys: { store: durableSystemKeyStore, journal: durableSystemKeyJournal, kek: () => deploymentKek() }, litellm: realRoleKeyClient() },
      sharedKey: config.litellmAgentKey,
    },
    opts,
  );
}
