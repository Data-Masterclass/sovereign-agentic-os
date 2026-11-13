/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { config } from '@core/kernel/config';
import { recentTraces } from '@core/infra/agent-governed';
import { principalFor } from '@tabs/agents/lib/build/runtime-contract';
import { type Decision } from '@tabs/agents/lib/gateway';
import {
  type LangfuseClient,
  type LiteLlmClient,
  type LiteLlmKeyInput,
  type LiveDeps,
  type OpaClient,
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
  const dataUrl = (path: string) => `${config.opaUrl}/v1/data/${path}`;
  return {
    async putGrants(principal, tools) {
      const res = await withTimeout(dataUrl(`grants/${encodeURIComponent(principal)}`), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(tools),
      });
      if (!res || !res.ok) throw new Error(`OPA putGrants failed (${res?.status ?? 'unreachable'})`);
    },
    async mergeRequiresApproval(tools) {
      // Read-merge-write the global requires_approval list (in-memory data doc).
      // TODO(merge-to-main): this GET→union→PUT is lost-update racy under concurrent
      // builds and is GLOBAL (a tool held for one system is held for all). Acceptable
      // under the locked "OPA grants in-memory for now" decision; move to a
      // per-principal hold document when OPA grants are persisted.
      const cur = await withTimeout(dataUrl('requires_approval'), { method: 'GET' });
      let list: string[] = [];
      if (cur && cur.ok) {
        const d = (await cur.json().catch(() => ({}))) as { result?: unknown };
        if (Array.isArray(d.result)) list = d.result.map(String);
      }
      const merged = [...new Set([...list, ...tools])];
      const res = await withTimeout(dataUrl('requires_approval'), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(merged),
      });
      if (!res || !res.ok) throw new Error(`OPA mergeRequiresApproval failed (${res?.status ?? 'unreachable'})`);
    },
    async decision(principal, tool): Promise<Decision> {
      const res = await withTimeout(`${config.opaUrl}/v1/data/agentic/authz/decision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
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

/** Deterministic per-system virtual key value (kept out of git; derived, not stored). */
function keyValue(alias: string): string {
  return `sk-${alias}`;
}

/**
 * The virtual key value Build mints for one system (`sk-os-<systemId>`). A3: the build route writes it
 * to the secrets store ONCE and persists only the reference on the system record; runs read the
 * value back by reference. Exported for that single caller — never for a run path.
 */
export function agentKeyValue(systemId: string): string {
  return keyValue(principalFor(systemId));
}

export function realLitellm(): LiteLlmClient {
  const master = config.litellmMasterKey;
  const bearer = { authorization: `Bearer ${master}`, 'content-type': 'application/json' };
  return {
    async keyInfo(alias) {
      const res = await withTimeout(`${config.litellmUrl}/key/info?key=${encodeURIComponent(keyValue(alias))}`, {
        method: 'GET',
        headers: bearer,
      });
      if (!res || !res.ok) return null;
      const d = (await res.json().catch(() => null)) as { info?: { models?: string[]; max_budget?: number } } | null;
      if (!d?.info) return null;
      return { models: d.info.models ?? [], maxBudget: d.info.max_budget };
    },
    async generateKey(input: LiteLlmKeyInput) {
      // NOTE: `model_max_budget` (per-model cost cap) is a LiteLLM ENTERPRISE
      // feature — open-source LiteLLM 500s if it is set. We therefore enforce the
      // overall key spend cap (`max_budget`, OSS) here; the per-model STACKIT caps
      // are applied via the chart only where an enterprise license is present.
      const res = await withTimeout(`${config.litellmUrl}/key/generate`, {
        method: 'POST',
        headers: bearer,
        body: JSON.stringify({
          key: keyValue(input.alias),
          key_alias: input.alias,
          models: input.models,
          max_budget: input.maxBudget,
          rpm_limit: input.rpmLimit,
          tpm_limit: input.tpmLimit,
          metadata: { allowed_tools: input.allowedTools, model_max_budget: input.modelMaxBudget },
        }),
      });
      if (!res || !res.ok) throw new Error(`LiteLLM /key/generate failed (${res?.status ?? 'unreachable'})`);
      return { key: keyValue(input.alias) };
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
  };
}
