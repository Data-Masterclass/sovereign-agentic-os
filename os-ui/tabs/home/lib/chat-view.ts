/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Home chat view logic (re-export)
 * USER STORY: As a developer I want Home's chat helpers at their familiar path.
 * ARCHITECTURE: The logic moved to `core/ui/chat-view.ts` because the Ask-the-OS drawer (kernel UI)
 *             shares the confirm card with Home and the kernel may not import a tab.
 */
export * from '@core/ui/chat-view';
