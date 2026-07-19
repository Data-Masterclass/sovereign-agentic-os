/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * @sovereign-os/ui — the Sovereign Agentic OS design language as a small,
 * framework-agnostic React + CSS package.
 *
 * Import the theme ONCE (side-effect), then use the primitives:
 *   import '@sovereign-os/ui/theme.css';
 *   import { AppShell, Button, Card } from '@sovereign-os/ui';
 *
 * Every primitive forwards `className` + native props, so nothing is locked in —
 * override any class or drop down to the raw `.sb-*` classes at any time.
 */
export { cx } from './cx.ts';
export { AppShell, type AppShellProps, type NavItem } from './AppShell.tsx';
export { Button, type ButtonProps } from './Button.tsx';
export { Card, type CardProps } from './Card.tsx';
export { Badge, type BadgeProps, type BadgeTone } from './Badge.tsx';
export { Input, Textarea, type InputProps, type TextareaProps } from './Input.tsx';
export { Select, type SelectProps } from './Select.tsx';
export { Table, type TableProps } from './Table.tsx';
export { Section, Panel, type SectionProps, type PanelProps } from './Section.tsx';
