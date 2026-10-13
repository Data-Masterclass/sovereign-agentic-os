/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * The extracted-text preview truncation for the file detail pane. Long bodies are
 * clamped to a preview window; the reader expands with "Show all". Pure so the
 * toggle logic is unit-tested independently of React (the visual clamp is handled by
 * the `.preview-text.expanded` CSS rule).
 */
export const PREVIEW_TEXT_LIMIT = 1800;

export type PreviewText = {
  /** The text to render (truncated to the limit, or the whole body when expanded). */
  body: string;
  /** True when the rendered body is a truncated slice (append an ellipsis). */
  truncated: boolean;
  /** True when the body exceeds the limit — i.e. the Show all / Collapse toggle shows. */
  canToggle: boolean;
};

export function previewText(text: string, showAll: boolean, limit = PREVIEW_TEXT_LIMIT): PreviewText {
  const canToggle = text.length > limit;
  const truncated = !showAll && canToggle;
  return { body: truncated ? text.slice(0, limit) : text, truncated, canToggle };
}
