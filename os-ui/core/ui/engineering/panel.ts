/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       engineering view (UI)
 * FEATURE:    The "Under the hood" panel's logic and its every piece of static copy
 * USER STORY: As a reviewer I want the panel's labels to be testable without rendering React, so
 *             the vocabulary rule (checklist T2) is asserted over the real strings the user reads
 *             rather than over a copy of them.
 * ARCHITECTURE:
 *   - A `.ts` sibling of `UnderTheHood.tsx` holding ALL copy and ordering (the house rule: a test
 *     cannot import a `.tsx`). The component imports from here and adds no string of its own.
 *   - Pure: no fetch, no React, no `server-only`.
 */
import { ENGINEERING_TOOLS, type EngineeringSection, type EngineeringTool, type EngineeringView } from '@core/engineering/types';

/** The panel's own heading. The only OS-vocabulary string on the surface, and it names no artefact. */
export const PANEL_TITLE = 'Under the hood';

/** The one-line explanation under the heading. */
export const PANEL_SUBTITLE =
  'The real artefacts, in each tool\'s own words: the files in the repository, the asset the scheduler runs, the graph that was compiled, the trace of a run — with the command you would type yourself.';

/** What the diagram's lazy chunk says while it loads (the JSON is already on screen beside it). */
export const GRAPH_LOADING = 'Loading the graph diagram…';

/** What the panel says while it is loading, and when the view could not be fetched. */
export const PANEL_LOADING = 'Reading the artefacts…';
export const PANEL_ERROR_PREFIX = 'Could not read the artefacts: ';

/** The heading above a section's commands. */
export const COMMANDS_HEADING = 'Run it yourself';
/** The heading above a section's caveats — the "what is NOT true yet" pattern. */
export const CAVEATS_HEADING = 'What is not true yet';
/** The heading above the native export. */
export const EXPORT_HEADING = 'Take it elsewhere';

/** Tabs in the tools' fixed order, so the panel does not reshuffle between objects. */
export function orderedSections(view: EngineeringView): EngineeringSection[] {
  const rank = new Map<EngineeringTool, number>(ENGINEERING_TOOLS.map((t, i) => [t, i]));
  return [...view.sections].sort((a, b) => (rank.get(a.tool) ?? 99) - (rank.get(b.tool) ?? 99));
}

/** The tab caption: the tool's name, with a marker when the section could not be filled. */
export function tabCaption(section: EngineeringSection): string {
  return section.unavailable ? `${section.label} —` : section.label;
}

/** The sentence an empty section shows. Never blank: the reason is the content. */
export function emptyText(section: EngineeringSection): string {
  return section.unavailable ?? 'No reason was recorded, which is itself a defect — please report it.';
}

/** The sentence a link that cannot resolve shows in place of an address. */
export function unresolvedText(reason: string): string {
  return `This link does not resolve here: ${reason}`;
}
