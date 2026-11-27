/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { NextResponse } from 'next/server';
import { apiError } from '@core/kernel/route-server';
import { roleModel } from '@core/models/roles';
import { contextForAgentKey, tabForAgentKey } from '@core/tabs-meta/context';
import { currentUser } from '@core/kernel/auth';
import { runTabAgent, renderAssistantText, tabToolExecutor } from '@core/runtime/runtime';
import { decideConfirmation } from '@core/runtime/confirm-execute';
import { assistantComplete, AssistantNotConfiguredError } from '@core/runtime/complete';
import { getUserLocale } from '@core/prefs/locale';
import { withAnswerLanguage } from '@core/i18n/answer-language';

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
    'scaffold a new application. There is NO git server and NO CI in the OS: an',
    'app is a spec + design + generated files the OS stores, previews, verifies',
    'and serves after a deploy approval. For each request, propose the app name,',
    'language/framework and a starter file layout. Keep it minimal and runnable.',
    'Make clear the actual app creation happens when the user clicks "Create app"',
    '— your output is the plan/scaffold.',
  ].join(' '),
  'software-app': [
    'You are the per-app build assistant (OpenCode) for one application in the',
    'Sovereign Agentic OS Software tab, routed via the governed LiteLLM gateway.',
    'You scaffold and evolve the app\u2019s generated files, which the OS stores,',
    'previews and (after a deploy approval) serves on a live subdomain. There is',
    'no git server and no CI. Hold the app full context (design decisions, data',
    'model, docs).',
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
    'as a governed data product. Output runnable dbt SQL + a schema.yml',
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
  let conversationId: string | null = null;
  let confirmation: { id: string; conversationId: string; decision: 'confirm' | 'decline' } | null = null;
  try {
    const body = await req.json();
    agent = (body?.agent ?? '').toString();
    messages = Array.isArray(body?.messages) ? body.messages : [];
    // A write the helper wants to make is parked until the user confirms it. The caller may name its
    // conversation; absent or malformed, the turn mints one and returns it.
    if (typeof body?.conversationId === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(body.conversationId)) conversationId = body.conversationId;
    const c = body?.confirmation;
    if (c && typeof c.id === 'string' && typeof c.conversationId === 'string' && (c.decision === 'confirm' || c.decision === 'decline')) {
      confirmation = { id: c.id, conversationId: c.conversationId, decision: c.decision };
    }
  } catch {
    return apiError(400, 'Invalid JSON body', 'request.invalidJson');
  }

  // Confirm or decline a write this helper parked. Same governed dispatch, same user, the stored arguments.
  if (confirmation) {
    const tab = tabForAgentKey(agent);
    const user = await currentUser();
    if (!user) return apiError(401, 'Sign in to use this assistant.', 'agents.chatSignIn');
    if (!tab) return apiError(404, 'Unknown assistant.', 'agents.chatUnknownAssistant');
    const result = await decideConfirmation({
      user,
      confirmationId: confirmation.id,
      conversationId: confirmation.conversationId,
      surface: `tab:${tab}`,
      decision: confirmation.decision,
      execute: (tool, args) => tabToolExecutor(user, tab)(tool, args),
    });
    return NextResponse.json(result, { status: result.status === 'refused' ? (result.code === 'not_found' ? 404 : 409) : 200 });
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
    return apiError(400, 'No message to send', 'agents.chatNoMessage');
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
      return apiError(401, 'Sign in to use this assistant.', 'agents.chatSignIn');
    }
    // The helper answers — and drafts (the knowledge agent's workflow markdown) — in the user's language.
    const locale = await getUserLocale(user.id).catch(() => 'en' as const);
    try {
      const result = await runTabAgent({
        user,
        tab,
        locale,
        messages: clean,
        confirm: { ...(conversationId ? { conversationId } : {}), surface: `tab:${tab}` },
      });
      return NextResponse.json({
        role: 'assistant',
        content: renderAssistantText(result),
        model: roleModel('standard'),
        // Writes parked for the user's OK (empty when none) and the conversation they are bound to.
        pending: result.pending ?? [],
        conversationId: result.conversationId,
      });
    } catch (e) {
      if (e instanceof AssistantNotConfiguredError) {
        return NextResponse.json({ error: e.message }, { status: e.status });
      }
      if ((e as Error).name === 'AbortError') {
        return apiError(504, 'The model did not respond in time — it may still be warming up. Try again in a few seconds.', 'agents.chatModelTimeout');
      }
      return NextResponse.json(
        { error: `The assistant could not complete the request: ${(e as Error).message}` },
        { status: 502 },
      );
    }
  }

  // PLAIN PATH (keys with no tool surface, e.g. connections): ground the helper in
  // its tab's CONTEXT.md (tools, golden path, constraints) so answers match the
  // real, governed environment the user builds in. It runs on the SAME one
  // assistant model as every other built-in assistant, via the governed gateway.
  const base = SYSTEM_PROMPTS[agent] ?? FALLBACK_PROMPT;
  const tabContext = contextForAgentKey(agent);
  const system = tabContext
    ? `${base}\n\n--- TAB BUILD CONTEXT (authoritative environment reference) ---\n${tabContext}`
    : base;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CHAT_TIMEOUT_MS);
  try {
    const user = await currentUser().catch(() => null);
    const locale = user ? await getUserLocale(user.id).catch(() => 'en' as const) : 'en';
    const { content, model } = await assistantComplete(
      withAnswerLanguage([{ role: 'system' as const, content: system }, ...clean], locale, 'chat'),
      { user: user ?? undefined, signal: ctrl.signal },
    );
    return NextResponse.json({
      role: 'assistant',
      content: content || '(the model returned no content)',
      model,
    });
  } catch (e) {
    if (e instanceof AssistantNotConfiguredError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    if ((e as Error).name === 'AbortError') {
      return apiError(504, 'The model did not respond in time — it may still be warming up. Try again in a few seconds.', 'agents.chatModelTimeout');
    }
    return NextResponse.json(
      { error: `Could not reach the assistant model: ${(e as Error).message}` },
      { status: 502 },
    );
  } finally {
    clearTimeout(timer);
  }
}
