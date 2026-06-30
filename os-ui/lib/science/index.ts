/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * Science (Layer 4 / ML) module barrel. `@/lib/science` resolves here. The pure
 * types live in `./types` (client-safe); everything else is `server-only`.
 *
 *   churn          — the "Churn model" vertical slice + the predict tool body.
 *   model-service  — model-as-service tier ladder + dual-front-door governance (Opus).
 *   agent-control  — the two-mode ML agent + the cannot-self-certify invariant (Opus).
 *   marketplace    — consumption-at-certify (read-in-place / fork-to-retrain) (Opus).
 *   adapters       — the 5 verified Layer-4 adapters (live + offline-mock).
 */
export * from '@/lib/science/types';
export * from '@/lib/science/churn';
export * from '@/lib/science/model-service';
export * from '@/lib/science/agent-control';
export * from '@/lib/science/marketplace';
export * from '@/lib/science/adapters';
