/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Tutorials — the tab's PUBLIC API.
 *
 * Other tabs, API routes and the MCP import this tab through THIS module.
 */

// Tutorial definitions, listing and lookup.
export * from './registry.ts';

// Tutorial types (TutorialDef, WalkStep, GoldenPathKey, etc.).
export * from './types.ts';

// Engine: walkSteps / framingForRole / panelForRole.
export * from './engine.ts';

// Anchor attributes for tutorial step targeting.
export * from './anchors.ts';
