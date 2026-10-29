/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
/**
 * Guarded-action helper. Destructive Platform-Admin actions — a restore, an
 * archive, disabling a core-ish layer — are NEVER one-click: the caller must
 * echo back an exact confirmation phrase. The phrase is deterministic so the UI
 * can show it ("type `restore postgres` to confirm") and the server can verify
 * it, and every guarded action is audited by the adapter that owns it.
 *
 * Pure + dependency-free so it is unit-testable and reusable everywhere.
 */

export class GuardError extends Error {
  status = 412; // Precondition Failed
  constructor(message: string) {
    super(message);
    this.name = 'GuardError';
  }
}

/** The exact phrase a user must type to confirm a guarded action on `target`. */
export function confirmationPhrase(action: string, target: string): string {
  return `${action.trim().toLowerCase()} ${target.trim().toLowerCase()}`.replace(/\s+/g, ' ');
}

/**
 * Throws GuardError(412) unless `confirm` matches the required phrase for
 * (action, target). Returns the phrase on success so callers can audit it.
 */
export function assertGuarded(action: string, target: string, confirm: unknown): string {
  const expected = confirmationPhrase(action, target);
  const got = typeof confirm === 'string' ? confirm.trim().toLowerCase().replace(/\s+/g, ' ') : '';
  if (got !== expected) {
    throw new GuardError(`Confirmation required: type "${expected}" to proceed`);
  }
  return expected;
}
