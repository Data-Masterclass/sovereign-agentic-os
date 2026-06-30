/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
/**
 * Settings adapter — tenant-wide identity/SSO, branding/white-label, defaults,
 * localization (EN→DE), and integrations/notifications.
 *
 * SSO/identity is configured via Ory's secure flow: this stores only NON-SECRET
 * configuration (issuer URL, enabled flag, SCIM toggle). Client secrets go
 * through Ory + the secrets manager and never appear here — there is no field
 * for one. Pure store; unit-testable.
 */

export type Settings = {
  sso: { enabled: boolean; provider: string; issuerUrl: string; scim: boolean };
  branding: { displayName: string; accent: string; whiteLabel: boolean };
  defaults: { domainTemplate: string; newUserRole: 'participant' | 'builder' };
  localization: { locale: 'en' | 'de'; available: ('en' | 'de')[] };
  notifications: { email: string; backupFailure: boolean; costThreshold: boolean };
};

let settings: Settings = {
  sso: { enabled: false, provider: 'ory', issuerUrl: '', scim: false },
  branding: { displayName: 'Sovereign Agentic OS', accent: '#2aa39b', whiteLabel: false },
  defaults: { domainTemplate: 'analytics', newUserRole: 'participant' },
  localization: { locale: 'en', available: ['en', 'de'] },
  notifications: { email: 'admin@datamasterclass.com', backupFailure: true, costThreshold: true },
};

function fail(message: string, status: number): Error {
  const e = new Error(message);
  (e as Error & { status?: number }).status = status;
  return e;
}

export function getSettings(): Settings {
  return settings;
}

/** Deep-merge a patch. Rejects any attempt to smuggle a raw secret field. */
export function updateSettings(patch: Partial<Settings> & Record<string, unknown>): Settings {
  if ('ssoClientSecret' in patch || 'clientSecret' in patch || 'secret' in patch) {
    throw fail('Secrets are configured via Ory + the secrets manager, never here', 400);
  }
  settings = {
    sso: { ...settings.sso, ...(patch.sso ?? {}) },
    branding: { ...settings.branding, ...(patch.branding ?? {}) },
    defaults: { ...settings.defaults, ...(patch.defaults ?? {}) },
    localization: { ...settings.localization, ...(patch.localization ?? {}) },
    notifications: { ...settings.notifications, ...(patch.notifications ?? {}) },
  };
  return settings;
}

export function _reset(): void {
  settings = {
    sso: { enabled: false, provider: 'ory', issuerUrl: '', scim: false },
    branding: { displayName: 'Sovereign Agentic OS', accent: '#2aa39b', whiteLabel: false },
    defaults: { domainTemplate: 'analytics', newUserRole: 'participant' },
    localization: { locale: 'en', available: ['en', 'de'] },
    notifications: { email: 'admin@datamasterclass.com', backupFailure: true, costThreshold: true },
  };
}
