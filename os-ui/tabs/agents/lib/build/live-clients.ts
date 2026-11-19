/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { opaHeaders } from '@core/adapters/opa/client';
import 'server-only';
import { config } from '@core/kernel/config';
import { publishOpa } from '@core/policy/opa-publish';
import { mergeRequiresApproval } from '@tabs/agents/lib/build/opa-state';
import { recentTraces } from '@core/infra/agent-governed';
import { deploymentKek, durableSystemKeyStore } from '@core/infra/agent-system-keys';
import { roleModel } from '@core/models/roles';
import { type Decision } from '@tabs/agents/lib/gateway';
import {
  type LangfuseClient,
  type LiteLlmClient,
  type LiteLlmKeyInput,
  type LiveDeps,
  type OpaClient,
  parseGatewayFallbacks,
} from '@tabs/agents/lib/build/live';

/**
 * The REAL fetch-backed clients for the live Build adapters. Server-only: they
 * use `config` (credentials, in-cluster Service URLs) and never reach the browser.
 * Kept separate from the PURE `live.ts` adapter logic so the adapters stay
 * unit-testable against fakes; these thin wrappers are exercised by the kind gate.
 *
 * Failure posture: a network/HTTP failure surfaces as a thrown error or a falsy
 * result so the adapter's apply/verify reports ✗ honestly — Build never claims ✓
 * without a passing probe.
 */

async function withTimeout(
  url: string,
  init: RequestInit,
  ms = 4000,
  fetchImpl: typeof fetch = fetch,
): Promise<Response | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetchImpl(url, { ...init, signal: ctrl.signal, cache: 'no-store' });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------- OPA ------

export function realOpa(): OpaClient {
  return {
    async putGrants(principal, tools) {
      // Through the one OPA publisher. The same grants are composed into the whole `grants`
      // document by the agents grant contributor (`opa-state.ts`), so a recompile or an OPA
      // restart restores them.
      const r = await publishOpa({ kind: 'data', path: `grants/${encodeURIComponent(principal)}`, value: tools }, 4000);
      if (!r.ok) throw new Error(`OPA putGrants failed — ${r.detail}`);
    },
    async mergeRequiresApproval(tools) {
      const r = await mergeRequiresApproval(tools);
      if (!r.ok) throw new Error(`OPA mergeRequiresApproval failed — ${r.detail}`);
    },
    async decision(principal, tool): Promise<Decision> {
      const res = await withTimeout(`${config.opaUrl}/v1/data/agentic/authz/decision`, {
        method: 'POST',
        headers: opaHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ input: { principal, tool } }),
      });
      if (!res || !res.ok) throw new Error(`OPA decision failed (${res?.status ?? 'unreachable'})`);
      const d = (await res.json().catch(() => ({}))) as { result?: { effect?: Decision['effect']; reason?: string } };
      const effect = d.result?.effect ?? 'deny';
      return { effect, reason: d.result?.reason ?? '' };
    },
  };
}

// ------------------------------------------------------------------ LiteLLM ------

/**
 * The LiteLLM key properties Build sets — shared by `/key/generate` and `/key/update`.
 * `budget_duration` makes `max_budget` a resetting window ("7d" = weekly). It is sent as `null`
 * when the cap is configured as a lifetime one, so an update can also turn the reset OFF.
 * `metadata.os_owner` / `os_id` are the ownership stamp the gateway mirror reads back
 * (`tabs/admin/lib/gateway-mirror.ts` `ownerOf`), so the key shows as an agent's key in the Admin view.
 */
function keyProperties(input: LiteLlmKeyInput): Record<string, unknown> {
  return {
    models: input.models,
    max_budget: input.maxBudget,
    budget_duration: input.budgetDuration || null,
    rpm_limit: input.rpmLimit,
    tpm_limit: input.tpmLimit,
    max_parallel_requests: input.maxParallelRequests,
    metadata: { os_owner: 'agent', os_id: input.systemId, allowed_tools: input.allowedTools, model_max_budget: input.modelMaxBudget },
  };
}

type KeyListRow = {
  token?: unknown;
  key_alias?: unknown;
  models?: unknown;
  max_budget?: unknown;
  budget_duration?: unknown;
  rpm_limit?: unknown;
  tpm_limit?: unknown;
  max_parallel_requests?: unknown;
  metadata?: { allowed_tools?: unknown } | null;
};

const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

/**
 * The key-provisioning client. Every call here is an ADMIN call with the master key, made from the
 * server-side Build path only (this module is `server-only`; the worker pod that executes runs is
 * not given the master key at all). A key is addressed by its TOKEN ID (the SHA-256 of its value,
 * which LiteLLM accepts wherever it accepts a key) — the value itself is sent exactly once, in the
 * `/key/generate` that registers it, and is never logged or put in an error message.
 */
export function realLitellm(): LiteLlmClient {
  const master = config.litellmMasterKey;
  const bearer = { authorization: `Bearer ${master}`, 'content-type': 'application/json' };
  const post = async (path: string, body: unknown, what: string): Promise<void> => {
    const res = await withTimeout(`${config.litellmUrl}${path}`, { method: 'POST', headers: bearer, body: JSON.stringify(body) }, 8000);
    if (!res || !res.ok) throw new Error(`LiteLLM ${path} failed (${res?.status ?? 'unreachable'}) — ${what}`);
  };
  return {
    async keysByAlias(alias) {
      // `/key/list` matches `key_alias` exactly; the rows are filtered here as well, so a gateway
      // version that ignores the filter cannot hand back somebody else's key.
      const res = await withTimeout(
        `${config.litellmUrl}/key/list?key_alias=${encodeURIComponent(alias)}&return_full_object=true&include_team_keys=true&size=100`,
        { method: 'GET', headers: bearer },
        8000,
      );
      if (!res || !res.ok) throw new Error(`LiteLLM /key/list failed (${res?.status ?? 'unreachable'}) — could not check the key '${alias}', nothing was changed`);
      const body = (await res.json().catch(() => null)) as { keys?: unknown } | unknown[] | null;
      const rows = (Array.isArray(body) ? body : Array.isArray((body as { keys?: unknown })?.keys) ? (body as { keys: unknown[] }).keys : []) as KeyListRow[];
      return rows
        .filter((r) => r && typeof r === 'object' && r.key_alias === alias && typeof r.token === 'string' && r.token.length > 0)
        .map((r) => {
          const tools = r.metadata?.allowed_tools;
          return {
            tokenId: String(r.token),
            models: Array.isArray(r.models) ? r.models.filter((m): m is string => typeof m === 'string') : [],
            maxBudget: num(r.max_budget),
            budgetDuration: typeof r.budget_duration === 'string' ? r.budget_duration : '',
            rpmLimit: num(r.rpm_limit),
            tpmLimit: num(r.tpm_limit),
            maxParallelRequests: num(r.max_parallel_requests),
            // Absent metadata reads as "not reported" (no drift), never as an empty allowlist.
            allowedTools: Array.isArray(tools) ? tools.filter((t): t is string => typeof t === 'string') : undefined,
          };
        });
    },
    async generateKey(input: LiteLlmKeyInput, key: string) {
      // NOTE: `model_max_budget` (per-model cost cap) is a LiteLLM ENTERPRISE
      // feature — open-source LiteLLM 500s if it is set. We therefore enforce the
      // overall key spend cap (`max_budget`, OSS) here; the per-model STACKIT caps
      // are applied via the chart only where an enterprise license is present.
      await post(
        '/key/generate',
        { key, key_alias: input.alias, ...keyProperties(input) },
        'the key was not created (a 403 here means the gateway setting "disable custom API keys" is on; the OS supplies its own random key value and needs it off)',
      );
    },
    async updateKey(tokenId: string, input: LiteLlmKeyInput) {
      // The SAME properties as the create path (`keyProperties`), so the two can never disagree —
      // the rule the chart's key-init Job follows for the shared agent key.
      await post('/key/update', { key: tokenId, ...keyProperties(input) }, 'the key keeps its previous limits');
    },
    async deleteKey(tokenId: string) {
      await post('/key/delete', { keys: [tokenId] }, 'the old key was not removed');
    },
    async models() {
      const res = await withTimeout(`${config.litellmUrl}/v1/models`, { method: 'GET', headers: bearer });
      if (!res || !res.ok) return [];
      const d = (await res.json().catch(() => ({}))) as { data?: { id?: string }[] };
      return (d.data ?? []).map((m) => String(m.id ?? '')).filter(Boolean);
    },
  };
}

// ----------------------------------------------------------------- Langfuse ------

export function realLangfuse(): LangfuseClient {
  return {
    async ensureProject() {
      // The default Langfuse project is provisioned by the chart (langfuseInit);
      // traces are tagged per system, so there is no per-system project to create.
    },
    async tracesFor(principal) {
      // Authoritative: the os-ui in-process trace ring (every governed tool call
      // lands here synchronously). Langfuse remote is the durable async mirror, so
      // we don't depend on its eventual-consistency ingestion for the Build probe.
      const ring = recentTraces(200).filter((t) => t.principal === principal).length;
      if (ring > 0) return ring;
      // Fallback: best-effort remote read (covers a fresh process with no ring).
      const auth = 'Basic ' + Buffer.from(`${config.langfusePublicKey}:${config.langfuseSecretKey}`).toString('base64');
      const res = await withTimeout(`${config.langfuseUrl}/api/public/traces?limit=50`, {
        method: 'GET',
        headers: { authorization: auth, accept: 'application/json' },
      });
      if (!res || !res.ok) return 0;
      const d = (await res.json().catch(() => ({}))) as { data?: { metadata?: { principal?: string } }[] };
      return (d.data ?? []).filter((t) => t?.metadata?.principal === principal).length;
    },
  };
}

/**
 * Can we READ traces back from the durable Langfuse store? The trace query API is
 * clickhouse-backed, so this returns false when clickhouse is down — even though
 * ingestion (langfuse-web) may still accept writes. The Run panel uses this to
 * decide between an honest "in-run steps" note and a live "full trace" deep-link,
 * so it never shows a dead "(no trace appeared)".
 */
export async function traceStoreReachable(): Promise<boolean> {
  const auth = 'Basic ' + Buffer.from(`${config.langfusePublicKey}:${config.langfuseSecretKey}`).toString('base64');
  const res = await withTimeout(
    `${config.langfuseUrl}/api/public/traces?limit=1`,
    { method: 'GET', headers: { authorization: auth, accept: 'application/json' } },
    2500,
  );
  return Boolean(res && res.ok);
}

/**
 * Is the model gateway's ADMIN API reachable — i.e. is a cluster up? This is the switch
 * between the LIVE Build adapters (which mint the system's scoped LiteLLM key and probe OPA)
 * and the in-process teaching MOCK, honestly labelled either way.
 *
 * A5: this used to probe the Python `agent-runtime` `/health`. That runtime is gone, and the
 * dependency Build genuinely cannot fake is the gateway — the key it provisions is the thing a
 * later run actually uses. The graph step no longer needs a cluster at all: it compiles the
 * StateGraph in this process.
 */
export async function gatewayAdminReachable(): Promise<boolean> {
  const res = await withTimeout(`${config.litellmUrl}/health/readiness`, { method: 'GET' }, 2500);
  return Boolean(res && res.ok);
}

/** Assemble the real client set for the live Build adapters (server boundary). */
export function makeRealClients(): LiveDeps {
  return {
    opa: realOpa(),
    litellm: realLitellm(),
    langfuse: realLangfuse(),
    // The key Build mints is kept encrypted in the durable store both os-ui and the worker read.
    keys: { store: durableSystemKeyStore, kek: () => deploymentKek() },
    // The caps of a system's own key come from deployment config, not from a constant in the adapter.
    caps: { ...config.agentSystemKey, modelMaxBudget: {} },
    // The models a run picks by ROLE, and the gateway's fallback targets — both must be on the key.
    runModels: () => [roleModel('reasoning'), roleModel('tools')],
    fallbacks: parseGatewayFallbacks(config.agentSystemKeyFallbacksJson),
  };
}
