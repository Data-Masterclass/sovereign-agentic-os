/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Run os-ui's OWN workload writes against a real API server, as the os-ui ServiceAccount.
 * USER STORY: As the release-namespace admission test (scripts/tests/os-ui-workload-admission.kind.sh)
 *             I want the narrowed Role and the admission policy proven against what os-ui really
 *             sends — the Platform toggle's /scale PATCH, the warehouse registration's strategic-merge
 *             PATCH of Trino, the agent-schedule CronJob, the zot-users reconcile Job — not against a
 *             hand-written copy that could pass while os-ui's own request is refused.
 * ARCHITECTURE: Calls the production functions with the production in-cluster client
 *             (core/infra/k8s.ts), pointed at the test cluster by OS_K8S_SA_DIR (token + ca.crt of
 *             the os-ui ServiceAccount) and KUBERNETES_API. Prints one JSON outcome per call. Run from os-ui:
 *               node --experimental-test-module-mocks --import ./scripts/test-setup.mjs scripts/workload-rbac-probe.ts <action> [arg]
 *             actions: toggle <componentId> | register | remove | schedule <systemId> | unschedule <systemId> | zot
 */
import { toggleComponent } from '@tabs/admin/lib/platform';
import { applyLiveRegistration, removeLiveRegistration } from '@tabs/connections/lib/warehouse/k8s-registration';
import { catalogRegistration } from '@tabs/connections/lib/warehouse/registration';
import type { WarehouseSource } from '@tabs/connections/lib/warehouse/types';
import { reconcileScheduleCron } from '@tabs/agents/lib/schedule-cron';
import type { Schedule } from '@tabs/agents/lib/system-schema';
import { startReconcile } from '@core/adapters/zot/client';
import { k8s } from '@core/infra/k8s';
import { config } from '@core/kernel/config';

const [action, arg] = process.argv.slice(2);
const ns = config.platformNamespace;
const snowflake = (): WarehouseSource =>
  ({ catalog: 'snow_fin', platform: 'snowflake', accountUrl: 'ACME-PROD', database: 'DB', warehouse: 'WH', username: 'svc' }) as WarehouseSource;

async function run(): Promise<unknown> {
  switch (action) {
    case 'toggle':
      return toggleComponent(arg ?? 'minio');
    case 'register':
      // A throwaway value: the test cluster's Secret is deleted with the cluster.
      return applyLiveRegistration(catalogRegistration(snowflake()), { SNOWFLAKE_PRIVATE_KEY: 'kind-test-not-a-key' }, { namespace: ns });
    case 'remove':
      return removeLiveRegistration('snow_fin', { namespace: ns });
    case 'schedule':
      return reconcileScheduleCron(arg ?? 'kind-probe', { kind: 'cron', cron: '0 9 * * 1' } satisfies Schedule);
    case 'unschedule':
      return reconcileScheduleCron(arg ?? 'kind-probe', { kind: 'manual' } satisfies Schedule);
    case 'zot':
      return startReconcile({ k8s, platformNamespace: ns, buildNamespace: config.softwareTektonNamespace, registryHost: config.appRegistry });
    default:
      throw new Error(`unknown action ${action}`);
  }
}

console.log(JSON.stringify(await run()));
