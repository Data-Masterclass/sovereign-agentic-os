/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The stepper rail's words ("Step 2 — Grant: done", "Continue to Build") as catalog messages
 * USER STORY: As a user reading a guided builder in my language I want the rail's tooltips, accessible labels and
 *             next-button hint in that language, so the stepper never falls back to English.
 * ARCHITECTURE: Pure (no React) so the test can render it through the catalog and prove the English equals the
 *   kernel's English `label` (core/kernel/stages.ts). `StageShell.tsx` renders the messages with
 *   `useCommonMessage()`. Stage titles and the tabs' own problem / pending lines arrive already translated.
 */
import type { StageStatus } from '@core/kernel/stages';

export type StageMessage = { key: string; args?: Record<string, string> };

/** The state word of a rail entry: the tab's own text, or the fixed "done" / "not done yet". */
export function stageStateWord(state: StageStatus['state']): StageMessage | string {
  if (state.kind === 'text') return state.text;
  return { key: state.kind === 'done' ? 'stage.done' : 'stage.notDone' };
}

/** "Grant: done" — the tooltip; `stateText` is the rendered {@link stageStateWord}. */
export function stageLabelMessage(title: string, stateText: string): StageMessage {
  return { key: 'stage.stateLabel', args: { title, state: stateText } };
}

/** "Step 2 — Grant: done" — the accessible label; `label` is the rendered {@link stageLabelMessage}. */
export function stepAriaMessage(index: number, label: string): StageMessage {
  return { key: 'stage.stepAria', args: { n: String(index + 1), label } };
}

/** The next button's tooltip: "Continue to Build" when it can go, else "Finish Grant first". */
export function nextHintMessage(canNext: boolean, nextTitle: string, currentTitle: string): StageMessage {
  return canNext
    ? { key: 'stage.continueTo', args: { title: nextTitle } }
    : { key: 'stage.finishFirst', args: { title: currentTitle } };
}
