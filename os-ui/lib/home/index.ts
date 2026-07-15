/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Home — the tab's PUBLIC API.
 *
 * Other tabs, API routes and the MCP import this tab through THIS module.
 */

// Feed: homeFeed / cockpitFeed.
export * from './feed.ts';

// Intent classification: classifyAsk / deriveName / AskIntent.
export * from './intents.ts';

// Launcher cards + persona: launcherFor / personaFor / HomePersona / PathId.
export * from './launcher.ts';

// Scope helpers: whatNeedsMe / myWip / hasAuthored.
export * from './scope.ts';
