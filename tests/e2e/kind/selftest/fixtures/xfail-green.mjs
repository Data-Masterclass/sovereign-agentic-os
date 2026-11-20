// SPDX-License-Identifier: Apache-2.0
// Fixture for journey-framework.test.mjs: an expected-fail assertion that passes (must FAIL the run).
import { journey } from '../../lib/journey.mjs';
const J = journey('FX', 'fixture');
J.assertion('x2', { hop: 'h', record: 'r', expectedFail: 'WP-00' }, async () => {});
