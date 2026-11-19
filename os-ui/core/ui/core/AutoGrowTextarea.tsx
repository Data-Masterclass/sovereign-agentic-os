/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    AutoGrowTextarea — a textarea that grows with its content from a minimum row count
 * USER STORY: As a builder writing prose fields (stories, requirements, rules) I want the text box
 *             to grow as I type so that I do not have to scroll inside a small box.
 * ARCHITECTURE:
 *   - Shared core UI, used by the Software tab's story and epic editors.
 *   - Re-measures height on every `value` change (useLayoutEffect) and on input, by resetting to
 *     `auto` and then setting it to `scrollHeight`.
 */
'use client';

import { useLayoutEffect, useRef } from 'react';

/**
 * AutoGrowTextarea — the ONE roomy, auto-growing text field the guided builders use for
 * prose fields (story asA/iWant/soThat/acceptance, features, NFRs, rules, epic
 * requirements). It starts at a comfortable minimum height (min ~3 lines by default) and
 * grows with its content instead of scrolling inside a cramped box — no wall of tiny
 * inputs, generous line-height, calm padding, OS tokens only.
 *
 * Controlled + uncontrolled both work (it re-measures on every `value` change AND on
 * input). Keyboard-friendly by default; the host can still pass `onBlur` for
 * save-on-blur and any aria props through `...rest`.
 */
export default function AutoGrowTextarea({
  value,
  minRows = 3,
  className,
  style,
  onInput,
  ...rest
}: {
  value: string;
  /** The minimum visible rows (the resting height). Defaults to a roomy 3. */
  minRows?: number;
} & Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'rows'>) {
  const ref = useRef<HTMLTextAreaElement | null>(null);

  const fit = (el: HTMLTextAreaElement) => {
    // Reset to auto first so the box can SHRINK as well as grow, then lock to scrollHeight.
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  };

  // Re-measure after every render that could change the content height (e.g. an
  // assistant suggestion folded new text into a controlled `value`).
  useLayoutEffect(() => {
    if (ref.current) fit(ref.current);
  }, [value]);

  return (
    <textarea
      ref={ref}
      value={value}
      rows={minRows}
      className={className ? `agt ${className}` : 'agt'}
      onInput={(e) => {
        fit(e.currentTarget);
        onInput?.(e);
      }}
      style={{
        width: '100%',
        resize: 'none',
        overflow: 'hidden',
        lineHeight: 1.6,
        padding: '10px 12px',
        font: 'inherit',
        minHeight: `calc(${minRows} * 1.6em + 20px)`,
        ...style,
      }}
      {...rest}
    />
  );
}
