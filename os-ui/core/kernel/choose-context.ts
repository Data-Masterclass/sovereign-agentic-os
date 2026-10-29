/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * CHOOSE-CONTEXT core — the tab-agnostic pieces of the Choose-Context experience,
 * lifted out of the Software tab so every builder tab (Software today, Agents next)
 * shares one source of truth for the "N already available" summary copy and the
 * shape of a per-type descriptor's create-new behaviour.
 *
 * Pure + client-safe: NO React, NO grant-value logic. The Software model
 * (`lib/software/appspec/choose-context-model.ts`) re-exports from here, so its
 * existing imports + unit test keep passing unchanged. A host tab supplies its own
 * type list + copy; the shared `ChooseContextShell` component consumes descriptors
 * built from these shapes.
 */

/** How a Choose-Context type's "Create new" resolves — tab-agnostic. */
export type CreateNewMode =
  /** Create a fresh, possibly-empty artifact IN a host folder, then grant. */
  | 'in-folder'
  /** Deep-link into another tab's own builder (it has its own creator), then grant on return. */
  | 'deep-link'
  /** No standalone create (the artifact is derived elsewhere) — point to the owning tab. */
  | 'derived';

/**
 * The tab-agnostic shape of one Choose-Context type descriptor. Host tabs may
 * extend it with their own `type` union + extra fields; the shared pieces (label,
 * blurb, create behaviour copy) live here so the summary/copy never drift.
 */
export type ChooseContextTypeMetaBase = {
  label: string;
  /** One honest line under the type header — what granting THIS type gives the app. */
  blurb: string;
  createMode: CreateNewMode;
  /** The label on the create-new affordance. */
  createLabel: string;
  /** A short note explaining a deep-link / derived create (why it lives in another tab). */
  createNote?: string;
};

/** The "Already available" count line for a type, given how many are granted. */
export function grantedSummary(count: number): string {
  if (count === 0) return 'Nothing granted yet';
  return `${count} already available to this app`;
}
