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
 *   - i18n wave 4: every English reason has a stable code beside it (`issues`). The server sends the
 *     code (`password.<rule>`, rendered from the `server` catalog) and the meter renders the same rule
 *     from `common.password.*`. `reasons` stays the English list the API and tests always read.
 */

/** The rule a password breaks — `password.<rule>` in the `server` catalog, `password.<rule>` in `common`. */
export type PasswordRule = 'minLength' | 'mixClasses' | 'tooCommon' | 'containsUsername' | 'repeatedChar';
export type PasswordIssue = { reason: string; code: `password.${PasswordRule}`; rule: PasswordRule; params?: { min: number } };
export type Strength = { ok: boolean; score: number; reasons: string[]; issues: PasswordIssue[] };

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
  const issues: PasswordIssue[] = [];
  const add = (rule: PasswordRule, reason: string, params?: { min: number }): void => {
    issues.push(params ? { reason, code: `password.${rule}`, rule, params } : { reason, code: `password.${rule}`, rule });
  };
  const lower = pw.toLowerCase();

  if (pw.length < MIN_LEN) add('minLength', `Use at least ${MIN_LEN} characters`, { min: MIN_LEN });
  const classes =
    Number(/[a-z]/.test(pw)) +
    Number(/[A-Z]/.test(pw)) +
    Number(/[0-9]/.test(pw)) +
    Number(/[^A-Za-z0-9]/.test(pw));
  if (classes < 3) add('mixClasses', 'Mix upper, lower, numbers and symbols (3 of 4)');
  if (COMMON.has(lower)) add('tooCommon', 'That password is too common');
  if (username && lower.includes(username.trim().toLowerCase()) && username.trim().length >= 3)
    add('containsUsername', 'Do not include your username');
  if (/^(.)\1+$/.test(pw)) add('repeatedChar', 'Avoid a single repeated character');

  // Score 0..4 for the UI meter.
  let score = 0;
  if (pw.length >= MIN_LEN) score++;
  if (pw.length >= 16) score++;
  score += Math.max(0, classes - 2);
  score = Math.min(4, score);

  const reasons = issues.map((i) => i.reason);
  return { ok: reasons.length === 0, score, reasons, issues };
}

/**
 * The server's weak-password reply: the first broken rule (English + code + params) — the same text the
 * API has always sent as `error` — or the generic fallback. `issues` carries every rule for the UI list.
 */
export function weakPasswordMessage(s: Strength): { english: string; code: string; params?: { min: number } } {
  const first = s.issues[0];
  if (!first) return { english: 'Password is too weak', code: 'password.tooWeak' };
  return first.params ? { english: first.reason, code: first.code, params: first.params } : { english: first.reason, code: first.code };
}

/** The `issues` as the API sends them (`{ reason, code, params? }` per rule). */
export function issuesBody(s: Strength): { reason: string; code: string; params?: { min: number } }[] {
  return s.issues.map((i) => (i.params ? { reason: i.reason, code: i.code, params: i.params } : { reason: i.reason, code: i.code }));
}
