/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       core / models
 * FEATURE:    The real wiring of the role mapping: the platform repository file and LiteLLM's own admin API.
 * USER STORY: As an operator I want the role mapping enforced at the gateway through LiteLLM's documented API only.
 * ARCHITECTURE:
 *   - File: `role-store.ts`. Catalog: `readGatewayCatalog` (`/model/info`). Aliases: read with
 *     `GET /router/settings` (`current_values.model_group_alias`), written with
 *     `POST /config/update {router_settings: {model_group_alias}}` — the documented route; LiteLLM applies it
 *     without a restart and stores it in its database (refused when the alias is set in the config FILE).
 *   - Server-only: the admin calls use the master key.
 */
import 'server-only';
import { record as audit } from '@core/policy/audit';
import { readCredentials, readModels, readRouterAliases } from '@core/infra/litellm-admin';
import { adminPost } from '@core/infra/litellm-write';
import { readGatewayCatalog } from '@core/models/gateway-catalog';
import { log as gitLog, type GitStoreOptions } from '@core/infra/git-store';
import { PLATFORM_REPO } from '@core/infra/repo-layout';
import { platformRoleStore } from '@core/models/role-store';
import type { RoleReconcileIo } from '@core/models/role-reconcile';

/**
 * The catalog budget for the role mapping. It runs in the background (boot, the timer, an admin's apply) and a
 * false "unreadable" there costs far more than a wait: on 23 Nov 2026 the first mapping on a production first boot
 * hit the pages' 2.5 s default while LiteLLM was busy starting (the same read took ~95 ms a minute later), so no
 * mapping was written and every role call failed. Pages keep their own short default.
 */
export const ROLE_CATALOG_TIMEOUT_MS = 12_000;

export function liveRoleIo(opts: GitStoreOptions = {}): RoleReconcileIo {
  const store = platformRoleStore(opts);
  return {
    readMapping: () => store.read(),
    writeMapping: (mapping, by) => store.write(mapping, by),
    readRevision: async () => (await gitLog(PLATFORM_REPO, { ...opts, limit: 1 }))[0]?.sha ?? null,
    async catalog() {
      const r = await readGatewayCatalog({
        models: () => readModels(ROLE_CATALOG_TIMEOUT_MS),
        credentials: readCredentials,
        aliases: () => readRouterAliases(ROLE_CATALOG_TIMEOUT_MS),
      });
      return r.ok ? { ok: true, data: r.data.models.map((m) => m.name) } : r;
    },
    readAliases: () => readRouterAliases(ROLE_CATALOG_TIMEOUT_MS),
    writeAliases: (aliases) => adminPost('/config/update', { router_settings: { model_group_alias: aliases } }, 8000),
    audit: (e) => audit(e),
  };
}
