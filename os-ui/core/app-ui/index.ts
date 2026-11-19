/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    `@sovereign-os/ui` — the OS design language as a small React + CSS package
 * USER STORY: As an app builder I want to import the OS theme and primitives in one line so that
 *             a new app looks like the OS from the first build.
 * ARCHITECTURE:
 *   - The package entry point: re-exports every primitive in `core/app-ui/`. Import the theme once
 *     as a side effect (`import '@sovereign-os/ui/theme.css'`), then the components.
 *   - Framework-agnostic: vendored into generated apps by `tabs/software/lib/app-ui-vendor.ts`
 *     and also imported inside os-ui (e.g. `tabs/software/ui/appspec/*Renderer.tsx`).
 *   - Every primitive forwards `className` and native props, so callers can override any class
 *     or use the raw `.sb-*` classes directly.
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
