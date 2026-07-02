/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { config } from '@/lib/config';
import { requireUser } from '@/lib/auth';
import { getAppForUser, saveChat } from '@/lib/apps';
import { runTabAgent, renderAssistantText } from '@/lib/assistant/runtime';

export const dynamic = 'force-dynamic';

type Msg = { role: 'user' | 'assistant'; content: string };

/**
 * The per-app BUILD CHAT (Software golden path §2) — now genuinely AGENTIC. It
 * runs the shared PLAN → ACT → deploy(gated) harness scoped to the `software` MCP
 * tools: it plans with the reasoning tier, then acts with the exec tier, calling
 * the SAME governed pipeline the UI + MCP use — `commit` (scaffold + commit to
 * Forgejo → auto-MCP → CI scan), `start_preview`, and `request_deploy` (which
 * opens the Builder review gate; it never goes live on its own). THIS app's full
 * context (design decisions, data model, docs, repo, and its appId) is injected
 * so the agent builds coherently; the running conversation is persisted under the
 * app (home of record).
 */
function appContext(
  app: {
    id: string;
    name: string;
    template: string;
    subdomain: string;
    repo: { fullName: string };
    designDecisions: string;
    dataDescriptions: string;
    docs: string;
  },
): string {
  return [
    `You are the build assistant for the "${app.name}" application (appId: ${app.id}).`,
    'It is a Next.js + Supabase app that lives in its own Forgejo repo',
    `(${app.repo.fullName}) and ships via Forgejo Actions → Harbor → Argo CD to`,
    `${app.subdomain}. To build: generate the files, then call \`commit\` with THIS`,
    `appId (${app.id}) to write them (re-parsed on every commit), \`start_preview\``,
    'for the private sandbox, and `request_deploy` to open the Builder review gate.',
    'When you make a design decision or change the data model, state it explicitly',
    'so it can be captured under the app.',
    '',
    '## Design decisions',
    app.designDecisions || '(none yet)',
    '',
    '## Data descriptions',
    app.dataDescriptions || '(none yet)',
    '',
    '## Docs',
    app.docs || '(none yet)',
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

  let content = '';
  const model = config.litellmExecModel;
  try {
    const result = await runTabAgent({
      user,
      tab: 'software',
      messages: clean,
      extraContext: appContext(app),
    });
    content = renderAssistantText(result);
  } catch (e) {
    content =
      (e as Error).name === 'AbortError'
        ? '(the build assistant is still warming up — the model did not respond in time. Your message is saved; send it again in a few seconds.)'
        : '(build assistant offline — LiteLLM unreachable. Your message is saved under the app; the design decisions and data model are captured on this page.)';
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
