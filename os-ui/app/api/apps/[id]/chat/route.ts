/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { roleModel } from '@/lib/models/roles';
import { requireUser } from '@/lib/core/auth';
import { getAppForUser, saveChat } from '@/lib/software/apps';
import { scheduleRepairCheck } from '@/lib/software/ci-repair';
import { getSnapshot } from '@/lib/software/snapshot';
import { diffTrees, type FileChange } from '@/lib/software/build-changeset';
import { runTabAgent, renderAssistantText } from '@/lib/assistant/runtime';
import { cleanTurns } from '@/lib/assistant/turns';
import { buildRunError, buildMaxIterations, honestBuildFinalText } from '@/lib/software/build-run';
import { toolCallToLine, gateLineFromStep, committedSummaryLine, type ActivityLine } from '@/lib/software/build-activity';
import { asChatRunMode, isReadOnlyMode, modelRoleForMode, tierNote, READ_ONLY_MODE_TOOLS, BUILD_MODE_TOOLS, type ChatRunMode } from '@/lib/software/chat-modes';
import { appContext } from '@/lib/software/build-brief';
import { unresolvedDataNeedWarning } from '@/lib/software/data-plan';
import { resolveGrantedContext } from '@/lib/software/grants-context';
import type { BuildTarget } from '@/lib/software/build-target';

export const dynamic = 'force-dynamic';

type Msg = { role: 'user' | 'assistant'; content: string };

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let user;
  try {
    user = await requireUser();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 401 });
  }
  const { id } = await ctx.params;

  let messages: Msg[] = [];
  let mode: ChatRunMode = 'build';
  let target: BuildTarget | null = null;
  try {
    const body = await req.json();
    messages = Array.isArray(body?.messages) ? body.messages : [];
    mode = asChatRunMode(body?.mode);
    // The targeted scope: `target` ({kind, epicId?, storyId?}) is the current shape;
    // the legacy `story` ({epicId, storyId}) stays accepted for backward compat.
    const t = body?.target;
    if (t?.kind === 'app') target = { kind: 'app' };
    else if (t?.kind === 'epic' && typeof t.epicId === 'string') target = { kind: 'epic', epicId: t.epicId };
    else if (t?.kind === 'story' && typeof t.epicId === 'string' && typeof t.storyId === 'string') {
      target = { kind: 'story', epicId: t.epicId, storyId: t.storyId };
    } else if (body?.story && typeof body.story.epicId === 'string' && typeof body.story.storyId === 'string') {
      target = { kind: 'story', epicId: body.story.epicId, storyId: body.story.storyId };
    }
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  let app;
  try {
    app = await getAppForUser(id, user);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 404 });
  }

  const clean = cleanTurns(messages);
  if (clean.length === 0) return NextResponse.json({ error: 'No message to send' }, { status: 400 });

  // Snapshot the app's committed tree BEFORE the run so we can surface the exact
  // before/after changeset a Build turn produced (the harness commits through
  // `commitToApp`, which updates this same per-app snapshot).
  const before = getSnapshot(app.id);
  // Resolve the app's granted context ONCE (async, DLS-scoped as the caller) before the
  // streamed run, so the build agent gets the real data plane it was granted. Empty ⇒ ''.
  const grantedContext = await resolveGrantedContext(app.grants, user);
  // DATA-RESOLUTION GATE (0.6.101): if the app has ZERO granted datasets yet a story implies
  // a data need, warn LOUDLY + up front in the brief so the build agent stops with an honest,
  // actionable message ("resolve it in Design") instead of the cryptic empty commit. A warning,
  // not a hard block — the signal is conservative, so a good build is never rejected on it.
  const dataNeedWarning = unresolvedDataNeedWarning(app.epics ?? [], app.grants.data.length);
  // MODEL TIER (Software tab policy, 0.6.107): EVERY stage — plan (Design), Build (code
  // GENERATION), test and review — runs on the REASONING model. `modelRoleForMode` returns
  // 'reasoning' for all modes; this is now PASSED to runTabAgent (previously computed but
  // dropped, so the build silently ran on the platform assistant/standard model — the
  // "why is a basic feature so hard to build" root cause). See lib/software/chat-modes.ts.
  const model = roleModel(modelRoleForMode(mode));

  /**
   * STREAMING Build run (SSE, text/event-stream). Each event is one JSON line
   * prefixed `data: `. The client renders `activity` events as a live feed AS
   * the agent works, then the terminal `final` event carries the backward-
   * compatible payload ({ content, changes }) the old one-shot client relied on.
   *
   * Event shapes (all `{ type, ... }`):
   *   { type: 'plan', text }                          — the plan, once, first
   *   { type: 'activity', line: ActivityLine, raw }   — one per tool step, live
   *   { type: 'final', role, content, model, mode, changes }
   *   { type: 'error', message }                      — a run-level failure
   */
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          /* controller already closed (client aborted) — ignore */
        }
      };

      let content = '';
      // The calm closing summary shown in the final bubble (the plan + per-tool
      // actions already streamed live into the feed, so the bubble need not repeat
      // the whole markdown wall). `content` below stays the FULL render for
      // persistence + backward-compat.
      let finalText = '';
      let changes: FileChange[] = [];
      // The tier this turn ran on for the UI note — the mode's tier (reasoning for
      // every Software stage), which is what the run actually executes on now.
      const ranRole = modelRoleForMode(mode);
      try {
        const result = await runTabAgent({
          user,
          tab: 'software',
          messages: clean,
          extraContext:
            appContext(app, mode, target, grantedContext) +
            (dataNeedWarning ? `\n\n## Unresolved data need (RESOLVE IN DESIGN FIRST)\n${dataNeedWarning}` : ''),
          // This run is scoped to THIS app: bind its appId into every tool call so the
          // model never has to repeat it (an omitted/empty id is filled in, not 404'd —
          // the `commit({})` → not_found fix) and a mismatched id is rejected loudly.
          boundArgs: { appId: app.id },
          // EVERY stage (incl. Build code-generation) runs on the reasoning tier. Passing
          // it here is the fix: runTabAgent used to ignore the computed tier and run on the
          // platform assistant/standard model. No standard→reasoning escalation is needed
          // now — the run already starts on the strongest tier.
          model,
          // TOOL ALLOWLIST per mode (harness-enforced, not just prompted):
          //  • plan/test/review — READ_ONLY_MODE_TOOLS (no write).
          //  • build — BUILD_MODE_TOOLS: WRITE-ONLY (orientation + `commit`), no data
          //    discovery/query/design. Context is bound/created in Choose Context and frozen
          //    into the injected schema; the extra data tools only confused the build (0.6.108).
          //  • any other writable mode — undefined (full surface).
          toolNames: isReadOnlyMode(mode) ? READ_ONLY_MODE_TOOLS : mode === 'build' ? BUILD_MODE_TOOLS : undefined,
          // BUILD-LOOP GUARD (0.6.115): a `commit` that fails the compile gate must never
          // re-run byte-identically. Passing the write tool here makes the harness short-
          // circuit an identical failed re-commit with a stronger corrective note (stops
          // the observed loop at n=1). Only build writes, so only build arms the guard.
          writeToolNames: mode === 'build' ? ['commit'] : undefined,
          // ITERATION BUDGET (0.6.110): BUILD gets a real tool-call-round budget
          // (softwareBuildMaxSteps, default 24) — a build needs many steps (orient →
          // get_dataset → several compile-checked commits). Passing nothing let runAgentic
          // fall back to its bare DEFAULT_MAX_ITERATIONS (6), so a real build ran out of
          // steps mid-way. Read-only modes stay on the default (undefined ⇒ short + read-only).
          maxIterations: buildMaxIterations(mode),
          onPlan: (plan) => send({ type: 'plan', text: plan }),
          onStep: (step) => {
            // The verify-before-commit COMPILE GATE runs inside commitToApp, so it is
            // not its own tool call — surface its recorded outcome as its OWN feed step
            // ("compile check ✓ / ✗ N errors / skipped") before the commit line.
            const gateLine = gateLineFromStep(step);
            if (gateLine) send({ type: 'activity', line: gateLine });
            const line: ActivityLine = toolCallToLine(step);
            // `raw` carries the real tool I/O for the Builders-only "show details"
            // affordance; the client keeps it hidden by default.
            send({ type: 'activity', line, raw: { tool: step.tool, args: step.args, result: step.result } });
          },
        });
        content = renderAssistantText(result);
        finalText = result.finalText;
        // Diff the committed tree after the run (build mode only ever writes).
        if (mode === 'build') changes = diffTrees(before, getSnapshot(app.id));
        // EMPTY-CHANGESET HONESTY (0.6.115): a build turn that committed 0 files did NOT
        // land — prefix the bubble text authoritatively so the UI can't render a green
        // success over an empty changeset (no false "done" on a no-op build).
        finalText = honestBuildFinalText(mode, changes.length, finalText);
        // A closing activity line summarizing the real committed changeset.
        const summary = mode === 'build' ? committedSummaryLine(app.name, changes) : null;
        if (summary) send({ type: 'activity', line: { tool: 'commit', text: summary, isError: false } });
        // PHASE C — if this build turn committed, schedule a ONE-SHOT best-effort CI check
        // ~2.5 min out (no cron here). Its failing branch fires the bounded auto-repair.
        // A pod restart loses the pending timer — acceptable (the next on-load refresh
        // re-detects any failure). Skipped for a no-op turn or a non-live app.
        if (mode === 'build' && changes.length > 0 && app.mode === 'live') {
          scheduleRepairCheck(app.id);
        }
      } catch (e) {
        // HONEST failure (0.6.110): route the thrown error through the typed classifier
        // instead of blanket-labelling every non-abort exception "LiteLLM unreachable".
        // A model 400, a tool/compile/repo error now surfaces its REAL message; only a
        // genuine gateway outage says unreachable. Client-abort stays silent (no error
        // event). See lib/software/build-run.ts.
        const { content: errContent, errorMessage } = buildRunError(e);
        content = errContent;
        if (errorMessage) send({ type: 'error', message: errorMessage });
      }

      // Persist the running conversation under the app (home of record).
      const persisted: Msg[] = [...clean, { role: 'assistant', content }];
      try {
        await saveChat(id, user, persisted);
      } catch {
        /* persistence best-effort */
      }

      // Terminal event — backward-compatible payload the client reads for the
      // final assistant bubble + the committed diff. `content` is the full render
      // (persisted); `finalText` is the calm closing line the bubble prefers.
      send({
        type: 'final',
        role: 'assistant',
        content: content || '(no content)',
        finalText: finalText || content || '(no content)',
        model,
        // The tier that ACTUALLY ran this turn — reasoning if a bounded escalation fired,
        // else the mode's tier. Honest, not the pre-run assumption.
        tier: tierNote(ranRole),
        mode,
        changes,
      });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    },
  });
}
