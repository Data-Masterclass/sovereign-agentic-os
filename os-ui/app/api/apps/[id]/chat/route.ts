/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { config } from '@/lib/config';
import { requireUser } from '@/lib/auth';
import { getAppForUser, saveChat } from '@/lib/apps';

export const dynamic = 'force-dynamic';

type Msg = { role: 'user' | 'assistant'; content: string };

/**
 * The per-app BUILD CHAT (Software golden path §2). This is the dedicated chat
 * for ONE application — the OpenCode coding agent, routed via LiteLLM. It reuses
 * the same governed gateway as `/api/agent-chat`, but the system prompt is built
 * SERVER-SIDE from THIS app's full context (design decisions, data model, docs,
 * repo) so the assistant builds coherently and remembers the app's history. The
 * running conversation is persisted under the app (home of record).
 */
function systemPrompt(app: {
  name: string;
  template: string;
  subdomain: string;
  repo: { fullName: string };
  designDecisions: string;
  dataDescriptions: string;
  docs: string;
}): string {
  return [
    `You are the build assistant for the "${app.name}" application — OpenCode, the`,
    'coding agent behind this one app, routed via the governed LiteLLM gateway.',
    'You scaffold and evolve a Next.js + Supabase app and commit to its own Forgejo',
    `repo (${app.repo.fullName}); it ships via Forgejo Actions -> Harbor -> Argo CD`,
    `to ${app.subdomain}. You hold THIS app's full context below. When you make a`,
    'design decision or change the data model, state it explicitly so it can be',
    'captured under the app. Be concrete and runnable; note that codegen + deploy',
    'is a draft for review, not a live deployment.',
    '',
    '## Design decisions',
    app.designDecisions,
    '',
    '## Data descriptions',
    app.dataDescriptions,
    '',
    '## Docs',
    app.docs,
  ].join('\n');
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let user;
  try {
    user = await requireUser();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 401 });
  }
  const { id } = await ctx.params;

  let messages: Msg[] = [];
  try {
    const body = await req.json();
    messages = Array.isArray(body?.messages) ? body.messages : [];
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  let app;
  try {
    app = await getAppForUser(id, user);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 404 });
  }

  const clean = messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-20)
    .map((m) => ({ role: m.role, content: m.content.trim() }));
  if (clean.length === 0) return NextResponse.json({ error: 'No message to send' }, { status: 400 });

  const payload = {
    model: config.litellmChatModel,
    messages: [{ role: 'system', content: systemPrompt(app) }, ...clean],
    temperature: 0.2,
  };

  let content = '';
  let model = config.litellmChatModel;
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
    });
    const text = await res.text();
    if (res.ok) {
      const data = JSON.parse(text) as Record<string, unknown>;
      const choices = (data?.choices ?? []) as Array<Record<string, unknown>>;
      const message = (choices[0]?.message ?? {}) as Record<string, unknown>;
      content = String(message?.content ?? '').trim();
      model = String(data?.model ?? model);
    } else {
      content = `(build assistant offline — LiteLLM ${res.status}. Your message is saved under the app; design decisions and the data model are captured on this page.)`;
    }
  } catch {
    content =
      '(build assistant offline — LiteLLM unreachable. Your message is saved under the app; the design decisions and data model are captured on this page.)';
  }

  // Persist the running conversation under the app (home of record).
  const persisted: Msg[] = [...clean, { role: 'assistant', content }];
  try {
    await saveChat(id, user, persisted);
  } catch {
    /* persistence best-effort */
  }

  return NextResponse.json({ role: 'assistant', content: content || '(no content)', model });
}
