/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { getAppForUser, listAppFilesForViewer } from '@/lib/software/apps';
import { listConnectionsForUser, callConnectionTool } from '@/lib/connections';
import { pickConnectionForTemplate } from '@/lib/software/design-push';

export const dynamic = 'force-dynamic';

/**
 * Hand the app's code off to the user's OWN governed GitHub connection — NOT a shared
 * service account. The app's source already lives in its sovereign Forgejo repo; this
 * files a governed GitHub tracking issue on the target repo enumerating that repo's
 * file tree + source URL, so a human/CI can pull it in. We are HONEST about the reach
 * of the governed GitHub connector: its write tools are issue/PR/comment (Write-approval),
 * not a raw file-content push — so we do exactly what those governed tools allow and
 * label it truthfully, rather than claim a file push that the connection cannot make.
 *
 * `create_issue` is Write-approval, so the SAME governance gate decides allow / held —
 * we surface that honestly. Honest fallback: no GitHub connection ⇒ "connect GitHub
 * first". Body: { repo: "owner/repo", connectionId? }.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const app = await getAppForUser(id, user);
    const body = (await req.json().catch(() => ({}))) as { repo?: string; connectionId?: string };

    const repo = String(body.repo ?? '').trim();
    if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) {
      return NextResponse.json({ error: 'A target GitHub repo is required as "owner/repo".' }, { status: 400 });
    }

    const visible = await listConnectionsForUser(user);
    const grantedIds = (app.grants?.connections ?? []).map((g) => g.id);
    const chosenId = body.connectionId
      ? visible.find((c) => c.id === body.connectionId && c.template === 'github')?.id ?? null
      : pickConnectionForTemplate('github', grantedIds, visible)?.id ?? null;
    if (!chosenId) {
      return NextResponse.json(
        { error: 'No GitHub connection available. Connect GitHub in Connections first.', connectHref: '/connections' },
        { status: 400 },
      );
    }

    // The real file tree from the app's sovereign repo (honest — empty when Forgejo is
    // unreachable, and we say so in the issue body rather than inventing files).
    const tree = await listAppFilesForViewer(id, user).catch(() => ({ files: [] as string[], mode: 'offline' as const, branch: 'main' }));
    const fileList = tree.files.length
      ? tree.files.map((f) => `- ${f}`).join('\n')
      : '_(source tree unavailable — Forgejo unreachable)_';
    const bodyMd = [
      `Code hand-off from Sovereign Agentic OS app **${app.name}**.`,
      '',
      `Source repo: ${app.repo.htmlUrl || app.repo.fullName || '(not scaffolded)'}`,
      '',
      `## Files (${tree.files.length})`,
      fileList,
    ].join('\n');

    const out = await callConnectionTool(chosenId, user, {
      tool: 'create_issue',
      args: { repo, title: `Code hand-off: ${app.name}`, body: bodyMd },
      reason: `Design push · ${app.name}`,
    });

    if (out.decision === 'allow') {
      const result = out.result as { issue?: { url?: string; number?: number; deduped?: boolean }; ok?: boolean; reason?: string } | undefined;
      if (result?.issue) {
        return NextResponse.json({ connectionId: chosenId, repo, filesListed: tree.files.length, issue: result.issue });
      }
      return NextResponse.json({ error: result?.reason ?? 'GitHub did not return an issue.' }, { status: 502 });
    }
    if (out.decision === 'requires_approval' || out.decision === 'propose') {
      return NextResponse.json({ connectionId: chosenId, repo, queued: true, approvalId: out.approvalId, reason: out.reason }, { status: 202 });
    }
    return NextResponse.json({ error: out.reason }, { status: 403 });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
