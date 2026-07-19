/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import * as React from 'react';
import { cx } from './cx.ts';

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
