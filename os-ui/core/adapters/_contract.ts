/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The one result type every component adapter returns (design 00 §8.2).
 * USER STORY: As a user I want a component that is down, refusing or slow to show up as exactly
 *             that, with its reason — never as an empty list or a green light.
 * ARCHITECTURE:
 *   - Types only. `core/adapters/**` is the only code allowed to talk to a component (CI rule
 *     GLUE-1); every adapter module imports this contract (GLUE-3) and reports an expected
 *     failure as `ok:false` with a reason instead of throwing or returning a success-shaped value.
 *   - `health()` returns the version the component itself reports (GLUE-4: no version literals).
 */
export type FetchedFailure = 'unreachable' | 'unauthorized' | 'forbidden' | 'invalid' | 'conflict' | 'timeout';

export type Fetched<T> =
  | { ok: true; value: T; at: string }
  | { ok: false; reason: FetchedFailure; detail: string; at: string };

export type ComponentHealth = { version: string; status: 'ready' | 'degraded'; detail?: string };

export interface Adapter {
  readonly id: string;
  health(): Promise<Fetched<ComponentHealth>>;
}
