/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       acceptance harness (tests/e2e/kind)
 * FEATURE:    Typed "this hop is not there" errors
 * USER STORY: As the owner reading the nightly report I want every red assertion to name the hop
 *             and the component that failed and why, not a stack trace.
 * ARCHITECTURE:
 *   - HopError carries {component, hop, reason, wp}. Helpers throw it when a component's own
 *     record cannot be read or does not say what the assertion needs. No helper ever returns a
 *     default value in place of a record.
 */
export class HopError extends Error {
  constructor({ component, hop, reason, wp = null, detail = null }) {
    super(`[${component}] ${hop}: ${reason}${wp ? ` (closed by ${wp})` : ''}`);
    this.name = 'HopError';
    this.component = component;
    this.hop = hop;
    this.reason = reason;
    this.wp = wp;
    this.detail = detail;
  }
}

/** Throw a HopError unless `cond` holds. `what` is what the component's record should show. */
export function expectRecord(cond, { component, hop, reason, wp, detail }) {
  if (!cond) throw new HopError({ component, hop, reason, wp, detail });
}
