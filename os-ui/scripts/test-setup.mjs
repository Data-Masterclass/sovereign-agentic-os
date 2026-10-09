/* SPDX-License-Identifier: Apache-2.0 */
// #28: TAB_FEATURES (lib/core/tabs.ts) reads this once at import time, so it
// must be set before anything else runs. Most tests exercise FEATURE behavior
// (e.g. create_dataset), not gating itself, so the default test env mirrors a
// full install (every tab on) instead of the base-only production default —
// the few tests that DO test gating (marketplace/strategy-tools.test.ts) use
// their own local tool list and don't depend on this.
process.env.OS_ENABLED_TABS = 'home,cockpit,tutorials,mcp,about,strategy,big-bets,operating-model,workflows,marketplace,data,metrics,files,knowledge,connections,agents,dashboards,software,science,console,governance,monitoring,components,llm-gateway,admin';

import { register } from 'node:module';
register('./test-alias-hook.mjs', import.meta.url);

// os-ui 0.6.133: coded (custom) apps ship OFF by default (platform-admin gated) —
// Declarative is the sole default path. The pre-existing coded-path test fixtures
// (lib/software/*.test.ts) were authored assuming coded apps work, so we enable the
// flag ONCE here to represent "an environment where the platform admin has turned
// coded apps ON". The DEDICATED gate test (lib/software/coded-apps-gate.test.ts)
// explicitly drives the flag OFF to prove the default-off + fail-closed enforcement,
// so this harness default never hides the gate. Kept greppable + honest.
// __setForTests flips the flag IN-MEMORY only — unlike updateSettings it never
// lazily imports os-mirror (→ config), which at bootstrap would freeze `config`
// before env-before-import tests (e.g. build-stage.test.ts sets SOFTWARE_BUILD_SERVICE)
// set their env vars. Same in-memory effect, no config side effect.
const { __setForTests } = await import('../lib/platform-admin/settings.ts');
__setForTests({ codedAppsEnabled: true });
