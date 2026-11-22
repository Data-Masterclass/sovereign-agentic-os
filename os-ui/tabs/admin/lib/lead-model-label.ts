/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       admin
 * FEATURE:    The words of the lead-model switch in Platform → Models
 * USER STORY: As an admin I must see that this switch is a cost saver with a quality price, and which model leads now.
 * ARCHITECTURE: pure strings, shared by the panel and its test.
 */
export const LEAD_SWITCH_LABEL =
  'Save costs: the worker model leads and the strong model is only used to escalate — lower quality and fewer capabilities.';

/** The explanation under the checkbox, for the current state, with the model that leads right now. */
export function leadSwitchText(on: boolean, leadModelName: string): string {
  return on
    ? `The worker model leads: it plans, chooses tools and answers, and the strong model steps in only when a check fails, the worker refuses or gives an empty answer, or the worker asks for it. Lead model now: ${leadModelName}.`
    : `The strong model leads: it plans, chooses tools and answers, and decides on its own which clearly defined sub-tasks go to the worker. Lead model now: ${leadModelName}.`;
}
