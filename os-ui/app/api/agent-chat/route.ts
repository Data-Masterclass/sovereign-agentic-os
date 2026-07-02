/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { config } from '@/lib/config';
import { contextForAgentKey, tabForAgentKey } from '@/lib/tabs/context';
import { currentUser } from '@/lib/auth';
import { runTabAgent, renderAssistantText } from '@/lib/assistant/runtime';

export const dynamic = 'force-dynamic';

// Ceiling on the LiteLLM round-trip: a slow model gets room to answer, but a
// wedged one returns a clear 504 instead of hanging the request (and the client
// spinner) forever. Override via LLM_CHAT_TIMEOUT_MS.
const CHAT_TIMEOUT_MS = Number(process.env.LLM_CHAT_TIMEOUT_MS ?? '') || 90_000;

/**
 * Task-scoped agent chat -> LiteLLM. Every "agent" surface in the OS UI (the
 * agent builder, software builder, per-data-product dbt assistant, knowledge
 * agent, connections agent) is the SAME reusable <AgentChat> client posting
 * here with a different `agent` key. We map the key to a server-side system
 * prompt and forward the conversation to the governed LiteLLM gateway
 * (POST /v1/chat/completions, Bearer master key). The key + prompt never
 * reach the browser; only the assistant's text comes back.
 *
 * The offline default model is the deterministic `sovereign-mock`, which
 * echoes its grounded context rather than reasoning — so answers look canned
 * until LiteLLM is pointed at a real model (no UI change needed).
 */

type Role = 'system' | 'user' | 'assistant';
type Msg = { role: Role; content: string };

// Per-task system prompts. Kept server-side so the framing is governed.
const SYSTEM_PROMPTS: Record<string, string> = {
  'agent-builder': [
    'You are the Agent Builder for the Sovereign Agentic OS. You help a',
    'non-engineer design a LangGraph multi-agent system that runs on the',
    'platform (LangGraph runtime, LiteLLM model+MCP gateway, OPA tool policy,',
    'Langfuse tracing). For each request, propose: (1) the agents/nodes and',
    'their roles, (2) the graph edges / control flow, (3) the tools each node',
    'needs (from the governed MCP gateway) and the OPA grants required,',
    '(4) the shared state. Then output a concise spec the platform can',
    'scaffold. Be explicit that codegen + deploy is a draft/plan for review,',
    'not a live deployment.',
  ].join(' '),
  'software-builder': [
    'You are the Software Builder for the Sovereign Agentic OS. You help a user',
    'scaffold a new application that will live in Forgejo (sovereign Git) and',
    'ship via Forgejo Actions CI -> Argo CD. For each request, propose the repo',
    'name, language/framework, a starter file layout, the Dockerfile, the',
    '.forgejo/workflows/ci.yml steps, and the k8s manifest Argo will sync.',
    'Keep it minimal and runnable. Make clear the actual repo creation happens',
    'when the user clicks "Create repo" — your output is the plan/scaffold.',
  ].join(' '),
  'software-app': [
    'You are the per-app build assistant (OpenCode) for one application in the',
    'Sovereign Agentic OS Software tab, routed via the governed LiteLLM gateway.',
    'You scaffold and evolve a Next.js + Supabase app and commit to its own',
    'Forgejo repo; it ships via Forgejo Actions -> Harbor -> Argo CD to a live',
    'subdomain. Hold the app full context (design decisions, data model, docs).',
    'When you make a design decision or change the data model, state it explicitly',
    'so it can be captured under the app. Keep output concrete and runnable; note',
    'that codegen + deploy is a draft for review, not a live deployment. NOTE: the',
    'live per-app chat posts to /api/apps/{id}/chat where this prompt is rebuilt',
    "from that app's saved context and the conversation is persisted under it.",
  ].join(' '),
  'data-product': [
    'You are the Data Product agent for the Sovereign Agentic OS, scoped to one',
    'data product. You help define dbt transformations over governed Iceberg',
    'tables (raw -> staging -> mart). For each request, propose the dbt model',
    'SQL, the model materialization (view/table/incremental), dbt tests',
    '(not_null, unique, relationships, accepted_values), and how it registers',
    'as a data product in OpenMetadata. Output runnable dbt SQL + a schema.yml',
    'snippet. Note the model is a draft for review before it runs in Dagster.',
  ].join(' '),
  knowledge: [
    'You are the Knowledge Agent for the Sovereign Agentic OS. You help a',
    'domain expert capture a business WORKFLOW as a structured markdown',
    'knowledge file with exactly three sections: "## 1. The workflow,',
    'step by step", "## 2. Rules and decisions", and "## 3. Tacit business',
    'context". You may also capture domain-level context. Ask focused',
    'questions to fill gaps, then produce clean, well-structured markdown',
    'under those three headings. Keep it factual and specific to the domain.',
    'When the user is ready, output the full markdown document.',
  ].join(' '),
  connections: [
    'You are the Connections Agent for the Sovereign Agentic OS. You help a',
    'user build a connector to an external source (e.g. OneDrive, a Postgres',
    'database, a REST/GraphQL API). For each request, propose: the connector',
    'type, the required credentials (which go to the secrets store, never the',
    'browser), a draft connector config (YAML/JSON), and any polling/ingest',
    'schedule. Output a concrete config the platform can use to scaffold the',
    'connector. Be clear that building/registering the connection is a',
    'scaffold for review, not a live connection yet.',
  ].join(' '),
};

const FALLBACK_PROMPT =
  'You are a helpful assistant inside the Sovereign Agentic OS. Be concise and practical.';

export async function POST(req: Request) {
  let agent = '';
  let messages: Msg[] = [];
  try {
    const body = await req.json();
    agent = (body?.agent ?? '').toString();
    messages = Array.isArray(body?.messages) ? body.messages : [];
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const clean = messages
    .filter(
      (m) =>
        m &&
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string' &&
        m.content.trim().length > 0,
    )
    .slice(-20)
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content.trim() }));

  if (clean.length === 0) {
    return NextResponse.json({ error: 'No message to send' }, { status: 400 });
  }

  // AGENTIC PATH: when this helper's key maps to a tab with an MCP tool surface,
  // run the shared PLAN → ACT harness under the user's delegated identity so the
  // helper actually CALLS its tab's governed tools (query data, predict, search
  // knowledge, list systems, build software) instead of only chatting. Every tool
  // call routes through the same governed dispatch (OPA + role gate + Langfuse).
  const tab = tabForAgentKey(agent);
  if (tab) {
    const user = await currentUser();
    if (!user) {
      return NextResponse.json({ error: 'Sign in to use this assistant.' }, { status: 401 });
    }
    try {
      const result = await runTabAgent({ user, tab, messages: clean });
      return NextResponse.json({
        role: 'assistant',
        content: renderAssistantText(result),
        model: config.litellmExecModel,
      });
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        return NextResponse.json(
          { error: 'The model did not respond in time — it may still be warming up. Try again in a few seconds.' },
          { status: 504 },
        );
      }
      return NextResponse.json(
        { error: `The assistant could not complete the request: ${(e as Error).message}` },
        { status: 502 },
      );
    }
  }

  // PLAIN PATH (keys with no tool surface, e.g. connections): ground the helper in
  // its tab's CONTEXT.md (tools, golden path, constraints) so answers match the
  // real, governed environment the user builds in.
  const base = SYSTEM_PROMPTS[agent] ?? FALLBACK_PROMPT;
  const tabContext = contextForAgentKey(agent);
  const system = tabContext
    ? `${base}\n\n--- TAB BUILD CONTEXT (authoritative environment reference) ---\n${tabContext}`
    : base;
  const payload = {
    model: config.litellmChatModel,
    messages: [{ role: 'system', content: system }, ...clean],
    temperature: 0.2,
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CHAT_TIMEOUT_MS);
  try {
    const res = await fetch(`${config.litellmUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.litellmMasterKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(payload),
      cache: 'no-store',
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      return NextResponse.json(
        { error: `LiteLLM ${res.status}: ${text.slice(0, 300)}` },
        { status: 502 },
      );
    }
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(text);
    } catch {
      return NextResponse.json(
        { error: `LiteLLM returned non-JSON: ${text.slice(0, 200)}` },
        { status: 502 },
      );
    }
    const choices = (data?.choices ?? []) as Array<Record<string, unknown>>;
    const message = (choices[0]?.message ?? {}) as Record<string, unknown>;
    const content = String(message?.content ?? '').trim();
    return NextResponse.json({
      role: 'assistant',
      content: content || '(the model returned no content)',
      model: String(data?.model ?? config.litellmChatModel),
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      return NextResponse.json(
        { error: 'The model did not respond in time — it may still be warming up. Try again in a few seconds.' },
        { status: 504 },
      );
    }
    return NextResponse.json(
      { error: `Could not reach LiteLLM: ${(e as Error).message}` },
      { status: 502 },
    );
  } finally {
    clearTimeout(timer);
  }
}
