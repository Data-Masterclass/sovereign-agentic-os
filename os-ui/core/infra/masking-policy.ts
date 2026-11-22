/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The platform admin's Langfuse masking switch, read where traces are written
 * USER STORY: As a platform admin I switch masking on once; every place the OS sends a trace
 *             follows it on its next write, in os-ui and in the run worker, with no restart.
 * ARCHITECTURE: one read of the platform setting (`langfuseMasking`, Platform → Settings) after
 *             the settings are hydrated — after a pod restart the in-memory value is the default
 *             until the saved one is read, and a switch an admin turned ON must not read OFF: until it
 *             HAS been read the policy is the strictest (`UNKNOWN_MASKING`), never the default. The
 *             run worker re-reads the setting at most every few seconds (`settings.ts`).
 *             `gatewayMessageRedaction()` is the gateway half: LiteLLM's documented per-request
 *             header, sent on every model call while masking is on.
 */
import { langfuseMaskingPolicy, heldLangfuseMaskingPolicy, langfuseMaskingStatus, __setLangfuseMaskingForTests, __resetLangfuseMaskingForTests } from '@core/models/roles';
import type { MaskingPolicy } from '@core/infra/trace-masking';
import { gatewayRedactionHeaders } from '@core/runtime/gateway-trace';

/** The current masking policy, settings hydrated first. */
export function liveMasking(): Promise<MaskingPolicy> {
  return langfuseMaskingPolicy();
}

/** The policy as already held in memory (the synchronous call sites). */
export function heldMasking(): MaskingPolicy {
  return heldLangfuseMaskingPolicy();
}

/** Whether the switch has been read, and the policy that applies right now (strict while unknown). */
export const maskingStatus = langfuseMaskingStatus;

/** Test seam: set the switch in memory (no mirror, no restart — the same effect an admin's save has). */
export const __setMaskingForTests = __setLangfuseMaskingForTests;

/** Test seam: a fresh process - nothing read, nothing set (the switch is unknown again). */
export const __resetMaskingForTests = __resetLangfuseMaskingForTests;

/** The request headers that make LiteLLM leave the call's prompt and completion out of its callbacks. */
export async function gatewayMessageRedaction(): Promise<Record<string, string>> {
  return gatewayRedactionHeaders((await liveMasking()).enabled);
}
