/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Provider-agnostic LLM setup — glue over LiteLLM's own provider support.
 * USER STORY: As a platform admin installing on Azure, on my own Ollama or vLLM, on Mistral or on
 *             STACKIT, I choose the provider, give its endpoint and key, test the connection, pick the
 *             model and assign it to a role. Agents can call it at once, it survives restarts, and a
 *             host outside the egress allowlist is refused with the exact change to make.
 * ARCHITECTURE:
 *   Every step is a documented LiteLLM 1.109.1 admin API; the OS re-implements none of them:
 *     provider list + fields  GET  /public/providers/fields
 *     connection (key)        POST /credentials        — LiteLLM's store, encrypted with LITELLM_SALT_KEY
 *                              GET  /credentials        — values come back MASKED; the OS drops the key anyway
 *     test                    POST /health/test_connection {litellm_params:{model, litellm_credential_name}}
 *     model suggestions       GET  /public/litellm_model_cost_map (known models per provider, with prices)
 *     register                POST /model/new {litellm_credential_name, model_info.access_groups}
 *     dry-run migration       GET  /model/info → the /model/update each row WOULD get (nothing is sent)
 *   The OS adds only what LiteLLM cannot know: the egress check against the chart-rendered proxy
 *   allowlist (`LLM_EGRESS_ALLOWLIST`, the same list the proxy filters on), the access group the shared
 *   agent key holds (`LLM_ACCESS_GROUP`), and an admin-readable sentence for LiteLLM's errors.
 *   All writes go through `litellm-write.ts` (the one audited admin door); the master key stays there.
 *   The key an admin types passes through this process ONCE, to LiteLLM, and is never stored or returned.
 *   IO is injectable (`io`) so the gates are testable without a gateway; the default IO is the real one,
 *   proven by llm-providers.e2e.test.ts against the real LiteLLM image.
 */
import 'server-only';
import { adminPost } from '@core/infra/litellm-write';
import { adminGet, readModels, type Fetched, type LiteLlmModelRow } from '@core/infra/litellm-admin';
import { egressHost, isHardDeniedTarget } from '@core/infra/secrets';
import { ADMIN_REGISTERED_ACCESS_GROUP, perTokenCost } from '@tabs/admin/lib/provider-registration';
import {
  PRESETS, presetById, modelString, credentialValues, validCredentialName,
  type Preset, type ConnectionInput,
} from '@tabs/admin/lib/llm-provider-presets';

export { PRESETS, presetById, modelString, credentialValues, validCredentialName };
export type { Preset, PresetId, ConnectionInput } from '@tabs/admin/lib/llm-provider-presets';

export type GatewayIo = {
  get: <T>(path: string, timeoutMs?: number) => Promise<Fetched<T>>;
  post: <T>(path: string, body: unknown, timeoutMs?: number) => Promise<Fetched<T>>;
  models: () => Promise<Fetched<LiteLlmModelRow[]>>;
};
const realIo: GatewayIo = { get: adminGet, post: adminPost, models: readModels };

/** The access group the shared agent key holds (chart: llmProviders.accessGroup). */
export function accessGroup(): string {
  return (process.env.LLM_ACCESS_GROUP ?? '').trim() || ADMIN_REGISTERED_ACCESS_GROUP;
}

/** The hosts the egress proxy lets out — rendered by the chart from the SAME list as the proxy filter. */
export function egressAllowlist(): string[] {
  return (process.env.LLM_EGRESS_ALLOWLIST ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/** The names the gateway reaches without the proxy — the chart renders the gateway's NO_PROXY here too. */
export function noProxyList(): string[] {
  return (process.env.LLM_NO_PROXY ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

// ------------------------------------------------------------------------- egress --

export type EgressVerdict = { ok: boolean; host: string; route?: 'egress-proxy' | 'in-cluster'; guidance?: string };

const PRIVATE = /^(10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/;
const onList = (host: string, list: string[]) => list.some((d) => host === d || host.endsWith(`.${d}`));
/** NO_PROXY semantics: an exact name, or a suffix entry (".svc"). */
const bypassesProxy = (host: string, noProxy: string[]) =>
  /\.(svc|cluster\.local)$/.test(host) || noProxy.some((n) => (n.startsWith('.') ? host.endsWith(n) : host === n));

/**
 * May the gateway reach this provider? In-cluster names are reached directly (they are on the
 * gateway's NO_PROXY); every other host leaves through the egress proxy and must be on its filter.
 */
export function providerEgress(p: Preset, apiBase: string | undefined, allow: string[], noProxy: string[] = noProxyList()): EgressVerdict {
  const base = (apiBase ?? '').trim() || p.defaultApiBase || '';
  const host = base ? egressHost(base) : (p.defaultHost ?? '');
  if (!host) {
    return { ok: false, host: '', guidance: 'Give the provider\'s base URL, so its host can be checked against the egress allowlist.' };
  }
  if (isHardDeniedTarget(base || host) || host === 'localhost') {
    return { ok: false, host, guidance: `${host} is a loopback or metadata address. The gateway runs in its own pod: use the provider's Service name or its real host.` };
  }
  if (PRIVATE.test(host)) {
    return { ok: false, host, guidance: `${host} is a private network address. The egress proxy does not route private ranges; expose the server as a Service in the cluster (for example http://ollama:11434) and use that name.` };
  }
  if (bypassesProxy(host, noProxy)) return { ok: true, host, route: 'in-cluster' };
  if (!host.includes('.')) {
    return { ok: false, host, guidance: `${host} looks like an in-cluster Service, but the gateway would send it to the egress proxy. Use its full name (${host}.<namespace>.svc), or add it to llmProviders.noProxy in the deployment values and upgrade.` };
  }
  if (onList(host, allow)) return { ok: true, host, route: 'egress-proxy' };
  return {
    ok: false, host,
    guidance: `${host} is not on the egress allowlist, so the gateway cannot reach it. An operator adds it to llmProviders.allowHosts in the deployment values and upgrades:\n  llmProviders:\n    allowHosts:\n      - ${host}\nthen run this step again. (The allowlist is reviewed deployment config; it cannot be changed from this page.)`,
  };
}

// ------------------------------------------------------------------------- errors --

/** One clear sentence for a LiteLLM / provider error. Never a stack trace. */
export function explainGatewayError(raw: string): string {
  const text = String(raw ?? '');
  const first = text.split(/\nstack trace:|\nTraceback/)[0].split('\n')[0].trim();
  if (/AuthenticationError|invalid[_ ]api[_ ]key|Incorrect API key|invalid subscription key|\b401\b/i.test(text)) {
    return 'The provider rejected the API key. Check the key (for Azure: that it belongs to this resource), save the connection again and test.';
  }
  if (/Filtered|tinyproxy|Forbidden by|ProxyError|Tunnel connection failed|407 Proxy/i.test(text)) {
    return 'The egress proxy blocked this host: it is not on the egress allowlist. An operator adds it to llmProviders.allowHosts and upgrades.';
  }
  if (/NotFound|DeploymentNotFound|\b404\b|model .*not found/i.test(text)) {
    return 'The provider says this model or deployment was not found. Check the model name (for Azure: the deployment name and the API version).';
  }
  if (/Connection error|ConnectError|Name or service not known|nodename nor servname|timed out|Timeout|ECONNREFUSED/i.test(text)) {
    return 'The gateway could not reach the provider at that address. Check the base URL; an external host must also be on the egress allowlist.';
  }
  return `LiteLLM: ${first.slice(0, 300) || 'the provider returned an error'}`;
}

// --------------------------------------------------------------------- flow steps --

export type StepResult<T = Record<string, unknown>> =
  | ({ ok: true } & T)
  | { ok: false; status: number; code: string; message: string; host?: string; guidance?: string };

const refuse = (status: number, code: string, message: string, extra: Record<string, string> = {}): StepResult<never> =>
  ({ ok: false, status, code, message, ...extra });

function resolveProvider(p: Preset, provider?: string): string | null {
  return p.litellmProvider ?? ((provider ?? '').trim() || null);
}

/** LiteLLM's own provider catalogue (id, display name, the fields it needs). */
export async function providerCatalog(io: GatewayIo = realIo): Promise<StepResult<{ providers: { id: string; label: string; fields: unknown[] }[] }>> {
  const r = await io.get<{ litellm_provider?: string; provider_display_name?: string; credential_fields?: unknown[] }[]>('/public/providers/fields', 5000);
  if (!r.ok) return refuse(502, 'gateway_unreachable', `Could not read LiteLLM's provider list (${r.error}).`);
  const providers = (Array.isArray(r.data) ? r.data : [])
    .filter((x) => typeof x.litellm_provider === 'string')
    .map((x) => ({ id: x.litellm_provider as string, label: x.provider_display_name ?? (x.litellm_provider as string), fields: x.credential_fields ?? [] }));
  return { ok: true, providers };
}

export type ConnectInput = ConnectionInput & { preset: string; name: string; provider?: string };

/** Step 2: egress check, then LiteLLM `POST /credentials`. Nothing is stored when a check fails. */
export async function connectProvider(input: ConnectInput, io: GatewayIo = realIo): Promise<StepResult<{ name: string; provider: string; host: string; route: string }>> {
  const p = presetById(input.preset);
  if (!p) return refuse(400, 'unknown_preset', `Unknown provider type "${input.preset}".`);
  const name = (input.name ?? '').trim();
  if (!validCredentialName(name)) return refuse(400, 'bad_name', 'A connection name is lower-case letters, digits and dashes (e.g. azure-prod).');
  const provider = resolveProvider(p, input.provider);
  if (!provider) return refuse(400, 'no_provider', 'Pick the LiteLLM provider for this connection.');
  if (p.id === 'litellm') {
    const cat = await providerCatalog(io);
    if (!cat.ok) return cat;
    if (!cat.providers.some((x) => x.id === provider)) return refuse(400, 'unknown_provider', `LiteLLM does not list a provider "${provider}".`);
  }
  let values: Record<string, string>;
  try { values = credentialValues(p, input); } catch (e) { return refuse(400, 'missing_field', (e as Error).message); }
  const egress = providerEgress(p, values.api_base, egressAllowlist());
  if (!egress.ok) {
    return refuse(422, 'egress_not_allowed', `The gateway may not reach ${egress.host || 'this provider'}.`, { host: egress.host, guidance: egress.guidance ?? '' });
  }
  const r = await io.post('/credentials', {
    credential_name: name,
    credential_info: { custom_llm_provider: provider, os_preset: p.id },
    credential_values: values,
  }, 8000);
  if (!r.ok) return refuse(502, 'gateway_error', `LiteLLM did not store the connection: ${explainGatewayError(r.error)}`);
  return { ok: true, name, provider, host: egress.host, route: egress.route ?? '' };
}

export type Connection = { name: string; provider: string; preset: string; apiBase: string; apiVersion: string; hasKey: boolean };

/** The connections LiteLLM holds. The key is never part of the result (LiteLLM masks it; we drop it). */
export async function listConnections(io: GatewayIo = realIo): Promise<StepResult<{ connections: Connection[] }>> {
  const r = await io.get<{ credentials?: { credential_name?: string; credential_info?: Record<string, unknown>; credential_values?: Record<string, unknown> }[] }>('/credentials', 5000);
  if (!r.ok) return refuse(502, 'gateway_unreachable', `Could not read LiteLLM's connections (${r.error}).`);
  const connections = (r.data?.credentials ?? [])
    .filter((c) => typeof c.credential_name === 'string')
    .map((c) => ({
      name: c.credential_name as string,
      provider: String(c.credential_info?.custom_llm_provider ?? ''),
      preset: String(c.credential_info?.os_preset ?? ''),
      apiBase: String(c.credential_values?.api_base ?? ''),
      apiVersion: String(c.credential_values?.api_version ?? ''),
      hasKey: Boolean(c.credential_values?.api_key),
    }));
  return { ok: true, connections };
}

export type TestInput = { preset: string; provider?: string; connection?: string; model: string; mode?: 'chat' | 'embedding';
  /** Raw params straight to LiteLLM (used by the e2e negative twin only; never exposed by a route). */
  raw?: Record<string, string> };

/** Step 4: LiteLLM's own connection test, with the stored credential. */
export async function testProviderConnection(input: TestInput, io: GatewayIo = realIo): Promise<StepResult<{ model: string }>> {
  const p = presetById(input.preset);
  if (!p) return refuse(400, 'unknown_preset', `Unknown provider type "${input.preset}".`);
  const provider = resolveProvider(p, input.provider);
  if (!provider) return refuse(400, 'no_provider', 'Pick the LiteLLM provider.');
  let model: string;
  try { model = modelString(provider, input.model); } catch (e) { return refuse(400, 'missing_field', (e as Error).message); }
  if (!input.raw && !validCredentialName(input.connection ?? '')) return refuse(400, 'bad_name', 'Choose the connection to test.');
  const litellm_params = input.raw ? { model, ...input.raw } : { model, litellm_credential_name: input.connection };
  const r = await io.post<{ status?: string; result?: { error?: string } }>('/health/test_connection', { litellm_params, mode: input.mode ?? 'chat' }, 60_000);
  if (!r.ok) return refuse(502, 'gateway_error', explainGatewayError(r.error));
  if (r.data?.status !== 'success') return refuse(200, 'test_failed', explainGatewayError(r.data?.result?.error ?? ''));
  return { ok: true, model };
}

export type RegisterInput = { preset: string; provider?: string; connection: string; model: string; alias: string; mode?: 'chat' | 'embedding';
  /** Token prices per 1M tokens (the price book's currency). Without them LiteLLM books an unknown model at 0. */
  inputPerM?: number | null; outputPerM?: number | null };

/**
 * Step 5: LiteLLM `POST /model/new`, by credential name, into the access group the shared agent key
 * holds — so assistants and agents can call it without a values edit. Durable: LiteLLM's database.
 */
export async function registerProviderModel(input: RegisterInput, io: GatewayIo = realIo): Promise<StepResult<{ alias: string; model: string }>> {
  const p = presetById(input.preset);
  if (!p) return refuse(400, 'unknown_preset', `Unknown provider type "${input.preset}".`);
  const provider = resolveProvider(p, input.provider);
  if (!provider) return refuse(400, 'no_provider', 'Pick the LiteLLM provider.');
  const alias = (input.alias ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(alias)) return refuse(400, 'bad_alias', 'The alias is what roles and agents pick: letters, digits, dot, dash, colon.');
  if (alias.startsWith('sovereign-')) return refuse(409, 'reserved_alias', '"sovereign-*" aliases are set by the deployment (the role defaults); choose another alias.');
  if (!validCredentialName(input.connection ?? '')) return refuse(400, 'bad_name', 'Choose the connection this model uses.');
  let model: string;
  let costs: { input_cost_per_token?: number; output_cost_per_token?: number };
  try {
    model = modelString(provider, input.model);
    const inC = perTokenCost(input.inputPerM, 'Input price');
    const outC = perTokenCost(input.outputPerM, 'Output price');
    // LiteLLM "Custom pricing": in litellm_params (1.109.1 drops them from model_info on /model/new).
    costs = { ...(inC !== undefined ? { input_cost_per_token: inC } : {}), ...(outC !== undefined ? { output_cost_per_token: outC } : {}) };
  } catch (e) { return refuse(400, 'missing_field', (e as Error).message); }
  const r = await io.post('/model/new', {
    model_name: alias,
    litellm_params: { model, litellm_credential_name: input.connection, ...costs },
    model_info: { mode: input.mode ?? 'chat', access_groups: [accessGroup()], os_preset: p.id },
  }, 8000);
  if (!r.ok) return refuse(502, 'gateway_error', `LiteLLM did not register the model: ${explainGatewayError(r.error)}`);
  return { ok: true, alias, model };
}

// ----------------------------------------------------------------- model suggestions --

type CostMap = Record<string, { litellm_provider?: string; mode?: string; input_cost_per_token?: number; output_cost_per_token?: number }>;
let costMapCache: { at: number; data: CostMap } | null = null;

/**
 * Step 3: models LiteLLM knows for a provider (its own price map). Only for providers whose model
 * names are global (Mistral, any LiteLLM provider). Azure deployments, Ollama tags and the models of an
 * OpenAI-compatible server belong to the operator: there the list is empty and the field is free text.
 */
export async function modelSuggestions(presetId: string, provider: string | undefined, io: GatewayIo = realIo): Promise<StepResult<{ models: { id: string; mode: string; priced: boolean }[]; freeText: boolean }>> {
  const p = presetById(presetId);
  if (!p) return refuse(400, 'unknown_preset', `Unknown provider type "${presetId}".`);
  const prov = resolveProvider(p, provider);
  if (!prov || !(p.id === 'mistral' || p.id === 'litellm')) return { ok: true, models: [], freeText: true };
  if (!costMapCache || Date.now() - costMapCache.at > 600_000) {
    const r = await io.get<CostMap>('/public/litellm_model_cost_map', 10_000);
    if (!r.ok) return refuse(502, 'gateway_unreachable', `Could not read LiteLLM's model list (${r.error}).`);
    costMapCache = { at: Date.now(), data: r.data ?? {} };
  }
  const models = Object.entries(costMapCache.data)
    .filter(([, v]) => v && v.litellm_provider === prov && (v.mode === 'chat' || v.mode === 'embedding'))
    .map(([k, v]) => ({ id: k.startsWith(`${prov}/`) ? k.slice(prov.length + 1) : k, mode: String(v.mode), priced: typeof v.input_cost_per_token === 'number' }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return { ok: true, models, freeText: true };
}

// ------------------------------------------------------------------ migration (dry run) --

export type MigrationRow = {
  model: string; id: string; seeded: boolean; provider: string; host: string;
  egress: 'allowed' | 'blocked' | 'in-cluster' | 'unknown';
  inGroup: boolean;
  /** The /model/update this row WOULD get. null = nothing to change (or chart-owned). */
  update: { endpoint: '/model/update'; payload: { model_info: { id: string; access_groups: string[] } } } | null;
};
export type MigrationPlan = { dryRun: true; group: string; rows: MigrationRow[]; blockedHosts: string[] };

const DEFAULT_HOSTS: Record<string, string> = { mistral: 'api.mistral.ai', openai: 'api.openai.com', anthropic: 'api.anthropic.com' };

/** PURE: what moving every model behind the egress proxy and into the access group would mean. */
export function planProviderMigration(rows: LiteLlmModelRow[], allow: string[], group: string, noProxy: string[] = noProxyList()): MigrationPlan {
  const out: MigrationRow[] = [];
  for (const r of rows) {
    const params = (r.litellm_params ?? {}) as { model?: string; api_base?: string };
    const info = (r.model_info ?? {}) as { id?: string; db_model?: boolean; access_groups?: string[] };
    const provider = (params.model ?? '').includes('/') ? (params.model as string).split('/')[0] : 'unknown';
    const base = String(params.api_base ?? '');
    const host = base && !base.startsWith('os.environ/') ? egressHost(base) : (base ? '' : DEFAULT_HOSTS[provider] ?? '');
    let egress: MigrationRow['egress'] = 'unknown';
    if (host) {
      if (bypassesProxy(host, noProxy)) egress = 'in-cluster';
      else egress = onList(host, allow) ? 'allowed' : 'blocked';
    }
    const groups = Array.isArray(info.access_groups) ? info.access_groups : [];
    const seeded = info.db_model !== true;
    const inGroup = groups.includes(group);
    out.push({
      model: String(r.model_name ?? ''), id: String(info.id ?? ''), seeded, provider, host, egress, inGroup,
      update: !seeded && !inGroup && info.id
        ? { endpoint: '/model/update', payload: { model_info: { id: info.id, access_groups: [...groups, group] } } }
        : null,
    });
  }
  const blockedHosts = [...new Set(out.filter((r) => r.egress === 'blocked').map((r) => r.host))].sort();
  return { dryRun: true, group, rows: out, blockedHosts };
}

/** The dry run against the live gateway. Reads `/model/info`; writes nothing. */
export async function readProviderMigration(io: GatewayIo = realIo): Promise<StepResult<{ plan: MigrationPlan }>> {
  const r = await io.models();
  if (!r.ok) return refuse(502, 'gateway_unreachable', `Could not read LiteLLM's models (${r.error}).`);
  return { ok: true, plan: planProviderMigration(r.data, egressAllowlist(), accessGroup()) };
}
