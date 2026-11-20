// SPDX-License-Identifier: Apache-2.0
// Fixture for journey-framework.test.mjs: an expected-fail assertion that is red (must pass the run).
import { journey } from '../../lib/journey.mjs';
import { HopError } from '../../lib/hop.mjs';
const J = journey('FX', 'fixture');
J.assertion('x1', { hop: 'h', record: 'r', expectedFail: 'WP-00' }, async () => { throw new HopError({ component: 'c', hop: 'h', reason: 'not there yet' }); });
