/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The password strength rule — one function for the server check and the live meter
 * USER STORY: As someone choosing a password on the bootstrap, recovery or user-admin screens I
 *             want the meter to accept exactly what the server will accept, so the form never
 *             blocks a password the server allows or praises one it will refuse.
 * ARCHITECTURE:
 *   - PURE (no `node:crypto`, no `server-only`), so client components import it directly. The
 *     server re-exports it from `core/kernel/password.ts` and re-checks every password there;
 *     the browser copy is feedback only, but it is now the same code, not a mirror that drifts.
 *   - Before this module there were three hand-written client copies with different deny-lists
 *     and a username rule without the server's 3-character minimum.
 */

export type Strength = { ok: boolean; score: number; reasons: string[] };

const MIN_LEN = 12;

// A tiny deny-list of the most obvious choices. Not exhaustive — the length +
// character-class rules do the heavy lifting; this just blocks the worst.
const COMMON = new Set([
  'password', 'passw0rd', 'admin', 'administrator', 'changeme', 'letmein',
  'welcome', 'qwerty', 'qwertyuiop', '111111', '123456', '12345678',
  '123456789', '1234567890', 'iloveyou', 'monkey', 'dragon', 'sunshine',
  'password1', 'admin123', 'root', 'toor', 'secret', 'sovereign',
]);

/**
 * Assess a candidate password. Server-authoritative — the UI runs this same function
 * for live feedback and the API re-checks before accepting any password.
 */
export function assessPasswordStrength(pw: string, username = ''): Strength {
  const reasons: string[] = [];
  const lower = pw.toLowerCase();

  if (pw.length < MIN_LEN) reasons.push(`Use at least ${MIN_LEN} characters`);
  const classes =
    Number(/[a-z]/.test(pw)) +
    Number(/[A-Z]/.test(pw)) +
    Number(/[0-9]/.test(pw)) +
    Number(/[^A-Za-z0-9]/.test(pw));
  if (classes < 3) reasons.push('Mix upper, lower, numbers and symbols (3 of 4)');
  if (COMMON.has(lower)) reasons.push('That password is too common');
  if (username && lower.includes(username.trim().toLowerCase()) && username.trim().length >= 3)
    reasons.push('Do not include your username');
  if (/^(.)\1+$/.test(pw)) reasons.push('Avoid a single repeated character');

  // Score 0..4 for the UI meter.
  let score = 0;
  if (pw.length >= MIN_LEN) score++;
  if (pw.length >= 16) score++;
  score += Math.max(0, classes - 2);
  score = Math.min(4, score);

  return { ok: reasons.length === 0, score, reasons };
}
