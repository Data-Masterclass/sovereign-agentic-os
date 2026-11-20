// SPDX-License-Identifier: Apache-2.0
// Fixture for journey-framework.test.mjs: a red twin declared without redReasonMust. Must FAIL the run.
import { journey } from '../../lib/journey.mjs';
const J = journey('FX', 'fixture');
J.twin('t4', { disables: 'the hop' }, { check: async () => {}, disable: async () => {}, restore: async () => {} });
