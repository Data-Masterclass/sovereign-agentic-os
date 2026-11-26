// SPDX-License-Identifier: Apache-2.0
// Fixture for scripts/tests/check-test-top-level-await.test.mjs — NOT a test (never run).
// The fixed twin: every top-level await comes before the first test()/hook. Awaits INSIDE tests,
// hooks, helpers and class methods after that point are fine: they run later, not at module load.
import { test, describe, after, mock } from 'node:test';

const real = async (m: string) => ({ ...(await import(m)) });
mock.module('./a', { namedExports: { ...(await real('./a')), a: async () => 1 } });
const { a } = await import('./a');
const { b } = await import('./b');

after(async () => { await a(); });
test('one', async () => { await a(); });
const helper = async () => { for await (const x of [Promise.resolve(1)]) void x; return b(); };
class Later { async run() { await helper(); } }
describe('group', () => {
  test('two', async () => { await new Later().run(); });
});
test.skip('three', async () => { await b(); });
