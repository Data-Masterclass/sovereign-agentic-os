/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Input and Textarea — OS-styled text fields
 * USER STORY: As an app builder I want text fields that match the OS so that forms in my app
 *             look consistent without extra styling.
 * ARCHITECTURE:
 *   - Part of the `@sovereign-os/ui` package (`core/app-ui/`), re-exported from `index.ts`.
 *   - Both forward refs and native props; both use the `.sb-input` class from `theme.css`.
 */
import * as React from 'react';
import { cx } from './cx';

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

/** OS text input — gold focus ring. */
export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, type, ...rest },
  ref,
) {
  return <input ref={ref} type={type ?? 'text'} className={cx('sb-input', className)} {...rest} />;
});

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

/** OS textarea — same field styling, vertical resize. */
export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, ...rest },
  ref,
) {
  return <textarea ref={ref} className={cx('sb-input', className)} {...rest} />;
});
