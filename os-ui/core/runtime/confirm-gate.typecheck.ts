/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Compile-time proof that the agentic harness cannot be handed an ungated executor.
 * USER STORY: As the owner I want "a caller cannot compile without choosing a gate" to be a
 *             failing build, not a convention someone has to remember.
 * ARCHITECTURE: Types only — no value is imported, nothing runs, nothing is bundled. `tsc` reads
 *   this file like any other non-test source, so if `runAgentic` ever accepts a plain
 *   `ToolExecutor` again the first assertion below resolves to `false` and the build fails.
 *   (Test files are excluded from `tsc`, so this cannot live in one.)
 */
import type { runAgentic, ToolExecutor } from '@core/runtime/agentic';
import type { GatedToolExecutor } from '@core/runtime/confirm-gate';

type HarnessExecutor = Parameters<typeof runAgentic>[0]['callTool'];
type Assert<T extends true> = T;

/** A plain executor — one whose author chose no gate — is NOT accepted by the harness. */
export type PlainExecutorIsRejected = Assert<ToolExecutor extends HarnessExecutor ? false : true>;

/** A gated one is. */
export type GatedExecutorIsAccepted = Assert<GatedToolExecutor extends HarnessExecutor ? true : false>;
