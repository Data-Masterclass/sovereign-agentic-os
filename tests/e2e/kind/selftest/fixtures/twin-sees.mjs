// SPDX-License-Identifier: Apache-2.0
// Fixture for journey-framework.test.mjs: a twin whose check turns red when the hop is disabled (must pass).
import { journey } from '../../lib/journey.mjs';
let on = true;
const J = journey('FX', 'fixture');
J.twin('t2', { disables: 'the hop', redReasonMust: /hop off/ }, { check: async () => { if (!on) throw new Error('hop off'); }, disable: async () => { on = false; }, restore: async () => { on = true; } });
