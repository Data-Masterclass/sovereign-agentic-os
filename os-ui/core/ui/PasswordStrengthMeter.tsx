/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The live password strength meter on the first-admin and account-recovery pages
 * USER STORY: As someone setting a password I want a bar and a list of what is still missing,
 *             computed by the same rule the server applies when I press Submit.
 * ARCHITECTURE:
 *   - Renders `assessPasswordStrength` from `@core/kernel/password-strength` (pure, shared
 *     with the server), with the existing `auth-strength-*` classes from the auth stylesheet.
 *   - Used by `app/(entry)/onboarding/bootstrap` and `app/(entry)/recover`, which until now
 *     each carried a private copy of the rule and of this component.
 *   - Each unmet rule renders from `common.password.<rule>` in the user's language (the rule's
 *     stable key travels beside its English reason; i18n wave 4).
 */
'use client';

import { assessPasswordStrength } from '@core/kernel/password-strength';
import { useTranslations } from '@core/i18n/client';

const FILL_COLORS = ['#c0392b', '#e06a2a', '#c8a24a', '#2aa39b', '#2aa39b'];

export function PasswordStrengthMeter({ password, username }: { password: string; username: string }) {
  const t = useTranslations('common');
  if (!password) return null;
  const { score, issues } = assessPasswordStrength(password, username);
  return (
    <div className="auth-strength-wrap">
      <div className="auth-strength-bar">
        <div
          className="auth-strength-fill"
          style={{ width: `${(score + 1) * 20}%`, backgroundColor: FILL_COLORS[score] }}
        />
      </div>
      <div className="auth-strength-rules">
        {issues.length === 0 ? (
          <div className="auth-strength-rule">✓ {t('password.strong')}</div>
        ) : (
          issues.map((i) => (
            <div key={i.rule} className="auth-strength-rule unmet">
              ✗ {t(`password.${i.rule}`, i.params)}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
