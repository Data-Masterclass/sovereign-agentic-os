/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       core / models
 * FEATURE:    The model list, as LiteLLM holds it: one row per alias from `/model/info`, the
 *             connections behind them from `/credentials`, and who manages each model.
 * USER STORY: As a platform admin I add or remove a model in LiteLLM and the OS follows with no
 *             change of its own. I can see which models the deployment's config file sets and
 *             which live in LiteLLM's database.
 * ARCHITECTURE:
 *   - OWNERSHIP: LiteLLM owns providers, credentials and models. The OS keeps no list, no seed, no
 *     cache and no enable switch for them; this module is a live read and a mapping.
 *   - TWO KINDS OF MODEL (LiteLLM, https://docs.litellm.ai/docs/proxy/model_management). `store_model_in_db`
 *     is on in this chart, so both coexist:
 *       config    the chart's `litellm.proxy_config.model_list`: written from the config file at every
 *                 start; LiteLLM cannot edit or delete it in its UI or API (`db_model: false`). The
 *                 chart values are authoritative — change them with a deploy.
 *       database  registered in LiteLLM's own database (its UI, `/model/new`, the OS "Add a provider"
 *                 flow): durable, editable and removable in LiteLLM (`db_model: true`). LiteLLM is
 *                 authoritative.
 *       mixed     one alias served by both (a load-balanced alias): treated as config, because the
 *                 config part cannot be removed.
 *     A row with no `db_model` flag reads as `config` — the fail-safe: it is never offered for removal.
 *   - NO SECRETS: only credential NAMES and `credential_info` are kept. `credential_values` is
 *     not typed, not read and not copied, even when the gateway sends it.
 *   - A gateway that cannot be read is `{ ok: false, error }`. Credentials that cannot be listed do
 *     not hide the models: `credentials: null` and `credentialsError` say so.
 *   - Server-side only (the reads use the master key).
 */
import 'server-only';
import { readCredentials, readModels, type Fetched, type LiteLlmCredentialRow, type LiteLlmModelRow } from '@core/infra/litellm-admin';

export type ModelManagement = 'config' | 'database' | 'mixed';

export type GatewayModel = {
  /** The alias a caller pins (`model_name`). */
  name: string;
  /** How many deployments serve the alias (a load-balanced alias has several). */
  deployments: number;
  management: ModelManagement;
  /** `embedding` when LiteLLM says so; everything else is a chat model. */
  mode: 'chat' | 'embedding';
  /** The first deployment's routing parameters (the provider family is inferred from them). */
  primary: { model?: string; api_base?: string };
  /** The upstream model strings (`<provider>/<model>`) behind the alias. */
  litellmModels: string[];
  /** Names of the LiteLLM credentials the alias's deployments use. */
  credentials: string[];
  accessGroups: string[];
};

export type GatewayCredential = {
  name: string;
  info: Record<string, unknown>;
  /** Aliases that use this connection. */
  models: string[];
};

export type GatewayCatalog = {
  models: GatewayModel[];
  /** null = LiteLLM's credential list could not be read (see `credentialsError`). */
  credentials: GatewayCredential[] | null;
  credentialsError?: string;
};

const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];

/** Pure: LiteLLM's rows in, the OS view out. */
export function mapGatewayCatalog(rows: LiteLlmModelRow[], credentialRows: LiteLlmCredentialRow[] | null, credentialsError?: string): GatewayCatalog {
  const byName = new Map<string, LiteLlmModelRow[]>();
  for (const r of rows) {
    if (typeof r.model_name !== 'string' || r.model_name.length === 0) continue;
    byName.set(r.model_name, [...(byName.get(r.model_name) ?? []), r]);
  }
  const models: GatewayModel[] = [...byName.entries()].map(([name, deployments]) => {
    const db = deployments.filter((d) => d.model_info?.db_model === true).length;
    const first = deployments[0];
    return {
      name,
      deployments: deployments.length,
      management: db === deployments.length ? 'database' : db === 0 ? 'config' : 'mixed',
      mode: deployments.some((d) => d.model_info?.mode === 'embedding') ? 'embedding' : 'chat',
      primary: { ...(first.litellm_params?.model ? { model: first.litellm_params.model } : {}), ...(first.litellm_params?.api_base ? { api_base: first.litellm_params.api_base } : {}) },
      litellmModels: uniq(deployments.map((d) => d.litellm_params?.model).filter((m): m is string => typeof m === 'string')),
      credentials: uniq(deployments.map((d) => d.litellm_params?.litellm_credential_name).filter((c): c is string => typeof c === 'string' && c.length > 0)),
      accessGroups: uniq(deployments.flatMap((d) => d.model_info?.access_groups ?? []).filter((g): g is string => typeof g === 'string')),
    };
  });
  const credentials: GatewayCredential[] | null = credentialRows === null
    ? null
    : credentialRows
        .filter((c): c is LiteLlmCredentialRow & { credential_name: string } => typeof c.credential_name === 'string' && c.credential_name.length > 0)
        .map((c) => ({
          name: c.credential_name,
          info: c.credential_info && typeof c.credential_info === 'object' ? { ...c.credential_info } : {},
          models: models.filter((m) => m.credentials.includes(c.credential_name)).map((m) => m.name),
        }));
  return { models, credentials, ...(credentialsError ? { credentialsError } : {}) };
}

export type GatewayCatalogIo = {
  models: () => Promise<Fetched<LiteLlmModelRow[]>>;
  credentials: () => Promise<Fetched<LiteLlmCredentialRow[]>>;
};

/** Read the catalog live. No cache, no fallback. */
export async function readGatewayCatalog(io: GatewayCatalogIo = { models: readModels, credentials: readCredentials }): Promise<Fetched<GatewayCatalog>> {
  const [m, c] = await Promise.all([io.models(), io.credentials()]);
  if (!m.ok) return { ok: false, error: m.error };
  return { ok: true, data: mapGatewayCatalog(m.data, c.ok ? c.data : null, c.ok ? undefined : c.error) };
}
