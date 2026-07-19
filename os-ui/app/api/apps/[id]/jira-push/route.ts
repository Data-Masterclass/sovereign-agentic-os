/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { getAppForUser } from '@/lib/software/apps';
import { listConnectionsForUser, callConnectionTool } from '@/lib/connections';
import { planJiraIssues, pickConnectionForTemplate } from '@/lib/software/design-push';

export const dynamic = 'force-dynamic';

/**
 * Push the app's Design EPICs + user stories to Jira through the user's OWN governed
 * Atlassian connection — NOT a shared service account. Each EPIC → a Jira `Epic`
 * issue, each story → a `Story` issue, via the governed `jira_create_issue` tool.
 * That tool is Write-approval, so the SAME governance gate every connection write
 * passes decides allow / held-for-approval — we surface that state honestly and never
 * fake a success. Honest fallback: no Atlassian connection ⇒ a clear "connect Jira
 * first" 400 pointing at Connections.
 *
 * Body: { projectKey, issueType?, connectionId? }.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const app = await getAppForUser(id, user);
    const body = (await req.json().catch(() => ({}))) as { projectKey?: string; connectionId?: string };

    const projectKey = String(body.projectKey ?? '').trim();
    if (!projectKey) {
      return NextResponse.json({ error: 'A Jira project key is required (e.g. "OPS").' }, { status: 400 });
    }

    const plan = planJiraIssues(app.epics ?? []);
    if (plan.length === 0) {
      return NextResponse.json({ error: 'No EPICs to push — add EPICs and stories on the Design stage first.' }, { status: 400 });
    }

    // The user's OWN governed Atlassian connection: prefer one the app was granted,
    // else the first visible one. No connection ⇒ honest "connect Jira first".
    const visible = await listConnectionsForUser(user);
    const grantedIds = (app.grants?.connections ?? []).map((g) => g.id);
    const chosenId = body.connectionId
      ? visible.find((c) => c.id === body.connectionId && c.template === 'atlassian')?.id ?? null
      : pickConnectionForTemplate('atlassian', grantedIds, visible)?.id ?? null;
    if (!chosenId) {
      return NextResponse.json(
        { error: 'No Atlassian (Jira) connection available. Connect Jira in Connections first.', connectHref: '/connections' },
        { status: 400 },
      );
    }

    // Create each issue through the governed gate. A Write-approval hold is NOT a
    // failure — we record it as queued so the caller sees the honest state.
    const created: { ref: JiraRef; key: string; url: string }[] = [];
    const queued: { ref: JiraRef; approvalId?: string }[] = [];
    const failed: { ref: JiraRef; reason: string }[] = [];
    for (const item of plan) {
      const out = await callConnectionTool(chosenId, user, {
        tool: 'jira_create_issue',
        args: { projectKey, issueType: item.issueType, summary: item.summary, description: item.description },
        reason: `Design push · ${app.name}`,
      });
      if (out.decision === 'allow') {
        const result = out.result as { issue?: { key?: string; url?: string }; ok?: boolean; reason?: string } | undefined;
        if (result?.issue?.key) created.push({ ref: item.ref, key: result.issue.key, url: result.issue.url ?? '' });
        else failed.push({ ref: item.ref, reason: result?.reason ?? 'Jira did not return an issue key.' });
      } else if (out.decision === 'requires_approval' || out.decision === 'propose') {
        queued.push({ ref: item.ref, approvalId: out.approvalId });
      } else {
        failed.push({ ref: item.ref, reason: out.reason });
      }
    }

    return NextResponse.json({
      connectionId: chosenId,
      projectKey,
      total: plan.length,
      created,
      queued,
      failed,
    });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}

type JiraRef = { epicId: string; storyId?: string };
