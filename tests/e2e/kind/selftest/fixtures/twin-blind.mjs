// SPDX-License-Identifier: Apache-2.0
// Fixture for journey-framework.test.mjs: a twin whose check cannot see the disabled hop (must FAIL).
import { journey } from '../../lib/journey.mjs';
const J = journey('FX', 'fixture');
J.twin('t1', { disables: 'nothing the check reads' }, { check: async () => {}, disable: async () => {}, restore: async () => {} });
