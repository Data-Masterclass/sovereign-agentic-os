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
import { readRouterAliases } from '@core/infra/litellm-admin';
import { adminPost } from '@core/infra/litellm-write';
import { readGatewayCatalog } from '@core/models/gateway-catalog';
import type { GitStoreOptions } from '@core/infra/git-store';
import { platformRoleStore } from '@core/models/role-store';
import type { RoleReconcileIo } from '@core/models/role-reconcile';

export function liveRoleIo(opts: GitStoreOptions = {}): RoleReconcileIo {
  const store = platformRoleStore(opts);
  return {
    readMapping: () => store.read(),
    writeMapping: (mapping, by) => store.write(mapping, { id: by }),
    async catalog() {
      const r = await readGatewayCatalog();
      return r.ok ? { ok: true, data: r.data.models.map((m) => m.name) } : r;
    },
    readAliases: readRouterAliases,
    writeAliases: (aliases) => adminPost('/config/update', { router_settings: { model_group_alias: aliases } }, 8000),
    audit: (e) => audit(e),
  };
}
