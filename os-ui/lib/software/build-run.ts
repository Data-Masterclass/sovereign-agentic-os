/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { classifyTeamError } from '@/lib/agents/build/phase-router';
import { AssistantNotConfiguredError } from '@/lib/assistant/complete';
import { config } from '@/lib/core/config';
import type { ChatRunMode } from '@/lib/software/chat-modes';

/**
 * HONEST failure classification for the streamed Build chat run (0.6.110).
 *
 * The old catch labelled EVERY non-abort exception "LiteLLM unreachable" — so a
 * model 400, a tool error, a compile error and a repo error all lied as a gateway
 * outage. This routes the thrown error through the EXISTING typed `classifyTeamError`
 * (phase-router), which preserves the real message for `model`/`error` kinds and only
 * says gateway/unreachable on a genuine ECONNREFUSED/ENOTFOUND/fetch-failed.
 *
 * Returns:
 *   • `content`      — the text persisted + shown in the final bubble.
 *   • `errorMessage` — the message for the `{ type: 'error', message }` SSE event,
 *                      or `null` when NO error event should fire (client-abort — kept
 *                      silent/as-is — or an unconfigured assistant, a soft note).
 */
export function buildRunError(e: unknown): { content: string; errorMessage: string | null } {
  // Assistant not configured is a soft, expected note — surface it verbatim, no error event.
  if (e instanceof AssistantNotConfiguredError) {
    return { content: `(${(e as Error).message})`, errorMessage: null };
  }
  // Client-abort / warm-up timeout stays AS-IS and SILENT (no `{type:'error'}` event):
  // the message is saved and the user just resends.
  if ((e as Error)?.name === 'AbortError') {
    return {
      content:
        '(the build assistant is still warming up — the model did not respond in time. ' +
        'Your message is saved; send it again in a few seconds.)',
      errorMessage: null,
    };
  }
  // Everything else: the REAL, typed cause — a model 400, a tool/compile/repo error, or a
  // genuine gateway outage — never a blanket "unreachable" lie.
  const { message } = classifyTeamError(e);
  return { content: `(${message})`, errorMessage: message };
}

/**
 * The tool-call-round budget for a run mode (0.6.110). BUILD gets a real budget
 * (`softwareBuildMaxSteps`, default 24) because a build legitimately needs many
 * steps (orient → get_dataset → several compile-checked commits); the route passed
 * none before, so runAgentic fell back to its bare DEFAULT_MAX_ITERATIONS (6) and a
 * real build ran out of steps mid-way. Read-only modes (plan/test/review) are short
 * and read-only, so they keep the default (returns `undefined` ⇒ runAgentic default).
 */
export function buildMaxIterations(mode: ChatRunMode): number | undefined {
  return mode === 'build' ? config.softwareBuildMaxSteps : undefined;
}

/** The authoritative prefix for a build turn that committed nothing (B3, 0.6.115). */
export const BUILD_NOT_LANDED_PREFIX = 'No files were committed this turn — the build did not land.';

/**
 * EMPTY-CHANGESET HONESTY (0.6.115). A `build` turn that committed 0 files did NOT land —
 * prefix the final bubble text authoritatively so the UI can't render a green success over
 * an empty changeset (no false "done"). Non-build modes, or a build that DID commit, pass
 * `finalText` through unchanged. Pure.
 */
export function honestBuildFinalText(mode: ChatRunMode, changeCount: number, finalText: string): string {
  if (mode !== 'build' || changeCount > 0) return finalText;
  return finalText ? `${BUILD_NOT_LANDED_PREFIX}\n\n${finalText}` : BUILD_NOT_LANDED_PREFIX;
}
