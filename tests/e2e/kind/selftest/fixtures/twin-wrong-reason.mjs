// SPDX-License-Identifier: Apache-2.0
// Fixture for journey-framework.test.mjs: a twin that turns red for a reason other than the one
// that proves the hop (here: an infrastructure error). Must FAIL the run.
import { journey } from '../../lib/journey.mjs';
let on = true;
const J = journey('FX', 'fixture');
J.twin('t3', { disables: 'the hop', redReasonMust: /^hop off$/ }, { check: async () => { if (!on) throw new Error('port-forward: connection refused'); }, disable: async () => { on = false; }, restore: async () => { on = true; } });
