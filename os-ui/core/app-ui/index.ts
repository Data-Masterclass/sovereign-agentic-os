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
export { cx } from './cx';
export { AppShell, type AppShellProps, type NavItem } from './AppShell';
export { Button, type ButtonProps } from './Button';
export { Card, type CardProps } from './Card';
export { Badge, type BadgeProps, type BadgeTone } from './Badge';
export { Input, Textarea, type InputProps, type TextareaProps } from './Input';
export { Select, type SelectProps } from './Select';
export { Table, type TableProps } from './Table';
export { Section, Panel, type SectionProps, type PanelProps } from './Section';
export { Alert, type AlertProps, type AlertVariant } from './Alert';
export { Spinner, type SpinnerProps } from './Spinner';
