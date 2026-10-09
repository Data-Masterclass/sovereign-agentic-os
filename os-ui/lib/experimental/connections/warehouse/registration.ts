/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * External-warehouse connector — CATALOG REGISTRATION SNIPPET (layer 2 live seam).
 *
 * Registering a federated source as a live Trino catalog is a GITOPS operation, NOT
 * a runtime API call. The Trino pod runs with `readOnlyRootFilesystem: true` and its
 * catalog dir is a read-only ConfigMap mount (`/etc/trino/catalog`), so a catalog
 * CANNOT be written into the pod at runtime — that is a deliberate hardening choice,
 * not a limitation to route around. The supported path is:
 *
 *   1. an operator adds an entry to `.Values.trino.externalCatalogs` (the props this
 *      module renders) + wires the secret,
 *   2. `helm upgrade` re-renders the `trino-catalog` ConfigMap,
 *   3. the Trino Deployment (strategy: Recreate) rolls and picks up the new catalog.
 *
 * This module turns a warehouse source into (a) the catalog `.properties` block and
 * (b) the exact `values.yaml` snippet the operator pastes. It is PURE — it renders
 * text from the provider registry + the source; it performs no I/O and emits no
 * secret material (secrets are referenced by `${ENV:...}` / mounted files only).
 */

import type { WarehouseSource } from './types.ts';
import { trinoCatalogProps } from './catalog-props.ts';
import { providerFor } from './registry.ts';

/** The parts an operator needs to register ONE external catalog via GitOps. */
export type CatalogRegistration = {
  /** The Trino catalog name (mount `<name>.properties`). */
  name: string;
  /** The rendered catalog props (no secrets — env-referenced). */
  props: Record<string, string>;
  /** Secret env vars this catalog's props reference (`${ENV:...}`). */
  envVars: string[];
  /** Vault secret keys backing those env vars (mounted via secretKeyRef). */
  secretKeys: string[];
  /** OpenMetadata connector type + config keys for the ingestion stub. */
  openMetadata: { connectorType: string; configKeys: string[] };
  /** The exact `.Values.trino.externalCatalogs[]` YAML entry to paste. */
  valuesSnippet: string;
};

/** Serialize a props map to `key=value` lines (deterministic key order). */
function propsToLines(props: Record<string, string>): string[] {
  return Object.keys(props)
    .sort()
    .map((k) => `${k}=${props[k]}`);
}

/** Indent every line of `text` by `spaces`. */
function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((l) => (l ? pad + l : l))
    .join('\n');
}

/**
 * Render the GitOps registration for a warehouse source: the catalog props (pure,
 * from the provider), the secret plumbing it needs, the OM ingestion hint, and the
 * ready-to-paste `values.yaml` snippet. Pure + total: it delegates the actual prop
 * generation to `trinoCatalogProps`, which throws on a malformed source.
 */
export function catalogRegistration(source: WarehouseSource): CatalogRegistration {
  const provider = providerFor(source.platform);
  const props = trinoCatalogProps(source);
  const { secretKeys, envVars } = provider.secretMaterial;

  // The values.yaml list entry the operator pastes under trino.externalCatalogs.
  // `properties` is a YAML block scalar (|) of the catalog .properties lines;
  // `secretEnv` maps each ${ENV:VAR} to a (secretName,key) the operator fills in.
  const propLines = propsToLines(props).join('\n');
  const secretEnvLines =
    envVars.length === 0
      ? '# none — this platform authenticates via cloud-native identity (IRSA/Workload Identity)'
      : envVars
          .map(
            (v) =>
              `- name: ${v}\n  secretName: <k8s-secret-name>   # the Secret you created\n  key: <secret-key>`,
          )
          .join('\n');

  const valuesSnippet = [
    `- name: ${source.catalog}`,
    `  platform: ${source.platform}`,
    `  properties: |`,
    indent(propLines, 4),
    `  secretEnv:`,
    indent(secretEnvLines, 4),
  ].join('\n');

  return {
    name: source.catalog,
    props,
    envVars,
    secretKeys,
    openMetadata: provider.openMetadata,
    valuesSnippet,
  };
}
