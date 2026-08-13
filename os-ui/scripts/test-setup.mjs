/* SPDX-License-Identifier: Apache-2.0 */
import { register } from 'node:module';
register('./test-alias-hook.mjs', import.meta.url);

// os-ui 0.6.133: coded (custom) apps ship OFF by default (platform-admin gated) —
// Declarative is the sole default path. The pre-existing coded-path test fixtures
// (lib/software/*.test.ts) were authored assuming coded apps work, so we enable the
// flag ONCE here to represent "an environment where the platform admin has turned
// coded apps ON". The DEDICATED gate test (lib/software/coded-apps-gate.test.ts)
// explicitly drives the flag OFF to prove the default-off + fail-closed enforcement,
// so this harness default never hides the gate. Kept greppable + honest.
const { updateSettings } = await import('../lib/platform-admin/settings.ts');
updateSettings({ codedAppsEnabled: true });
