/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       admin
 * FEATURE:    The words of the lead-model switch in Platform → Models
 * USER STORY: As an admin I must see that this switch is a cost saver with a quality price, and which model leads now.
 * ARCHITECTURE: pure strings, shared by the panel and its test. The panel renders the matching catalog keys
 *             (`admin.models.lead.*`, I18N wave 2); the English here is the source text the test pins.
 */
export const LEAD_SWITCH_LABEL =
  'Save costs: the worker model leads and the strong model is only used to escalate — lower quality and fewer capabilities.';

/** The explanation under the checkbox, for the current state, with the model that leads right now. */
export function leadSwitchText(on: boolean, leadModelName: string): string {
  return on
    ? `The worker model leads: it plans, chooses tools and answers, and the strong model steps in only when a check fails, the worker refuses or gives an empty answer, or the worker asks for it. Lead model now: ${leadModelName}.`
    : `The strong model leads: it plans, chooses tools and answers, and decides on its own which clearly defined sub-tasks go to the worker. Lead model now: ${leadModelName}.`;
}

/** The catalog key (namespace `admin`) of LEAD_SWITCH_LABEL — what the panel renders. */
export const LEAD_SWITCH_LABEL_KEY = 'models.lead.switchLabel' as const;

/** The catalog key of leadSwitchText(on, …); the message takes `{model}`. */
export function leadSwitchTextKey(on: boolean): 'models.lead.textOn' | 'models.lead.textOff' {
  return on ? 'models.lead.textOn' : 'models.lead.textOff';
}
